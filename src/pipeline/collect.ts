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
import { SUMMARY_VARIANTS } from '@/providers/summarize/prompt'
import { pLimit } from './limit'
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
  needsPendingRevert,
  buildFallbackSummaries,
  briefRunStartData,
} from './collectHelpers'

/** 본문이 짧아 요약 자체를 시도하지 않은 경우의 사유 — 화면에 "사유 미기록"으로
 * 뜨지 않도록 남긴다. summariesFailed 에는 넣지 않는다(의도된 결정이지 장애가 아니다). */
const EMPTY_BODY_REASON = '본문이 너무 짧아 요약을 생략함'
/** 할당량 소진 이후 아예 시도하지 않고 건너뛴 경우의 사유. */
const QUOTA_EXHAUSTED_REASON = '할당량 소진 이후 요약을 건너뜀'

/** Gemini 무료 티어 한도에 맞춘 동시 호출 수. 늘리면 429가 난다. */
const SUMMARY_CONCURRENCY = 4

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

export async function runCollection(now: Date): Promise<{
  runId: string
  ok: number
  failed: number
  candidatesCreated: number
  summariesGenerated: number
  summariesSkippedEmptyBody: number
  summariesFailed: number
  bodyCrawlFailed: number
  ytdBaseFailed: number
  newsFailed: number
  newsRecordFailed: number
  fxFailed: number
  quoteFailed: number
}> {
  const runDate = kstDateString(now)
  const year = Number(runDate.slice(0, 4))

  const instruments = await prisma.instrument.findMany({ orderBy: { displayOrder: 'asc' } })

  // briefRunStartData가 statusDetail도 함께 null로 비운다 — 그러지 않으면 재실행
  // 도중 화면에 지난 실행의 실패 사유가 오늘 것처럼 남는다(collectHelpers.ts 참고).
  const run = await prisma.briefRun.upsert({
    where: { runDate },
    ...briefRunStartData(runDate),
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

  // 2) 시세
  const quotes = await fetchAllQuotes(targets)

  // 3) 연초대비 기준가(전년 마지막 거래일 종가) — 캐시에 없는 종목만 조회.
  // 기준가를 못 구해도 나머지 열은 계속 채운다. 다만 조용히 넘어가지는 않는다 —
  // 어느 종목이 왜 비었는지 로그와 반환값에 남긴다(재현되지 않는 공란 방지).
  let ytdBaseFailed = 0
  const cached = await prisma.ytdBasePrice.findMany({ where: { year } })
  const cachedIds = new Set(cached.map(c => c.instrumentId))
  const missing = targets.filter(t => !cachedIds.has(t.id))
  if (missing.length > 0) {
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
            runId: run.id, instrumentId: inst.id, sourceName: inst.quoteSource,
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
          sourceName: inst.quoteSource,
        },
      })
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
  }

  // 5) 뉴스 수집 + 별칭 필터 + 클러스터링.
  // 검색 성공 여부를 NewsFetch 에 남긴다 — 이게 없으면 "후보 0건"이 "오늘 기사가 없다"와
  // "검색을 못 했다" 두 가지를 동시에 뜻하게 되고, 화면은 그 둘을 구분할 수 없다.
  let newsFailed = 0
  // 검색 결과를 DB 에 남기지 못한 종목 수. 이 행은 화면에서 근거 없이
  // 「당일·D-1 기사 없음」으로 단정된다(recordNewsFetch 주석 참고) — 행별로는
  // 바로잡을 수 없어도 실행 단위 배너에는 반드시 남아야 한다.
  let newsRecordFailed = 0
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
        }
      }),
    ),
  )

  // 6) 후보 저장 + 같은 사건 표시 + 요약 3안 생성
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
  const quotaGuard = createQuotaGuard()

  const sumLimit = pLimit(SUMMARY_CONCURRENCY)
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
            const attempt = await attemptSummary(
              { title: c.representative.title, body: body.text },
              quotaGuard,
              summarize,
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
            // 'failed' | 'skipped-quota-exhausted' — 모델 요약은 없지만 후보를 빈 칸으로
            // 남기지 않는다. 이미 손에 있는 본문/스니펫에서 발췌한 대체 요약을 채운다
            // (재요청하지 않는다). summaryError 는 그대로 남겨 모델이 아니라 발췌라는 걸
            // 검수자/운영자가 알 수 있게 한다.
            const errorMessage = attempt.outcome === 'failed' ? attempt.error : QUOTA_EXHAUSTED_REASON
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
            summariesFailed++
          })
          // isolate가 예외를 삼켰다면(예: newsCandidate.create 자체가 실패) worker 내부의
          // summariesFailed 증가는 일어나지 않았다 — 여기서 집계한다.
          if (!handled) summariesFailed++
        }),
      )
    }),
  )

  // 7) Selection 행 준비 (없는 것만)
  for (const inst of instruments) {
    await prisma.selection.upsert({
      where: { runId_instrumentId: { runId: run.id, instrumentId: inst.id } },
      update: {},
      create: { runId: run.id, instrumentId: inst.id, decision: 'PENDING' },
    })
  }

  // status 와 statusDetail 은 같은 카운터 여섯 개에서 나온다. 둘이 어긋나지 않도록
  // 문구 조립은 collectHelpers 의 순수 함수에 두고 테스트가 짝을 지킨다.
  const status = computeRunStatus(summariesFailed, ytdBaseFailed, newsFailed, fxFailed, quoteFailed, newsRecordFailed)
  const statusDetail = buildStatusDetail({
    quoteFailed,
    summariesFailed,
    candidatesCreated,
    ytdBaseFailed,
    newsFailed,
    newsRecordFailed,
    missingCurrencies,
  })
  await prisma.briefRun.update({
    where: { id: run.id },
    data: { status, statusDetail, finishedAt: new Date() },
  })

  return { runId: run.id, ok, failed, candidatesCreated, summariesGenerated, summariesSkippedEmptyBody, summariesFailed, bodyCrawlFailed, ytdBaseFailed, newsFailed, newsRecordFailed, fxFailed, quoteFailed }
}
