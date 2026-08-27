import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchTwelveDataQuotes } from './twelvedata'

afterEach(() => vi.unstubAllGlobals())

function stub(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })))
}

describe('fetchTwelveDataQuotes', () => {
  it('단일 심볼 응답을 읽는다', async () => {
    stub({
      symbol: 'PFE', name: 'Pfizer Inc.', close: '28.30000',
      previous_close: '28.57000', currency: 'USD', datetime: '2026-08-26',
    })
    const m = await fetchTwelveDataQuotes(['PFE'])
    expect(m.get('PFE')).toEqual({
      close: 28.3, prevClose: 28.57, currency: 'USD', asOf: '2026-08-26',
    })
  })

  it('복수 심볼 응답을 심볼별로 나눈다', async () => {
    stub({
      PFE: { symbol: 'PFE', close: '28.30', previous_close: '28.57', currency: 'USD', datetime: '2026-08-26' },
      MRK: { symbol: 'MRK', close: '153.10', previous_close: '156.45', currency: 'USD', datetime: '2026-08-26' },
    })
    const m = await fetchTwelveDataQuotes(['PFE', 'MRK'])
    expect(m.size).toBe(2)
    expect(m.get('MRK')?.close).toBeCloseTo(153.1, 4)
  })

  it('심볼별 오류는 그 심볼만 빠뜨리고 나머지를 살린다', async () => {
    stub({
      PFE: { symbol: 'PFE', close: '28.30', previous_close: '28.57', currency: 'USD', datetime: '2026-08-26' },
      WXIBY: { status: 'error', message: 'symbol not found' },
    })
    const m = await fetchTwelveDataQuotes(['PFE', 'WXIBY'])
    expect(m.has('PFE')).toBe(true)
    expect(m.has('WXIBY')).toBe(false)
  })

  it('빈 목록이면 호출하지 않는다', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const m = await fetchTwelveDataQuotes([])
    expect(m.size).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })
})
