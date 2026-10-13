'use client'

import { Fragment, useState } from 'react'
import { formatPrice, formatPrevDiff, formatMarketCap } from '@/domain/format'
import { groupByCategory, newsColumnContent, rowStateLabel, type ClientRow, type RowState } from '@/db/repo'
import { newsCellSpans, newsGroupEnd, newsOwnerSymbol } from '@/domain/newsShare'
import { NEWS_SUMMARY_STYLE, NEWS_TITLE_STYLE } from '@/domain/newsStyle'
import { RowPanel } from './RowPanel'

/**
 * 여섯 가지 행 상태를 한눈에 구분할 수 있도록 서로 다른 배경색을 준다.
 * bg와 text를 항상 짝으로 명시한다 — text를 비워 상위(main)의 글자색 상속에
 * 맡기면, 페이지가 라이트로 고정돼 있어도 나중에 이 조각만 재사용될 때 다시
 * 깨질 수 있다.
 * STALE_SELECTION은 PENDING(미검토)과 같은 급의 "다시 봐야 함"이지만 사유가
 * 다르므로(담당자가 고른 뒤 재수집으로 무효화됨) pending(황토)과 겹치지 않는
 * stale(분홍)을 쓴다.
 *
 * NEWS_FAILED는 NO_NEWS의 회색과 반드시 달라야 한다. 회색은 "볼 것 없음"으로 읽히는데,
 * 이 행은 정반대로 **담당자가 직접 네이버에서 찾아봐야 하는 행**이다. 조용한 공란과
 * 섞이면 안 되므로 주의를 끄는 fail(주황)을 쓴다(pending/stale과도 겹치지 않는다).
 *
 * Task 22: 뉴스 칼럼이 상태 배지를 대신하게 되면서, 행 상태를 알아볼 유일한 단서가
 * 이 배경 틴트와(NEWS_FAILED/STALE_SELECTION만) 뉴스 칼럼 안의 작은 라벨이 됐다.
 * 스크린샷으로 확인한 결과 PENDING/SELECTED/OMITTED/NO_NEWS 는 틴트만으로 서로
 * 구분됐지만, "이 행이 확정됐는지 미확정인지"는 틴트 하나로는 부족해서(옅어서
 * 훑어볼 때 놓치기 쉽다) 뉴스 칼럼 안에 "미확정" 표시를 추가로 넣었다
 * (아래 NewsCell 참고).
 *
 * Task 34: 톤을 웜 뉴트럴로 옮기면서 색은 전부 `globals.css` 의 의미 토큰으로
 * 갈아탔다(bg-amber-50 → bg-pending-row 등). **틴트 여섯 개가 서로 구분된다는
 * 조건은 그대로다** — 색을 바꿀 때 그 조건이 무너지면 이 파일의 안전장치가
 * 통째로 무력해진다.
 */
const ROW_BG: Record<RowState, string> = {
  NEWS_FAILED: 'bg-fail-row text-ink',
  NO_NEWS: 'bg-none-row text-ink-muted',
  OMITTED: 'bg-omitted-row text-ink-muted',
  PENDING: 'bg-pending-row text-ink',
  SELECTED: 'bg-page text-ink',
  STALE_SELECTION: 'bg-stale-row text-ink',
  // 실제로는 소유 행(S&P500)의 틴트를 빌려 쓴다(아래 rowBg) — 병합된 뉴스 칸이 소유 행의
  // 틴트를 갖고 두 행에 걸쳐 있으므로, 덮인 행이 다른 색이면 한 칸이 두 색으로 갈라진다.
  // 소유 행을 못 찾을 때만 이 값이다.
  NEWS_SHARED: 'bg-page text-ink',
}

function pct(v: number | null): string {
  if (v === null) return '-'
  return `${(v * 100).toFixed(2)}%`
}

/**
 * 사용자 요청: 숫자 칸은 오른쪽 정렬, 글자 칸(구분/기업)은 가운데 정렬, 뉴스는 왼쪽 정렬.
 * 헤더와 본문이 각자 정렬 클래스를 따로 들고 있으면 나중에 한쪽만 고치다 어긋나기
 * 쉬우므로, 칼럼 순서에 맞춘 배열 하나를 두고 헤더/본문 모두 이 배열로 렌더한다.
 * 숫자 칸에는 tabular-nums도 같이 건다 — 오른쪽 정렬의 목적이 자릿수를 세로로
 * 맞추는 것인데 비례폭 숫자면 정렬해도 소수점이 안 맞는다.
 */
const COL_ALIGN = [
  'text-center', // 구분
  'text-center', // 기업
  'text-right tabular-nums', // 주가
  'text-right tabular-nums', // 전일대비
  'text-right tabular-nums', // %
  'text-right tabular-nums', // 연초대비
  'text-right tabular-nums', // 시가총액(조원)
  'text-left', // 뉴스
] as const

/**
 * 뉴스 칼럼 렌더러. newsColumnContent(순수 함수, repo.ts)가 정한 kind에 따라
 * 완전히 다른 모양을 그린다 — NO_NEWS('-')와 NEWS_FAILED(라벨), OMITTED('-'지만
 * 표시 붙음)와 NO_NEWS('-'만)가 같은 문자열로 수렴하면 안 된다는 것이 이번
 * 작업의 핵심 요구사항이었다.
 */
function NewsCell({ row, ownerName }: { row: ClientRow; ownerName: string | null }) {
  const content = newsColumnContent({
    state: row.state,
    candidates: row.candidates,
    chosenCandidateId: row.selection.chosenCandidateId,
    chosenSummaryId: row.selection.chosenSummaryId,
    editedText: row.selection.editedText,
  })

  if (content.kind === 'shared') {
    // 병합이 되면 이 칸은 그려지지 않는다(BriefTable). 여기 오는 것은 소유 행 바로 아래가
    // 아니라 병합할 수 없을 때뿐이다 — 비우거나 '-' 로 두면 「미확정」·「기사 없음」으로
    // 읽힌다. 어느 행의 칸을 보라는 것인지 말한다.
    return (
      <span className="inline-block rounded bg-badge px-2 py-0.5 text-xs text-badge-fg">
        {ownerName !== null ? `${ownerName} 뉴스와 같음` : rowStateLabel('NEWS_SHARED')}
      </span>
    )
  }

  if (content.kind === 'none') {
    return <span className="text-ink-faint">-</span>
  }

  if (content.kind === 'omitted') {
    // NO_NEWS와 똑같이 '-'로만 보이면 "기사가 없었다"와 "담당자가 뺐다"가
    // 구분이 안 된다 — 작은 표시를 덧붙인다.
    return (
      <span className="text-ink-faint">
        - <span className="rounded bg-badge px-1 py-0.5 text-[10px] text-badge-fg">싣지 않음</span>
      </span>
    )
  }

  if (content.kind === 'label') {
    const color = row.state === 'NEWS_FAILED' ? 'bg-fail text-fail-fg' : 'bg-stale text-stale-fg'
    return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${color}`}>{content.text}</span>
  }

  // content.kind === 'article'
  // isFallback 배지는 RowPanel의 "본문 발췌 (모델 요약 실패)"와 같은 사실을
  // 알려야 하므로 같은 계열(excerpt)을 쓴다 — 패널과 시각 언어를 맞춘다.
  // "미확정"(pending)과 "발췌"(excerpt)는 서로 다른 질문에 대한 답이다 — 하나는
  // 확정 여부, 하나는 출처(모델 vs 기계 발췌) — 이므로 하나로 합쳐 문구를 늘리지
  // 않고 나란히 놓인 두 개의 작은 pill로 유지한다. 색이 다르므로 나란히 있어도
  // 같은 신호로 뭉쳐 보이지 않는다(ROW_BG 주석의 구분 원칙과 같다).
  const fallbackBadge = content.isFallback && (
    <span className="inline-block rounded bg-excerpt px-1.5 py-0.5 text-[10px] font-semibold text-excerpt-fg">
      본문 발췌
    </span>
  )

  // 제목·요약 서식은 인라인 style 이다(domain/newsStyle.ts). 담당자가 이 칸을 복사해
  // 임원 메일에 붙이는데, 클래스로만 건 서식은 붙여넣기 대상에 따라 빠진다.
  const title = (
    <a
      href={content.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={e => e.stopPropagation()}
      className="block"
      style={NEWS_TITLE_STYLE}
    >
      {content.title}
    </a>
  )
  const summary = content.summary && (
    <div className="leading-snug" style={NEWS_SUMMARY_STYLE}>
      {content.summary}
    </div>
  )

  if (!content.confirmed) {
    // PENDING 미리보기 — confirmed 확정본과 절대 같아 보이면 안 된다.
    //
    // 예전에는 기울임체 + pending 색 + 「미확정」 배지 세 겹이었다. **앞의 둘은
    // 2026-10-02 담당자 피드백으로 뺐다**: 담당자는 이 칸을 복사해 메일에 붙이고,
    // 기울임과 황토색이 메일까지 따라 들어갔다(「이탤릭체 모두 제거 ▶ 제목 파란색…」).
    // 남은 구분 신호는 둘이다 — 「미확정 · 1순위 후보」 배지와 행 배경(bg-pending-row).
    // 둘 다 칸 안의 글자 서식이 아니라서 복사본에는 실리지 않으면서 화면에서는 남는다.
    // **배지를 지우지 마라.** 행 배경은 옅어서 훑어볼 때 놓치기 쉽고, 그러면 이 미리보기가
    // 확정본과 같아 보인다. 엑셀은 별도로 미확정 칸을 공란으로 내보낸다(domain/excel.ts).
    return (
      <div className="py-0.5">
        <div className="mb-0.5 flex flex-wrap items-center gap-1">
          <span className="inline-block rounded bg-pending px-1.5 py-0.5 text-[10px] font-semibold text-pending-fg">
            미확정 · 1순위 후보
          </span>
          {fallbackBadge}
        </div>
        {title}
        {summary}
      </div>
    )
  }

  return (
    <div className="py-0.5">
      {fallbackBadge && <div className="mb-0.5">{fallbackBadge}</div>}
      {title}
      {summary}
    </div>
  )
}

/**
 * 뉴스 칸 병합(S&P500 + Nasdaq — domain/newsShare.ts). 엑셀과 **같은 함수**로
 * 정한다. 구분(category) 묶음 안에서만 계산한다 — 묶음 머리 행을 사이에 두고
 * 병합하면 rowSpan 이 머리 행을 덮는다.
 *
 * 펼침 패널은 묶음의 **마지막 행 뒤에** 그린다. 소유 행 바로 뒤에 패널 행을
 * 끼우면 rowSpan 이 패널 행을 덮고 덮인 행(Nasdaq)은 패널 아래로 밀려 표가 깨진다.
 */
function CategoryRows({
  categoryRows,
  allRows,
  runDate,
  openId,
  setOpenId,
}: {
  categoryRows: ClientRow[]
  /** 소유 행을 찾을 때 쓴다. 소유 행이 다른 구분에 있어도 이름·틴트는 빌려 온다. */
  allRows: ClientRow[]
  runDate: string
  openId: string | null
  setOpenId: (id: string | null) => void
}) {
  const spans = newsCellSpans(categoryRows.map(r => r.instrument))
  const openIndex = categoryRows.findIndex(r => r.instrument.id === openId)
  const panelAfter = openIndex >= 0 ? newsGroupEnd(spans, openIndex) : -1
  const ownerOf = (row: ClientRow): ClientRow | null => {
    const sym = newsOwnerSymbol(row.instrument.quoteSymbol)
    return sym === row.instrument.quoteSymbol ? null : (allRows.find(r => r.instrument.quoteSymbol === sym) ?? null)
  }

  return (
    <>
      {categoryRows.map((row, i) => {
        const isOpen = openId === row.instrument.id
        const owner = ownerOf(row)
        const rowBg = row.state === 'NEWS_SHARED' && owner !== null ? ROW_BG[owner.state] : ROW_BG[row.state]
        const openRow = i === panelAfter ? categoryRows[openIndex] : null
        return (
          <Fragment key={row.instrument.id}>
            <tr
              onClick={() => setOpenId(isOpen ? null : row.instrument.id)}
              className={`cursor-pointer border-b border-rowline align-top ${rowBg}`}
            >
              <td className={`px-2 py-1.5 ${COL_ALIGN[0]}`}>{row.instrument.category}</td>
              <td className={`px-2 py-1.5 font-medium ${COL_ALIGN[1]}`}>{row.instrument.name}</td>
              <td className={`px-2 py-1.5 ${COL_ALIGN[2]}`}>
                {row.display.close !== null ? (
                  <>
                    {formatPrice(row.display.close, row.instrument.currency, row.instrument.isIndex)}
                    {row.display.isManual && (
                      <span className="ml-1 text-[10px] text-link">(수기)</span>
                    )}
                  </>
                ) : row.quoteFailReason !== null ? (
                  /*
                   * 시세 수집이 실패한 행. 그냥 '-'로 두면 주가·전일대비·%·연초대비
                   * 네 칸이 전부 공란이 되는데, 그 공란은 "값이 없다"와 "받아오지
                   * 못했다"를 똑같이 뜻하게 된다 — 배너가 초록색 「준비 완료」일
                   * 때는 담당자가 구분할 근거가 화면에 하나도 없다.
                   *
                   * NEWS_FAILED 라벨(NewsCell)과 **같은 시각 언어**를 쓴다
                   * (orange pill). 화면에 실패 표시가 두 가지 방언으로 존재하면
                   * 안 된다. 같은 orange 계열인 시총의 '환율 미확보'가 pill이
                   * 아니라 평문인 것은 뜻이 달라서다 — 그쪽은 시총 한 칸만
                   * 못 채운 부분 결손이고, 이쪽은 이 행의 숫자가 통째로 없다.
                   *
                   * 사유는 지어내지 않는다. title 에 errorMessage 원문을 그대로
                   * 남겨 담당자·운영자가 DB를 열지 않고도 원문을 볼 수 있게 한다.
                   */
                  <span
                    className="inline-block rounded bg-fail px-2 py-0.5 text-[12px] font-medium text-fail-fg"
                    title={row.quoteFailReason}
                  >
                    시세 실패
                  </span>
                ) : (
                  '-'
                )}
                {/* text-align은 상속되므로 td의 text-right를 따로 반복하지 않아도
                    이 보조 줄도 같이 오른쪽으로 맞춰진다.

                    값이 보이는 행에는 **항상** 기준일 줄을 그린다. 예전에는
                    asOf 가 falsy 면 줄 자체가 사라졌는데, 소스가 기준일을 주지
                    않으면(twelvedata 의 datetime 누락, 네이버 파싱 실패) 그
                    공백이 "오늘 종가"로 읽힌다 — 해외 종목은 전일 종가일 수
                    있고, 스펙 §3.2·§13.2 는 담당자가 그 지연을 판단할 수 있도록
                    기준일 노출을 요구한다. 모르면 모른다고 말한다. */}
                {row.display.close !== null && (
                  <div className="text-[10px] text-ink-faint">
                    {row.quote?.asOf ? `기준 ${row.quote.asOf}` : '기준일 미상'}
                  </div>
                )}
                {/* 1차 소스가 죽어 2차(폴백)로 채운 행. **실패가 아니다** —
                    값이 다 차 있고 담당자가 오늘 할 일은 없다. 그래서 「시세 실패」의
                    orange pill 을 쓰지 않는다(그 색은 "이 행의 숫자가 통째로 없다"는
                    뜻으로 이미 쓰이고 있다). 대신 '(수기)'와 같은 급의 조용한 표시로
                    둔다 — 뜻도 같은 계열이다: "이 값은 평소와 다른 경로로 들어왔다".
                    그래도 표시 자체를 없애면 안 된다. 폴백이 조용히 성공하면 1차가
                    몇 주째 죽어 있어도 아무도 모른다(db/repo.ts 의 판정 함수 참고). */}
                {row.quoteFallbackSource !== null && (
                  <div>
                    <span
                      className="inline-block rounded bg-note px-1 py-0.5 text-[10px] font-medium text-note-fg"
                      title={`평소 소스${row.quote?.fallbackFrom ? `(${row.quote.fallbackFrom})` : ''}가 실패해 대체 소스(${row.quoteFallbackSource})로 채운 값입니다. 값 자체는 정상이지만 1차 소스를 점검해야 합니다.`}
                    >
                      {row.quoteFallbackSource} 대체
                    </span>
                  </div>
                )}
              </td>
              {/* formatPrevDiff가 close/prevClose null 여부와 보합(0)을 각각 다른
                 문자열로 처리하므로 여기서 다시 분기하지 않는다. */}
              <td className={`px-2 py-1.5 ${COL_ALIGN[3]}`}>
                {formatPrevDiff(row.display.close, row.display.prevClose)}
              </td>
              <td className={`px-2 py-1.5 ${COL_ALIGN[4]}`}>{pct(row.display.changePct)}</td>
              <td className={`px-2 py-1.5 ${COL_ALIGN[5]}`}>{pct(row.quote?.ytdPct ?? null)}</td>
              {/* 시총 공란의 이유를 아는 경우에만 표시한다. 환율 미확보는 해외사에만
                  해당하고(국내는 네이버가 시총을 직접 준다), 지수와 "이유를 모르는
                  공란"에는 아무 표시도 하지 않는다 — marketCapBlankReason 참조. */}
              <td className={`px-2 py-1.5 ${COL_ALIGN[6]}`}>
                {row.marketCapBlankReason === 'FX_UNAVAILABLE' ? (
                  <span
                    className="text-fail-fg"
                    title={`${row.instrument.currency} 환율을 받지 못해 시가총액을 계산하지 못했습니다`}
                  >
                    환율 미확보
                  </span>
                ) : (
                  formatMarketCap(row.quote?.marketCapKrwTrillion ?? null)
                )}
              </td>
              {spans[i] > 0 && (
                <td
                  rowSpan={spans[i] > 1 ? spans[i] : undefined}
                  className={`px-2 py-1.5 ${COL_ALIGN[7]}`}
                >
                  <NewsCell row={row} ownerName={owner?.instrument.name ?? null} />
                </td>
              )}
            </tr>
            {openRow !== null && (
              <tr>
                <td colSpan={8} className="border-b border-rowline bg-thead">
                  <RowPanel
                    key={`${openRow.instrument.id}:${openRow.selection.chosenCandidateId}:${openRow.selection.chosenSummaryId}:${openRow.selection.decision}`}
                    runDate={runDate}
                    row={openRow}
                    newsOwnerName={ownerOf(openRow)?.instrument.name ?? null}
                  />
                </td>
              </tr>
            )}
          </Fragment>
        )
      })}
    </>
  )
}

export function BriefTable({ runDate, rows }: { runDate: string; rows: ClientRow[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const groups = groupByCategory(rows)

  return (
    <table className="w-full table-fixed border-collapse text-[14px]">
      {/*
       * 뉴스 칼럼이 제목+요약(최대 100자) 두 줄을 담아야 해서 나머지 칼럼보다
       * 훨씬 넓어야 한다. table-fixed + colgroup으로 비율을 고정한다 — auto
       * 레이아웃에 맡기면 브라우저가 내용 길이에 따라 뉴스 칼럼을 계속
       * 넓혔다 좁혔다 해서(글자 수가 행마다 다르므로) 표가 흔들린다.
       */}
      {/*
       * 사용자 요청: 뉴스 칸을 줄이고 주가/전일대비/%/연초대비/시가총액을 20%씩
       * 늘인다. Tailwind 고정 스케일에는 20% 단위가 없어 arbitrary value를 쓴다
       * (7rem→8.4rem, 6rem→7.2rem, 4rem→4.8rem, 5rem→6rem, 6rem→7.2rem). 구분/기업은
       * 그대로 두고, 뉴스는 remainder라 남은 폭만큼 자동으로 줄어든다.
       * 이 변경이 기존 줄바꿈 버그도 고친다 — 삼성바이오로직스 "KRW 1,594,000"이
       * w-28(7rem)에서 두 줄로 넘쳤는데 8.4rem에서는 한 줄에 들어간다(스크린샷으로 확인).
       */}
      <colgroup>
        <col className="w-16" />
        <col className="w-40" />
        <col className="w-[8.4rem]" />
        <col className="w-[7.2rem]" />
        <col className="w-[4.8rem]" />
        <col className="w-24" />
        <col className="w-[7.2rem]" />
        <col />
      </colgroup>
      <thead>
        <tr className="border-b border-line bg-thead text-[12px] text-ink-muted">
          <th className={`px-2 py-1 ${COL_ALIGN[0]}`}>구분</th>
          <th className={`px-2 py-1 ${COL_ALIGN[1]}`}>기업</th>
          <th className={`px-2 py-1 ${COL_ALIGN[2]}`}>주가</th>
          <th className={`px-2 py-1 ${COL_ALIGN[3]}`}>전일대비</th>
          <th className={`px-2 py-1 ${COL_ALIGN[4]}`}>%</th>
          <th className={`px-2 py-1 ${COL_ALIGN[5]}`}>연초대비</th>
          <th className={`px-2 py-1 ${COL_ALIGN[6]}`}>시가총액(조원)</th>
          <th className={`px-2 py-1 ${COL_ALIGN[7]}`}>뉴스</th>
        </tr>
      </thead>
      <tbody>
        {groups.map(g => (
          <Fragment key={g.category}>
            <tr>
              <td colSpan={8} className="bg-sidebar px-2 py-1.5 text-[12px] font-semibold text-white">
                {g.category}
              </td>
            </tr>
            <CategoryRows
              categoryRows={g.rows}
              allRows={rows}
              runDate={runDate}
              openId={openId}
              setOpenId={setOpenId}
            />
          </Fragment>
        ))}
      </tbody>
    </table>
  )
}
