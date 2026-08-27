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
  fetchMarketstackYtdBase: vi.fn(async () => new Map()),
}))

import { fetchAllQuotes } from './index'
import { fetchNaverStock, fetchNaverDomesticIndex, fetchNaverWorldIndex } from './naver'
import { fetchTwelveDataQuotes } from './twelvedata'
import { fetchMarketstackQuotes } from './marketstack'

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

  it('알 수 없는 quoteSource 는 Error 로 남기고 값이 사라지지 않는다', async () => {
    const r = await fetchAllQuotes([{ id: 'typo', quoteSource: 'naver-stok', quoteSymbol: '207940' }])
    expect(r.has('typo')).toBe(true)
    expect(r.get('typo')).toBeInstanceOf(Error)
    expect((r.get('typo') as Error).message).toContain('naver-stok')
  })

  it('naver-index 이고 심볼이 . 로 시작하면 해외지수 fetcher 를 부른다', async () => {
    const r = await fetchAllQuotes([{ id: 'w', quoteSource: 'naver-index', quoteSymbol: '.INX' }])
    expect((r.get('w') as any).close).toBe(7675)
    expect(fetchNaverWorldIndex).toHaveBeenCalledWith('.INX')
    expect(fetchNaverDomesticIndex).not.toHaveBeenCalled()
  })

  it('naver-index 이고 심볼이 . 로 시작하지 않으면 국내지수 fetcher 를 부른다', async () => {
    const r = await fetchAllQuotes([{ id: 'k', quoteSource: 'naver-index', quoteSymbol: 'KOSPI' }])
    expect((r.get('k') as any).close).toBe(6800)
    expect(fetchNaverDomesticIndex).toHaveBeenCalledWith('KOSPI')
    expect(fetchNaverWorldIndex).not.toHaveBeenCalled()
  })

  it('twelvedata 가 전체 실패하면 해당 배치의 모든 종목이 Error 이고 다른 그룹은 영향받지 않는다', async () => {
    vi.mocked(fetchTwelveDataQuotes).mockRejectedValueOnce(new Error('td down'))
    const r = await fetchAllQuotes([
      { id: 'a', quoteSource: 'naver-stock', quoteSymbol: '207940' },
      { id: 'b', quoteSource: 'twelvedata', quoteSymbol: 'PFE' },
      { id: 'c', quoteSource: 'twelvedata', quoteSymbol: 'JNJ' },
      { id: 'd', quoteSource: 'marketstack', quoteSymbol: 'GSK.L' },
    ])
    expect(r.get('b')).toBeInstanceOf(Error)
    expect(r.get('c')).toBeInstanceOf(Error)
    expect((r.get('a') as any).close).toBe(100)
    expect((r.get('d') as any).close).toBeCloseTo(1890.5, 4)
  })

  it('marketstack 가 전체 실패하면 해당 배치의 모든 종목이 Error 이고 다른 그룹은 영향받지 않는다', async () => {
    vi.mocked(fetchMarketstackQuotes).mockRejectedValueOnce(new Error('ms down'))
    const r = await fetchAllQuotes([
      { id: 'a', quoteSource: 'naver-stock', quoteSymbol: '207940' },
      { id: 'c', quoteSource: 'marketstack', quoteSymbol: 'GSK.L' },
      { id: 'd', quoteSource: 'marketstack', quoteSymbol: 'AZN.L' },
      { id: 'b', quoteSource: 'twelvedata', quoteSymbol: 'PFE' },
    ])
    expect(r.get('c')).toBeInstanceOf(Error)
    expect(r.get('d')).toBeInstanceOf(Error)
    expect((r.get('a') as any).close).toBe(100)
    expect((r.get('b') as any).close).toBeCloseTo(28.3, 4)
  })
})
