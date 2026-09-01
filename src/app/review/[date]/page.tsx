import { getBriefRows, getCollectTarget, runStatusLabel, type ClientRow } from '@/db/repo'
import { isValidMonthKey, monthKeyOf } from '@/domain/calendar'
import { kstDateString } from '@/domain/date'
import { countBlankNewsCells, countNewsFailed } from '@/domain/excel'
import {
  PROGRESS_POLL_MS,
  formatElapsed,
  progressHeadline,
  runProgressView,
  shouldPollProgress,
  stalledNotice,
  type RunProgressView,
} from '@/domain/runProgress'
import { AppShell } from './AppShell'
import { BriefTable } from './BriefTable'
import { CollectButton } from './CollectButton'
import { ProgressPoller } from './ProgressPoller'

/**
 * `force-dynamic`. 이 화면은 사이드바에서 「오늘」을 표시하려고
 * `kstDateString(new Date())` 를 읽는다. 정적으로 굳으면 그 「오늘」이 배포일에
 * 고정돼 달력이 매일 지난 날짜를 오늘이라고 가리킨다 — 루트 `/` 리다이렉트에서
 * 이미 한 번 밟은 함정과 같은 것이다.
 *
 * 수집 진행 표시도 여기에 기대고 있다. 폴링이 다시 읽어 오는 것은 이 서버
 * 컴포넌트이고, 캐시되면 4초마다 같은 문구를 다시 그린다.
 */
export const dynamic = 'force-dynamic'

/**
 * 실행 상태 배너의 색.
 *
 * **`COLLECTING` 하나에 두 칸이 있다.** 상태 문자열은 같지만 「지금 돌고 있다」와
 * 「도는 중인 채로 멈춰 있다」는 담당자가 할 일이 정반대다(기다린다 / 다시 돌린다).
 * 색까지 같으면 훑어보는 화면에서 그 둘이 완전히 같아진다 — 이 코드베이스가
 * 반복해서 고쳐 온 결함이다.
 */
const STATUS_BANNER_STYLE: Record<string, string> = {
  COLLECTING: 'border-info-border bg-info text-info-fg',
  COLLECTING_STALLED: 'border-pending-border bg-pending text-pending-fg',
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

  const now = new Date()
  /*
   * 수집 버튼은 **보고 있는 날짜가 아니라 오늘** 자로 돈다(CollectButton 주석 참고).
   * 그래서 버튼이 알아야 하는 사실(이미 도는 중인가 / 무효화될 선택이 몇 건인가)도
   * 오늘 날짜의 것을 읽는다 — 보고 있는 날짜의 것을 쓰면 실제로 덮어써질 날짜와
   * 다른 날짜에 대해 경고하게 된다.
   */
  const today = kstDateString(now)
  const [data, target] = await Promise.all([getBriefRows(date), getCollectTarget(today)])

  const targetView = runProgressView({
    status: target.run?.status ?? '',
    startedAtMs: target.run?.startedAtMs ?? 0,
    nowMs: now.getTime(),
    progressDetail: target.run?.progressDetail ?? null,
  })

  const collectButton = (
    <CollectButton
      targetDate={today}
      viewingDate={date}
      view={targetView}
      decidedRows={target.decidedRows}
    />
  )

  // 보고 있는 날짜의 진행. 위 targetView(오늘 자)와 다른 값일 수 있다 —
  // 지난 날짜를 열어 둔 채 오늘 수집을 돌리는 경우가 그렇다.
  const view: RunProgressView =
    data === null
      ? { kind: 'IDLE' }
      : runProgressView({
          status: data.run.status,
          startedAtMs: data.run.startedAtMs,
          nowMs: now.getTime(),
          progressDetail: data.run.progressDetail,
        })

  return (
    <AppShell date={date} monthKey={monthKey}>
      {data === null ? (
        <main className="px-8 py-7">
          <h1 className="text-[28px] font-bold text-ink">{date} 브리프가 없습니다</h1>
          <p className="mt-1 text-[13px] text-ink-muted">
            수집이 아직 돌지 않았습니다. 왼쪽 달력에서 브리프가 있는 날짜를 고르거나, 아래에서 직접 수집을 돌리세요.
          </p>
          {/* 브리프가 없는 날짜야말로 버튼이 가장 필요한 화면이다 — 크론이 없는
              배포에서 담당자가 처음 마주치는 화면이 바로 여기다. */}
          <div className="mt-4">{collectButton}</div>
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

            <div className="flex flex-wrap items-start justify-end gap-3 text-right">
              {collectButton}

              <div>
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
            </div>
          </header>

          <StatusBanner
            status={data.run.status}
            statusDetail={data.run.statusDetail}
            view={view}
            rerunnable={date === today}
          />

          {/* 폴링은 도는 중일 때만 붙는다 — 마운트 자체가 조건이다(ProgressPoller 주석). */}
          {shouldPollProgress(view) && <ProgressPoller intervalMs={PROGRESS_POLL_MS} />}

          <BriefTable runDate={date} rows={data.rows} />
        </main>
      )}
    </AppShell>
  )
}

/**
 * 실행 상태 배너.
 *
 * 세 갈래다. **`COLLECTING` 이 두 갈래로 나뉘는 것이 이 컴포넌트의 요점이다** —
 * 죽은 프로세스가 남긴 행은 지금 돌고 있는 실행과 상태 문자열이 같아서, 색·머리말·
 * 문구를 모두 갈라 놓지 않으면 화면이 "돌고 있다"고 **단정**한다. 우리가 아는 것은
 * "COLLECTING 인 채로 이만큼 지났다"뿐이므로 그 사실만 말하고 판단은 담당자에게 준다.
 */
function StatusBanner({
  status,
  statusDetail,
  view,
  rerunnable,
}: {
  status: string
  statusDetail: string | null
  view: RunProgressView
  /** 이 날짜를 「수집 실행」으로 다시 돌릴 수 있는가 = 보고 있는 날짜가 오늘인가. */
  rerunnable: boolean
}) {
  const styleKey = view.kind === 'STALLED' ? 'COLLECTING_STALLED' : status
  const headline = view.kind === 'IDLE' ? runStatusLabel(status) : progressHeadline(view.kind)

  return (
    <div
      className={`mb-5 rounded border px-3 py-2 text-[13px] ${
        STATUS_BANNER_STYLE[styleKey] ?? 'border-line bg-thead text-ink-muted'
      }`}
    >
      <span className="font-semibold">실행 상태: {headline}</span>

      {/*
       * 완료 사유. 진행 문구와 칸이 나뉘어 있어 서로 덮어쓰지 않는다(BriefRun.progressDetail).
       * FAILED 도 함께 보여준다 — 예외로 끝난 실행은 사유가 여기에만 남고(collect.ts 의
       * markRunFailed), 그걸 감추면 배너가 「실패」라고만 말하고 왜인지는 말하지 않는다.
       *
       * **READY 도 보여준다.** 예전에는 READY 면 statusDetail 이 항상 null 이라 조건에
       * 넣을 이유가 없었는데, 지금은 「실패는 아니지만 그날 있었던 일」이 여기 적힌다
       * (요약 API 가 붐벼 재시도를 포기한 횟수 — collectHelpers 의 buildStatusDetail).
       * 그런 날 배너를 노랑으로 낮추지는 않는다(담당자가 할 일이 없다). 다만 **적히기는
       * 해야** 다음 사람이 예산 값을 조정할 근거를 갖는다. 조건에서 빼면 그 문장이
       * DB 에만 남고 화면에서는 사라진다.
       */}
      {view.kind === 'IDLE' && statusDetail && (
        <span className="ml-2">— {statusDetail}</span>
      )}

      {view.kind === 'RUNNING' && (
        <span className="ml-2">
          {view.detail ?? '진행 단계가 아직 기록되지 않았습니다'}
          {/*
           * 진행 문구가 몇 초째 같아도 시간이 흐르는 것은 보여야 한다 — 멈춘 화면과
           * 느린 단계를 담당자가 구분할 수 있는 단서다. stalledNotice 와 같은
           * 포맷터를 쓴다: 두 배너가 경과 시간을 다른 말로 적으면 같은 값을 보고도
           * 다른 이야기로 읽힌다.
           */}
          <span className="ml-2 text-[12px] opacity-80">({formatElapsed(view.elapsedMs)} 경과)</span>
        </span>
      )}

      {view.kind === 'STALLED' && (
        <div className="mt-1 space-y-0.5">
          <p>{stalledNotice(view.elapsedMs)}</p>
          {/* 마지막으로 도달한 단계. 없으면 없다고 말한다 — 어디서 멈췄는지
              지어내지 않는다(이 실행이 진행 표시가 생기기 전 것일 수도 있다). */}
          <p className="text-[12px] opacity-90">
            {view.detail !== null
              ? `마지막 진행: ${view.detail}`
              : '마지막 진행 기록이 없습니다.'}
          </p>
          {/*
            * 다시 돌릴 수 있는지는 **날짜에 따라 다르다.** 수집은 항상 오늘 자로
            * 돌기 때문에 지난 날짜의 멈춘 실행은 되살릴 방법이 없다. 그 사실을
            * 말하지 않고 「다시 돌릴 수 있습니다」라고만 적으면, 담당자는 버튼을
            * 누르고 나서 엉뚱한 날짜가 갱신되는 것을 보게 된다.
            */}
          <p className="text-[12px] opacity-90">
            {rerunnable
              ? '실제로 돌고 있는지는 알 수 없습니다. 「수집 실행」으로 다시 돌릴 수 있습니다.'
              : '실제로 돌고 있는지는 알 수 없습니다. 지난 날짜는 다시 수집할 수 없습니다 — 시세 소스가 직전 영업일 종가만 주기 때문입니다.'}
          </p>
        </div>
      )}
    </div>
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
