'use client'

import { Fragment, useState } from 'react'
import { formatPrice, formatPrevDiff } from '@/domain/format'
import { groupByCategory, rowStateLabel, type ClientRow, type RowState } from '@/db/repo'
import { RowPanel } from './RowPanel'

/** 네 가지 행 상태를 한눈에 구분할 수 있도록 서로 다른 배경/배지 색을 준다. */
const ROW_BG: Record<RowState, string> = {
  NO_NEWS: 'bg-gray-50 text-gray-400',
  OMITTED: 'bg-gray-100 text-gray-500',
  PENDING: 'bg-amber-50',
  SELECTED: 'bg-white',
}
const BADGE_STYLE: Record<RowState, string> = {
  NO_NEWS: 'bg-gray-200 text-gray-500',
  OMITTED: 'bg-gray-300 text-gray-700',
  PENDING: 'bg-amber-200 text-amber-900',
  SELECTED: 'bg-emerald-200 text-emerald-900',
}

function pct(v: number | null): string {
  if (v === null) return '-'
  return `${(v * 100).toFixed(2)}%`
}

export function BriefTable({ runDate, rows }: { runDate: string; rows: ClientRow[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const groups = groupByCategory(rows)

  return (
    <table className="w-full border-collapse text-sm">
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
                    className={`cursor-pointer border-b border-gray-200 ${ROW_BG[row.state]}`}
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
                    <td className="px-2 py-1.5">
                      {row.display.close !== null && row.display.prevClose !== null
                        ? formatPrevDiff(row.display.close, row.display.prevClose)
                        : '-'}
                    </td>
                    <td className="px-2 py-1.5">{pct(row.display.changePct)}</td>
                    <td className="px-2 py-1.5">{pct(row.quote?.ytdPct ?? null)}</td>
                    <td className="px-2 py-1.5">
                      {row.quote?.marketCapKrwTrillion != null
                        ? row.quote.marketCapKrwTrillion.toFixed(1)
                        : '-'}
                    </td>
                    <td className="px-2 py-1.5">
                      <span className={`rounded px-2 py-0.5 text-xs ${BADGE_STYLE[row.state]}`}>
                        {rowStateLabel(row.state)}
                      </span>
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
