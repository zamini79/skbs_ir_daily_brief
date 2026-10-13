import { marketCapKrwTrillion, changePct, ytdPct } from '@/domain/calc'
import type { QuoteHit } from '@/providers/quote'
import { charLength, truncateAtSentence } from '@/domain/text'
import { finalizeSummary } from '@/domain/summaryFormat'
import { tokenize, jaccard } from './cluster'
import type { SummarySet } from '@/providers/summarize/gemini'
import { MAX_SUMMARY_CHARS, SUMMARY_VARIANTS } from '@/providers/summarize/prompt'

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
 * 뉴스 칸에 **증시 시황·수급 기사가 들어오는 것이 정답인 행**의 이름 목록.
 * cluster.ts 의 newsPenalty 가 이 행에서만 시황·수급 감점을 건너뛴다.
 *
 * **왜 `isIndex` 로는 안 되는가.** 감점 예외의 진짜 기준은 "지수인가"가 아니라
 * **"이 행이 원하는 것이 시황인가"** 다. 처음에는 둘이 같아 보였다 — 지수 행이
 * 셋뿐이었고 셋 다 시황을 원했기 때문이다. 코스피200 헬스케어 행에 업종 검색어
 * (`제약주`)를 준 뒤로 그 전제가 깨졌다: 이 행도 `isIndex: true` 지만 원하는 것은
 * 시황이 아니라 **헬스케어 업종 동향**이다(원본 샘플 엑셀의 「美 FDA, 의약품 용기
 * 지침 바뀐다…삼성·셀트리온 시밀러도 영향」이 그 근거다. prisma/instruments.ts 주석 참고).
 *
 * `isIndex` 를 그대로 쓰면 이 행에서 미국 증시 시황이 감점 없이 업종 기사와 동률이
 * 되어, 실측(2026-08-27)에서 정작 업종 기사인 「한미약품 3.5조 잭팟에 제약株
 * 불붙었다」가 2순위로 밀렸다.
 *
 * **"지수인데 왜 따로 두지" 하고 `isIndex` 로 되돌리지 마라.** 그러면 헬스케어 행이
 * 다시 미국 증시 시황으로 채워진다. 네 지수 행이 서로 다른 것을 원한다는 것이 요점이다.
 *
 * 검색어 문자열로 추론하지 않고 이름을 명시한다 — `newsQuery` 가 '뉴욕증시'라서
 * 시황 행이라고 넘겨짚으면, 검색어를 바꾸는 순간 감점 규칙이 조용히 따라 바뀐다.
 * 목록의 이름이 실재하는 지수 행인지는 prisma/instruments.test.ts 가 지킨다.
 */
export const MARKET_WRAP_ROWS: ReadonlySet<string> = new Set(['S&P500', 'Nasdaq', 'KOSPI'])

/** 이 행의 뉴스 칸이 증시 시황·수급 기사를 원하는가. 위 MARKET_WRAP_ROWS 주석 참고. */
export function wantsMarketWrapNews(inst: { name: string }): boolean {
  return MARKET_WRAP_ROWS.has(inst.name)
}

/**
 * 요청한 통화 중 환율을 얻지 못한 것들을 돌려준다. KRW는 절대 여기 담기지 않는다 —
 * 국내 종목의 시가총액은 네이버가 직접 주고(resolveMarketCap이 quoteMarketCap을
 * fxRate 검사보다 먼저 반환한다), 국내 종목은 애초에 fx['KRW']를 들여다보지 않는다.
 * 그래서 환율 조회가 통째로 실패해 fx가 빈 객체여도 국내 10개 행의 시가총액은
 * 멀쩡하다. 여기서 KRW를 걸러내지 않으면 "환율 미확보: KRW, USD, ..." 라는 배너가
 * 있지도 않은 문제(국내 종목 시총 공란)를 있는 것처럼 말하게 된다.
 * (이 필터를 "빠뜨린 필드"로 보고 되돌리고 싶어질 수 있는데, 그러면 안 된다 — KRW는
 * 원래도 이 목록에 실려서는 안 되는 값이다.)
 *
 * fetchFxToKrw 의 실패 형태 두 가지를 한 방식으로 잡는다:
 *  - 전체 실패: 함수가 던져서 호출부가 빈 객체를 들고 있다 → KRW를 제외한 전 통화가
 *              여기 담긴다.
 *  - 부분 결손: 정상 반환했지만 특정 통화 키가 없다(frankfurter 의 `if (!usdToC) continue`)
 *              → 그 통화만 담긴다.
 * 둘을 갈라 보고 싶으면 호출부에서 "던졌는지"를 함께 보면 된다. 여기서는 결과만 센다.
 */
export function missingFxCurrencies(requested: string[], fx: Record<string, number>): string[] {
  return [...new Set(requested)].filter(c => c !== 'KRW' && fx[c] === undefined)
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
 * 통화 이름을 비교 가능한 형태로 접는다.
 *
 * **단위 차이는 통화 차이가 아니다.** 런던은 펜스(GBX/GBp)로 호가하지만 통화는
 * GBP 이고, 그 100배 차이는 `priceDivisorForMarketCap` 이 이미 처리한다
 * (스펙 §3.2 주의 1). **두 표기를 실제로 둘 다 봤다**: marketstack 은 `GSK.L` 에
 * `GBP` 를 줬고, 지금 쓰는 LSE 엔드포인트는 같은 가격에 `GBX` 를 준다(실측).
 * 같은 상장의 같은 가격이므로 표기가 어느 쪽이든 멀쩡한 행을 버리면 안 된다.
 */
function canonicalCurrency(c: string): string {
  const u = c.trim().toUpperCase()
  return u === 'GBX' ? 'GBP' : u
}

/**
 * provider 가 돌려준 통화가 시드에 등록된 통화와 **다른 통화**면 그 사유를 준다.
 * 같거나 판단할 수 없으면 null 이다.
 *
 * 왜 필요한가: `resolveFxRate(inst.currency, fx)` 는 **시드의 통화**로 환율을
 * 고르는데 `q.close` 는 **provider 가 돌려준 통화**의 가격이다. 둘이 어긋나면
 * 시가총액이 환율 배수만큼 조용히 틀리고, 화면의 가격은 틀린 통화 라벨을 달고
 * 나온다. 스펙 §3.2 가 실측으로 경고한 사고 형태다 — marketstack 이 심볼 해석을
 * 바꿔 `GSK.L` 에 뉴욕 ADR(USD) 값을 주면 그 USD 가격에 GBP 환율을 곱하고 100으로
 * 나눈다. 그럴듯한 숫자라서 아무도 눈치채지 못한다.
 *
 * 소스가 통화를 알려주지 않으면(marketstack 의 `price_currency ?? ''`) 판단하지
 * 않는다 — 모르는 것을 아는 것처럼 단정하지 않는다는 이 코드베이스의 규칙 그대로다.
 */
export function currencyMismatchReason(expected: string, actual: string): string | null {
  const e = canonicalCurrency(expected)
  const a = canonicalCurrency(actual)
  if (!e || !a) return null
  if (e === a) return null
  return `통화 불일치: 기대 ${expected}, 응답 ${actual} — 다른 통화의 가격이므로 이 행의 시세를 버렸습니다`
}

/**
 * 소스가 준 시세 기준일을 저장 가능한 형태로 만든다. 빈 문자열은 null 이다.
 *
 * twelvedata 는 `datetime` 이 없으면 `''` 를, 네이버 파서는 날짜를 못 읽으면 `''` 를
 * 준다. 그 `''` 를 그대로 저장하면 화면의 `{row.quote?.asOf && …}` 가 falsy 로 보고
 * **「기준 YYYY-MM-DD」 줄을 아예 그리지 않는다** — 기준일이 조용히 사라진다.
 * 스펙 §3.2 주의 2·§13.2 는 국제 시장의 지연(해외 종목은 전일 종가일 수 있다)을
 * 담당자가 판단할 수 있도록 기준일 노출을 요구한다. 없으면 없다고 말해야지,
 * 줄 자체가 사라지면 담당자는 오늘 종가라고 읽는다.
 */
export function normalizeAsOf(raw: string | null | undefined): string | null {
  const t = (raw ?? '').trim()
  return t === '' ? null : t
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

/**
 * 값을 얻은 종목의 QuoteSnapshot 레코드. collect.ts 는 이것을 그대로 `create` 한다.
 *
 * Prisma 밖으로 뺀 이유는 **`fallbackFrom` 한 줄을 테스트로 고정하기 위해서다.**
 * 화면의 「… 대체」 배지는 이 저장값만 본다(db/repo.ts 의 quoteFallbackSourceUsed).
 * 이 줄이 빠지면 폴백이 돈 날에도 배지가 뜨지 않는다 — 값은 다 차 있고 배너도
 * 초록이라, 1차가 몇 주째 죽어 있어도 아무도 모르는 상태로 돌아간다.
 * collect.ts 는 Prisma 에 묶여 테스트할 수 없으므로 그 결함은 여기서만 잡힌다.
 */
export function buildQuoteSnapshotData(args: {
  runId: string
  instrumentId: string
  q: QuoteHit
  ytdBase: number | undefined
  marketCapKrwTrillion: number | null
  fxRate: number | null
}) {
  const { q } = args
  return {
    runId: args.runId,
    instrumentId: args.instrumentId,
    close: q.close,
    prevClose: q.prevClose,
    changePct: changePct(q.close, q.prevClose),
    ytdPct: args.ytdBase ? ytdPct(q.close, args.ytdBase) : null,
    marketCapKrwTrillion: args.marketCapKrwTrillion,
    fxRate: args.fxRate,
    asOf: normalizeAsOf(q.asOf),
    // **실제로 값을 가져온 소스**다. 설정값(inst.quoteSource)이 아니다 —
    // 폴백이 돌면 둘이 달라지고, 설정값을 넣으면 이 칸이 거짓말을 한다.
    sourceName: q.sourceName,
    // 수집 **당시**의 폴백 여부. 화면 배지가 이것만 본다 — 시드가 나중에 바뀌어도
    // 과거 날짜의 판정이 흔들리지 않는다(schema.prisma 의 fallbackFrom 주석).
    fallbackFrom: q.fallbackFrom,
  }
}

/**
 * 값을 받았지만 **기대한 통화가 아니라서 버리는** 행의 QuoteSnapshot 레코드.
 * 숫자는 싣지 않고 사유만 남긴다(collect.ts 의 통화 불일치 분기 주석).
 *
 * 값을 버리더라도 **그 값을 준 소스와 폴백 여부**는 남긴다. 폴백이 돌았는데 2차가
 * 다른 통화를 준 경우, 1차 이름만 남으면 조사가 엉뚱한 데서 시작된다.
 * 배지는 이 행에 뜨지 않지만(표시할 값이 없다) 기록은 그날의 사실 그대로여야 한다.
 */
export function buildQuoteMismatchSnapshotData(args: {
  runId: string
  instrumentId: string
  q: QuoteHit
  errorMessage: string
}) {
  return {
    runId: args.runId,
    instrumentId: args.instrumentId,
    sourceName: args.q.sourceName,
    fallbackFrom: args.q.fallbackFrom,
    errorMessage: args.errorMessage,
  }
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
 * 요약 단계의 마감 시한 판정.
 *
 * 시계를 주입받는 이유는 테스트가 20분을 실제로 기다리지 않기 위해서다. 값은
 * `SUMMARY_DEADLINE_MS`(domain/runProgress.ts)에서 오고, 그 상수 옆에 왜 20분인지와
 * **왜 `STALLED_AFTER_MS` 보다 작아야 하는지**가 적혀 있다.
 *
 * **경계는 `>=` 다.** 정확히 마감 시각이면 지난 것으로 본다 — 어느 쪽인지 코드로
 * 못 읽으면 테스트가 못 고정한다(`runProgressView` 와 같은 규칙).
 */
export type Deadline = { exceeded: () => boolean }

export function createDeadline(
  startedAtMs: number,
  budgetMs: number,
  now: () => number = Date.now,
): Deadline {
  return { exceeded: () => now() - startedAtMs >= budgetMs }
}

/**
 * Gemini 에러 메시지가 할당량/속도 제한 소진을 뜻하는지 판별한다.
 * gemini.ts 는 `gemini HTTP {status}: {본문}` 형태로 던지므로 상태 코드와
 * 구글의 표준 사유 문자열을 함께 본다.
 *
 * ⚠ **지금 이 판정에 걸리는 경로는 사실상 없다. 살아 있는 안전장치로 읽지 마라.**
 * `summarize()` 가 던지는 메시지는 (a) 모델 이름과 한국어 사유 라벨로만 이뤄진
 * 「모든 모델이 실패했다 (…)」, (b) 「모든 모델의 쿼터가 소진됐다 (시도: …)」,
 * (c) `other` 로 분류된 실패의 `gemini HTTP {status}` 인데, 429·RESOURCE_EXHAUSTED 는
 * `other` 가 아니므로 (c) 에도 오지 않는다. 이 사실은 2026-09-01 변경 **이전에도**
 * 같았다(그때도 429 는 `quota` 로 분류돼 던져지지 않았다) — 이번 변경이 만든 상태가
 * 아니다.
 *
 * **일부러 고치지 않았다.** 이 판정이 실제로 걸리면 `guard.tripped` 가 서고, 남은
 * 후보 전부가 요약을 **시도조차 하지 않고** 발췌로 떨어진다. 그것이 바로 2026-09-01
 * 작업이 없애려던 결과다. 곱셈을 끊는 일은 대신 `RateLimitBudget`(재시도 대기 총량)과
 * 요약 단계 마감(`SUMMARY_DEADLINE_MS`)이 맡는다 — 둘 다 **재시도만 줄이고 시도 자체는
 * 남긴다.** 하루치가 정말 전부 소진된 날은 `candidates.length === 0` 경로가 네트워크
 * 호출 없이 즉시 던지므로 비용도 없다.
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
  | { outcome: 'skipped-deadline' }
  | { outcome: 'skipped-quota-exhausted' }
  | { outcome: 'failed'; error: string }

/**
 * 후보 하나에 대해 요약을 시도한다.
 * - 본문이 짧으면 호출하지 않는다(의도된 결정, 실패가 아니다).
 * - **요약 단계 마감이 지났으면 호출하지 않는다.** 실패가 아니라 시간이 없어 시작하지
 *   않은 것이다 — 호출부가 `summariesFailed` 와 갈라 센다.
 *
 *   이 판정이 `collect.ts` 가 아니라 **여기** 있는 이유: 저쪽은 최상단에서 Prisma 를
 *   끌어와 테스트가 가볍게 import 할 수 없다. 리뷰에서 `if (deadline.exceeded())` 를
 *   `if (false)` 로 바꿔도 933개가 전부 통과하는 것이 확인됐다. `deadline` 을
 *   **선택 인자로 두지 않은 것도 같은 이유다** — 호출부가 빼면 컴파일이 안 된다.
 * - 이미 이번 실행에서 할당량 소진이 감지됐으면(guard.tripped) 호출하지 않는다 —
 *   죽은 할당량에 나머지를 전부 쏘고 매번 실패시키지 않는다. 재시도/백오프는 하지 않는다.
 * - summarizeFn 이 던지면 실패로 기록하고, 메시지가 할당량 소진을 뜻하면 guard 를 트립시켜
 *   이후 호출들이 스스로 건너뛰게 만든다. **다만 `isQuotaExhaustedMessage` 에 걸리는
 *   메시지가 실제로는 오지 않는다** — 그 함수의 ⚠ 주석을 함께 읽어라. 이 갈래는
 *   현재 죽어 있고, 그것이 의도된 상태다.
 */
export async function attemptSummary(
  args: { title: string; body: string },
  guard: QuotaGuard,
  summarizeFn: (title: string, body: string) => Promise<SummarySet>,
  deadline: Deadline,
): Promise<SummarizeAttempt> {
  // 순서가 뜻을 갖는다. 본문이 짧은 것은 마감과 무관한 사실이므로 먼저 가른다 —
  // 마감 뒤에 두면 같은 후보가 날마다 다른 사유를 달게 된다.
  if (charLength(args.body) < MIN_BODY_CHARS_FOR_SUMMARY) return { outcome: 'skipped-empty-body' }
  if (deadline.exceeded()) return { outcome: 'skipped-deadline' }
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
 * 상태에 남기지 않으면 재현되지 않는 공란이 되어 아무도 눈치채지 못한다.
 *
 * 뉴스 검색 실패도 같은 규칙이다. 이쪽은 오히려 더 나빴다 — 실패한 행이 화면에서
 * "당일·D-1 기사 없음"이라는 **단정**으로 보였기 때문이다(모르는 것을 아는 것처럼 표시).
 * 이제 NewsFetch 에 사실이 남고, 상태에도 반영해 운영자가 실행 단위로 알 수 있다.
 *
 * 환율 미확보도 같은 규칙이다. 환율이 없으면 해외사 시가총액이 통째로 공란이 되는데,
 * 1로 대체하지 않는 판단은 옳지만(틀린 숫자보다 공란이 낫다) 그 사실이 어디에도 남지
 * 않으면 담당자는 시총이 왜 비었는지 알 수 없다. 이쪽만 단위가 종목이 아니라 통화다 —
 * 환율은 실행별·통화별 사실이기 때문이다.
 *
 * 시세 수집 실패는 위 넷과 같은 규칙이면서 **가장 넓은 경로**다. 실패한 행은 주가·
 * 전일대비·%·연초대비·시가총액 다섯 칸이 전부 공란이 되는데, 이 카운터가 없으면 그
 * 행이 초록색 「준비 완료」 배너 아래에 놓인다. Twelve Data 가 분당 크레딧을 넘기면
 * HTTP 200 + 평면 에러 객체를 주고 미국 5행이 통째로 빠지는데(심볼별 맵이 아니라서
 * 전 심볼이 응답에서 사라진다), 그 상태로 메일 본문이 확정될 수 있었다. marketstack
 * 전체 실패(4행)·네이버 스키마 변경(10행)·KRX 키 만료(1행)도 같은 경로다.
 *
 * 세는 단위는 **실제로 실패한 종목**이다. quoteSource 가 'manual' 인 행(수집 대상이
 * 아니라 수기 입력 대상)은 여기 들어오지 않는다 — 의도된 공란을 장애로 세면 매일
 * PARTIAL 이 뜨고 배너가 아무 뜻도 없어진다(collect.ts 의 quoteFailed 참고).
 *
 * 뉴스 상태 **기록** 실패(newsRecordFailed)도 같은 규칙이다. 이쪽은 값이 비는 게
 * 아니라 **화면이 없는 사실을 단정하게 되는** 경우다 — NewsFetch 기록이 없으면
 * rowDisplayState 가 NO_NEWS 를 주고 화면은 「당일·D-1 기사 없음」이라고 말하는데,
 * 그 근거가 실은 없다. 행별로 바로잡을 수 없으니 실행 단위로라도 남긴다. */
/**
 * computeRunStatus 의 입력. **전부 필수이고 기본값이 없다.**
 *
 * 예전에는 위치 인자 + 기본값이었다. 그래서 collect.ts 에서 가운데 인자 한 줄
 * (`newsTally.newsFailed,`)을 지워도 tsc·테스트가 모두 통과했다 — 뒤 인자들이 한 칸씩
 * 당겨지고 마지막 자리는 기본값 0 으로 채워져, 뉴스 조회가 실패한 날 초록 「준비 완료」가
 * 떴다(Task 41 재리뷰의 변이 실험). 이름 붙은 필수 필드면 빠뜨린 필드는 컴파일 오류이고
 * 순서는 의미가 없다. **선택 필드나 기본값으로 되돌리지 마라.**
 */
export type RunStatusCounts = {
  summariesFailed: number
  ytdBaseFailed: number
  newsFailed: number
  /** 환율을 못 구한 **통화** 수(collect.ts 의 missingCurrencies.length). */
  fxFailed: number
  quoteFailed: number
  newsRecordFailed: number
  summariesSkippedDeadline: number
}

export function computeRunStatus(c: RunStatusCounts): 'READY' | 'PARTIAL' {
  return c.summariesFailed > 0 ||
    c.ytdBaseFailed > 0 ||
    c.newsFailed > 0 ||
    c.fxFailed > 0 ||
    c.quoteFailed > 0 ||
    c.newsRecordFailed > 0 ||
    c.summariesSkippedDeadline > 0
    ? 'PARTIAL'
    : 'READY'
}

/**
 * 배너에 붙는 사유 문구를 만든다. `computeRunStatus` 와 **반드시 짝을 이룬다** —
 * 같은 카운터 여섯 개를 보고, 하나라도 0이 아니면 그 항목을 문구에 싣는다.
 * (둘이 어긋나면 「부분 완료」인데 사유가 비거나, 사유가 있는데 「준비 완료」가 된다.
 * 그 불일치를 막는 것이 이 함수를 인라인 문자열에서 빼낸 이유다 — 테스트가 짝을 지킨다.)
 *
 * 순서는 무게 순이다. 시세 실패가 맨 앞인 것은 그 행의 숫자가 통째로 없다는 뜻이라
 * 나머지 넷보다 무겁기 때문이다(요약·기준가·뉴스·환율은 한 칸씩 비운다).
 *
 * 통화 이름은 그대로 적는다 — 어느 행의 시총이 비었는지 운영자가 바로 짚을 수 있다.
 * 실패가 하나도 없으면 null 이다(문구 없음).
 */
export function buildStatusDetail(counts: {
  quoteFailed: number
  summariesFailed: number
  candidatesCreated: number
  ytdBaseFailed: number
  newsFailed: number
  /** 기본값 0 — 이 카운터가 생기기 전 호출부(테스트 포함)와의 호환용. */
  newsRecordFailed?: number
  /**
   * 요약 단계 마감에 걸려 **시도하지 못한** 후보 수. 기본값 0.
   * `summariesFailed` 와 **반드시 갈라 적는다** — 실패한 것과 시간이 없어 안 한 것은
   * 담당자가 할 일이 다르다(전자는 원인을 봐야 하고, 후자는 다시 돌리면 된다).
   * 합쳐 세면 그 구분이 영영 사라진다.
   */
  summariesSkippedDeadline?: number
  /**
   * 실행 재시도 예산이 모자라 분당 한도 재시도를 포기한 횟수. 기본값 0.
   *
   * **이것만으로는 status 를 PARTIAL 로 낮추지 않는다**(computeRunStatus 에 없다).
   * 예산이 걸려도 남은 후보가 뒤쪽 모델에서 요약을 받아냈다면 담당자가 할 일은 없다.
   * 할 일이 없는 날에 노란 배너를 띄우면 담당자가 노란 배너를 무시하는 법을 배운다 —
   * `STALLED_AFTER_MS` 주석이 경계한 것과 같은 논리다.
   *
   * 그래도 **적히기는 해야 한다.** 그날 붐볐다는 사실은 다음 사람이 예산 값을 조정할
   * 유일한 근거이고, 로그와 크론 응답에만 남기면 화면을 보는 사람은 영영 모른다.
   */
  rateLimitRetriesDenied?: number
  /**
   * 우선 기사(연합뉴스 「뉴욕증시 종합」·「마켓뷰」) 추가 검색이 실패한 종목 수.
   * rateLimitRetriesDenied 와 같은 급이다 — 그 행의 뉴스는 기본 검색으로 채워져 있으므로
   * status 는 낮추지 않지만(computeRunStatus 에 없다), 1순위가 평소 기사가 아닐 수 있다는
   * 사실은 적혀야 한다(pipeline/instrumentNews.ts).
   *
   * **필수다(기본값 없음).** 429 로 우선 검색이 실패한 날 담당자가 볼 신호는 이 문장
   * 하나뿐이다. 선택 인자였을 때는 collect.ts 에서 넘기는 줄을 지워도 tsc·테스트가 모두
   * 통과했다(Task 41 리뷰). collect.ts 는 tallyNewsOutcomes 결과를 펼쳐 넘긴다.
   */
  priorityNewsFailed: number
  missingCurrencies: string[]
}): string | null {
  const parts: string[] = []
  if (counts.quoteFailed > 0) parts.push(`시세 ${counts.quoteFailed}종목 수집 실패`)
  if (counts.summariesFailed > 0) {
    parts.push(`요약 ${counts.summariesFailed}건 실패(후보 ${counts.candidatesCreated}건 중)`)
  }
  if (counts.ytdBaseFailed > 0) parts.push(`연초 기준가 ${counts.ytdBaseFailed}종목 조회 실패`)
  if (counts.newsFailed > 0) parts.push(`뉴스 검색 ${counts.newsFailed}종목 실패`)
  if ((counts.newsRecordFailed ?? 0) > 0) {
    // 문구가 "검색 실패"와 헷갈리면 안 된다. 이쪽은 검색은 했는데 그 결과를 남기지
    // 못한 것이고, 그래서 그 행의 「기사 없음」 표시를 믿을 수 없다는 뜻이다.
    parts.push(`뉴스 상태 기록 실패 ${counts.newsRecordFailed}종목 (해당 행의 「기사 없음」은 근거 없음)`)
  }
  if ((counts.summariesSkippedDeadline ?? 0) > 0) {
    parts.push(
      `요약 시간 초과로 ${counts.summariesSkippedDeadline}건 미생성(후보 ${counts.candidatesCreated}건 중, 재실행하면 채워집니다)`,
    )
  }
  if (counts.missingCurrencies.length > 0) {
    parts.push(`환율 미확보: ${counts.missingCurrencies.join(', ')} (시가총액 공란)`)
  }
  if (counts.priorityNewsFailed > 0) {
    parts.push(
      `우선 기사(연합뉴스) 검색 ${counts.priorityNewsFailed}종목 실패(해당 행 1순위는 일반 검색 결과)`,
    )
  }
  // **맨 뒤다.** 실패가 아니라 관측이므로, 실패가 함께 있는 날에는 그것들 뒤에 붙는다.
  if ((counts.rateLimitRetriesDenied ?? 0) > 0) {
    parts.push(`요약 API 가 붐벼 재시도를 ${counts.rateLimitRetriesDenied}회 포기함(요약 자체는 채워졌습니다)`)
  }
  return parts.length > 0 ? parts.join(', ') : null
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

/**
 * runCollection이 시작할 때 BriefRun을 upsert할 데이터를 만든다.
 *
 * update 쪽에서 status를 COLLECTING으로 되돌리면서 statusDetail도 함께 null로
 * 비운다. 비우지 않으면 재실행 도중(status=COLLECTING) 화면에는 지난 실행의
 * statusDetail이 그대로 남는다 — 예를 들어 07:40 수집이 아직 진행 중인데 어제의
 * "환율 미확보: ..." 문구가 여전히 붙어 있으면, 그 사이 화면을 연 검수자는 그것을
 * 오늘 것으로 오인한다. 이번 실행의 진짜 사유는 실행이 끝난 뒤 별도로 다시 채워진다
 * (collect.ts 끝부분의 status 갱신).
 *
 * progressDetail도 같은 이유로 비운다. 그쪽은 더 나쁘다 — 지난 실행이 남긴
 * 「요약 생성 중 (31/47)」이 그대로 있으면 방금 시작한 실행이 이미 요약 단계에
 * 와 있는 것처럼 보이고, 몇 초 뒤 「환율 수집 중」으로 **뒷걸음질친다.**
 * 시작 시점에 아는 것은 "아직 아무 단계도 끝나지 않았다"뿐이다.
 */
export function briefRunStartData(runDate: string): {
  update: {
    status: 'COLLECTING'
    statusDetail: null
    progressDetail: null
    startedAt: Date
    finishedAt: null
  }
  create: { runDate: string; tradeDate: string; status: 'COLLECTING' }
} {
  return {
    update: {
      status: 'COLLECTING',
      statusDetail: null,
      progressDetail: null,
      startedAt: new Date(),
      finishedAt: null,
    },
    create: { runDate, tradeDate: runDate, status: 'COLLECTING' },
  }
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
 * 요약이 실패했을 때 화면 칸을 비워두지 않기 위한 기계적 발췌를 만든다.
 * 모델이 만든 게 아니므로(isFallback 마커는 호출자가 붙인다) 본문/스니펫에서
 * 있는 그대로 잘라낸다 — 새로 텍스트를 짓지 않는다.
 *
 * **개수는 정상 경로와 같다** — 상한이 `SUMMARY_VARIANTS.length` 다(2026-08-28
 * 기준 2). 여기에 숫자를 직접 적으면 관점 개수를 바꿀 때 한쪽만 따라가서
 * "정상 요약은 2안인데 발췌만 3안"이 된다. 담당자는 그 차이를 요약 실패의
 * 신호로 읽지 않는다 — 그냥 행마다 개수가 다른 화면으로 보인다.
 *
 * 슬라이스 전략: (1) 본문 선두, (2) 본문에서 (1)이 소비한 구간 다음, (3) 검색
 * 스니펫(본문과 다를 때만). 각각 100자(코드포인트) 제한을 지키기 위해
 * truncateAtSentence 로 문장 경계에서 자른다 — 모델이 만든 요약과 같은 제약이다.
 * 본문이 짧아 서로 다른 구간을 뽑을 수 없으면 중복을 만들지 않고 개수를 줄인다.
 * (3)은 (1)·(2)가 상한을 못 채웠을 때에만 실제로 쓰인다.
 *
 * **구간은 원문 기준으로 정하고, 내보내기 직전에 모델 요약과 같은 서식을 입힌다**
 * (`finalizeSummary`, 2026-10-02). 담당자는 화면의 요약을 출처와 무관하게 메일에
 * 그대로 붙이므로 문장부호·금액 표기가 같아야 한다. 순서를 바꾸면 안 된다 — (2)의
 * 시작 위치는 (1)이 원문에서 소비한 글자 수이고, 서식은 그 글자 수를 바꾼다(마침표
 * 삭제, 금액 콤마). 그래서 원문 절단은 마침표 경계(`truncateAtSentence`)로 하고,
 * 서식 뒤의 100자 보장은 `finalizeSummary` 가 한다. 중복 검사도 서식 뒤의 모양으로
 * 한다 — 담당자에게 보이는 것이 그것이다.
 *
 * 그 대가: (1)에 금액 콤마가 붙어 100자를 넘으면 `finalizeSummary` 가 끝 문장을 한 번
 * 더 떨구고, 그 문장은 (2)로 넘어가지 않는다. 겹치지는 않고 빠질 뿐이다 — 발췌는
 * 원래 본문의 일부만 싣는 것이라 이쪽이 위치 계산을 서식과 엮는 것보다 낫다.
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
  for (const raw of slices) {
    const s = finalizeSummary(raw, MAX_SUMMARY_CHARS)
    if (!s) continue
    if (out.some(existing => isNearDuplicate(existing, s))) continue
    out.push(s)
  }
  return out.slice(0, SUMMARY_VARIANTS.length)
}
