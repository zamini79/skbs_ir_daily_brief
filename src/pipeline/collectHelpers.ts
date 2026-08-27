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
 * (스펙 §3.2 주의 1). marketstack 은 실측상 `GSK.L` 에 `GBP` 를 주는데, 언젠가
 * 표기를 `GBX` 로 고치더라도 그건 표기 개선이지 다른 상장으로 갈아탄 것이
 * 아니므로 멀쩡한 행을 버리면 안 된다.
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
export function computeRunStatus(
  summariesFailed: number,
  ytdBaseFailed = 0,
  newsFailed = 0,
  fxFailed = 0,
  quoteFailed = 0,
  newsRecordFailed = 0,
): 'READY' | 'PARTIAL' {
  return summariesFailed > 0 ||
    ytdBaseFailed > 0 ||
    newsFailed > 0 ||
    fxFailed > 0 ||
    quoteFailed > 0 ||
    newsRecordFailed > 0
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
  if (counts.missingCurrencies.length > 0) {
    parts.push(`환율 미확보: ${counts.missingCurrencies.join(', ')} (시가총액 공란)`)
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
 */
export function briefRunStartData(runDate: string): {
  update: { status: 'COLLECTING'; statusDetail: null; startedAt: Date; finishedAt: null }
  create: { runDate: string; tradeDate: string; status: 'COLLECTING' }
} {
  return {
    update: { status: 'COLLECTING', statusDetail: null, startedAt: new Date(), finishedAt: null },
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
