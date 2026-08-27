import { describe, it, expect } from 'vitest'
import { normalizeTitle, jaccard, topClusters } from './cluster'
import type { NewsItem } from '@/providers/news/types'

function item(title: string, opts: Partial<NewsItem> = {}): NewsItem {
  return {
    title,
    url: opts.url ?? `https://x.com/${encodeURIComponent(title)}`,
    naverUrl: opts.naverUrl ?? null,
    publisher: opts.publisher ?? 'x.com',
    publishedAt: opts.publishedAt ?? new Date('2026-08-27T06:00:00+09:00'),
    description: '',
  }
}

describe('normalizeTitle', () => {
  it('대괄호 말머리를 없앤다', () => {
    expect(normalizeTitle('[속보] 셀트리온 매출 증가')).toBe('셀트리온 매출 증가')
  })
  it('따옴표와 기호를 없앤다', () => {
    expect(normalizeTitle('셀트리온, "글로벌 톱3" 굳힌다…')).toBe('셀트리온 글로벌 톱3 굳힌다')
  })
  it('연속 공백을 하나로 줄인다', () => {
    expect(normalizeTitle('셀트리온   매출')).toBe('셀트리온 매출')
  })
})

describe('jaccard', () => {
  it('완전히 같으면 1이다', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1)
  })
  it('겹치지 않으면 0이다', () => {
    expect(jaccard(['a'], ['b'])).toBe(0)
  })
  it('절반 겹치면 1/3이다', () => {
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 6)
  })
  it('둘 다 비면 0이다', () => {
    expect(jaccard([], [])).toBe(0)
  })
})

describe('topClusters', () => {
  it('많이 보도된 사건을 앞에 놓는다', () => {
    const items = [
      item('셀트리온 글로벌 톱3 굳힌다'),
      item('셀트리온, 글로벌 톱3 지위 굳힌다'),
      item('셀트리온 글로벌 톱3 굳힌다고 밝혀'),
      item('셀트리온 신규 공장 착공'),
    ]
    const r = topClusters(items, 3)
    expect(r[0].size).toBe(3)
    expect(r[1].size).toBe(1)
  })

  it('최대 topN 개만 준다', () => {
    const items = ['가나다 사건', '라마바 사건', '사아자 사건', '차카타 사건'].map(t => item(t))
    expect(topClusters(items, 3)).toHaveLength(3)
  })

  it('기사가 없으면 빈 배열을 준다', () => {
    expect(topClusters([], 3)).toEqual([])
  })

  it('대표 기사는 네이버뉴스 링크가 있는 쪽을 고른다', () => {
    const items = [
      item('셀트리온 글로벌 톱3 굳힌다'),
      item('셀트리온 글로벌 톱3 굳힌다 확정', { naverUrl: 'https://n.news.naver.com/1' }),
    ]
    const r = topClusters(items, 3)
    expect(r[0].representative.naverUrl).toContain('n.news.naver.com')
  })
})
