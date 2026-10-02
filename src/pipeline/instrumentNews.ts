import type { NewsItem } from '@/providers/news/types'
import { ownsNews } from '@/domain/newsShare'
import { filterByTitleMention, topClusters } from './cluster'
import { resolveAliases, wantsMarketWrapNews } from './collectHelpers'
import { priorityNewsRuleFor, selectRowClusters, type RankedCluster } from './priorityNews'

/**
 * 종목 하나의 뉴스 단계 — **무엇을 검색하고 무엇을 후보로 남길지**를 정한다.
 *
 * collect.ts 의 루프 본문에 있던 판단을 여기로 옮겼다. collect.ts 는 최상단에서 Prisma 를
 * 끌어와 어떤 테스트도 import 하지 못한다 — 이 저장소가 두 번 연속 「상수는 고정했는데
 * 배선은 무방비」 결함을 낸 자리다. 그래서 판단(공유 행은 검색하지 않는다, 우선 기사를
 * rank 1 로 넣는다, 우선 검색 실패를 갈라 센다)은 전부 이 함수 안에 있고, 검색은 주입받는다.
 * collect.ts 에 남는 것은 DB 기록과 카운터 합산뿐이다.
 *
 * 검색(search)은 호출부가 NEWS_CONCURRENCY=1 큐 **안에서** 부른다. 우선 검색도 같은
 * 작업 안에서 이어 부르므로 같은 큐·같은 재시도 경로(searchNaverNews 의 429 1회 재시도)를
 * 그대로 탄다 — 별도 동시 호출이 생기지 않는다.
 */

export type InstrumentNewsOutcome =
  /** 이 행은 자기 뉴스를 갖지 않는다(domain/newsShare.ts). 검색하지 않았고 기록할 것도 없다. */
  | { kind: 'shared' }
  /** 기본 검색 실패. 사유는 원문 그대로다. 우선 검색은 시도하지 않는다(아래 주석). */
  | { kind: 'failed'; error: string }
  | {
      kind: 'ok'
      clusters: RankedCluster[]
      /**
       * 우선 기사 단계의 결과.
       *   none      — 이 행에는 규칙이 없다
       *   found     — 찾아서 rank 1 로 넣었다
       *   not-found — 검색은 됐지만 조건에 맞는 기사가 없다(발행 전일 수 있다 — 정상)
       *   failed    — 검색 자체가 실패했다. clusters 는 기존 결과 그대로다
       */
      priority:
        | { status: 'none' }
        | { status: 'found'; title: string }
        | { status: 'not-found' }
        | { status: 'failed'; error: string }
    }

export async function gatherInstrumentNews(
  inst: { name: string; quoteSymbol: string; newsQuery: string; newsAliases: string },
  topN: number,
  deps: { search: (query: string) => Promise<NewsItem[]>; now: Date },
): Promise<InstrumentNewsOutcome> {
  if (!ownsNews(inst.quoteSymbol)) return { kind: 'shared' }

  let ranked: RankedCluster[]
  try {
    const items = await deps.search(inst.newsQuery)
    const filtered = filterByTitleMention(items, resolveAliases(inst))
    // 이 값을 넘기지 않으면 시황·수급 기사가 KOSPI·S&P500 행에서도 감점되어 지금 잘
    // 뽑히는 1순위가 전부 바뀐다(cluster.ts 의 newsPenalty 참고). inst.isIndex 를 쓰면
    // 안 된다 — 코스피200 헬스케어도 지수지만 업종 동향을 원한다(collectHelpers.ts 의
    // MARKET_WRAP_ROWS). 자르기 전 순위 전체를 받는 것은 우선 기사가 같은 사건 묶음을
    // 뺀 뒤 그 아래 순위로 2..topN 을 채우기 때문이다.
    ranked = topClusters(filtered, Infinity, { wantsMarketWrap: wantsMarketWrapNews(inst) })
  } catch (e) {
    // 기본 검색이 실패하면 우선 검색도 하지 않는다. 그 행은 NEWS_FAILED(「뉴스 조회
    // 실패 — 확인 필요」)로 남아야 한다 — 우선 기사 한 건만 들어오면 후보가 생겨
    // 행이 평범한 「미검토」로 보이고, 2·3순위가 왜 없는지(조회 실패) 사라진다.
    return { kind: 'failed', error: e instanceof Error ? e.message : String(e) }
  }

  const rule = priorityNewsRuleFor(inst.quoteSymbol)
  if (rule === null) {
    return { kind: 'ok', clusters: selectRowClusters(ranked, null, topN), priority: { status: 'none' } }
  }

  try {
    // 별칭 필터를 거치지 않는다 — 우선 기사 제목에는 지수명이 없다(priorityNews.ts 머리 주석).
    // 대신 pick 의 조건(연합뉴스·제목 규칙·당일)이 그 자리를 맡는다.
    const picked = rule.pick(await deps.search(rule.query), deps.now)
    return {
      kind: 'ok',
      clusters: selectRowClusters(ranked, picked, topN),
      priority: picked === null ? { status: 'not-found' } : { status: 'found', title: picked.title },
    }
  } catch (e) {
    // 행의 기존 뉴스는 그대로 둔다(채워져 있으니 담당자가 할 일은 없다). 다만 조용히
    // 넘어가지 않는다 — 호출부가 priorityNewsFailed 로 세어 statusDetail 에 적는다.
    return {
      kind: 'ok',
      clusters: selectRowClusters(ranked, null, topN),
      priority: { status: 'failed', error: e instanceof Error ? e.message : String(e) },
    }
  }
}
