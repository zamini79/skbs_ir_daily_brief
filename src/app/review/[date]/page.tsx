import { getBriefRows, runStatusLabel, type ClientRow } from '@/db/repo'
import { isValidMonthKey, monthKeyOf } from '@/domain/calendar'
import { kstDateString } from '@/domain/date'
import { countBlankNewsCells, countNewsFailed } from '@/domain/excel'
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
          <header className="mb-5 flex flex-wrap items-start justify-between gap-4">
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

            <div className="text-right">
              {/*
               * 서버가 Content-Disposition 으로 파일명을 정하므로 평범한 링크면 된다
               * (next/link 를 쓰면 클라이언트 라우팅으로 잡아채려 해서 안 된다).
               */}
              <a
                href={`/api/export/${date}`}
                className="inline-block rounded border border-btn-border bg-page px-3.5 py-2 text-[13px] font-medium text-ink hover:bg-thead"
              >
                Excel 다운로드
              </a>
              <ExportNotice rows={data.rows} />
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

/**
 * 다운로드를 막지 않는다 — 담당자가 중간 산출물을 받아볼 이유가 있다. 다만
 * **누르기 전에** 파일이 화면과 어떻게 다를지 말해 준다.
 *
 * 두 가지는 뜻도 결과도 다르므로 한 문장으로 뭉치지 않는다:
 *  - 미확정 → 뉴스 칸이 **빈다**(아직 정해지지 않았다). 「미검토」(PENDING)와
 *    「선택 무효화됨」(STALE_SELECTION)을 함께 세므로 헤더의 「미검토」 수와 다를
 *    수 있고, 그래서 라벨도 다른 말을 쓴다.
 *  - 조회 실패 → 뉴스 칸에 **「뉴스 조회 실패 — 확인 필요」가 적혀서** 나간다.
 *    그 문구는 메일 받는 사람 눈에 그대로 보이므로, 몇 건인지 알고 붙여야 한다.
 *
 * 빈 칸 수는 `countBlankNewsCells` 가 **실제로 만들어진 셀에서** 센다. 화면이
 * 파일과 다른 수를 말하면 경고가 없느니만 못하다.
 */
function ExportNotice({ rows }: { rows: ClientRow[] }) {
  const blank = countBlankNewsCells(rows)
  const newsFailed = countNewsFailed(rows)
  if (blank === 0 && newsFailed === 0) return null

  return (
    <p className="mt-1.5 max-w-[22rem] text-[11px] leading-snug text-pending-fg">
      {blank > 0 && <>미확정 {blank}건은 뉴스가 비어 있습니다.</>}
      {blank > 0 && newsFailed > 0 && ' '}
      {newsFailed > 0 && (
        <>뉴스 조회 실패 {newsFailed}건은 「뉴스 조회 실패 — 확인 필요」로 나갑니다.</>
      )}
    </p>
  )
}
