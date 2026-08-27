import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./naver', () => ({
  fetchNaverStock: vi.fn(async (c: string) => ({ close: 100, prevClose: 90, currency: 'KRW', asOf: '2026-08-26' })),
  fetchNaverDomesticIndex: vi.fn(async () => ({ close: 6800, prevClose: 6700, currency: 'KRW', asOf: '2026-08-26' })),
  fetchNaverWorldIndex: vi.fn(async () => ({ close: 7675, prevClose: 7677, currency: 'USD', asOf: '2026-08-26' })),
  fetchNaverWorldStock: vi.fn(async () => ({ close: 50.5, prevClose: 50.75, currency: 'HKD', asOf: '2026-08-27' })),
}))
vi.mock('./lse', () => ({
  fetchLseQuote: vi.fn(async () => ({ close: 1852, prevClose: 1899.5, currency: 'GBX', asOf: '2026-08-27' })),
}))
vi.mock('./six', () => ({
  fetchSixQuote: vi.fn(async () => ({ close: 588.4, prevClose: 587.8, currency: 'CHF', asOf: '2026-08-27' })),
}))
vi.mock('./twelvedata', () => ({
  fetchTwelveDataQuotes: vi.fn(async () => ({
    quotes: new Map([['PFE', { close: 28.3, prevClose: 28.57, currency: 'USD', asOf: '2026-08-26' }]]),
    failures: new Map(),
  })),
}))
vi.mock('./krx', () => ({
  fetchKrxIndexQuote: vi.fn(async () => ({ close: 2173.53, prevClose: 2108.2, currency: 'KRW', asOf: '2026-08-26' })),
}))
vi.mock('./marketstack', () => ({
  fetchMarketstackQuotes: vi.fn(async () => new Map([['GSK.L', { close: 1890.5, prevClose: 1875, currency: 'GBP', asOf: '2026-08-25' }]])),
  fetchMarketstackYtdBase: vi.fn(async () => new Map()),
}))

import { fetchAllQuotes } from './index'
import {
  fetchNaverStock,
  fetchNaverDomesticIndex,
  fetchNaverWorldIndex,
  fetchNaverWorldStock,
} from './naver'
import { fetchTwelveDataQuotes } from './twelvedata'
import { fetchMarketstackQuotes } from './marketstack'
import { fetchKrxIndexQuote } from './krx'
import { fetchLseQuote } from './lse'
import { fetchSixQuote } from './six'

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

  it('krx-index 는 KRX 지수 fetcher 로 간다 — 심볼이 . 로 시작하지 않아도 네이버로 새지 않는다', async () => {
    const r = await fetchAllQuotes([
      { id: 'h', quoteSource: 'krx-index', quoteSymbol: '코스피 200 헬스케어' },
    ])
    expect((r.get('h') as any).close).toBeCloseTo(2173.53, 2)
    expect(fetchKrxIndexQuote).toHaveBeenCalledWith('코스피 200 헬스케어')
    expect(fetchNaverDomesticIndex).not.toHaveBeenCalled()
    expect(fetchNaverStock).not.toHaveBeenCalled()
  })

  it('krx-index 가 실패해도 다른 종목은 살아남고 사유가 Error 로 남는다', async () => {
    vi.mocked(fetchKrxIndexQuote).mockRejectedValueOnce(new Error('[코스피 200 헬스케어] 거래일을 찾지 못함'))
    const r = await fetchAllQuotes([
      { id: 'h', quoteSource: 'krx-index', quoteSymbol: '코스피 200 헬스케어' },
      { id: 'a', quoteSource: 'naver-stock', quoteSymbol: '207940' },
    ])
    expect(r.get('h')).toBeInstanceOf(Error)
    expect((r.get('h') as Error).message).toContain('거래일을 찾지 못함')
    expect((r.get('a') as any).close).toBe(100)
  })

  // ── Task 31: GSK·Lonza·Wuxi 를 marketstack 에서 무료 거래소 엔드포인트로 옮겼다 ──

  it('lse·six·naver-world-stock 은 각자의 fetcher 로 가고 marketstack 을 부르지 않는다', async () => {
    // 이 셋이 marketstack 으로 새면 옮긴 의미가 없다(월 88회로 되돌아간다).
    const r = await fetchAllQuotes([
      { id: 'gsk', quoteSource: 'lse', quoteSymbol: 'GSK' },
      { id: 'lonn', quoteSource: 'six', quoteSymbol: 'LONN' },
      { id: 'wuxi', quoteSource: 'naver-world-stock', quoteSymbol: '2269.HK' },
    ])
    expect((r.get('gsk') as any).close).toBe(1852)
    expect((r.get('lonn') as any).close).toBeCloseTo(588.4, 4)
    expect((r.get('wuxi') as any).close).toBeCloseTo(50.5, 4)
    expect(fetchLseQuote).toHaveBeenCalledWith('GSK')
    expect(fetchSixQuote).toHaveBeenCalledWith('LONN')
    expect(fetchNaverWorldStock).toHaveBeenCalledWith('2269.HK')
    expect(fetchMarketstackQuotes).not.toHaveBeenCalled()
  })

  it('naver-world-stock 은 국내주·지수 fetcher 로 새지 않는다', async () => {
    // 같은 파일(naver.ts)에 있고 심볼이 . 을 포함하므로(2269.HK) 분기가 헷갈리기 쉽다.
    await fetchAllQuotes([{ id: 'wuxi', quoteSource: 'naver-world-stock', quoteSymbol: '2269.HK' }])
    expect(fetchNaverStock).not.toHaveBeenCalled()
    expect(fetchNaverDomesticIndex).not.toHaveBeenCalled()
    expect(fetchNaverWorldIndex).not.toHaveBeenCalled()
  })

  it('사노피는 여전히 marketstack 이고, 옮긴 세 종목이 실패해도 서로 영향이 없다', async () => {
    // 소스를 넷으로 쪼갠 이유가 이것이다 — 한 소스의 한도 소진이 네 행을 통째로
    // 비우지 않는다. marketstack 소진 시 사노피만 실패하는 것이 정상이다.
    vi.mocked(fetchMarketstackQuotes).mockRejectedValueOnce(
      new Error('marketstack HTTP 429 (usage_limit_reached: Your monthly usage limit has been reached.)'),
    )
    const r = await fetchAllQuotes(
      [
        { id: 'gsk', quoteSource: 'lse', quoteSymbol: 'GSK' },
        { id: 'san', quoteSource: 'marketstack', quoteSymbol: 'SAN.PA' },
        { id: 'lonn', quoteSource: 'six', quoteSymbol: 'LONN' },
        { id: 'wuxi', quoteSource: 'naver-world-stock', quoteSymbol: '2269.HK' },
      ],
      { sleep: async () => {} },
    )
    expect(r.get('san')).toBeInstanceOf(Error)
    expect((r.get('san') as Error).message).toContain('usage_limit_reached')
    expect((r.get('gsk') as any).close).toBe(1852)
    expect((r.get('lonn') as any).close).toBeCloseTo(588.4, 4)
    expect((r.get('wuxi') as any).close).toBeCloseTo(50.5, 4)
    // 한도 소진은 기다려도 안 풀린다 — 재시도하지 않는다.
    expect(fetchMarketstackQuotes).toHaveBeenCalledTimes(1)
  })

  it('새 소스도 일시적 실패면 한 번 더 부른다', async () => {
    vi.mocked(fetchSixQuote).mockRejectedValueOnce(new Error('[LONN] SIX HTTP 502'))
    const r = await fetchAllQuotes(
      [{ id: 'lonn', quoteSource: 'six', quoteSymbol: 'LONN' }],
      { sleep: async () => {} },
    )
    expect((r.get('lonn') as any).close).toBeCloseTo(588.4, 4)
    expect(fetchSixQuote).toHaveBeenCalledTimes(2)
  })

  it('새 소스가 끝내 실패하면 그 행만 사유와 함께 남는다', async () => {
    vi.mocked(fetchLseQuote).mockRejectedValueOnce(new Error('[GSK] LSE HTTP 404 (Not found instrument with tidm: GSK)'))
    const r = await fetchAllQuotes(
      [
        { id: 'gsk', quoteSource: 'lse', quoteSymbol: 'GSK' },
        { id: 'lonn', quoteSource: 'six', quoteSymbol: 'LONN' },
      ],
      { sleep: async () => {} },
    )
    expect(r.get('gsk')).toBeInstanceOf(Error)
    expect((r.get('gsk') as Error).message).toContain('HTTP 404')
    expect((r.get('lonn') as any).close).toBeCloseTo(588.4, 4)
    expect(fetchLseQuote).toHaveBeenCalledTimes(1) // 404 는 재시도하지 않는다
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

  it('twelvedata 가 준 실패 사유를 "응답 없음"으로 뭉개지 않고 그대로 싣는다', async () => {
    // 한도 초과와 심볼 오타가 화면에서 같은 문장이 되면 안 된다.
    vi.mocked(fetchTwelveDataQuotes).mockResolvedValueOnce({
      quotes: new Map(),
      failures: new Map([
        ['PFE', 'You have run out of API credits for the current minute.'],
        ['WXIBY', 'symbol not found'],
      ]),
    })
    const r = await fetchAllQuotes([
      { id: 'p', quoteSource: 'twelvedata', quoteSymbol: 'PFE' },
      { id: 'w', quoteSource: 'twelvedata', quoteSymbol: 'WXIBY' },
    ])
    expect((r.get('p') as Error).message).toContain('API credits')
    expect((r.get('w') as Error).message).toContain('symbol not found')
    expect((r.get('p') as Error).message).not.toBe((r.get('w') as Error).message)
  })

  it('사유가 없는 심볼만 "응답 없음"으로 남는다', async () => {
    vi.mocked(fetchTwelveDataQuotes).mockResolvedValueOnce({
      quotes: new Map(),
      failures: new Map(),
    })
    const r = await fetchAllQuotes([{ id: 'x', quoteSource: 'twelvedata', quoteSymbol: 'NOPE' }])
    expect((r.get('x') as Error).message).toBe('twelvedata: NOPE 응답 없음')
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

  it('일시적 실패(522)는 같은 소스를 한 번 더 불러 하루치 공란을 막는다', async () => {
    // 실측: twelvedata 522 로 미국 5행이 통째로 비었고, 몇 분 뒤 손으로 부르니 정상이었다.
    // 수집은 07:40 한 번뿐이라 재시도가 없으면 그 공란이 하루 종일 남는다.
    vi.mocked(fetchTwelveDataQuotes).mockRejectedValueOnce(new Error('twelvedata HTTP 522'))
    const r = await fetchAllQuotes(
      [{ id: 'b', quoteSource: 'twelvedata', quoteSymbol: 'PFE' }],
      { sleep: async () => {} },
    )
    expect((r.get('b') as any).close).toBeCloseTo(28.3, 4)
    expect(fetchTwelveDataQuotes).toHaveBeenCalledTimes(2)
  })

  it('marketstack 429 도 같은 규칙으로 한 번 더 부른다', async () => {
    vi.mocked(fetchMarketstackQuotes).mockRejectedValueOnce(new Error('marketstack HTTP 429'))
    const r = await fetchAllQuotes(
      [{ id: 'c', quoteSource: 'marketstack', quoteSymbol: 'GSK.L' }],
      { sleep: async () => {} },
    )
    expect((r.get('c') as any).close).toBeCloseTo(1890.5, 4)
    expect(fetchMarketstackQuotes).toHaveBeenCalledTimes(2)
  })

  it('재시도해도 소용없는 실패(401)는 한 번만 부르고 사유를 남긴다', async () => {
    vi.mocked(fetchNaverStock).mockRejectedValueOnce(new Error('[207940] HTTP 401'))
    const r = await fetchAllQuotes(
      [{ id: 'a', quoteSource: 'naver-stock', quoteSymbol: '207940' }],
      { sleep: async () => {} },
    )
    expect(r.get('a')).toBeInstanceOf(Error)
    expect((r.get('a') as Error).message).toContain('401')
    expect(fetchNaverStock).toHaveBeenCalledTimes(1)
  })

  it('끝내 실패하면 사유가 그대로 남는다 — 재시도가 실패를 지우지 않는다', async () => {
    vi.mocked(fetchTwelveDataQuotes)
      .mockRejectedValueOnce(new Error('twelvedata HTTP 522'))
      .mockRejectedValueOnce(new Error('twelvedata HTTP 522'))
      .mockRejectedValueOnce(new Error('twelvedata HTTP 522'))
    const r = await fetchAllQuotes(
      [{ id: 'b', quoteSource: 'twelvedata', quoteSymbol: 'PFE' }],
      { sleep: async () => {} },
    )
    expect(r.get('b')).toBeInstanceOf(Error)
    expect((r.get('b') as Error).message).toContain('522')
    expect(fetchTwelveDataQuotes).toHaveBeenCalledTimes(3)
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
