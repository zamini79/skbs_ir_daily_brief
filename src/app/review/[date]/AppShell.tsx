import type { ReactNode } from 'react'
import Link from 'next/link'
import { kstDateString } from '@/domain/date'
import { isValidDateString, weekdayLabelOf } from '@/domain/calendar'
import {
  adjacentBriefDates,
  listBriefDates,
  listRecentBriefDates,
  runStatusLabel,
  type BriefDayMark,
} from '@/db/repo'
import { Calendar } from './Calendar'

/**
 * 왼쪽 메뉴 / 오른쪽 내용 셸.
 *
 * **왜 `layout.tsx` 가 아니라 페이지에서 감싸는가.** 달력의 월 이동은 `?m=YYYY-MM`
 * 쿼리로 상태를 들고 있는데, App Router 의 layout 은 `searchParams` 를 받지 않는다
 * (page 만 받는다). layout 에 사이드바를 두면 달력이 자기 상태를 읽을 방법이
 * 클라이언트 상태 + 월별 추가 fetch 밖에 없어진다. 셸을 페이지에서 감싸면 링크
 * 하나로 끝나고 클라이언트 자바스크립트가 0 이다. 지금 이 셸 안에 들어가는 화면은
 * `/review/[date]` 하나뿐이라(루트 `/` 는 리다이렉트만 한다) 중복도 생기지 않는다.
 *
 * 사이드바에 **메뉴 항목을 지어내지 않는다.** 이 시스템에는 아직 브리프 화면
 * 하나뿐이라, 눌러도 아무 일이 없는 메뉴를 그리는 것은 빈 사이드바보다 나쁘다.
 * 날짜 네비게이션이 곧 메뉴다.
 */

const MARK_DOT: Record<BriefDayMark, string> = {
  DONE: 'bg-mark-done',
  PARTIAL: 'bg-mark-partial',
  RUNNING: 'bg-mark-running',
  FAILED: 'bg-mark-failed',
  UNKNOWN: 'bg-mark-unknown',
}

const RECENT_LIMIT = 6

export async function AppShell({
  date,
  monthKey,
  children,
}: {
  date: string
  monthKey: string
  children: ReactNode
}) {
  const [monthEntries, recent, adjacent] = await Promise.all([
    listBriefDates(monthKey),
    listRecentBriefDates(RECENT_LIMIT),
    adjacentBriefDates(date),
  ])

  const today = kstDateString(new Date())

  return (
    <div className="flex min-h-screen bg-page">
      <aside className="sticky top-0 flex h-screen w-[280px] shrink-0 flex-col overflow-y-auto bg-sidebar px-5 py-6">
        <div>
          <div className="text-[15px] font-bold text-white">IR Daily Brief</div>
          <div className="mt-0.5 text-[11px] tracking-[0.14em] text-sidebar-label uppercase">
            Daily Market &amp; News Brief
          </div>
        </div>

        <div className="mt-7">
          <div className="text-[10px] tracking-[0.12em] text-sidebar-label uppercase">보고 있는 날짜</div>
          <div className="mt-1 text-[20px] font-bold text-white">
            {date}
            {isValidDateString(date) && (
              <span className="ml-1.5 text-[13px] font-normal text-sidebar-fg">
                ({weekdayLabelOf(date)})
              </span>
            )}
          </div>
          {/*
           * 하루씩 움직이지 않는다 — 수집은 평일에만 돌아서 하루씩 넘기면
           * 주말마다 「브리프 없음」에 떨어진다. 실제 데이터가 있는 이웃 날짜로
           * 건너뛰고, 없으면 링크가 아니라 흐린 글자다(누르기 전에 알 수 있다).
           */}
          <div className="mt-2 flex gap-1.5">
            <StepLink to={adjacent.prev} label="◀ 이전" empty="◀ 이전 없음" />
            <StepLink to={adjacent.next} label="다음 ▶" empty="다음 없음 ▶" />
          </div>
        </div>

        <div className="mt-6">
          <Calendar monthKey={monthKey} selected={date} today={today} entries={monthEntries} />
        </div>

        <div className="mt-7">
          <div className="text-[10px] tracking-[0.12em] text-sidebar-label uppercase">최근 브리프</div>
          <ul className="mt-2 space-y-0.5">
            {recent.length === 0 && (
              <li className="py-1 text-[12px] text-sidebar-label">아직 수집된 브리프가 없습니다.</li>
            )}
            {recent.map(r => {
              const active = r.date === date
              return (
                <li key={r.date}>
                  <Link
                    href={`/review/${r.date}`}
                    className={`flex items-center gap-2 rounded px-2 py-1.5 text-[14px] ${
                      active ? 'bg-sidebar-active text-white' : 'text-sidebar-fg hover:bg-sidebar-active'
                    }`}
                  >
                    <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${MARK_DOT[r.mark]}`} />
                    <span className="tabular-nums">{r.date}</span>
                    {/* 상태를 점 색에만 맡기지 않는다. 「부분 완료」가 「준비 완료」와
                        같아 보이면 안 되는데 색만으로는 훑을 때 놓치기 쉽다. */}
                    <span className="ml-auto text-[11px] text-sidebar-label">
                      {runStatusLabel(r.status)}
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      </aside>

      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function StepLink({ to, label, empty }: { to: string | null; label: string; empty: string }) {
  if (to === null) {
    return (
      <span className="rounded border border-sidebar-active px-2 py-1 text-[11px] text-sidebar-label/60">
        {empty}
      </span>
    )
  }
  return (
    <Link
      href={`/review/${to}`}
      className="rounded border border-sidebar-active px-2 py-1 text-[11px] text-sidebar-fg hover:bg-sidebar-active hover:text-white"
    >
      {label}
    </Link>
  )
}
