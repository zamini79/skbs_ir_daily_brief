import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchFxToKrw } from './frankfurter'

afterEach(() => vi.unstubAllGlobals())

function stubFetch(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })))
}

describe('fetchFxToKrw', () => {
  it('USD 기준 응답을 통화별 KRW 환율로 바꾼다', async () => {
    // USD->KRW 1383.49, USD->GBP 0.73368  =>  GBP->KRW = 1383.49/0.73368
    stubFetch({ amount: 1, base: 'USD', date: '2026-08-26', rates: { KRW: 1383.49, GBP: 0.73368 } })
    const fx = await fetchFxToKrw(['USD', 'GBP'])
    expect(fx.USD).toBeCloseTo(1383.49, 2)
    expect(fx.GBP).toBeCloseTo(1885.68, 1)
  })

  it('KRW 는 항상 1이다', async () => {
    stubFetch({ amount: 1, base: 'USD', date: '2026-08-26', rates: { KRW: 1383.49 } })
    const fx = await fetchFxToKrw(['KRW'])
    expect(fx.KRW).toBe(1)
  })

  it('응답에 없는 통화는 결과에서 빠진다', async () => {
    stubFetch({ amount: 1, base: 'USD', date: '2026-08-26', rates: { KRW: 1383.49 } })
    const fx = await fetchFxToKrw(['USD', 'CHF'])
    expect(fx.CHF).toBeUndefined()
  })
})
