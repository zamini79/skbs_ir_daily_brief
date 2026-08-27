import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchTwelveDataQuotes } from './twelvedata'

beforeEach(() => { process.env.TWELVEDATA_API_KEY = 'test-key' })
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
    const { quotes } = await fetchTwelveDataQuotes(['PFE'])
    expect(quotes.get('PFE')).toEqual({
      close: 28.3, prevClose: 28.57, currency: 'USD', asOf: '2026-08-26',
    })
  })

  it('복수 심볼 응답을 심볼별로 나눈다', async () => {
    stub({
      PFE: { symbol: 'PFE', close: '28.30', previous_close: '28.57', currency: 'USD', datetime: '2026-08-26' },
      MRK: { symbol: 'MRK', close: '153.10', previous_close: '156.45', currency: 'USD', datetime: '2026-08-26' },
    })
    const { quotes, failures } = await fetchTwelveDataQuotes(['PFE', 'MRK'])
    expect(quotes.size).toBe(2)
    expect(quotes.get('MRK')?.close).toBeCloseTo(153.1, 4)
    expect(failures.size).toBe(0)
  })

  it('심볼별 오류는 그 심볼만 빠뜨리고 나머지를 살린다', async () => {
    stub({
      PFE: { symbol: 'PFE', close: '28.30', previous_close: '28.57', currency: 'USD', datetime: '2026-08-26' },
      WXIBY: { status: 'error', message: 'symbol not found' },
    })
    const { quotes } = await fetchTwelveDataQuotes(['PFE', 'WXIBY'])
    expect(quotes.has('PFE')).toBe(true)
    expect(quotes.has('WXIBY')).toBe(false)
  })

  // 아래 세 건은 서로 다른 사유가 서로 다른 문자열로 나오는지를 본다.
  // 사유를 버리고 전부 "응답 없음"으로 뭉개던 구현에서는 셋 다 실패한다.
  it('심볼별 오류의 message 를 버리지 않고 failures 에 남긴다', async () => {
    stub({
      PFE: { symbol: 'PFE', close: '28.30', previous_close: '28.57', currency: 'USD', datetime: '2026-08-26' },
      WXIBY: { status: 'error', code: 400, message: 'symbol not found' },
    })
    const { failures } = await fetchTwelveDataQuotes(['PFE', 'WXIBY'])
    expect(failures.get('WXIBY')).toBe('symbol not found')
    expect(failures.has('PFE')).toBe(false)
  })

  it('응답에 심볼 키 자체가 없는 것과 오류 응답을 다른 사유로 구분한다', async () => {
    stub({
      PFE: { status: 'error', message: 'symbol not found' },
      // MRK 는 아예 응답에 없다
    })
    const { failures } = await fetchTwelveDataQuotes(['PFE', 'MRK'])
    expect(failures.get('MRK')).toBe('응답에 심볼 없음')
    expect(failures.get('PFE')).toBe('symbol not found')
    expect(failures.get('MRK')).not.toBe(failures.get('PFE'))
  })

  it('한도 초과(평면 오류 객체)를 배치 전 심볼의 사유로 승격시킨다', async () => {
    // 실측 형태: HTTP 200 + 심볼별 맵이 아니라 평면 객체.
    // 심볼 루프에 그대로 들어가면 5행 전부 "응답 없음"이 되어 원인이 사라진다.
    stub({
      code: 429,
      status: 'error',
      message: 'You have run out of API credits for the current minute.',
    })
    const { quotes, failures } = await fetchTwelveDataQuotes(['PFE', 'MRK', 'NVAX', 'PCVX', 'MRNA'])
    expect(quotes.size).toBe(0)
    expect(failures.size).toBe(5)
    for (const s of ['PFE', 'MRK', 'NVAX', 'PCVX', 'MRNA']) {
      expect(failures.get(s)).toContain('API credits')
    }
  })

  it('빈 문자열 close 를 0 으로 통과시키지 않고 사유를 남긴다', async () => {
    // Number('') === 0 이므로, 걸러내지 않으면 주가 0 원이 그럴듯하게 찍힌다.
    stub({
      PFE: { symbol: 'PFE', close: '', previous_close: '', currency: 'USD' },
      MRK: { symbol: 'MRK', close: '1', previous_close: '2' },
    })
    const { quotes, failures } = await fetchTwelveDataQuotes(['PFE', 'MRK'])
    expect(quotes.has('MRK')).toBe(true)
    expect(quotes.has('PFE')).toBe(false)
    expect(failures.get('PFE')).toContain('close')
  })

  it('빈 목록이면 호출하지 않는다', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const { quotes } = await fetchTwelveDataQuotes([])
    expect(quotes.size).toBe(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('API 키가 없으면 심볼이 있을 때 에러를 던진다', async () => {
    delete process.env.TWELVEDATA_API_KEY
    const stub = vi.fn()
    vi.stubGlobal('fetch', stub)
    await expect(fetchTwelveDataQuotes(['PFE'])).rejects.toThrow(/TWELVEDATA_API_KEY/)
    expect(stub).not.toHaveBeenCalled()
    // restore for later tests
    process.env.TWELVEDATA_API_KEY = 'test-key'
  })

  it('API 키가 없어도 빈 목록이면 에러를 던지지 않는다', async () => {
    delete process.env.TWELVEDATA_API_KEY
    const { quotes } = await fetchTwelveDataQuotes([])
    expect(quotes.size).toBe(0)
    // restore for later tests
    process.env.TWELVEDATA_API_KEY = 'test-key'
  })
})
