'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/db/client'
import { kstDateString } from '@/domain/date'
import { STALLED_AFTER_MS } from '@/domain/runProgress'
import { runCollection } from '@/pipeline/collect'
import { briefRunStartData } from '@/pipeline/collectHelpers'

async function updateSelection(
  runDate: string,
  instrumentId: string,
  data: Record<string, unknown>,
) {
  const run = await prisma.briefRun.findUniqueOrThrow({ where: { runDate } })
  await prisma.selection.upsert({
    where: { runId_instrumentId: { runId: run.id, instrumentId } },
    update: data,
    create: { runId: run.id, instrumentId, decision: 'PENDING', ...data },
  })
  revalidatePath(`/review/${runDate}`)
}

/**
 * 뉴스 후보를 고른다. summaryId 는 아직 요약을 고르지 않았으면 null 로 둘 수 있다
 * (예: summaryError 로 요약이 아예 없는 후보를 제목만 보고 고른 경우).
 * 후보를 다시 고르면 이전에 담당자가 직접 고친 텍스트(editedText)는 더 이상
 * 유효하지 않으므로 비운다.
 */
export async function selectNews(
  runDate: string,
  instrumentId: string,
  candidateId: string,
  summaryId: string | null,
) {
  await updateSelection(runDate, instrumentId, {
    decision: 'SELECTED',
    chosenCandidateId: candidateId,
    chosenSummaryId: summaryId,
    editedText: null,
  })
}

/** 후보가 있어도 담당자가 싣지 않기로 한 경우. NO_NEWS 와 구분된다. */
export async function omitNews(runDate: string, instrumentId: string) {
  await updateSelection(runDate, instrumentId, {
    decision: 'OMITTED',
    chosenCandidateId: null,
    chosenSummaryId: null,
  })
}

/**
 * 선택한 요약 텍스트를 담당자가 직접 고친 결과를 저장한다.
 *
 * **빈 문자열은 null 로 정규화한다.** 텍스트를 지우고 blur 하면 `editedText = ''` 가
 * 저장되는데, 표시 쪽 `row.editedText ?? chosenSummary?.text`(repo.ts) 는 `''` 를
 * nullish 로 보지 않으므로 담당자가 고른 요약이 화면에서 영구히 가려진다 —
 * 행은 여전히 「선택 완료」라서 비어 있는 이유를 알 방법이 없다. 지운 것은
 * "빈 요약을 쓰겠다"가 아니라 "고치기 전으로 되돌리겠다"는 뜻으로 본다.
 *
 * 100자 초과는 막지 않는다. 이 텍스트는 담당자가 직접 쓴 최종본이고, 편집칸 옆
 * 카운터가 이미 빨갛게 초과를 알린다(RowPanel). 서버가 조용히 버리면 담당자는
 * 저장된 줄 알고 08:00 에 없는 문장을 싣게 된다 — 길이 위반보다 나쁘다.
 */
export async function editSummary(runDate: string, instrumentId: string, text: string) {
  const trimmed = text.trim()
  await updateSelection(runDate, instrumentId, { editedText: trimmed === '' ? null : text })
}

/** 코스피200 헬스케어 전용 수기 입력. 자동 소스가 없는 종목의 종가/전일종가. */
export async function saveManualQuote(
  runDate: string,
  instrumentId: string,
  close: number,
  prevClose: number,
) {
  await updateSelection(runDate, instrumentId, { manualClose: close, manualPrevClose: prevClose })
}

/* ------------------------------------------------------------------------ *
 * 화면에서 수집 직접 실행
 * ------------------------------------------------------------------------ */

/**
 * 「수집 실행」 결과. 거절도 정상적인 결과다 — 화면이 사유를 그대로 보여준다.
 */
export type StartCollectionResult =
  | { ok: true; runDate: string }
  | { ok: false; runDate: string; reason: string }

/**
 * 화면에서 수집을 직접 시작한다.
 *
 * **왜 서버 액션인가.** `POST /api/cron/collect` 는 `x-cron-secret` 으로 보호된다.
 * 그 시크릿을 화면이 다루게 만드는 순간 브라우저로 내려가고 보호가 사라진다.
 * 서버 액션은 자기가 쓰인 페이지 경로(`/review/...`)로 가는 POST 라 프록시의
 * Basic 인증 뒤에 있고(`src/proxy.ts`), 시크릿을 알 필요도 없다.
 *
 * **크론 엔드포인트는 그대로 둔다.** 스케줄러를 코드에 넣지 않는 것이 이관 전략의
 * 핵심이고(설계 문서 §4.1-3), 사내 crontab 의 `curl` 한 줄이 그 엔드포인트를 부른다.
 * 이 버튼은 그 경로를 대체하지 않는다 — **같은 `runCollection` 을 부르는 두 번째
 * 입구**일 뿐이고 수집 로직은 한 벌이다.
 *
 * **`await` 로 끝까지 기다리지 않는다.** 실측 202초짜리 작업이라 Render 의 요청
 * 타임아웃에 걸린다. 시작만 시키고 즉시 돌아오면 화면이 `BriefRun` 을 폴링해
 * 진행을 따라간다.
 *
 * ⚠️ **이 방식은 "요청이 끝나도 프로세스가 살아 있다"에 기대고 있다.** Render 는
 * 상주 Node 프로세스라 성립한다. **Vercel(서버리스)로 다시 올리면 깨진다** —
 * 응답을 보낸 뒤 함수가 얼려지거나 종료되어 수집이 중간에 죽고, 그 행은
 * `COLLECTING` 인 채로 남는다(화면은 그걸 「중단됐을 수 있음」으로 보여준다).
 * 그때는 이 버튼이 아니라 크론/큐 경로로 되돌려야 한다. `docs/운영.md` §3.6 참조.
 */
export async function startCollection(): Promise<StartCollectionResult> {
  const now = new Date()
  const runDate = kstDateString(now)

  const claim = await claimRun(runDate, now)
  if (!claim.ok) return { ok: false, runDate, reason: claim.reason }

  // 떼어 놓고 시작한다. 이 프로미스를 기다리지 않으므로 반드시 catch 를 붙인다 —
  // 처리되지 않은 거절은 Node 프로세스를 죽일 수 있고, 그러면 개발자가 아니라
  // 담당자가 그 대가를 치른다. 실패 상태 자체는 runCollection 이 DB 에 남긴다.
  void runCollection(now).catch(e => {
    console.error(`[collect] 화면에서 시작한 수집 실패: ${e instanceof Error ? e.message : String(e)}`)
  })

  revalidatePath(`/review/${runDate}`)
  return { ok: true, runDate }
}

/**
 * 이 날짜의 수집을 선점한다. 이미 도는 중이면 거절한다.
 *
 * **왜 막아야 하나.** 같은 날짜에 두 수집이 겹치면 서로의 후보를 지우고 다시
 * 만들면서 결과를 덮어쓴다. 화면 버튼은 비활성이지만 그것만으로는 부족하다 —
 * 두 탭, 새로고침 직후의 낡은 화면, 크론과의 경합이 전부 남는다.
 *
 * **왜 `updateMany` 인가.** 읽고 나서 쓰면 두 요청이 같은 "안 돌고 있음"을 읽고
 * 둘 다 시작한다. 조건부 갱신 한 번으로 선점하면 DB 가 승자를 하나로 정한다.
 * 갱신된 행이 0이면 두 가지다 — 행이 아예 없거나(첫 실행), 다른 쪽이 이미
 * 잡았거나. 그래서 곧바로 `create` 를 시도하고, 유니크 충돌이면 후자다.
 *
 * **멈춘 것으로 보이는 실행은 선점할 수 있다.** 그러지 않으면 프로세스가 죽은 날의
 * 날짜가 영원히 잠긴다 — 아무것도 돌지 않는데 아무도 다시 돌릴 수 없는 상태가 된다.
 */
async function claimRun(runDate: string, now: Date): Promise<{ ok: true } | { ok: false; reason: string }> {
  const staleBefore = new Date(now.getTime() - STALLED_AFTER_MS)
  const start = briefRunStartData(runDate)

  const taken = await prisma.briefRun.updateMany({
    where: {
      runDate,
      OR: [{ status: { not: 'COLLECTING' } }, { startedAt: { lte: staleBefore } }],
    },
    data: start.update,
  })
  if (taken.count > 0) return { ok: true }

  try {
    await prisma.briefRun.create({ data: start.create })
    return { ok: true }
  } catch {
    // runDate 에 @@unique 가 걸려 있다. 여기까지 왔다는 것은 행이 이미 있고
    // 위 조건부 갱신이 그것을 못 잡았다는 뜻 — 즉 지금 도는 중이다.
    return {
      ok: false,
      reason: '이미 수집이 진행 중입니다. 끝날 때까지 기다려 주세요 (보통 3~4분).',
    }
  }
}
