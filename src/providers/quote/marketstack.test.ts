import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchMarketstackQuotes, fetchMarketstackYearOpen } from './marketstack'

beforeEach(() => { process.env.MARKETSTACK_API_KEY = 'test-key' })
afterEach(() => vi.unstubAllGlobals())

function stub(payload: unknown, status = 200) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status })))
}

describe('fetchMarketstackQuotes', () => {
  it('심볼별 최신 2거래일로 종가와 전일 종가를 만든다', async () => {
    stub({
      data: [
        { symbol: 'GSK.L', close: 1890.5, price_currency: 'GBP', date: '2026-08-25T00:00:00+0000' },
        { symbol: 'GSK.L', close: 1875.0, price_currency: 'GBP', date: '2026-08-24T00:00:00+0000' },
        { symbol: 'SAN.PA', close: 78.74, price_currency: 'EUR', date: '2026-08-26T00:00:00+0000' },
        { symbol: 'SAN.PA', close: 79.10, price_currency: 'EUR', date: '2026-08-25T00:00:00+0000' },
      ],
    })
    const m = await fetchMarketstackQuotes(['GSK.L', 'SAN.PA'])
    expect(m.get('GSK.L')).toEqual({
      close: 1890.5, prevClose: 1875.0, currency: 'GBP', asOf: '2026-08-25',
    })
    expect(m.get('SAN.PA')?.prevClose).toBeCloseTo(79.1, 4)
  })

  it('거래일이 하나뿐이면 그 심볼을 버린다', async () => {
    stub({ data: [{ symbol: 'LONN.SW', close: 593.8, price_currency: 'CHF', date: '2026-08-26T00:00:00+0000' }] })
    const m = await fetchMarketstackQuotes(['LONN.SW'])
    expect(m.has('LONN.SW')).toBe(false)
  })

  it('오류 응답이면 예외를 던진다', async () => {
    stub({ error: { code: 'invalid_access_key', message: 'bad key' } })
    await expect(fetchMarketstackQuotes(['GSK.L'])).rejects.toThrow(/marketstack/)
  })

  it('HTTP 오류 상태면 빈 맵 대신 예외를 던진다', async () => {
    stub({}, 503)
    await expect(fetchMarketstackQuotes(['GSK.L'])).rejects.toThrow(/marketstack HTTP 503/)
  })

  it('빈 목록이면 호출하지 않는다', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const m = await fetchMarketstackQuotes([])
    expect(m.size).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('API 키가 없으면 심볼이 있을 때 에러를 던진다', async () => {
    delete process.env.MARKETSTACK_API_KEY
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    await expect(fetchMarketstackQuotes(['GSK.L'])).rejects.toThrow(/MARKETSTACK_API_KEY/)
    expect(spy).not.toHaveBeenCalled()
    // restore for later tests
    process.env.MARKETSTACK_API_KEY = 'test-key'
  })

  it('API 키가 없어도 빈 목록이면 에러를 던지지 않는다', async () => {
    delete process.env.MARKETSTACK_API_KEY
    const m = await fetchMarketstackQuotes([])
    expect(m.size).toBe(0)
    // restore for later tests
    process.env.MARKETSTACK_API_KEY = 'test-key'
  })
})

describe('fetchMarketstackYearOpen', () => {
  it('그 해 가장 이른 거래일의 시가를 쓴다(종가 아님)', async () => {
    // 배열 순서를 일부러 뒤섞어서 정렬 로직도 함께 검증한다.
    stub({
      data: [
        { symbol: 'GSK.L', open: 1650.0, close: 1660.0, price_currency: 'GBP', date: '2026-01-05T00:00:00+0000' },
        { symbol: 'GSK.L', open: 1600.0, close: 1620.0, price_currency: 'GBP', date: '2026-01-02T00:00:00+0000' },
      ],
    })
    const m = await fetchMarketstackYearOpen(['GSK.L'], 2026)
    expect(m.get('GSK.L')).toBe(1600.0)
  })

  it('여러 심볼을 정확히 분리한다', async () => {
    stub({
      data: [
        { symbol: 'GSK.L', open: 1600.0, close: 1620.0, price_currency: 'GBP', date: '2026-01-02T00:00:00+0000' },
        { symbol: 'SAN.PA', open: 75.0, close: 75.5, price_currency: 'EUR', date: '2026-01-02T00:00:00+0000' },
      ],
    })
    const m = await fetchMarketstackYearOpen(['GSK.L', 'SAN.PA'], 2026)
    expect(m.size).toBe(2)
    expect(m.get('GSK.L')).toBe(1600.0)
    expect(m.get('SAN.PA')).toBe(75.0)
  })

  it('데이터가 없는 심볼은 맵에서 빠진다', async () => {
    stub({
      data: [
        { symbol: 'GSK.L', open: 1600.0, close: 1620.0, price_currency: 'GBP', date: '2026-01-02T00:00:00+0000' },
      ],
    })
    const m = await fetchMarketstackYearOpen(['GSK.L', 'LONN.SW'], 2026)
    expect(m.has('GSK.L')).toBe(true)
    expect(m.has('LONN.SW')).toBe(false)
  })

  it('빈 목록이면 호출하지 않고 키도 필요 없다', async () => {
    delete process.env.MARKETSTACK_API_KEY
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const m = await fetchMarketstackYearOpen([], 2026)
    expect(m.size).toBe(0)
    expect(spy).not.toHaveBeenCalled()
    // restore for later tests
    process.env.MARKETSTACK_API_KEY = 'test-key'
  })

  it('HTTP 오류 상태면 빈 맵 대신 예외를 던진다', async () => {
    stub({}, 503)
    await expect(fetchMarketstackYearOpen(['GSK.L'], 2026)).rejects.toThrow(/marketstack HTTP 503/)
  })
})
