'use client'

import { Fragment, useState } from 'react'
import { formatPrice, formatPrevDiff, formatMarketCap } from '@/domain/format'
import { groupByCategory, newsColumnContent, type ClientRow, type RowState } from '@/db/repo'
import { RowPanel } from './RowPanel'

/**
 * 여섯 가지 행 상태를 한눈에 구분할 수 있도록 서로 다른 배경색을 준다.
 * bg와 text를 항상 짝으로 명시한다 — text를 비워 상위(main)의 글자색 상속에
 * 맡기면, 페이지가 라이트로 고정돼 있어도 나중에 이 조각만 재사용될 때 다시
 * 깨질 수 있다.
 * STALE_SELECTION은 PENDING(미검토)과 같은 급의 "다시 봐야 함"이지만 사유가
 * 다르므로(담당자가 고른 뒤 재수집으로 무효화됨) amber와 겹치지 않는 rose를 쓴다.
 *
 * NEWS_FAILED는 NO_NEWS의 회색과 반드시 달라야 한다. 회색은 "볼 것 없음"으로 읽히는데,
 * 이 행은 정반대로 **담당자가 직접 네이버에서 찾아봐야 하는 행**이다. 조용한 공란과
 * 섞이면 안 되므로 주의를 끄는 orange를 쓴다(amber/rose와도 겹치지 않는다).
 *
 * Task 22: 뉴스 칼럼이 상태 배지를 대신하게 되면서, 행 상태를 알아볼 유일한 단서가
 * 이 배경 틴트와(NEWS_FAILED/STALE_SELECTION만) 뉴스 칼럼 안의 작은 라벨이 됐다.
 * 스크린샷으로 확인한 결과 PENDING(amber)/SELECTED(white)/OMITTED(gray-100)/
 * NO_NEWS(gray-50) 는 틴트만으로 서로 구분됐지만, "이 행이 확정됐는지 미확정인지"는
 * 틴트 하나로는 부족해서(같은 amber 계열이라도 옅어서 훑어볼 때 놓치기 쉽다)
 * 뉴스 칼럼 안에 "미확정" 표시를 추가로 넣었다(아래 NewsCell 참고).
 */
const ROW_BG: Record<RowState, string> = {
  NEWS_FAILED: 'bg-orange-50 text-gray-900',
  NO_NEWS: 'bg-gray-50 text-gray-500',
  OMITTED: 'bg-gray-100 text-gray-600',
  PENDING: 'bg-amber-50 text-gray-900',
  SELECTED: 'bg-white text-gray-900',
  STALE_SELECTION: 'bg-rose-50 text-gray-900',
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
function NewsCell({ row }: { row: ClientRow }) {
  const content = newsColumnContent({
    state: row.state,
    candidates: row.candidates,
    chosenCandidateId: row.selection.chosenCandidateId,
    chosenSummaryId: row.selection.chosenSummaryId,
    editedText: row.selection.editedText,
  })

  if (content.kind === 'none') {
    return <span className="text-gray-400">-</span>
  }

  if (content.kind === 'omitted') {
    // NO_NEWS와 똑같이 '-'로만 보이면 "기사가 없었다"와 "담당자가 뺐다"가
    // 구분이 안 된다 — 작은 표시를 덧붙인다.
    return (
      <span className="text-gray-400">
        - <span className="rounded bg-gray-200 px-1 py-0.5 text-[10px] text-gray-600">싣지 않음</span>
      </span>
    )
  }

  if (content.kind === 'label') {
    const color = row.state === 'NEWS_FAILED' ? 'bg-orange-200 text-orange-900' : 'bg-rose-200 text-rose-900'
    return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${color}`}>{content.text}</span>
  }

  // content.kind === 'article'
  // isFallback 배지는 RowPanel의 "본문 발췌 (모델 요약 실패)"와 같은 사실을
  // 알려야 하므로 같은 orange를 쓴다(패널과 시각 언어를 맞춘다). "미확정"(amber)과
  // "발췌"(orange)는 서로 다른 질문에 대한 답이다 — 하나는 확정 여부, 하나는
  // 출처(모델 vs 기계 발췌) — 이므로 하나로 합쳐 문구를 늘리지 않고 나란히 놓인
  // 두 개의 작은 pill로 유지한다. 색이 다르므로 나란히 있어도 같은 신호로
  // 뭉쳐 보이지 않는다(ROW_BG 주석의 amber/orange 구분 원칙과 같다).
  const fallbackBadge = content.isFallback && (
    <span className="inline-block rounded bg-orange-200 px-1.5 py-0.5 text-[10px] font-semibold text-orange-900">
      본문 발췌
    </span>
  )

  if (!content.confirmed) {
    // PENDING 미리보기 — confirmed 확정본과 절대 같아 보이면 안 된다. 기울임체 +
    // amber 색 + "미확정" 태그 세 겹으로 표시한다. 이 중 하나만 놓쳐도(예: 태그를
    // 잘라내는 리팩터링) 나머지 두 신호가 남아 있도록 일부러 중복시켰다.
    return (
      <div className="py-0.5">
        <div className="mb-0.5 flex flex-wrap items-center gap-1">
          <span className="inline-block rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">
            미확정 · 1순위 후보
          </span>
          {fallbackBadge}
        </div>
        <a
          href={content.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          className="block font-medium text-amber-800 italic hover:underline"
        >
          {content.title}
        </a>
        {content.summary && <div className="text-[13px] leading-snug text-amber-700 italic">{content.summary}</div>}
      </div>
    )
  }

  return (
    <div className="py-0.5">
      {fallbackBadge && <div className="mb-0.5">{fallbackBadge}</div>}
      <a
        href={content.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}
        className="block font-medium text-blue-700 hover:underline"
      >
        {content.title}
      </a>
      {content.summary && <div className="text-[13px] leading-snug text-gray-700">{content.summary}</div>}
    </div>
  )
}

export function BriefTable({ runDate, rows }: { runDate: string; rows: ClientRow[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const groups = groupByCategory(rows)

  return (
    <table className="w-full table-fixed border-collapse text-sm">
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
        <tr className="border-b border-gray-300 text-xs text-gray-500">
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
              <td colSpan={8} className="bg-slate-800 px-2 py-1 text-xs font-semibold text-white">
                {g.category}
              </td>
            </tr>
            {g.rows.map(row => {
              const isOpen = openId === row.instrument.id
              return (
                <Fragment key={row.instrument.id}>
                  <tr
                    onClick={() => setOpenId(isOpen ? null : row.instrument.id)}
                    className={`cursor-pointer border-b border-gray-200 align-top ${ROW_BG[row.state]}`}
                  >
                    <td className={`px-2 py-1.5 ${COL_ALIGN[0]}`}>{row.instrument.category}</td>
                    <td className={`px-2 py-1.5 font-medium ${COL_ALIGN[1]}`}>{row.instrument.name}</td>
                    <td className={`px-2 py-1.5 ${COL_ALIGN[2]}`}>
                      {row.display.close !== null ? (
                        <>
                          {formatPrice(row.display.close, row.instrument.currency, row.instrument.isIndex)}
                          {row.display.isManual && (
                            <span className="ml-1 text-[10px] text-blue-600">(수기)</span>
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
                          className="inline-block rounded bg-orange-200 px-2 py-0.5 text-xs font-medium text-orange-900"
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
                        <div className="text-[10px] text-gray-400">
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
                            className="inline-block rounded bg-sky-100 px-1 py-0.5 text-[10px] font-medium text-sky-800"
                            title={`평소 소스(${row.instrument.quoteSource})가 실패해 대체 소스(${row.quoteFallbackSource})로 채운 값입니다. 값 자체는 정상이지만 1차 소스를 점검해야 합니다.`}
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
                          className="text-orange-700"
                          title={`${row.instrument.currency} 환율을 받지 못해 시가총액을 계산하지 못했습니다`}
                        >
                          환율 미확보
                        </span>
                      ) : (
                        formatMarketCap(row.quote?.marketCapKrwTrillion ?? null)
                      )}
                    </td>
                    <td className={`px-2 py-1.5 ${COL_ALIGN[7]}`}>
                      <NewsCell row={row} />
                    </td>
                  </tr>
                  {isOpen && (
                    <tr>
                      <td colSpan={8} className="border-b border-gray-200 bg-slate-50">
                        <RowPanel
                          key={`${row.instrument.id}:${row.selection.chosenCandidateId}:${row.selection.chosenSummaryId}:${row.selection.decision}`}
                          runDate={runDate}
                          row={row}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </Fragment>
        ))}
      </tbody>
    </table>
  )
}
