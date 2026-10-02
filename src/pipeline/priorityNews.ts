import { kstDateString } from '@/domain/date'
import type { NewsItem } from '@/providers/news/types'
import { jaccard, tokenize, CLUSTER_THRESHOLD } from './cluster'

/**
 * ─── 우선 기사(1순위 고정) ────────────────────────────────────────────────
 *
 * 2026-10-02 담당자 피드백: 지수 두 행은 **연합뉴스의 정해진 아침 기사**를 1순위로 넣는다.
 *
 *   S&P500 — 새벽 6시경 「뉴욕증시 … (종합)」
 *            예: 美국채 금리 고공행진에 뉴욕증시 약보합…다우 0.3%↓(종합)
 *   KOSPI  — 7~8시경 「[마켓뷰] …」
 *            예: [마켓뷰] 美금리 악재 속 반도체주 상승…코스피 반등 시도하나
 *
 * **왜 기존 검색·클러스터링으로는 안 되는가** (2026-10-02 11:32 KST 네이버 검색 API 실측):
 *  - S&P500 의 검색어 `뉴욕증시` 결과 100건 안에 그날 06:10 종합 기사가 **없었다**.
 *    시황 기사가 워낙 많아 다섯 시간 만에 100건 밖으로 밀려났다.
 *  - 들어왔더라도 그 제목(「美국채 금리 따라 등락 반복한 뉴욕증시…강보합 마감(종합)」)에는
 *    `S&P500` 이 없어 별칭 필터(newsAliases)에 걸려 버려진다.
 * 그래서 전용 검색어로 한 번 더 찾고, 찾으면 별칭 필터를 **우회해** rank 1 로 넣는다.
 *
 * 규칙은 DB 컬럼이 아니라 이 상수다(quoteSymbol 로 고른다). 연합뉴스의 편집 관행에
 * 묶인 규칙이라 바뀔 때는 코드와 그 근거 주석이 함께 바뀌어야 한다.
 *
 * **못 찾는 것은 정상이다.** 아직 발행 전일 수 있다(마켓뷰는 07:47~08:12 발행, 실측
 * 사흘치). 그때는 기존 동작 그대로 간다. 검색 자체가 **실패**한 것은 다르다 —
 * instrumentNews.ts 가 그것을 따로 센다.
 */

/** 연합뉴스. publisher 는 originallink 의 호스트에서 www. 를 뗀 값이다(providers/news/naver.ts). */
const YNA_HOST = 'yna.co.kr'

export function isYonhap(item: Pick<NewsItem, 'publisher'>): boolean {
  return item.publisher === YNA_HOST || item.publisher.endsWith(`.${YNA_HOST}`)
}

/**
 * KST 시(0~23). 한국은 서머타임이 없어 UTC+9 고정이다 — Intl 을 거치지 않고 더한다.
 */
function kstHour(d: Date): number {
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).getUTCHours()
}

/** 실행일(KST)에 발행됐는가. 검색은 D-1 까지 주므로 여기서 한 번 더 좁힌다. */
function publishedOnRunDate(item: NewsItem, now: Date): boolean {
  return kstDateString(item.publishedAt) === kstDateString(now)
}

function latest(items: NewsItem[]): NewsItem | null {
  if (items.length === 0) return null
  return [...items].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())[0]
}

/**
 * 「(종합)」 으로 끝나는 제목. 연합뉴스는 같은 기사를 고쳐 낼 때 「(종합2보)」 처럼
 * 판 번호를 붙이므로 그것도 받는다 — 브리프의 예시는 `(종합)` 하나뿐이지만, 2보가
 * 나온 날 1보를 고르면 낡은 판을 싣게 된다.
 */
const WRAP_SUFFIX = /\(종합(?:\d+보)?\)\s*$/

/**
 * S&P500 — 연합뉴스 「뉴욕증시 종합」.
 *
 * 조건: 연합뉴스 · 제목에 `뉴욕증시` · 실행일(KST) 04:00 이후 발행.
 * 그중 `(종합)` 으로 끝나는 것을 먼저, 없으면 `마감` 이 든 것(종합 전에 나오는 속보판,
 * 실측 05:22 「…강보합 마감」). 같은 조건이 여럿이면 최신.
 *
 * `뉴욕증시` 를 요구하는 이유: 같은 검색어로 「美 10년물 5.34% 최고치 경신…글로벌
 * 국채 투매 심화(종합)」(08:02) 도 나온다. 뉴욕증시 기사가 아니다.
 * 04:00 하한은 자정 넘어 나오는 장중 시황(「…혼조 출발」 류)을 거르기 위한 것이다.
 * 미국 장 마감은 KST 05:00(서머타임) / 06:00(해제)이라 마감 기사는 늘 그 뒤에 나온다.
 */
export function pickNyseWrap(items: NewsItem[], now: Date): NewsItem | null {
  const eligible = items.filter(
    it =>
      isYonhap(it) &&
      it.title.includes('뉴욕증시') &&
      publishedOnRunDate(it, now) &&
      kstHour(it.publishedAt) >= 4,
  )
  return latest(eligible.filter(it => WRAP_SUFFIX.test(it.title))) ?? latest(eligible.filter(it => it.title.includes('마감')))
}

/**
 * KOSPI — 연합뉴스 「[마켓뷰]」.
 *
 * 조건: 연합뉴스 · 제목이 `[마켓뷰]` 로 시작 · **실행일(KST) 당일** 발행.
 * 검색 결과에는 매일 것이 줄줄이 나온다(실측: 10-02, 10-01, 09-30 …). 전날 마켓뷰는
 * 전날 장을 내다본 기사라 오늘 칸에 실으면 안 된다 — 당일 것이 아직 없으면 고르지 않는다.
 */
export function pickKospiMarketView(items: NewsItem[], now: Date): NewsItem | null {
  return latest(
    items.filter(it => isYonhap(it) && it.title.trimStart().startsWith('[마켓뷰]') && publishedOnRunDate(it, now)),
  )
}

export type PriorityNewsRule = {
  /** 기존 검색과 별도로 한 번 더 던지는 검색어. */
  query: string
  pick: (items: NewsItem[], now: Date) => NewsItem | null
}

/** quoteSymbol → 규칙. 여기 없는 행은 추가 검색을 하지 않는다. */
export const PRIORITY_NEWS_RULES: Readonly<Record<string, PriorityNewsRule>> = {
  '.INX': { query: '뉴욕증시 종합', pick: pickNyseWrap },
  KOSPI: { query: '마켓뷰', pick: pickKospiMarketView },
}

export function priorityNewsRuleFor(quoteSymbol: string): PriorityNewsRule | null {
  return PRIORITY_NEWS_RULES[quoteSymbol] ?? null
}

export type RankedCluster = {
  representative: NewsItem
  size: number
  penalty: number
  members: NewsItem[]
}

/**
 * 행에 실을 후보를 정한다. `ranked` 는 topClusters 가 **자르기 전** 순위 전체다.
 *
 * 우선 기사가 없으면 기존 결과(앞에서 topN)를 그대로 준다.
 * 있으면 그것을 rank 1 로 두고, rank 2..topN 은 기존 순위에서 **우선 기사와 같은 사건인
 * 묶음을 뺀 뒤** 채운다. 같은 사건의 판정은 클러스터링과 같은 규칙이다 — 묶음의 어느
 * 멤버든 URL 이 같거나 제목 유사도가 임계값 이상이면 같은 사건이다(topClusters 가 새
 * 기사를 묶음에 넣는 조건과 같다). 그렇게 빠진 묶음의 기사는 우선 기사의 보도 수에
 * 더한다 — 화면의 「N개 매체」가 그 사건의 실제 보도량을 말하게.
 */
export function selectRowClusters(
  ranked: RankedCluster[],
  priority: NewsItem | null,
  topN: number,
): RankedCluster[] {
  if (priority === null) return ranked.slice(0, topN)

  const pTokens = tokenize(priority.title)
  const sameEvent = (m: NewsItem) =>
    m.url === priority.url ||
    (priority.naverUrl !== null && m.naverUrl === priority.naverUrl) ||
    (pTokens.length > 0 && jaccard(tokenize(m.title), pTokens) >= CLUSTER_THRESHOLD)

  const rest: RankedCluster[] = []
  const absorbed: NewsItem[] = []
  for (const c of ranked) {
    if (c.members.some(sameEvent)) absorbed.push(...c.members)
    else rest.push(c)
  }

  const urls = new Set([priority.url, ...absorbed.map(m => m.url)])
  const head: RankedCluster = {
    representative: priority,
    size: urls.size,
    penalty: 0,
    members: [priority, ...absorbed.filter(m => m.url !== priority.url)],
  }
  return [head, ...rest].slice(0, topN)
}
