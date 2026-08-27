import { marketCapKrwTrillion } from '@/domain/calc'
import { charLength } from '@/domain/text'
import { tokenize, jaccard } from './cluster'
import type { SummarySet } from '@/providers/summarize/gemini'

/**
 * 뉴스 관련성 필터에 쓸 별칭 목록을 만든다. newsAliases 는 콤마 구분 문자열이다.
 * 비어 있으면(설정 누락) name 하나로 폴백한다 — 필터가 조용히 전부 통과시키는
 * 사고를 막기 위함이다.
 */
export function resolveAliases(inst: { name: string; newsAliases: string }): string[] {
  const list = inst.newsAliases
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
  return list.length > 0 ? list : [inst.name]
}

/**
 * 환율 조회. 없으면 null — 절대 1로 대체하지 않는다.
 * 1로 대체하면 시가총액이 조용히 통화 배수만큼 틀어진다(예: USD를 1로 두면
 * 실제 값의 1300배 이상 축소된 숫자가 그럴듯하게 찍힌다).
 */
export function resolveFxRate(currency: string, fx: Record<string, number>): number | null {
  return fx[currency] ?? null
}

/**
 * 시가총액(조원)을 계산한다.
 * - 지수는 시가총액 개념이 없다 → null.
 * - 소스(네이버 국내주식)가 시총을 직접 준 경우 환율과 무관하게 그 값을 쓴다.
 * - 그 외에는 환율이 없으면 계산할 수 없다 → null(1로 대체하지 않는다).
 */
export function resolveMarketCap(args: {
  isIndex: boolean
  quoteMarketCap?: number
  close: number
  shares: number | null
  fxRate: number | null
  priceDivisor: number
}): number | null {
  if (args.isIndex) return null
  if (args.quoteMarketCap !== undefined) return args.quoteMarketCap
  if (args.fxRate === null) return null
  return marketCapKrwTrillion({
    close: args.close,
    shares: args.shares,
    fxToKrw: args.fxRate,
    priceDivisor: args.priceDivisor,
  })
}

/** 같은 사건 판정에 쓰는 임계값. 클러스터링 임계값(0.5)보다 낮다 —
 * 0.5로 하면 이미 클러스터링 단계에서 하나로 합쳐졌을 것이므로 여기서는 절대 안 걸린다. */
const SAME_EVENT_THRESHOLD = 0.3

/**
 * 선정된 후보(보통 rank 1..3)들 중, 더 높은 순위(작은 rank)의 후보와 제목이
 * 유사하면(jaccard >= 0.3) 그 rank를 표시한다. "같은 사건" 배지용이다.
 * rank 1은 비교 대상이 없으므로 항상 null.
 * 같은 후보와 여러 상위 후보가 매칭되면 가장 순위가 높은(rank가 작은) 쪽을 남긴다.
 */
export function computeSameEventAsRank(
  candidates: Array<{ rank: number; title: string }>,
): Map<number, number | null> {
  const sorted = [...candidates].sort((a, b) => a.rank - b.rank)
  const tokensByRank = sorted.map(c => ({ rank: c.rank, tokens: tokenize(c.title) }))

  const out = new Map<number, number | null>()
  for (let i = 0; i < tokensByRank.length; i++) {
    let matchRank: number | null = null
    for (let j = 0; j < i; j++) {
      if (jaccard(tokensByRank[i].tokens, tokensByRank[j].tokens) >= SAME_EVENT_THRESHOLD) {
        matchRank = tokensByRank[j].rank
        break
      }
    }
    out.set(tokensByRank[i].rank, matchRank)
  }
  return out
}

/** 이보다 짧은 본문은 요약해도 의미가 없다 — 빈 프롬프트로 8초를 버리지 않는다. */
export const MIN_BODY_CHARS_FOR_SUMMARY = 20

/**
 * Gemini 에러 메시지가 할당량/속도 제한 소진을 뜻하는지 판별한다.
 * gemini.ts 는 `gemini HTTP {status}: {본문}` 형태로 던지므로 상태 코드와
 * 구글의 표준 사유 문자열을 함께 본다.
 */
export function isQuotaExhaustedMessage(message: string): boolean {
  return /\b429\b|RESOURCE_EXHAUSTED/i.test(message)
}

/** 한 실행(run) 동안 공유하는, 할당량 소진 여부를 기억하는 상태. */
export type QuotaGuard = { tripped: boolean }

export function createQuotaGuard(): QuotaGuard {
  return { tripped: false }
}

export type SummarizeAttempt =
  | { outcome: 'generated'; summary: SummarySet }
  | { outcome: 'skipped-empty-body' }
  | { outcome: 'skipped-quota-exhausted' }
  | { outcome: 'failed'; error: string }

/**
 * 후보 하나에 대해 요약을 시도한다.
 * - 본문이 짧으면 호출하지 않는다(의도된 결정, 실패가 아니다).
 * - 이미 이번 실행에서 할당량 소진이 감지됐으면(guard.tripped) 호출하지 않는다 —
 *   죽은 할당량에 나머지를 전부 쏘고 매번 실패시키지 않는다. 재시도/백오프는 하지 않는다.
 * - summarizeFn 이 던지면 실패로 기록하고, 메시지가 할당량 소진을 뜻하면 guard 를 트립시켜
 *   이후 호출들이 스스로 건너뛰게 만든다.
 */
export async function attemptSummary(
  args: { title: string; body: string },
  guard: QuotaGuard,
  summarizeFn: (title: string, body: string) => Promise<SummarySet>,
): Promise<SummarizeAttempt> {
  if (charLength(args.body) < MIN_BODY_CHARS_FOR_SUMMARY) return { outcome: 'skipped-empty-body' }
  if (guard.tripped) return { outcome: 'skipped-quota-exhausted' }

  try {
    const summary = await summarizeFn(args.title, args.body)
    return { outcome: 'generated', summary }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    if (isQuotaExhaustedMessage(message)) guard.tripped = true
    return { outcome: 'failed', error: message }
  }
}

/** 요약 실패가 하나라도 있으면 PARTIAL — "오늘 뉴스가 적었다"와 "요약기가 죽어있었다"를
 * 검수 화면과 운영자가 구분할 수 있어야 한다. */
export function computeRunStatus(summariesFailed: number): 'READY' | 'PARTIAL' {
  return summariesFailed > 0 ? 'PARTIAL' : 'READY'
}

/**
 * 항목 하나를 처리하다 예외가 나도 배치 전체(Promise.all이든 순차 for 루프든)를
 * 막지 않는다. `worker` 가 성공 경로에서 이미 카운터를 올렸다면, 실패 시 그 증가를
 * 되돌리는 건 이 함수의 책임이 아니다 — 이 함수는 오직 "예외가 이 항목 밖으로
 * 새어나가지 않는다"만 보장한다. 호출자는 `ok`가 false일 때만 실패를 집계하면 된다.
 */
export async function isolate(worker: () => Promise<void>): Promise<{ ok: boolean }> {
  try {
    await worker()
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

/**
 * 재실행으로 NewsCandidate/NewsSummary가 삭제되면 FK(onDelete: SetNull)가
 * Selection.chosenCandidateId/chosenSummaryId를 곧바로 null로 되돌린다. 하지만
 * decision은 그 자체로는 되돌아가지 않는다 — decision이 여전히 SELECTED인데 참조가
 * null이면, 존재하지 않는 후보를 가리키는 "완료된 선택"으로 보인다. 이 함수가 그
 * 판정을 내린다. OMITTED는 애초에 후보를 참조하지 않는 정상 상태이므로 대상이 아니다.
 */
export function needsPendingRevert(selection: {
  decision: string
  chosenCandidateId: string | null
  chosenSummaryId: string | null
}): boolean {
  return (
    selection.decision === 'SELECTED' &&
    (selection.chosenCandidateId === null || selection.chosenSummaryId === null)
  )
}
