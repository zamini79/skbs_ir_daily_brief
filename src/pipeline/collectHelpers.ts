import { marketCapKrwTrillion } from '@/domain/calc'
import { tokenize, jaccard } from './cluster'

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
