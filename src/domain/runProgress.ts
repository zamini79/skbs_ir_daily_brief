/**
 * 수집 실행의 **진행**을 다루는 순수 함수들. 두 방향을 한 파일에 둔다:
 *
 *  - 쓰는 쪽 (`formatProgress`) — 파이프라인이 단계마다 남기는 한 줄.
 *  - 읽는 쪽 (`runProgressView`) — 화면이 그 한 줄과 `startedAt` 을 보고
 *    「도는 중」인지 「멈춘 것으로 보이는지」를 가른다.
 *
 * 둘을 갈라 두면 문구 어휘가 두 벌이 된다. 한쪽이 「요약 생성 중 (31/47)」을 쓰는데
 * 다른 쪽이 그 형식을 모르면, 화면이 진행 문구를 못 알아보고 "알 수 없음"으로
 * 떨어뜨리는 날이 온다.
 *
 * **`BriefRun.statusDetail` 과 섞지 않는다.** 그 칸은 완료 사유(「요약 3건 실패…」)
 * 전용이고, 진행 문구는 `BriefRun.progressDetail` 이라는 별도 칸에 쓴다. 한 칸을
 * 둘이 나눠 쓰면 진행 문구가 지난 실행의 실패 사유를 덮거나(사유가 사라진다),
 * 완료 시점의 사유가 진행 문구로 읽힌다(끝난 실행이 도는 것처럼 보인다).
 */

/* ------------------------------------------------------------------ *
 * 쓰는 쪽 — 단계 문구
 * ------------------------------------------------------------------ */

/**
 * 파이프라인 단계. `collect.ts` 의 실제 실행 순서와 같은 순서로 적는다
 * (환율 → 시세 → 연초 기준가 → 시세 저장 → 뉴스 → 요약 → 마무리).
 */
export const COLLECTION_STEPS = [
  'fx',
  'quote',
  'ytdBase',
  'quoteSave',
  'news',
  'summary',
  'finish',
] as const

export type CollectionStep = (typeof COLLECTION_STEPS)[number]

const STEP_LABEL: Record<CollectionStep, string> = {
  fx: '환율 수집 중',
  quote: '시세 수집 중',
  ytdBase: '연초 기준가 조회 중',
  quoteSave: '시세 저장 중',
  news: '뉴스 수집 중',
  summary: '요약 생성 중',
  finish: '마무리 중',
}

/**
 * 진행 한 줄을 만든다.
 *
 * **건수는 실제로 센 값일 때만 붙인다.** `counted` 를 주지 않으면 단계 이름만
 * 나온다 — 그 단계에 셀 수 있는 단위가 없다는 뜻이다(예: 환율은 1회 호출이고,
 * `fetchAllQuotes` 는 배치라 중간 진행을 알려주지 않는다). 모르는 숫자를 지어내
 * 붙이면 담당자가 그 숫자로 남은 시간을 가늠하게 되는데, 그 근거가 없다.
 *
 * `total <= 0` 도 같은 이유로 숫자를 빼고 단계 이름만 남긴다. 「요약 생성 중 (0/0)」은
 * 진행이 멈춘 것처럼 읽히지만 실제로는 **셀 대상이 애초에 없다**는 뜻이라
 * (오늘 후보가 0건인 날) 서로 다른 사실이 같은 화면으로 수렴한다.
 */
export function formatProgress(step: CollectionStep, counted?: { done: number; total: number }): string {
  const label = STEP_LABEL[step]
  if (counted === undefined || counted.total <= 0) return label
  return `${label} (${counted.done}/${counted.total})`
}

/* ------------------------------------------------------------------ *
 * 읽는 쪽 — 멈춘 것으로 보이는가
 * ------------------------------------------------------------------ */

/**
 * **요약 단계의 마감 시한.** 이 시간이 지나면 파이프라인은 새 요약을 시작하지 않고
 * 정상 종료 경로로 빠져나가 상태와 카운터를 기록한다(`collect.ts`).
 *
 * 플랫폼이 죽이기를 기다리지 않고 **스스로 멈추는 것**이 요점이다. 서버리스가
 * 하드 킬하면 `runCollection` 의 catch 가 돌지 못해 `BriefRun` 이 `COLLECTING` 인
 * 채로 남고, 카운터는 하나도 기록되지 않으며, 절반쯤 저장된 후보 행이 화면에
 * 정상처럼 보인다 — 이 저장소가 반복해서 고쳐 온 「부분 실패가 정상값처럼 보이는」
 * 결함 그 자체다. 마감은 그 **조용한 죽음을 큰 소리의 부분 완료로** 바꾼다.
 *
 * 근거: 감속 이후 실측이 **457.7초**다(2026-09-01, 후보 37건, 요약 실패 0).
 * 20분은 그 2.6배라 후보가 오늘보다 훨씬 많은 날에도 여유가 있고, 요청 상한이 긴
 * 호스트(사내 crontab·Render 100분)에는 한참 못 미친다.
 *
 * 시세·환율·뉴스 단계에는 걸지 않는다. 그 단계들은 짧고, 잘리면 표 자체가 비어
 * 브리프가 무의미해진다 — 마감으로 지킬 값이 없다.
 */
export const SUMMARY_DEADLINE_MS = 20 * 60 * 1000

/**
 * 이 시간이 지나도록 `COLLECTING` 인 실행은 **「멈춘 것으로 보인다」**고 말한다.
 *
 * **이 값은 `SUMMARY_DEADLINE_MS` 보다 반드시 커야 한다. 두 상수를 같이 읽어라.**
 * 이 임계값은 화면 문구만 정하는 것이 아니라 `claimRun`(review/[date]/actions.ts)의
 * **선점 조건으로도 쓰인다** — `startedAt <= now - STALLED_AFTER_MS` 면 도는 중인
 * 실행도 빼앗는다. 살아 있는 실행이 이 선을 넘을 수 있으면, 담당자가 「수집 실행」을
 * 눌렀을 때 선점이 성공해 **같은 날짜에 두 수집이 동시에 돌고 서로의 후보를 지우며
 * 덮어쓴다**(docs/운영.md). 마감이 20분이면 살아 있는 실행은 스스로 끝나므로,
 * 임계값이 마감보다 크기만 하면 그 상태가 **구조적으로** 생기지 않는다.
 * 이 불변식은 테스트가 지킨다(runProgress.test.ts).
 *
 * 근거: 감속 이후 실측 **457.7초**(2026-09-01, 후보 37건). 30분은 그 3.9배이고
 * 마감 20분에 10분의 여유를 둔 값이다.
 * (감속 이전 실측은 202초였다 — 2026-08-27, 동시성 4·간격 0·타임아웃 60초 시절.
 * 그때의 근거였던 「15분 = 202초의 4.4배」는 그대로 두면 마감보다 작아져 위 불변식이
 * 깨진다. 옛 값을 남겨 두는 것은 감속의 대가를 보여 주는 기록이기 때문이다.)
 *
 * **이 값을 실측치 가까이 낮추지 마라.** 멀쩡히 도는 실행에 「중단됐을 수 있습니다」가
 * 붙으면 담당자가 그 문구를 무시하는 법을 배우고, 그러면 진짜로 죽은 날에도 무시한다.
 */
export const STALLED_AFTER_MS = 30 * 60 * 1000

/**
 * 화면이 실행 상태에 대해 말할 수 있는 것.
 *
 * `IDLE` 은 "도는 중이 아니다"이지 "끝났다"가 아니다 — 끝난 실행의 결과는
 * `status`/`statusDetail` 이 말한다. 여기서는 진행에 대해 할 말이 없다는 뜻이다.
 */
export type RunProgressView =
  | { kind: 'IDLE' }
  | { kind: 'RUNNING'; detail: string | null; elapsedMs: number }
  | { kind: 'STALLED'; detail: string | null; elapsedMs: number }

/**
 * 실행 하나에 대해 진행을 어떻게 말할지 정한다.
 *
 * **경계는 `>=` 다** — 정확히 임계 시간이면 STALLED 다. 어느 쪽인지 코드로 못 읽으면
 * 테스트가 못 고정하고, 못 고정하면 리팩터링이 조용히 뒤집는다.
 *
 * 경과 시간은 음수가 되지 않게 자른다. 서버와 DB 의 시계가 몇 초 어긋나면
 * `startedAt` 이 미래로 보일 수 있는데, 「-1분 경과」는 담당자에게 아무 뜻이 없다.
 */
export function runProgressView(run: {
  status: string
  startedAtMs: number
  nowMs: number
  progressDetail: string | null
}): RunProgressView {
  if (run.status !== 'COLLECTING') return { kind: 'IDLE' }
  const elapsedMs = Math.max(0, run.nowMs - run.startedAtMs)
  const kind = elapsedMs >= STALLED_AFTER_MS ? 'STALLED' : 'RUNNING'
  return { kind, detail: run.progressDetail, elapsedMs }
}

/**
 * 화면이 주기적으로 새로고침해야 하는가.
 *
 * `RUNNING` 일 때만 참이다. 끝난 실행(IDLE)을 계속 두드리지 않는 것은 물론이고,
 * **멈춘 것으로 보이는 실행(STALLED)도 두드리지 않는다** — 그 화면은 몇 초 뒤에도
 * 같은 값이다. 폴링은 "곧 바뀔 것"이라는 근거가 있을 때만 한다.
 */
export function shouldPollProgress(view: RunProgressView): boolean {
  return view.kind === 'RUNNING'
}

/** 폴링 간격. 실측 457.7초짜리 작업이라(2026-09-01, 감속 이전에는 202초였다)
 *  4초면 단계 전환을 놓치지 않는다. */
export const PROGRESS_POLL_MS = 4000

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * 경과 시간을 사람이 읽는 말로 바꾼다.
 *
 * 분으로만 적으면 며칠 묵은 행이 「7,215분 경과」가 되어 담당자가 그 숫자를
 * 한 번 더 계산해야 한다. 큰 단위 둘까지만 적는다 — 「5일 3시간」이면 충분하고
 * 초까지 적어도 판단이 달라지지 않는다.
 */
export function formatElapsed(ms: number): string {
  const clamped = Math.max(0, ms)
  if (clamped < MINUTE) return '1분 미만'
  if (clamped < HOUR) return `${Math.floor(clamped / MINUTE)}분`
  if (clamped < DAY) {
    const h = Math.floor(clamped / HOUR)
    const m = Math.floor((clamped % HOUR) / MINUTE)
    return m === 0 ? `${h}시간` : `${h}시간 ${m}분`
  }
  const d = Math.floor(clamped / DAY)
  const h = Math.floor((clamped % DAY) / HOUR)
  return h === 0 ? `${d}일` : `${d}일 ${h}시간`
}

/**
 * 멈춘 것으로 보이는 실행에 붙일 문구.
 *
 * **단정하지 않는다.** 우리는 그 프로세스가 죽었는지 모른다 — 아는 것은
 * "COLLECTING 인 채로 이만큼 지났다"뿐이고, 판단은 담당자가 한다. 그래서
 * 「중단됐습니다」가 아니라 「중단됐을 수 있습니다」이고, 경과 시간을 함께 준다.
 */
export function stalledNotice(elapsedMs: number): string {
  return `수집이 시작된 지 ${formatElapsed(elapsedMs)} 지났습니다. 중단됐을 수 있습니다.`
}

/**
 * 진행 배너의 머리말.
 *
 * **STALLED 가 RUNNING 과 같은 말을 쓰면 안 된다.** 이 코드베이스가 반복해서
 * 고쳐 온 결함이 정확히 그것이다 — 죽은 실행이 도는 실행과 똑같이 「수집 중」으로
 * 렌더된다. 상태 문자열은 둘 다 `COLLECTING` 이므로 구분은 이 문구와 색이 진다.
 */
export function progressHeadline(kind: RunProgressView['kind']): string {
  switch (kind) {
    case 'RUNNING':
      return '수집 중'
    case 'STALLED':
      return '수집 중 상태로 멈춰 있음'
    case 'IDLE':
      return ''
  }
}
