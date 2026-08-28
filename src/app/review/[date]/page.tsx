import { getBriefRows, runStatusLabel } from '@/db/repo'
import { isValidMonthKey, monthKeyOf } from '@/domain/calendar'
import { kstDateString } from '@/domain/date'
import { AppShell } from './AppShell'
import { BriefTable } from './BriefTable'

/**
 * `force-dynamic`. 이 화면은 사이드바에서 「오늘」을 표시하려고
 * `kstDateString(new Date())` 를 읽는다. 정적으로 굳으면 그 「오늘」이 배포일에
 * 고정돼 달력이 매일 지난 날짜를 오늘이라고 가리킨다 — 루트 `/` 리다이렉트에서
 * 이미 한 번 밟은 함정과 같은 것이다.
 */
export const dynamic = 'force-dynamic'

const STATUS_BANNER_STYLE: Record<string, string> = {
  COLLECTING: 'border-info-border bg-info text-info-fg',
  READY: 'border-ok-border bg-ok text-ok-fg',
  PARTIAL: 'border-pending-border bg-pending text-pending-fg',
  FAILED: 'border-fail-border bg-fail text-fail-fg',
}

export default async function ReviewPage({ params, searchParams }: PageProps<'/review/[date]'>) {
  const { date } = await params
  const query = await searchParams

  /*
   * 달력이 보여줄 달. `?m=` 이 있으면 그 달(사용자가 달력을 넘긴 것),
   * 없으면 보고 있는 날짜의 달이다. 형식이 틀린 `?m=` 은 조용히 무시하고
   * 날짜의 달로 돌아간다 — 잘못된 값으로 빈 달력을 그리면 화면이 "이 달에는
   * 브리프가 없다"고 거짓으로 말하게 된다.
   */
  const requested = typeof query.m === 'string' && isValidMonthKey(query.m) ? query.m : null
  const monthKey = requested ?? monthKeyOf(date) ?? monthKeyOf(kstDateString(new Date()))!

  const data = await getBriefRows(date)

  return (
    <AppShell date={date} monthKey={monthKey}>
      {data === null ? (
        <main className="px-8 py-7">
          <h1 className="text-[28px] font-bold text-ink">{date} 브리프가 없습니다</h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            수집이 아직 돌지 않았습니다. 왼쪽 달력에서 브리프가 있는 날짜를 고르세요.
          </p>
        </main>
      ) : (
        <main className="px-8 py-7">
          <header className="mb-5">
            <div>
              <h1 className="text-[28px] leading-tight font-bold text-ink">주가 현황 및 뉴스</h1>
              <p className="mt-1 text-[13px] text-ink-muted">
                <span className="tabular-nums">{date}</span> · 미검토{' '}
                <span className="tabular-nums">
                  {data.rows.filter(r => r.state === 'PENDING').length}
                </span>
                건 / 전체 <span className="tabular-nums">{data.rows.length}</span>건
              </p>
            </div>

          </header>

          <div
            className={`mb-5 rounded border px-3 py-2 text-[13px] ${
              STATUS_BANNER_STYLE[data.run.status] ?? 'border-line bg-thead text-ink-muted'
            }`}
          >
            <span className="font-semibold">실행 상태: {runStatusLabel(data.run.status)}</span>
            {data.run.status === 'PARTIAL' && data.run.statusDetail && (
              <span className="ml-2">— {data.run.statusDetail}</span>
            )}
          </div>

          <BriefTable runDate={date} rows={data.rows} />
        </main>
      )}
    </AppShell>
  )
}
