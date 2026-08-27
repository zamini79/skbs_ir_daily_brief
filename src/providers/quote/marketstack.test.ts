import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchMarketstackQuotes, fetchMarketstackYtdBase } from './marketstack'

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

// 스펙 §3.5: YTD 기준가 = 전년도 마지막 거래일의 종가.
describe('fetchMarketstackYtdBase', () => {
  it('전년 마지막 거래일의 종가를 쓴다(시가 아님) — 순서를 뒤섞어 정렬 로직도 함께 검증한다', async () => {
    // 심볼당 3거래일. 시가와 종가를 전부 다르게 둬서 open<->close 바꿔치기와
    // first/last 혼동이 각각 다른 값으로 드러나게 한다.
    stub({
      data: [
        { symbol: 'GSK.L', open: 1600.0, close: 1620.0, price_currency: 'GBP', date: '2025-12-01T00:00:00+0000' },
        { symbol: 'GSK.L', open: 1700.0, close: 1710.0, price_currency: 'GBP', date: '2025-12-31T00:00:00+0000' },
        { symbol: 'GSK.L', open: 1650.0, close: 1660.0, price_currency: 'GBP', date: '2025-12-15T00:00:00+0000' },
      ],
    })
    const m = await fetchMarketstackYtdBase(['GSK.L'], 2026)
    expect(m.get('GSK.L')).toBe(1710.0)
  })

  it('전년 12월 창을 조회한다 — 창이 틀리면 값은 그럴듯한데 조용히 틀린다', async () => {
    const spy = vi.fn(async (_url: string) => new Response(JSON.stringify({
      data: [{ symbol: 'GSK.L', open: 1700.0, close: 1710.0, price_currency: 'GBP', date: '2025-12-31T00:00:00+0000' }],
    }), { status: 200 }))
    vi.stubGlobal('fetch', spy)
    await fetchMarketstackYtdBase(['GSK.L', 'SAN.PA'], 2026)
    const url = String(spy.mock.calls[0][0])
    expect(url).toContain('date_from=2025-12-01')
    expect(url).toContain('date_to=2025-12-31')
    expect(url).not.toContain('2026-01-01')
    // limit 은 심볼 전체에 걸린 전역 캡이다. 12월 창은 31일이므로 심볼당 31행.
    expect(url).toContain(`limit=${2 * 31}`)
  })

  it('여러 심볼을 정확히 분리한다', async () => {
    stub({
      data: [
        { symbol: 'GSK.L', open: 1600.0, close: 1620.0, price_currency: 'GBP', date: '2025-12-30T00:00:00+0000' },
        { symbol: 'GSK.L', open: 1700.0, close: 1710.0, price_currency: 'GBP', date: '2025-12-31T00:00:00+0000' },
        { symbol: 'SAN.PA', open: 75.0, close: 75.5, price_currency: 'EUR', date: '2025-12-30T00:00:00+0000' },
        { symbol: 'SAN.PA', open: 76.0, close: 76.5, price_currency: 'EUR', date: '2025-12-31T00:00:00+0000' },
      ],
    })
    const m = await fetchMarketstackYtdBase(['GSK.L', 'SAN.PA'], 2026)
    expect(m.size).toBe(2)
    expect(m.get('GSK.L')).toBe(1710.0)
    expect(m.get('SAN.PA')).toBe(76.5)
  })

  it('데이터가 없는 심볼은 맵에서 빠진다', async () => {
    stub({
      data: [
        { symbol: 'GSK.L', open: 1700.0, close: 1710.0, price_currency: 'GBP', date: '2025-12-31T00:00:00+0000' },
      ],
    })
    const m = await fetchMarketstackYtdBase(['GSK.L', 'LONN.SW'], 2026)
    expect(m.has('GSK.L')).toBe(true)
    expect(m.has('LONN.SW')).toBe(false)
  })

  it('빈 목록이면 호출하지 않고 키도 필요 없다', async () => {
    delete process.env.MARKETSTACK_API_KEY
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const m = await fetchMarketstackYtdBase([], 2026)
    expect(m.size).toBe(0)
    expect(spy).not.toHaveBeenCalled()
    // restore for later tests
    process.env.MARKETSTACK_API_KEY = 'test-key'
  })

  it('HTTP 오류 상태면 빈 맵 대신 예외를 던진다', async () => {
    stub({}, 503)
    await expect(fetchMarketstackYtdBase(['GSK.L'], 2026)).rejects.toThrow(/marketstack HTTP 503/)
  })
})
