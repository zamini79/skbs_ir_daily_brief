import { marketCapKrwTrillion } from '@/domain/calc'
import { charLength, truncateAtSentence } from '@/domain/text'
import { tokenize, jaccard } from './cluster'
import type { SummarySet } from '@/providers/summarize/gemini'
import { MAX_SUMMARY_CHARS } from '@/providers/summarize/prompt'

/**
 * 뉴스 관련성 필터에 쓸 별칭 목록을 만든다. newsAliases 는 콤마 구분 문자열이다.
 * 비어 있으면(설정 누락) newsQuery 하나로 폴백한다 — 필터가 조용히 전부 통과시키는
 * 사고를 막기 위함이다.
 *
 * 폴백을 name 이 아니라 newsQuery 로 두는 이유: name 은 영문 표기다(Pfizer, Merck, GSK).
 * 한국어 헤드라인에 그 문자열은 등장하지 않으므로 name 으로 폴백하면 관련성 필터가
 * 후보를 전량 탈락시킨다. newsQuery 는 실제로 검색에 쓰는 한국어 문자열이다(화이자, 머크).
 */
export function resolveAliases(inst: { newsQuery: string; newsAliases: string }): string[] {
  const list = inst.newsAliases
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)
  return list.length > 0 ? list : [inst.newsQuery]
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
 * 검수 화면과 운영자가 구분할 수 있어야 한다.
 *
 * 연초 기준가 실패도 같은 규칙으로 PARTIAL 로 본다. 근거는 요약 실패와 동일하다:
 * 연초대비 칸이 비었을 때 "기준가를 못 구했다"와 "정상인데 값이 0이다"를 구분할 수
 * 있어야 한다. 특히 이 실패는 API 분당 한도 경합이라 어느 종목이 빌지가 매일 달라진다 —
 * 상태에 남기지 않으면 재현되지 않는 공란이 되어 아무도 눈치채지 못한다. */
export function computeRunStatus(summariesFailed: number, ytdBaseFailed = 0): 'READY' | 'PARTIAL' {
  return summariesFailed > 0 || ytdBaseFailed > 0 ? 'PARTIAL' : 'READY'
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
 * 재실행으로 NewsCandidate가 삭제되면 FK(onDelete: SetNull)가
 * Selection.chosenCandidateId를 곧바로 null로 되돌린다. 하지만 decision은 그 자체로는
 * 되돌아가지 않는다 — decision이 여전히 SELECTED인데 참조가 null이면, 존재하지 않는
 * 후보를 가리키는 "완료된 선택"으로 보인다. 이 함수가 그 판정을 내린다. OMITTED는
 * 애초에 후보를 참조하지 않는 정상 상태이므로 대상이 아니다.
 *
 * chosenCandidateId만 본다 — chosenSummaryId는 보지 않는다. collect.ts는 재실행
 * 시작 시 NewsCandidate를 통째로 지우므로(그 후보에 딸린 NewsSummary도 함께 지워짐),
 * 후보 자체가 사라진 경우 chosenCandidateId 하나만으로 충분히 잡아낸다. 반대로
 * chosenSummaryId가 null인데 chosenCandidateId는 여전히 유효한 경우도 있다 —
 * 담당자가 고른 후보에 애초에 요약이 없어서(summaryError 없이 summaries가 빈
 * 경우) 요약을 고르지 못한 채 선택을 끝낸 것으로, 이는 무효화가 아니라 정상적으로
 * 끝난 선택이다. chosenSummaryId도 조건에 넣으면 그런 정상 선택을 매번 PENDING으로
 * 되돌리게 된다.
 */
export function needsPendingRevert(selection: {
  decision: string
  chosenCandidateId: string | null
  /** 실제 Selection 행 모양과 맞추기 위해 받지만, 판정에는 쓰지 않는다(위 주석 참고). */
  chosenSummaryId: string | null
}): boolean {
  return selection.decision === 'SELECTED' && selection.chosenCandidateId === null
}

/** 접두사/포함 비교용으로 공백만 접는다. 자카드 같은 유사도는 과하다 — 네이버
 * 스니펫이 본문 선두와 다른 경우는 거의 항상 엔티티 처리 차이나 공백 하나뿐이다. */
function normalizeForDedup(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** 한쪽이 다른 쪽을 포함하면(접두사인 경우도 포함) 사실상 같은 슬라이스로 본다. */
function isNearDuplicate(a: string, b: string): boolean {
  const na = normalizeForDedup(a)
  const nb = normalizeForDedup(b)
  if (!na || !nb) return false
  return na.includes(nb) || nb.includes(na)
}

/**
 * 요약이 실패했을 때 화면 칸을 비워두지 않기 위한 기계적 발췌 3안을 만든다.
 * 모델이 만든 게 아니므로(isFallback 마커는 호출자가 붙인다) 본문/스니펫에서
 * 있는 그대로 잘라낸다 — 새로 텍스트를 짓지 않는다.
 *
 * 슬라이스 전략: (1) 본문 선두, (2) 본문에서 (1)이 소비한 구간 다음, (3) 검색
 * 스니펫(본문과 다를 때만). 각각 100자(코드포인트) 제한을 지키기 위해
 * truncateAtSentence 로 문장 경계에서 자른다 — 모델이 만든 요약과 같은 제약이다.
 * 본문이 짧아 서로 다른 구간을 뽑을 수 없으면 중복을 만들지 않고 개수를 줄인다.
 */
export function buildFallbackSummaries(body: string, snippet: string): string[] {
  const cap = (s: string): string => {
    const t = s.trim()
    if (!t) return ''
    return charLength(t) <= MAX_SUMMARY_CHARS ? t : truncateAtSentence(t, MAX_SUMMARY_CHARS)
  }

  const slices: string[] = []
  const trimmedBody = body.trim()

  if (trimmedBody) {
    const first = cap(trimmedBody)
    slices.push(first)

    // (1)이 소비한 구간 다음부터 다시 자른다 — 완전히 다른 문장들이 된다.
    const bodyChars = [...trimmedBody]
    const rest = bodyChars.slice(charLength(first)).join('').trim()
    if (rest) slices.push(cap(rest))
  }

  const trimmedSnippet = snippet.trim()
  if (trimmedSnippet && trimmedSnippet !== trimmedBody) {
    slices.push(cap(trimmedSnippet))
  }

  // 본문이 짧아 스니펫과 겹치는 등, 중복(정확히 같거나 한쪽이 다른 쪽을 포함)이
  // 생기면 하나로 줄인다 — 복제본으로 채우지 않는다. 네이버 스니펫은 대개 기사
  // 도입부라서 본문 선두와 "거의 같지만 미세하게 다른"(엔티티 처리, 말줄임표,
  // 공백 하나) 경우가 흔하다 — 정확히 같은 문자열만 보면 이런 사실상-중복을
  // 놓친다.
  const out: string[] = []
  for (const s of slices) {
    if (!s) continue
    if (out.some(existing => isNearDuplicate(existing, s))) continue
    out.push(s)
  }
  return out.slice(0, 3)
}
