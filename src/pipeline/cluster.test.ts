import { describe, it, expect } from 'vitest'
import { normalizeTitle, jaccard, topClusters, filterByTitleMention } from './cluster'
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

describe('filterByTitleMention', () => {
  it('제목에 회사명이 있으면 남기고 없으면 뺀다', () => {
    const items = [
      item('삼성바이오로직스 파업 끝나나'),
      item('엔비디아 훈풍…코스피 7000선'),
    ]
    const r = filterByTitleMention(items, ['삼성바이오로직스'])
    expect(r).toHaveLength(1)
    expect(r[0].title).toBe('삼성바이오로직스 파업 끝나나')
  })

  it('공백 유무와 무관하게 매칭한다', () => {
    const items = [item('삼성 바이오 특허 등록')]
    const r = filterByTitleMention(items, ['삼성바이오'])
    expect(r).toHaveLength(1)
  })

  it('대소문자를 구분하지 않는다', () => {
    const items = [item('gsk 백신 부문 실적 발표')]
    const r = filterByTitleMention(items, ['GSK'])
    expect(r).toHaveLength(1)
  })

  it('여러 별칭 중 두번째만 맞아도 남긴다', () => {
    const items = [item('유바이오로직스 백신 임상 결과 발표')]
    const r = filterByTitleMention(items, ['잘못된별칭', '유바이오로직스'])
    expect(r).toHaveLength(1)
  })

  it('별칭이 비어 있으면 원본을 그대로 준다', () => {
    const items = [item('아무 상관 없는 기사')]
    expect(filterByTitleMention(items, [])).toEqual(items)
  })

  it('실제 실패 재현: 회사 기사 하나와 코스피 시황 기사들 중 회사 기사만 남는다', () => {
    const items = [
      item('삼성바이오로직스 파업 추석 전에 끝나나'),
      item('엔비디아 훈풍…코스피 7000선 돌파'),
      item('코스피, 금리 인상에 흔들렸지만 6900선대 강세'),
      item('엔비디아 효과…코스피 2%대 상승'),
    ]
    const r = filterByTitleMention(items, ['삼성바이오로직스'])
    expect(r).toHaveLength(1)
    expect(r[0].title).toBe('삼성바이오로직스 파업 추석 전에 끝나나')
  })

  it('인덱스 케이스: 별칭이 코스피면 코스피 시황 기사도 남는다', () => {
    const items = [
      item('코스피, 금리 인상에 흔들렸지만 6900선대 강세'),
      item('삼성바이오로직스 파업 추석 전에 끝나나'),
    ]
    const r = filterByTitleMention(items, ['코스피'])
    expect(r).toHaveLength(1)
    expect(r[0].title).toBe('코스피, 금리 인상에 흔들렸지만 6900선대 강세')
  })
})

describe('topClusters — 전이적 유사도 (모든 멤버와 비교)', () => {
  // 토큰 집합을 의도적으로 구성한다:
  //   A = {aa, bb, cc}
  //   B = {bb, cc, dd}
  //   C = {cc, dd, ee}
  // J(A,B) = |{bb,cc}| / |{aa,bb,cc,dd}|       = 2/4 = 0.5  (임계값 이상 → 유사)
  // J(B,C) = |{cc,dd}| / |{bb,cc,dd,ee}|       = 2/4 = 0.5  (임계값 이상 → 유사)
  // J(A,C) = |{cc}|     / |{aa,bb,cc,dd,ee}|   = 1/5 = 0.2  (임계값 미만 → 비유사)
  // 창설 멤버(A)하고만 비교하면 C 는 새 묶음이 되어 버린다. 모든 멤버와 비교해야
  // B 를 매개로 A-B-C 가 하나의 사건으로 묶인다.
  const A = 'aa bb cc'
  const B = 'bb cc dd'
  const C = 'cc dd ee'

  it('A, B, C 순서로 들어와도 하나의 묶음이 된다', () => {
    const items = [item(A), item(B), item(C)]
    const r = topClusters(items, 3)
    expect(r).toHaveLength(1)
    expect(r[0].size).toBe(3)
  })

  it('C, B, A 역순으로 들어와도 하나의 묶음이 된다 (순서에 무관하다)', () => {
    const items = [item(C), item(B), item(A)]
    const r = topClusters(items, 3)
    expect(r).toHaveLength(1)
    expect(r[0].size).toBe(3)
  })

  it('서로 무관한 두 제목은 여전히 별개의 묶음이 된다', () => {
    const items = [item('ff gg hh'), item('ii jj kk')]
    const r = topClusters(items, 3)
    expect(r).toHaveLength(2)
    expect(r[0].size).toBe(1)
    expect(r[1].size).toBe(1)
  })

  it('병합 후 묶음 크기는 실제 멤버 수와 같다 (검토자에게 보이는 숫자)', () => {
    const items = [item(A), item(B), item(C)]
    const r = topClusters(items, 3)
    expect(r[0].size).toBe(3)
  })
})
