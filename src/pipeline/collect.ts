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
  resolveFxRate,
  resolveMarketCap,
  computeSameEventAsRank,
  createQuotaGuard,
  attemptSummary,
  computeRunStatus,
  isolate,
  needsPendingRevert,
  buildFallbackSummaries,
} from './collectHelpers'

/** 본문이 짧아 요약 자체를 시도하지 않은 경우의 사유 — 화면에 "사유 미기록"으로
 * 뜨지 않도록 남긴다. summariesFailed 에는 넣지 않는다(의도된 결정이지 장애가 아니다). */
const EMPTY_BODY_REASON = '본문이 너무 짧아 요약을 생략함'
/** 할당량 소진 이후 아예 시도하지 않고 건너뛴 경우의 사유. */
const QUOTA_EXHAUSTED_REASON = '할당량 소진 이후 요약을 건너뜀'

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
  ytdBaseFailed: number
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
  // NewsCandidate 를 지우면 그 후보를 가리키던 Selection.chosenCandidateId/chosenSummaryId 는
  // FK(onDelete: SetNull)에 의해 DB가 곧바로 null로 되돌린다 — 존재하지 않는 행을 가리키는
  // 일은 없다. 다만 decision 은 그 자체로는 되돌아가지 않으므로 아래에서 명시적으로 되돌린다.
  await prisma.newsCandidate.deleteMany({ where: { runId: run.id } })
  await prisma.quoteSnapshot.deleteMany({ where: { runId: run.id } })

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
  const currencies = [...new Set(instruments.map(i => i.currency))]
  const fx = await fetchFxToKrw(currencies).catch(() => ({} as Record<string, number>))

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
          asOf: q.asOf,
          sourceName: inst.quoteSource,
        },
      })
      ok++
    })
    // isolate가 예외를 삼켰다면(DB 쓰기 자체가 실패 등) worker 내부의 ok/failed 증가는
    // 일어나지 않았다 — 여기서 이 종목만 실패로 집계하고 나머지는 계속 진행한다.
    if (!wrote) failed++
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
            const attempt = await attemptSummary({ title: c.representative.title, body }, quotaGuard, summarize)

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
            const fallbacks = buildFallbackSummaries(body, c.representative.description)
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

  const status = computeRunStatus(summariesFailed, ytdBaseFailed)
  const detailParts: string[] = []
  if (summariesFailed > 0) detailParts.push(`요약 ${summariesFailed}건 실패(후보 ${candidatesCreated}건 중)`)
  if (ytdBaseFailed > 0) detailParts.push(`연초 기준가 ${ytdBaseFailed}종목 조회 실패`)
  await prisma.briefRun.update({
    where: { id: run.id },
    data: {
      status,
      statusDetail: detailParts.length > 0 ? detailParts.join(', ') : null,
      finishedAt: new Date(),
    },
  })

  return { runId: run.id, ok, failed, candidatesCreated, summariesGenerated, summariesSkippedEmptyBody, summariesFailed, ytdBaseFailed }
}
