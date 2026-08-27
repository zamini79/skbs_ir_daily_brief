import type { NewsItem } from '@/providers/news/types'

/** 같은 사건으로 볼 제목 유사도 임계값 */
const THRESHOLD = 0.5

export function normalizeTitle(title: string): string {
  return title
    .replace(/\[[^\]]*\]/g, ' ')       // [속보], [단독] 같은 말머리
    .replace(/[「」『』<>《》]/g, ' ')
    .replace(/["'"'`]/g, ' ')
    .replace(/[,.…·:;!?~\-–—()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenize(title: string): string[] {
  return normalizeTitle(title)
    .split(' ')
    .filter(t => [...t].length >= 2)
}

export function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size === 0 && sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : inter / union
}

/** 네이버뉴스 링크가 있으면 우선, 그다음 최신순으로 대표 기사를 고른다. */
function pickRepresentative(members: NewsItem[]): NewsItem {
  return [...members].sort((a, b) => {
    const an = a.naverUrl ? 0 : 1
    const bn = b.naverUrl ? 0 : 1
    if (an !== bn) return an - bn
    return b.publishedAt.getTime() - a.publishedAt.getTime()
  })[0]
}

/**
 * 제목 유사도로 묶은 뒤 묶음 크기(=보도 빈도) 상위 topN 개를 반환한다.
 * 탐욕적 클러스터링이다. 기사 100건 규모에서는 충분하고 결과가 안정적이다.
 */
export function topClusters(
  items: NewsItem[],
  topN: number,
): Array<{ representative: NewsItem; size: number }> {
  const clusters: Array<{ tokens: string[]; members: NewsItem[] }> = []

  for (const it of items) {
    const tokens = tokenize(it.title)
    if (tokens.length === 0) continue
    const hit = clusters.find(c => jaccard(c.tokens, tokens) >= THRESHOLD)
    if (hit) {
      hit.members.push(it)
    } else {
      clusters.push({ tokens, members: [it] })
    }
  }

  return clusters
    .sort((a, b) => {
      if (b.members.length !== a.members.length) return b.members.length - a.members.length
      // 동점이면 최신 기사가 있는 묶음을 앞에 둔다
      const at = Math.max(...a.members.map(m => m.publishedAt.getTime()))
      const bt = Math.max(...b.members.map(m => m.publishedAt.getTime()))
      return bt - at
    })
    .slice(0, topN)
    .map(c => ({ representative: pickRepresentative(c.members), size: c.members.length }))
}
