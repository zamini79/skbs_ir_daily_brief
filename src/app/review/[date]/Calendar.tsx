import Link from 'next/link'
import { monthGrid, monthTitle, shiftMonth, WEEKDAY_LABELS } from '@/domain/calendar'
import { type BriefDateEntry, type BriefDayMark } from '@/db/repo'

/**
 * 사이드바의 월 달력.
 *
 * 서버 컴포넌트다. 월 이동은 `?m=YYYY-MM` 쿼리를 바꾸는 링크이고, 어느 날짜에
 * 브리프가 있는지는 그 달을 서버에서 조회해 넘겨받는다 — 클라이언트 상태도
 * 추가 fetch 도 없다. 새로고침해도, 링크를 복사해 붙여도 같은 달이 열린다.
 *
 * **이 달력의 유일한 일은 "누르기 전에 알려주는 것"이다.** 브리프가 없는 날짜는
 * 링크가 아니다(눌러도 아무 일이 없는 것보다 아예 누를 수 없는 편이 정직하다).
 * 있는 날짜도 완료/부분 완료/수집 중/실패를 점 색으로 갈라 두고, 그 달에 실제로
 * 나타난 표시만 아래 범례에 적는다.
 *
 * 「수집 중」은 **두 가지**로 갈린다(`STALLED`). 상태 문자열은 둘 다 `COLLECTING`
 * 이지만, 몇 달 전에 죽은 실행을 오늘 아침에 시작한 실행과 같은 점으로 그리면
 * 달력이 거짓말을 한다 — 그것도 담당자가 그 날짜를 열어 보지 않으므로 오래 사는
 * 거짓말이다. 점 색과 글자를 **둘 다** 가른다(`briefDayMarkLabel`).
 */

const MARK_DOT: Record<BriefDayMark, string> = {
  DONE: 'bg-mark-done',
  PARTIAL: 'bg-mark-partial',
  RUNNING: 'bg-mark-running',
  STALLED: 'bg-mark-stalled',
  FAILED: 'bg-mark-failed',
  UNKNOWN: 'bg-mark-unknown',
}

export function Calendar({
  monthKey,
  selected,
  today,
  entries,
}: {
  monthKey: string
  /** 지금 보고 있는 날짜(URL). 이 달이 아닐 수도 있다 — 그때는 채운 칸이 없다. */
  selected: string
  /** KST 오늘. 호출자가 구해서 넘긴다(domain/calendar.ts 는 시간대를 모른다). */
  today: string
  entries: BriefDateEntry[]
}) {
  const weeks = monthGrid(monthKey)
  const byDate = new Map(entries.map(e => [e.date, e]))

  // 이 달에 실제로 나타난 표시만 범례에 적는다. 쓰지도 않은 색을 나열하면
  // 280px 사이드바에서 범례가 달력보다 커진다.
  const legend: Array<{ mark: BriefDayMark; label: string }> = []
  for (const e of entries) {
    if (legend.some(l => l.mark === e.mark)) continue
    legend.push({ mark: e.mark, label: e.label })
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <MonthNavLink date={selected} monthKey={shiftMonth(monthKey, -1)} label="이전 달">
          ◀
        </MonthNavLink>
        <span className="text-[13px] font-medium text-white">{monthTitle(monthKey)}</span>
        <MonthNavLink date={selected} monthKey={shiftMonth(monthKey, 1)} label="다음 달">
          ▶
        </MonthNavLink>
      </div>

      <div className="grid grid-cols-7 gap-y-0.5 text-center">
        {WEEKDAY_LABELS.map(w => (
          <div key={w} className="pb-1 text-[10px] text-sidebar-label">
            {w}
          </div>
        ))}

        {weeks.flat().map((cell, i) => {
          if (cell === null) return <div key={`blank-${i}`} />

          const entry = byDate.get(cell.date) ?? null
          const isSelected = cell.date === selected
          const isToday = cell.date === today

          // 브리프가 없는 날짜: 링크가 아니다. 흐린 글자 + 커서 기본 + title 로
          // "여기엔 없다"를 누르기 전에 말한다. 주말은 한 단계 더 흐리다
          // (수집이 평일에만 돈다 — 비어 있는 게 정상이라는 뜻이다).
          if (entry === null) {
            return (
              <div
                key={cell.date}
                title={`${cell.date} · 브리프 없음`}
                className={`mx-auto flex h-7 w-7 items-center justify-center rounded text-[12px] ${
                  cell.weekend ? 'text-sidebar-label/50' : 'text-sidebar-label'
                } ${isToday ? 'border border-sidebar-label' : ''}`}
              >
                {cell.day}
              </div>
            )
          }

          return (
            <Link
              key={cell.date}
              href={`/review/${cell.date}`}
              title={`${cell.date} · ${entry.label}`}
              className={`relative mx-auto flex h-7 w-7 items-center justify-center rounded text-[12px] ${
                isSelected
                  ? 'bg-sidebar-fg font-bold text-sidebar'
                  : `text-white hover:bg-sidebar-active ${isToday ? 'border border-sidebar-fg' : ''}`
              }`}
            >
              {cell.day}
              <span
                aria-hidden
                className={`absolute bottom-0.5 h-1 w-1 rounded-full ${MARK_DOT[entry.mark]}`}
              />
            </Link>
          )
        })}
      </div>

      <ul className="mt-3 space-y-1 text-[10px] text-sidebar-label">
        {legend.map(l => (
          <li key={l.mark} className="flex items-center gap-1.5">
            <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${MARK_DOT[l.mark]}`} />
            {l.label}
          </li>
        ))}
        <li>흐린 날짜 — 브리프 없음</li>
      </ul>
    </div>
  )
}

function MonthNavLink({
  date,
  monthKey,
  label,
  children,
}: {
  date: string
  monthKey: string
  label: string
  children: React.ReactNode
}) {
  return (
    <Link
      href={`/review/${date}?m=${monthKey}`}
      aria-label={label}
      className="rounded px-1.5 py-0.5 text-[11px] text-sidebar-fg hover:bg-sidebar-active hover:text-white"
    >
      {children}
    </Link>
  )
}
