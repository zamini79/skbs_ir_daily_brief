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
 * 제목에 별칭이 하나라도 등장하는 기사만 남긴다.
 * 공백은 양쪽 모두 제거하고("삼성 바이오" ↔ "삼성바이오"), 대소문자를 구분하지 않는다.
 * (GSK, Sanofi 같은 라틴 문자 별칭 대응). 클러스터링과는 별개의 전처리 단계로 분리해
 * 두 함수를 각각 독립적으로 테스트할 수 있게 한다.
 * aliases 가 비어 있으면 필터링하지 않고 원본을 그대로 반환한다 — 설정 누락으로
 * 화면이 조용히 비는 것을 막기 위함이다.
 */
export function filterByTitleMention(items: NewsItem[], aliases: string[]): NewsItem[] {
  if (aliases.length === 0) return items
  const needles = aliases.map(a => a.replace(/\s+/g, '').toLowerCase())
  return items.filter(it => {
    const haystack = it.title.replace(/\s+/g, '').toLowerCase()
    return needles.some(n => haystack.includes(n))
  })
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
