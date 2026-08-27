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
  if (!content.confirmed) {
    // PENDING 미리보기 — confirmed 확정본과 절대 같아 보이면 안 된다. 기울임체 +
    // amber 색 + "미확정" 태그 세 겹으로 표시한다. 이 중 하나만 놓쳐도(예: 태그를
    // 잘라내는 리팩터링) 나머지 두 신호가 남아 있도록 일부러 중복시켰다.
    return (
      <div className="py-0.5">
        <span className="mb-0.5 inline-block rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">
          미확정 · 1순위 후보
        </span>
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
      <colgroup>
        <col className="w-16" />
        <col className="w-40" />
        <col className="w-28" />
        <col className="w-24" />
        <col className="w-16" />
        <col className="w-20" />
        <col className="w-24" />
        <col />
      </colgroup>
      <thead>
        <tr className="border-b border-gray-300 text-left text-xs text-gray-500">
          <th className="px-2 py-1">구분</th>
          <th className="px-2 py-1">기업</th>
          <th className="px-2 py-1">주가</th>
          <th className="px-2 py-1">전일대비</th>
          <th className="px-2 py-1">%</th>
          <th className="px-2 py-1">연초대비</th>
          <th className="px-2 py-1">시가총액(조원)</th>
          <th className="px-2 py-1">뉴스</th>
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
                    <td className="px-2 py-1.5">{row.instrument.category}</td>
                    <td className="px-2 py-1.5 font-medium">{row.instrument.name}</td>
                    <td className="px-2 py-1.5">
                      {row.display.close !== null ? (
                        <>
                          {formatPrice(row.display.close, row.instrument.currency, row.instrument.isIndex)}
                          {row.display.isManual && (
                            <span className="ml-1 text-[10px] text-blue-600">(수기)</span>
                          )}
                        </>
                      ) : (
                        '-'
                      )}
                      {row.quote?.asOf && (
                        <div className="text-[10px] text-gray-400">기준 {row.quote.asOf}</div>
                      )}
                    </td>
                    {/* formatPrevDiff가 close/prevClose null 여부와 보합(0)을 각각 다른
                       문자열로 처리하므로 여기서 다시 분기하지 않는다. */}
                    <td className="px-2 py-1.5">{formatPrevDiff(row.display.close, row.display.prevClose)}</td>
                    <td className="px-2 py-1.5">{pct(row.display.changePct)}</td>
                    <td className="px-2 py-1.5">{pct(row.quote?.ytdPct ?? null)}</td>
                    {/* 시총 공란의 이유를 아는 경우에만 표시한다. 환율 미확보는 해외사에만
                        해당하고(국내는 네이버가 시총을 직접 준다), 지수와 "이유를 모르는
                        공란"에는 아무 표시도 하지 않는다 — marketCapBlankReason 참조. */}
                    <td className="px-2 py-1.5">
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
                    <td className="px-2 py-1.5">
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
