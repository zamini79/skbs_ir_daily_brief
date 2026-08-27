import { prisma } from '@/db/client'
import { kstDateString } from '@/domain/date'
import { changePct, ytdPct } from '@/domain/calc'
import { fetchFxToKrw } from '@/providers/fx/frankfurter'
import { fetchAllQuotes, type QuoteTarget } from '@/providers/quote'
import { fetchYearOpen } from '@/providers/quote/yearOpen'
import { searchNaverNews } from '@/providers/news/naver'
import { fetchArticleBody } from '@/providers/news/article'
import { topClusters, filterByTitleMention } from './cluster'
import { summarize } from '@/providers/summarize/gemini'
import { SUMMARY_VARIANTS } from '@/providers/summarize/prompt'
import { pLimit } from './limit'
import {
  resolveAliases,
  resolveFxRate,
  resolveMarketCap,
  computeSameEventAsRank,
  createQuotaGuard,
  attemptSummary,
  computeRunStatus,
} from './collectHelpers'

/** Gemini 무료 티어 한도에 맞춘 동시 호출 수. 늘리면 429가 난다. */
const SUMMARY_CONCURRENCY = 4
const NEWS_CONCURRENCY = 5
const TOP_N = 3

export async function runCollection(now: Date): Promise<{
  runId: string
  ok: number
  failed: number
  candidatesCreated: number
  summariesGenerated: number
  summariesSkippedEmptyBody: number
  summariesFailed: number
}> {
  const runDate = kstDateString(now)
  const year = Number(runDate.slice(0, 4))

  const instruments = await prisma.instrument.findMany({ orderBy: { displayOrder: 'asc' } })

  const run = await prisma.briefRun.upsert({
    where: { runDate },
    update: { status: 'COLLECTING', startedAt: new Date(), finishedAt: null },
    create: { runDate, tradeDate: runDate, status: 'COLLECTING' },
  })

  // 이전 실행분을 지운다. Selection 은 남긴다(담당자 선택을 덮어쓰지 않는다).
  await prisma.newsCandidate.deleteMany({ where: { runId: run.id } })
  await prisma.quoteSnapshot.deleteMany({ where: { runId: run.id } })

  const targets: QuoteTarget[] = instruments.map(i => ({
    id: i.id, quoteSource: i.quoteSource, quoteSymbol: i.quoteSymbol,
  }))

  // 1) 환율. 실패해도 절대 1로 대체하지 않는다 — 통화가 없으면 그 종목 시총은
  // null로 남는다(resolveFxRate/resolveMarketCap). 국내 종목은 네이버가 시총을
  // 직접 주므로 영향이 없다.
  const currencies = [...new Set(instruments.map(i => i.currency))]
  const fx = await fetchFxToKrw(currencies).catch(() => ({} as Record<string, number>))

  // 2) 시세
  const quotes = await fetchAllQuotes(targets)

  // 3) 연초 기준가 — 캐시에 없는 종목만 조회
  const cached = await prisma.yearOpenPrice.findMany({ where: { year } })
  const cachedIds = new Set(cached.map(c => c.instrumentId))
  const missing = targets.filter(t => !cachedIds.has(t.id))
  if (missing.length > 0) {
    const fetched = await fetchYearOpen(missing, year)
    for (const [instrumentId, price] of fetched) {
      await prisma.yearOpenPrice.upsert({
        where: { instrumentId_year: { instrumentId, year } },
        update: { price },
        create: { instrumentId, year, price },
      })
    }
  }
  const yearOpens = new Map(
    (await prisma.yearOpenPrice.findMany({ where: { year } })).map(c => [c.instrumentId, Number(c.price)]),
  )

  // 4) 시세 저장
  let ok = 0
  let failed = 0
  for (const inst of instruments) {
    const q = quotes.get(inst.id)
    if (!q || q instanceof Error) {
      failed++
      await prisma.quoteSnapshot.create({
        data: {
          runId: run.id, instrumentId: inst.id, sourceName: inst.quoteSource,
          errorMessage: q instanceof Error ? q.message : '소스 없음(수기 입력 대상)',
        },
      })
      continue
    }
    ok++
    const rate = resolveFxRate(inst.currency, fx)
    const yearOpen = yearOpens.get(inst.id)
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
        ytdPct: yearOpen ? ytdPct(q.close, yearOpen) : null,
        marketCapKrwTrillion: cap,
        fxRate: rate,
        asOf: q.asOf,
        sourceName: inst.quoteSource,
      },
    })
  }

  // 5) 뉴스 수집 + 별칭 필터 + 클러스터링
  const newsLimit = pLimit(NEWS_CONCURRENCY)
  const perInstrument = await Promise.all(
    instruments.map(inst =>
      newsLimit(async () => {
        try {
          const items = await searchNaverNews(inst.newsQuery, now)
          const filtered = filterByTitleMention(items, resolveAliases(inst))
          return { inst, clusters: topClusters(filtered, TOP_N) }
        } catch {
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
          const attempt = await attemptSummary({ title: c.representative.title, body }, quotaGuard, summarize)

          switch (attempt.outcome) {
            case 'skipped-empty-body':
              summariesSkippedEmptyBody++
              return
            case 'generated':
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
            case 'failed':
              summariesFailed++
              await prisma.newsCandidate.update({
                where: { id: candidate.id },
                data: { summaryError: attempt.error },
              })
              return
            case 'skipped-quota-exhausted':
              summariesFailed++
              await prisma.newsCandidate.update({
                where: { id: candidate.id },
                data: { summaryError: '할당량 소진 이후 요약을 건너뜀' },
              })
              return
          }
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

  const status = computeRunStatus(summariesFailed)
  await prisma.briefRun.update({
    where: { id: run.id },
    data: {
      status,
      statusDetail: status === 'PARTIAL' ? `요약 ${summariesFailed}건 실패(후보 ${candidatesCreated}건 중)` : null,
      finishedAt: new Date(),
    },
  })

  return { runId: run.id, ok, failed, candidatesCreated, summariesGenerated, summariesSkippedEmptyBody, summariesFailed }
}
