import { prisma } from '@/db/client'
import { kstDateString } from '@/domain/date'
import { changePct, ytdPct } from '@/domain/calc'
import { fetchFxToKrw } from '@/providers/fx/frankfurter'
import { fetchAllQuotes, type QuoteTarget } from '@/providers/quote'
import { fetchYtdBase } from '@/providers/quote/ytdBase'
import { searchNaverNews } from '@/providers/news/naver'
import { fetchArticleBody } from '@/providers/news/article'
import { topClusters, filterByTitleMention } from './cluster'
import { summarize } from '@/providers/summarize/gemini'
import { createRateLimitBudget } from '@/providers/summarize/rateLimitBudget'
import { SUMMARY_VARIANTS } from '@/providers/summarize/prompt'
import { pLimit } from './limit'
import { createPacer } from './pacer'
import { SUMMARY_CONCURRENCY, SUMMARY_MIN_INTERVAL_MS, createSummaryCaller } from './summaryPolicy'
import {
  resolveAliases,
  wantsMarketWrapNews,
  missingFxCurrencies,
  resolveFxRate,
  currencyMismatchReason,
  normalizeAsOf,
  resolveMarketCap,
  computeSameEventAsRank,
  createQuotaGuard,
  attemptSummary,
  computeRunStatus,
  buildStatusDetail,
  isolate,
  createDeadline,
  needsPendingRevert,
  buildFallbackSummaries,
  briefRunStartData,
} from './collectHelpers'
import { createProgressReporter } from './progressReporter'
import { SUMMARY_DEADLINE_MS } from '@/domain/runProgress'

/** 본문이 짧아 요약 자체를 시도하지 않은 경우의 사유 — 화면에 "사유 미기록"으로
 * 뜨지 않도록 남긴다. summariesFailed 에는 넣지 않는다(의도된 결정이지 장애가 아니다). */
const EMPTY_BODY_REASON = '본문이 너무 짧아 요약을 생략함'
/** 할당량 소진 이후 아예 시도하지 않고 건너뛴 경우의 사유. */
const QUOTA_EXHAUSTED_REASON = '할당량 소진 이후 요약을 건너뜀'

/** 마감에 걸려 요약을 시작조차 못한 후보의 사유. summariesFailed 와 갈라 센다. */
const DEADLINE_REASON = '요약 단계 마감 시간 초과로 생성하지 못함(재실행하면 채워집니다)'

/**
 * 네이버 검색 API 는 순간 속도 제한이 있다(일일 한도와 별개 — 하루 총 호출은 100회 남짓인데도
 * 429 가 난다). 23종목 실측(2026-08-27):
 *
 *     동시성 5 : 성공 10  429 13   0.5초   <- 실패가 뒤쪽(9, 12~23번)에 몰린다
 *     동시성 2 : 성공 23  429  0   5.7초
 *     동시성 1 : 성공 23  429  0   3.4초   <- 콜드 상태
 *     동시성 1 : 성공 19  429  4   2.0초   <- 직전 호출로 예산이 깎인 상태
 *
 * 종목은 displayOrder 순으로 처리되므로 동시성을 올리면 **매일 같은 뒤쪽 행**이 빈다
 * (해외사 후반부와 지수 4행). 3.4초는 07:40~08:00 수집 창에서 무의미한 비용이다.
 * 성능을 이유로 이 값을 올리지 마라 — 위 표가 그 대가다.
 *
 * 마지막 줄이 보여주듯 1이어도 429 가 완전히 사라지지는 않는다. searchNaverNews 의
 * 1회 재시도가 나머지를 덮는다.
 */
const NEWS_CONCURRENCY = 1
const TOP_N = 3

/**
 * 종목별 뉴스 검색 결과를 남긴다. 이 기록 자체가 실패해도 수집을 멈추지 않는다 —
 * 여기서 예외를 던져 뉴스 단계 전체를 무너뜨리는 것보다는 낫다.
 *
 * **다만 조용히 넘어가지는 않는다.** 기록이 없으면 rowDisplayState 가 그 행을
 * NO_NEWS 로 보고 화면이 「당일·D-1 기사 없음」이라고 **단정**한다(repo.ts) —
 * 검색이 실패했는데도 그렇다. 기록 실패를 삼키면 그 단정이 근거 없이 서고,
 * 그것은 이 코드베이스가 반복해서 고쳐 온 바로 그 결함이다.
 * 그래서 성공 여부를 돌려주고 호출부가 실행 단위로 집계한다.
 */
async function recordNewsFetch(
  runId: string,
  instrumentId: string,
  status: 'OK' | 'FAILED',
  error: string | null,
): Promise<boolean> {
  try {
    await prisma.newsFetch.upsert({
      where: { runId_instrumentId: { runId, instrumentId } },
      update: { status, error },
      create: { runId, instrumentId, status, error },
    })
    return true
  } catch (e) {
    console.error(`[news] 상태 기록 실패 (${instrumentId}): ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

export type CollectionResult = {
  runId: string
  ok: number
  failed: number
  candidatesCreated: number
  summariesGenerated: number
  summariesSkippedEmptyBody: number
  summariesFailed: number
  /** 요약 단계 마감에 걸려 **시도하지 못한** 후보 수. 실패가 아니다 — 갈라 센다. */
  summariesSkippedDeadline: number
  /** 실행 재시도 예산이 모자라 분당 한도 재시도를 포기한 횟수. 0이 아니면 그날 붐볐다는 뜻. */
  rateLimitRetriesDenied: number
  bodyCrawlFailed: number
  ytdBaseFailed: number
  newsFailed: number
  newsRecordFailed: number
  fxFailed: number
  quoteFailed: number
  /** 1차 소스가 실패해 2차(폴백)로 채운 행의 수. 실패가 아니다 — 아래 선언부 주석 참고. */
  quoteFallbackUsed: number
}

/**
 * 예외로 끝난 실행을 `COLLECTING` 인 채로 남기지 않는다.
 *
 * 이게 없으면 파이프라인이 예외를 던진 날의 행이 영원히 「수집 중」으로 보인다 —
 * 아무것도 돌고 있지 않은데 화면은 도는 중이라고 말한다. 실제로 2026-08-26 행이
 * 그 상태로 남아 있었고, 이 코드베이스가 반복해서 고쳐 온 결함(어떤 상태가 다른
 * 상태와 똑같이 렌더된다)의 살아 있는 예다.
 *
 * **`updateMany` 에 `status: 'COLLECTING'` 조건을 건다.** 그 사이 다른 실행이
 * 이 날짜를 다시 선점해 정상적으로 돌고 있을 수 있는데, 조건 없이 덮으면 멀쩡히
 * 도는 실행을 실패로 만든다.
 *
 * 이 기록 자체가 실패해도 삼킨다 — 원래 예외를 가리면 안 된다. 호출부(크론 라우트,
 * 서버 액션)는 여전히 원래 예외를 받는다.
 *
 * 프로세스가 통째로 죽는 경우는 여기서 잡을 수 없다. 그쪽은 화면이
 * `startedAt` 경과 시간으로 판정한다(`domain/runProgress.ts`).
 */
async function markRunFailed(runDate: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error)
  try {
    await prisma.briefRun.updateMany({
      where: { runDate, status: 'COLLECTING' },
      data: {
        status: 'FAILED',
        statusDetail: `수집이 중단됐습니다: ${message}`,
        progressDetail: null,
        finishedAt: new Date(),
      },
    })
  } catch (e) {
    console.error(`[collect] 실패 상태 기록 실패 (${runDate}): ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * 수집 실행. 크론 라우트와 화면의 「수집 실행」 버튼이 **둘 다 이 함수 하나**를 부른다
 * (수집 로직을 두 벌로 만들지 않는다 — 설계 문서 §4.1-3).
 */
export type CollectionOptions = {
  /**
   * 요약 단계 마감 시한. 기본값은 `SUMMARY_DEADLINE_MS`(domain/runProgress.ts)이고,
   * 주입할 수 있게 둔 것은 테스트가 20분을 실제로 기다리지 않기 위해서다.
   */
  summaryDeadlineMs?: number
}

export async function runCollection(now: Date, opts: CollectionOptions = {}): Promise<CollectionResult> {
  try {
    return await collect(now, opts)
  } catch (e) {
    await markRunFailed(kstDateString(now), e)
    throw e
  }
}

async function collect(now: Date, opts: CollectionOptions = {}): Promise<CollectionResult> {
  const runDate = kstDateString(now)
  const year = Number(runDate.slice(0, 4))

  const instruments = await prisma.instrument.findMany({ orderBy: { displayOrder: 'asc' } })

  // briefRunStartData가 statusDetail도 함께 null로 비운다 — 그러지 않으면 재실행
  // 도중 화면에 지난 실행의 실패 사유가 오늘 것처럼 남는다(collectHelpers.ts 참고).
  const run = await prisma.briefRun.upsert({
    where: { runDate },
    ...briefRunStartData(runDate),
  })

  /**
   * 단계마다 `BriefRun.progressDetail` 을 갱신한다. 실측 457.7초짜리 작업이라
   * (2026-09-01, 후보 37건. 감속 이전에는 202초였다)
   * 아무 표시도 없으면 화면은 "고장 났다"와 구별되지 않는다.
   *
   * 쓰기는 뒤에서 돌고 수집을 붙잡지 않는다(progressReporter.ts 참고).
   * **건수는 아래 실제 카운터에서만 온다** — 지어낸 진행률을 쓰지 않는다.
   */
  const progress = createProgressReporter(async text => {
    // **`status: 'COLLECTING'` 조건이 붙어 있다.** 실행이 끝났거나(READY/PARTIAL)
    // 예외로 FAILED 가 기록된 뒤에 뒤늦게 도착한 진행 쓰기가 완료된 행에 단계
    // 문구를 되살리면, 끝난 실행이 다시 도는 것처럼 보인다. 조건이 없으면 예외
    // 경로(progress.close() 를 부르지 못하는 경로)에서 실제로 그렇게 된다.
    await prisma.briefRun.updateMany({
      where: { id: run.id, status: 'COLLECTING' },
      data: { progressDetail: text },
    })
  })

  // 이전 실행분을 지운다. Selection 은 남긴다(담당자 선택을 덮어쓰지 않는다).
  // NewsCandidate 를 지우면 그 후보를 가리키던 Selection.chosenCandidateId/chosenSummaryId 는
  // FK(onDelete: SetNull)에 의해 DB가 곧바로 null로 되돌린다 — 존재하지 않는 행을 가리키는
  // 일은 없다. 다만 decision 은 그 자체로는 되돌아가지 않으므로 아래에서 명시적으로 되돌린다.
  await prisma.newsCandidate.deleteMany({ where: { runId: run.id } })
  await prisma.quoteSnapshot.deleteMany({ where: { runId: run.id } })
  await prisma.newsFetch.deleteMany({ where: { runId: run.id } })

  // 재실행으로 참조가 null이 됐는데 decision이 여전히 SELECTED면, 존재하지 않는 후보를
  // 가리키는 "완료된 선택"처럼 보인다 — 검수자가 알아채길 기대하지 않고 PENDING으로
  // 되돌린다. editedText는 건드리지 않는다(검수자의 작업물이므로 이 update의 data에
  // 애초에 넣지 않는다 — 아래 { decision: 'PENDING' } 뿐이다).
  const existingSelections = await prisma.selection.findMany({ where: { runId: run.id } })
  const toRevert = existingSelections.filter(needsPendingRevert)
  if (toRevert.length > 0) {
    await prisma.selection.updateMany({
      where: { id: { in: toRevert.map(s => s.id) } },
      data: { decision: 'PENDING' },
    })
  }

  const targets: QuoteTarget[] = instruments.map(i => ({
    id: i.id, quoteSource: i.quoteSource, quoteSymbol: i.quoteSymbol,
    // 2차 소스는 1차가 실패한 날에만 쓰인다(providers/quote/index.ts 의 폴백 단계).
    // 연초 기준가는 여기와 무관하게 여전히 1차 경로(marketstack)로 간다 — ytdBase.ts 는
    // quoteSource 로만 라우팅하므로 이 두 필드가 그 배선을 건드리지 않는다.
    quoteFallbackSource: i.quoteFallbackSource,
    quoteFallbackSymbol: i.quoteFallbackSymbol,
  }))

  // 1) 환율. 실패해도 절대 1로 대체하지 않는다 — 통화가 없으면 그 종목 시총은
  // null로 남는다(resolveFxRate/resolveMarketCap). 국내 종목은 네이버가 시총을
  // 직접 주므로 영향이 없다.
  //
  // 그 판단은 옳지만(틀린 숫자보다 공란이 낫다) 예전에는 실패가 아무 데도 남지 않아
  // 해외사 9행의 시총이 통째로 조용히 비었다. 이제 어느 통화를 못 구했는지 남긴다.
  //
  // fetchFxToKrw 의 실패 형태는 두 가지이고 서로 구분된다:
  //   전체 실패 — 던진다(HTTP 오류, 또는 KRW 환율 누락). 한 통화도 못 얻는다.
  //   부분 결손 — 정상 반환하지만 특정 통화 키가 빠져 있다(frankfurter.ts 의
  //               `if (!usdToC) continue`). 나머지 통화는 멀쩡하다.
  // 요청한 통화와 돌려받은 키를 비교하면 둘 다 같은 방식으로 잡힌다.
  progress.step('fx')
  const currencies = [...new Set(instruments.map(i => i.currency))]
  let fx: Record<string, number> = {}
  let fxError: string | null = null
  try {
    fx = await fetchFxToKrw(currencies)
  } catch (e) {
    fxError = e instanceof Error ? e.message : String(e)
  }
  // 카운터는 종목이 아니라 **통화** 개수다. 환율은 종목별 사실이 아니라 실행별·통화별
  // 사실이라서, 종목 수로 세면 같은 통화를 쓰는 종목 수에 따라 숫자가 부풀려진다.
  // missingFxCurrencies는 KRW를 절대 담지 않는다 — 국내 종목은 네이버가 시총을
  // 직접 주므로 환율이 통째로 없어도 국내 행은 전혀 영향받지 않는다(collectHelpers.ts 참고).
  const missingCurrencies = missingFxCurrencies(currencies, fx)
  const fxFailed = missingCurrencies.length
  if (fxFailed > 0) {
    // 사유는 있는 그대로 남긴다. 전체 실패면 원문 메시지가, 부분 결손이면 그 사실이 붙는다.
    const why = fxError ?? '응답에 해당 통화 환율이 없음'
    console.error(`[fx] 환율 미확보: ${missingCurrencies.join(', ')} — ${why}`)
  }

  // 2) 시세.
  // `fetchAllQuotes` 는 배치라 중간 진행을 알려주지 않는다 — 건수를 지어내지 않고
  // 단계 이름만 남긴다.
  progress.step('quote')
  const quotes = await fetchAllQuotes(targets)

  // 3) 연초대비 기준가(전년 마지막 거래일 종가) — 캐시에 없는 종목만 조회.
  // 기준가를 못 구해도 나머지 열은 계속 채운다. 다만 조용히 넘어가지는 않는다 —
  // 어느 종목이 왜 비었는지 로그와 반환값에 남긴다(재현되지 않는 공란 방지).
  let ytdBaseFailed = 0
  const cached = await prisma.ytdBasePrice.findMany({ where: { year } })
  const cachedIds = new Set(cached.map(c => c.instrumentId))
  const missing = targets.filter(t => !cachedIds.has(t.id))
  if (missing.length > 0) {
    // 대부분의 날은 캐시가 차 있어 이 단계가 통째로 건너뛰어진다. 조회할 게 있을
    // 때만 단계를 알린다 — 없는데 「연초 기준가 조회 중」을 띄우면 거짓말이다.
    progress.step('ytdBase')
    const { prices, failures } = await fetchYtdBase(missing, year)
    for (const [instrumentId, price] of prices) {
      await prisma.ytdBasePrice.upsert({
        where: { instrumentId_year: { instrumentId, year } },
        update: { price },
        create: { instrumentId, year, price },
      })
    }
    ytdBaseFailed = failures.length
    for (const f of failures) {
      // 심볼과 사유만 남긴다. URL 에는 API 키가 들어 있으므로 절대 싣지 않는다.
      console.error(`[ytdBase] ${f.symbol}: ${f.reason}`)
    }
  }
  const ytdBases = new Map(
    (await prisma.ytdBasePrice.findMany({ where: { year } })).map(c => [c.instrumentId, Number(c.price)]),
  )

  // 4) 시세 저장. 종목 하나의 DB 쓰기가 실패해도(일시적 접속 장애 등) 나머지 22종목은
  // 계속 저장돼야 한다 — try/catch로 격리하지 않으면 예외가 루프를 끊고 Step 7과 최종
  // 상태 갱신까지 전부 건너뛴다.
  let ok = 0
  let failed = 0
  // `failed` 와 `quoteFailed` 는 일부러 다르다.
  //   failed      — 이번 실행에서 시세 값을 얻지 못한 행 전부. 수기 입력 대상(quoteSource
  //                 'manual', 애초에 수집하지 않는다)도 포함한다. 크론 응답 JSON 의
  //                 기존 의미를 그대로 유지한다.
  //   quoteFailed — 그중 **실제로 실패한** 행만. 이 값이 배너(BriefRun.status/statusDetail)를
  //                 움직인다. 의도된 공란(manual)을 장애로 세면 매일 PARTIAL 이 떠서
  //                 배너가 아무 뜻도 없어진다 — 지금은 manual 종목이 없지만, 운영 문서가
  //                 KRX 약관 문제 시 이 행을 manual 로 되돌리라고 안내하고 있다.
  let quoteFailed = 0
  /**
   * 1차가 실패해 2차(폴백) 소스로 채운 행의 수.
   *
   * **`computeRunStatus` 에는 넣지 않는다 — 의도한 판단이다.** 이 행들은 다섯 칸이
   * 정상적으로 채워졌고 담당자가 오늘 아침에 할 일이 없다. PARTIAL 은 "이 실행에서
   * 무언가를 얻지 못했다"는 뜻이고, 얻은 실행을 매번 「부분 완료」로 물들이면
   * 배너가 뜻을 잃는다(bodyCrawlFailed 를 배너에서 뺀 것과 같은 규칙이다).
   *
   * 그렇다고 조용히 넘어가면 안 된다 — 1차가 몇 주째 죽어 있어도 아무도 모르는
   * 것이 이 장치의 가장 큰 위험이다. 그래서 **세 군데에 남긴다**:
   *   1) 행마다 화면에 「ft 대체」 배지 (db/repo.ts 의 quoteFallbackSourceUsed)
   *   2) `[quote] … 1차(…) 실패로 2차(…)를 썼다` 로그 (providers/quote/index.ts)
   *   3) 이 카운터 — 크론 응답 JSON 에 실려 나간다
   * 셋 중 어느 것도 배너를 흔들지 않지만, 셋 다 매일 보인다.
   */
  let quoteFallbackUsed = 0
  /** 진행 표시 전용 카운터. 성공/실패와 무관하게 **처리를 끝낸 행 수**다. */
  let quoteSaved = 0
  for (const inst of instruments) {
    const q = quotes.get(inst.id)
    const { ok: wrote } = await isolate(async () => {
      if (!q || q instanceof Error) {
        await prisma.quoteSnapshot.create({
          data: {
            runId: run.id, instrumentId: inst.id, sourceName: inst.quoteSource,
            errorMessage: q instanceof Error ? q.message : '소스 없음(수기 입력 대상)',
          },
        })
        failed++
        // Error 인 경우만 장애다. q 가 아예 없는 것은 fetchAllQuotes 가 manual 을
        // 의도적으로 제외한 결과이지 실패가 아니다(providers/quote/index.ts).
        // 화면 쪽도 같은 규칙으로 가른다 — repo.ts 의 quoteFailureReason 참고.
        if (q instanceof Error) quoteFailed++
        return
      }

      // 값을 받았어도 그 값이 **우리가 기대한 통화의 값**이 아니면 쓰지 않는다.
      // 아래 resolveFxRate 는 시드의 통화로 환율을 고르므로, 응답이 다른 통화면
      // 시총이 환율 배수만큼 조용히 틀리고 가격은 틀린 통화 라벨을 달고 나온다.
      // 시총만 비우는 것으로는 부족하다 — 가격 칸이 여전히 그럴듯한 숫자를
      // 보여주고, close 가 있으면 quoteFailureReason(repo.ts)이 사유를 화면에
      // 올리지 않아 아무 데도 남지 않는다. 그래서 위 실패 분기와 **같은 방식으로**
      // 숫자 없이 사유만 남긴다: 행은 「시세 실패」로 뜨고 배너 카운터에도 잡힌다.
      const mismatch = currencyMismatchReason(inst.currency, q.currency)
      if (mismatch) {
        await prisma.quoteSnapshot.create({
          data: {
            // 값을 버리더라도 **그 값을 준 소스**를 남긴다. 폴백이 돌았는데 2차가
            // 다른 통화를 준 경우, 여기에 1차 이름이 남으면 조사가 엉뚱한 데서 시작된다.
            runId: run.id, instrumentId: inst.id, sourceName: q.sourceName,
            errorMessage: mismatch,
          },
        })
        failed++
        quoteFailed++
        return
      }

      const rate = resolveFxRate(inst.currency, fx)
      const ytdBase = ytdBases.get(inst.id)
      const cap = resolveMarketCap({
        isIndex: inst.isIndex,
        quoteMarketCap: q.marketCapKrwTrillion,
        close: q.close,
        shares: inst.sharesOutstanding === null ? null : Number(inst.sharesOutstanding),
        fxRate: rate,
        priceDivisor: inst.priceDivisorForMarketCap,
      })

      await prisma.quoteSnapshot.create({
        data: {
          runId: run.id,
          instrumentId: inst.id,
          close: q.close,
          prevClose: q.prevClose,
          changePct: changePct(q.close, q.prevClose),
          ytdPct: ytdBase ? ytdPct(q.close, ytdBase) : null,
          marketCapKrwTrillion: cap,
          fxRate: rate,
          asOf: normalizeAsOf(q.asOf),
          // **실제로 값을 가져온 소스**다. 설정값(inst.quoteSource)이 아니다 —
          // 폴백이 돌면 둘이 달라지고, 설정값을 넣으면 이 칸이 거짓말을 한다.
          // 화면의 「대체」 배지도 이 값과 설정값의 차이로 판정한다(db/repo.ts).
          sourceName: q.sourceName,
        },
      })
      // 폴백으로 채운 행. 값이 있으니 실패는 아니지만 1차가 죽었다는 사실은 남긴다.
      if (q.fallbackFrom !== null) quoteFallbackUsed++
      ok++
    })
    // isolate가 예외를 삼켰다면(DB 쓰기 자체가 실패 등) worker 내부의 ok/failed 증가는
    // 일어나지 않았다 — 여기서 이 종목만 실패로 집계하고 나머지는 계속 진행한다.
    // 이 경우는 QuoteSnapshot 자체가 없어서 화면이 사유조차 보여줄 수 없다(행이 통째로
    // 빈다). 사유를 못 남기더라도 배너에는 반드시 남아야 하므로 quoteFailed 로도 센다.
    if (!wrote) {
      failed++
      quoteFailed++
    }
    quoteSaved++
    progress.step('quoteSave', { done: quoteSaved, total: instruments.length })
  }

  // 5) 뉴스 수집 + 별칭 필터 + 클러스터링.
  // 검색 성공 여부를 NewsFetch 에 남긴다 — 이게 없으면 "후보 0건"이 "오늘 기사가 없다"와
  // "검색을 못 했다" 두 가지를 동시에 뜻하게 되고, 화면은 그 둘을 구분할 수 없다.
  let newsFailed = 0
  // 검색 결과를 DB 에 남기지 못한 종목 수. 이 행은 화면에서 근거 없이
  // 「당일·D-1 기사 없음」으로 단정된다(recordNewsFetch 주석 참고) — 행별로는
  // 바로잡을 수 없어도 실행 단위 배너에는 반드시 남아야 한다.
  let newsRecordFailed = 0
  /** 진행 표시 전용. 검색을 마친 종목 수(성공·실패 무관). */
  let newsDone = 0
  progress.step('news', { done: 0, total: instruments.length })
  const newsLimit = pLimit(NEWS_CONCURRENCY)
  const perInstrument = await Promise.all(
    instruments.map(inst =>
      newsLimit(async () => {
        try {
          const items = await searchNaverNews(inst.newsQuery, now)
          const filtered = filterByTitleMention(items, resolveAliases(inst))
          if (!(await recordNewsFetch(run.id, inst.id, 'OK', null))) newsRecordFailed++
          // 이 값을 넘기지 않으면 시황·수급 기사가 KOSPI·S&P500·Nasdaq 행에서도
          // 감점되어 지금 잘 뽑히는 1순위가 전부 바뀐다(cluster.ts 의 newsPenalty 참고).
          // inst.isIndex 를 그대로 쓰면 안 된다 — 코스피200 헬스케어도 지수지만
          // 시황이 아니라 업종 동향을 원한다(collectHelpers.ts 의 MARKET_WRAP_ROWS).
          const wantsMarketWrap = wantsMarketWrapNews(inst)
          return { inst, clusters: topClusters(filtered, TOP_N, { wantsMarketWrap }) }
        } catch (e) {
          // 사유는 그대로 남긴다. 지어내지 않는다 — 담당자가 이 문구를 근거로 판단한다.
          const reason = e instanceof Error ? e.message : String(e)
          newsFailed++
          console.error(`[news] ${inst.name}: ${reason}`)
          if (!(await recordNewsFetch(run.id, inst.id, 'FAILED', reason))) newsRecordFailed++
          return { inst, clusters: [] }
        } finally {
          // 성공이든 실패든 그 종목은 **끝났다.** 성공만 세면 429 가 몇 건 난 날
          // 진행 숫자가 23에 못 미친 채 멈춰, 담당자에게는 파이프라인이 멈춘 것으로
          // 보인다 — 실제로는 다음 단계로 넘어갔는데도.
          newsDone++
          progress.step('news', { done: newsDone, total: instruments.length })
        }
      }),
    ),
  )

  // 6) 후보 저장 + 같은 사건 표시 + 요약 2안 생성
  let candidatesCreated = 0
  let summariesGenerated = 0
  let summariesSkippedEmptyBody = 0
  let summariesFailed = 0
  /**
   * 기사 **본문을 받으려다 실패해** 검색 스니펫으로 요약한 후보 수.
   *
   * 네이버 링크가 아예 없어 스니펫을 쓴 경우는 세지 않는다 — 그건 그 기사에 대한
   * 사실이고 매일 대다수 후보에서 일어난다. 그것까지 세면 이 숫자가 상수가 되어
   * 셀렉터가 깨진 날(모든 후보가 갑자기 추출 0자)을 알아볼 수 없다.
   *
   * 배너(status/statusDetail)에는 넣지 않는다. 요약은 정상적으로 만들어졌고 칸도
   * 비지 않았다 — 나빠진 것은 입력의 폭이지 결과의 유무가 아니다. 기사 한 건의
   * 크롤링 실패로 실행 전체가 매일 「부분 완료」가 되면 배너가 뜻을 잃는다.
   * 대신 사유를 로그에 남기고 크론 응답 JSON 으로 돌려준다
   * (summariesSkippedEmptyBody 와 같은 급의 관측값이다).
   */
  let bodyCrawlFailed = 0

  // 이번 실행 전체가 공유하는 할당량 가드. 첫 429/RESOURCE_EXHAUSTED 이후로는
  // 죽은 할당량에 나머지 후보를 계속 쏘지 않고 곧바로 실패로 기록한다.
  // (⚠ 이 가드는 현재 실제로는 트립되지 않는다 — collectHelpers 의
  //  isQuotaExhaustedMessage 주석 참고. 곱셈을 끊는 일은 rateLimitBudget 과
  //  아래 마감 시한이 맡는다.)
  const quotaGuard = createQuotaGuard()

  /**
   * 요약 단계의 마감 시한.
   *
   * **플랫폼이 죽이기를 기다리지 않고 스스로 멈춘다.** 하드 킬을 당하면 runCollection
   * 의 catch 가 돌지 못해 이 행이 `COLLECTING` 인 채로 남고, 카운터는 하나도 기록되지
   * 않으며, 절반쯤 저장된 후보가 화면에 정상처럼 보인다. 마감은 그 조용한 죽음을
   * **큰 소리의 부분 완료**로 바꾼다 — 아래 루프는 마감 뒤에도 정상 종료 경로를 그대로
   * 타고 status·statusDetail·카운터를 쓴다.
   *
   * 시작점은 이 함수가 시작한 시각이 아니라 **요약 단계에 들어온 시각**이다. 앞
   * 단계(시세·뉴스)가 느렸다고 요약 예산을 깎으면, 정작 마감을 만든 이유(요약이
   * 실행 시간의 대부분이다)와 어긋난다.
   */
  const summaryDeadline = createDeadline(Date.now(), opts.summaryDeadlineMs ?? SUMMARY_DEADLINE_MS)
  /** 마감에 걸려 **시도하지 못한** 후보 수. summariesFailed 와 절대 합치지 않는다. */
  let summariesSkippedDeadline = 0

  /**
   * 이번 실행에서 처리할 후보의 **총 개수**. 지어낸 값이 아니라 방금 뽑아 놓은
   * 클러스터를 실제로 센 것이다. 요약이 실행 시간의 대부분을 차지하므로(후보 47건 ×
   * 수 초) 여기만은 반드시 건수를 세어 보여준다 — 이 단계가 표시 없이 3분을 먹으면
   * 담당자는 고장으로 판단하고 버튼을 다시 누른다.
   */
  const summaryTotal = perInstrument.reduce((n, p) => n + p.clusters.length, 0)
  /** 진행 표시 전용. 처리를 끝낸 후보 수(생성·요약·실패 무관). */
  let summaryDone = 0
  progress.step('summary', { done: 0, total: summaryTotal })

  const sumLimit = pLimit(SUMMARY_CONCURRENCY)
  /**
   * 호출 간 최소 간격은 **provider 안이 아니라 여기**에 둔다.
   *
   *  - 간격은 기사 한 건의 성질이 아니라 **이번 배치가 무료 티어 쿼터를 얼마나
   *    빨리 먹느냐**의 성질이다. 그래서 같은 질문에 답하는 SUMMARY_CONCURRENCY
   *    바로 옆에 있어야 한다 — 둘이 다른 파일에 흩어지면 한쪽만 되돌아간다.
   *  - `summarize()` 는 "기사 하나 → 요약 하나"의 순수한 단위다. 거기에 호출
   *    간 상태를 넣으면 앞으로 생길 모든 호출부가 6초를 말없이 물려받고,
   *    단위 테스트가 실행 순서에 의존하게 된다.
   *  - provider 안쪽에서 기다려야 하는 것은 분당 한도에 **실제로 걸렸을 때**의
   *    재시도 대기이고, 그건 이미 거기 있다(gemini.ts RATE_LIMIT_DELAYS_MS).
   *
   * 합성 자체(`createSummaryCaller`)는 **이 파일에 두지 않는다.** 여기 있던 동안
   * `{ budget }` 을 지워도 테스트 933개가 전부 통과했다 — 이 파일이 Prisma 를 끌어와
   * 테스트가 import 할 수 없기 때문이다. 배선은 테스트가 보는 자리에 있어야 한다.
   */
  const summaryPace = createPacer(SUMMARY_MIN_INTERVAL_MS)
  /**
   * **이 실행 전체가 공유하는** 분당 한도 재시도 예산. 후보마다 새로 만들면 아무것도
   * 막지 못한다 — 끊으려는 것이 바로 후보 수만큼의 곱셈이다(rateLimitBudget.ts).
   */
  const rateLimitBudget = createRateLimitBudget()
  const pacedSummarize = createSummaryCaller({
    pace: summaryPace,
    budget: rateLimitBudget,
    summarize,
  })
  await Promise.all(
    perInstrument.flatMap(({ inst, clusters }) => {
      const sameEventMap = computeSameEventAsRank(
        clusters.map((c, idx) => ({ rank: idx + 1, title: c.representative.title })),
      )
      return clusters.map((c, idx) =>
        sumLimit(async () => {
          const rank = idx + 1
          // 이 후보 하나의 처리(생성/본문수집/요약/DB 기록) 중 어디서든 예기치 못한 오류가
          // 나면 이 후보만 실패로 격리한다 — Promise.all 전체를 무너뜨려 Step 7과 최종
          // 상태 갱신을 건너뛰게 하면 안 된다.
          const { ok: handled } = await isolate(async () => {
            const candidate = await prisma.newsCandidate.create({
              data: {
                runId: run.id,
                instrumentId: inst.id,
                rank,
                title: c.representative.title,
                url: c.representative.naverUrl ?? c.representative.url,
                publisher: c.representative.publisher,
                publishedAt: c.representative.publishedAt,
                clusterSize: c.size,
                sameEventAsRank: sameEventMap.get(rank) ?? null,
              },
            })
            candidatesCreated++

            const body = await fetchArticleBody(c.representative)
            if (body.crawlFailure !== null) {
              bodyCrawlFailed++
              // 제목만 남긴다. 기사 URL 은 싣지 않는다(로그 규칙 — providers 전반).
              console.error(`[article] ${c.representative.title}: ${body.crawlFailure}`)
            }
            // **마감 판정은 attemptSummary 안에 있다.** 본문 수집까지는 마치게 두는데,
            // 그 본문이 있어야 발췌 대체 요약이라도 채워 행이 빈칸으로 남지 않기
            // 때문이다. 아끼는 것은 뒤에 오는 비싼 부분(6초 간격 + Gemini 호출 +
            // 분당 한도 재시도)이다.
            const attempt = await attemptSummary(
              { title: c.representative.title, body: body.text },
              quotaGuard,
              pacedSummarize,
              summaryDeadline,
            )

            if (attempt.outcome === 'skipped-empty-body') {
              // 뽑아낼 본문 자체가 없으니 발췌 대체 요약도 만들 수 없다 — 그래도 사유는
              // 남긴다. 화면이 "사유 미기록"을 보여주지 않도록.
              await prisma.newsCandidate.update({
                where: { id: candidate.id },
                data: { summaryError: EMPTY_BODY_REASON },
              })
              summariesSkippedEmptyBody++
              return
            }
            if (attempt.outcome === 'generated') {
              await prisma.newsSummary.createMany({
                data: SUMMARY_VARIANTS.map(v => ({
                  candidateId: candidate.id,
                  variant: v.variant,
                  text: attempt.summary[v.key],
                })),
              })
              await prisma.newsCandidate.update({
                where: { id: candidate.id },
                data: { summaryModel: attempt.summary.model },
              })
              summariesGenerated++
              return
            }
            // 'failed' | 'skipped-quota-exhausted' | 'skipped-deadline' — 모델 요약은
            // 없지만 후보를 빈 칸으로 남기지 않는다. 이미 손에 있는 본문/스니펫에서
            // 발췌한 대체 요약을 채운다(재요청하지 않는다). summaryError 는 그대로
            // 남겨 모델이 아니라 발췌라는 걸 검수자/운영자가 알 수 있게 한다.
            const errorMessage =
              attempt.outcome === 'failed' ? attempt.error
              : attempt.outcome === 'skipped-deadline' ? DEADLINE_REASON
              : QUOTA_EXHAUSTED_REASON
            await prisma.newsCandidate.update({
              where: { id: candidate.id },
              data: { summaryError: errorMessage },
            })
            const fallbacks = buildFallbackSummaries(body.text, c.representative.description)
            if (fallbacks.length > 0) {
              await prisma.newsSummary.createMany({
                data: fallbacks.map((text, i) => ({
                  candidateId: candidate.id,
                  variant: SUMMARY_VARIANTS[i].variant,
                  text,
                  isFallback: true,
                })),
              })
            }
            // **마감은 실패가 아니다.** 시간이 없어 시작하지 않은 것이고, 둘을 합치면
            // 담당자가 원인을 가릴 수 없다(전자는 원인을 봐야 하고 후자는 다시 돌리면 된다).
            if (attempt.outcome === 'skipped-deadline') summariesSkippedDeadline++
            else summariesFailed++
          })
          // isolate가 예외를 삼켰다면(예: newsCandidate.create 자체가 실패) worker 내부의
          // summariesFailed 증가는 일어나지 않았다 — 여기서 집계한다.
          if (!handled) summariesFailed++
          // 성공·실패 무관하게 이 후보는 끝났다. 실패한 후보를 세지 않으면 요약이
          // 무더기로 실패한 날 진행 숫자가 총계에 못 미친 채 멈춘다.
          summaryDone++
          progress.step('summary', { done: summaryDone, total: summaryTotal })
        }),
      )
    }),
  )

  // 7) Selection 행 준비 (없는 것만)
  progress.step('finish')
  for (const inst of instruments) {
    await prisma.selection.upsert({
      where: { runId_instrumentId: { runId: run.id, instrumentId: inst.id } },
      update: {},
      create: { runId: run.id, instrumentId: inst.id, decision: 'PENDING' },
    })
  }

  // status 와 statusDetail 은 같은 카운터 여섯 개에서 나온다. 둘이 어긋나지 않도록
  // 문구 조립은 collectHelpers 의 순수 함수에 두고 테스트가 짝을 지킨다.
  // **quoteFallbackUsed 는 일부러 여기에 없다** — 값을 얻은 행이므로 배너를 흔들지
  // 않는다. 대신 행 배지·로그·크론 응답에 남는다(위 quoteFallbackUsed 선언부 참고).
  // 마감으로 못 한 건이 있으면 「준비 완료」일 수 없다 — 초록 배너 아래에 빈 요약을
  // 두는 것이 이 저장소가 반복해서 고쳐 온 결함이다.
  const status = computeRunStatus(
    summariesFailed,
    ytdBaseFailed,
    newsFailed,
    fxFailed,
    quoteFailed,
    newsRecordFailed,
    summariesSkippedDeadline,
  )
  const statusDetail = buildStatusDetail({
    quoteFailed,
    summariesFailed,
    candidatesCreated,
    ytdBaseFailed,
    newsFailed,
    newsRecordFailed,
    summariesSkippedDeadline,
    rateLimitRetriesDenied: rateLimitBudget.deniedCount,
    missingCurrencies,
  })
  // 완료 상태를 적기 **전에** 진행 리포터를 닫는다. 닫지 않으면 뒤에서 돌던 마지막
  // 진행 쓰기가 이 update 뒤에 도착해, 끝난 실행에 「마무리 중」이 다시 붙는다.
  // 차단기가 걸린 날은 **조용히 지나가지 않는다.** 카운터는 DB(statusDetail)와 크론
  // 응답에 남고, 예산 쪽은 사유 문구가 후보별 summaryError 에 남는다. 여기서는 실행
  // 단위 요약을 로그에 한 줄 남겨 운영자가 그날의 성격을 바로 알 수 있게 한다.
  if (rateLimitBudget.deniedCount > 0 || summariesSkippedDeadline > 0) {
    console.error(
      `[collect] 분당 한도 재시도 예산 ${rateLimitBudget.spentMs}/${rateLimitBudget.totalMs}ms 사용, ` +
        `재시도 거절 ${rateLimitBudget.deniedCount}회, 마감으로 미생성 ${summariesSkippedDeadline}건`,
    )
  }

  await progress.close()

  await prisma.briefRun.update({
    where: { id: run.id },
    // progressDetail 은 여기서 비운다. 남겨 두면 완료된 행이 마지막 단계 문구를
    // 계속 들고 있어, 화면이 그걸 근거로 도는 중이라고 말할 여지가 생긴다.
    // 「멈춘 것으로 보이는」 실행에서만 이 값이 살아남아 마지막 도달 단계를 알려준다.
    data: { status, statusDetail, progressDetail: null, finishedAt: new Date() },
  })

  return { runId: run.id, ok, failed, candidatesCreated, summariesGenerated, summariesSkippedEmptyBody, summariesFailed, summariesSkippedDeadline, rateLimitRetriesDenied: rateLimitBudget.deniedCount, bodyCrawlFailed, ytdBaseFailed, newsFailed, newsRecordFailed, fxFailed, quoteFailed, quoteFallbackUsed }
}
