import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./naver', () => ({
  fetchNaverStock: vi.fn(async (c: string) => ({ close: 100, prevClose: 90, currency: 'KRW', asOf: '2026-08-26' })),
  fetchNaverDomesticIndex: vi.fn(async () => ({ close: 6800, prevClose: 6700, currency: 'KRW', asOf: '2026-08-26' })),
  fetchNaverWorldIndex: vi.fn(async () => ({ close: 7675, prevClose: 7677, currency: 'USD', asOf: '2026-08-26' })),
}))
vi.mock('./twelvedata', () => ({
  fetchTwelveDataQuotes: vi.fn(async () => new Map([['PFE', { close: 28.3, prevClose: 28.57, currency: 'USD', asOf: '2026-08-26' }]])),
}))
vi.mock('./marketstack', () => ({
  fetchMarketstackQuotes: vi.fn(async () => new Map([['GSK.L', { close: 1890.5, prevClose: 1875, currency: 'GBP', asOf: '2026-08-25' }]])),
  fetchMarketstackYearOpen: vi.fn(async () => new Map()),
}))

import { fetchAllQuotes } from './index'
import { fetchNaverStock } from './naver'

beforeEach(() => vi.clearAllMocks())

describe('fetchAllQuotes', () => {
  it('소스별로 알맞은 fetcher 를 부른다', async () => {
    const r = await fetchAllQuotes([
      { id: 'a', quoteSource: 'naver-stock', quoteSymbol: '207940' },
      { id: 'b', quoteSource: 'twelvedata', quoteSymbol: 'PFE' },
      { id: 'c', quoteSource: 'marketstack', quoteSymbol: 'GSK.L' },
    ])
    expect((r.get('a') as any).close).toBe(100)
    expect((r.get('b') as any).close).toBeCloseTo(28.3, 4)
    expect((r.get('c') as any).close).toBeCloseTo(1890.5, 4)
  })

  it('manual 소스는 결과에 넣지 않는다', async () => {
    const r = await fetchAllQuotes([{ id: 'z', quoteSource: 'manual', quoteSymbol: '' }])
    expect(r.has('z')).toBe(false)
  })

  it('한 종목이 실패해도 나머지를 살린다', async () => {
    vi.mocked(fetchNaverStock).mockRejectedValueOnce(new Error('boom'))
    const r = await fetchAllQuotes([
      { id: 'a', quoteSource: 'naver-stock', quoteSymbol: '207940' },
      { id: 'b', quoteSource: 'twelvedata', quoteSymbol: 'PFE' },
    ])
    expect(r.get('a')).toBeInstanceOf(Error)
    expect((r.get('b') as any).close).toBeCloseTo(28.3, 4)
  })

  it('배치 소스에서 빠진 심볼은 Error 로 남긴다', async () => {
    const r = await fetchAllQuotes([{ id: 'x', quoteSource: 'twelvedata', quoteSymbol: 'NOPE' }])
    expect(r.get('x')).toBeInstanceOf(Error)
  })
})
