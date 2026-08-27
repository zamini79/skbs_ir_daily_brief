import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchMarketstackQuotes } from './marketstack'

beforeEach(() => { process.env.MARKETSTACK_API_KEY = 'test-key' })
afterEach(() => vi.unstubAllGlobals())

function stub(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })))
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
