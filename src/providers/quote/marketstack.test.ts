import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchMarketstackQuotes, fetchMarketstackYtdBase } from './marketstack'
import { withQuoteRetry, classifyQuoteFailure } from './retry'

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

  it('월 한도 소진(429)은 본문의 error.code 까지 사유에 싣는다 (실측 2026-08-27)', async () => {
    // 실제로 받은 응답 그대로. 상태 코드만 실으면 retry.ts 가 분당 속도 제한과
    // 구분하지 못해 61초를 기다렸다가 확실히 실패할 호출을 한 번 더 한다.
    stub({ error: { code: 'usage_limit_reached', message: 'Your monthly usage limit has been reached.' } }, 429)
    await expect(fetchMarketstackQuotes(['GSK.L'])).rejects.toThrow(
      /marketstack HTTP 429 .*usage_limit_reached.*monthly usage limit/,
    )
  })

  it('YTD 경로도 같은 사유를 싣는다', async () => {
    stub({ error: { code: 'usage_limit_reached', message: 'Your monthly usage limit has been reached.' } }, 429)
    await expect(fetchMarketstackYtdBase(['GSK.L'], 2026)).rejects.toThrow(/usage_limit_reached/)
  })

  it('본문이 JSON 이 아니어도 상태 코드 사유는 남는다 — 본문 파싱이 실패를 가리지 않는다', async () => {
    // 5xx 는 프록시가 HTML 을 돌려주기도 한다. 그때 errorDetail 이 던지면
    // 원래 사유(HTTP 502)가 통째로 사라진다.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 502 })))
    await expect(fetchMarketstackQuotes(['GSK.L'])).rejects.toThrow(/marketstack HTTP 502/)
  })

  it('사유에 API 키를 싣지 않는다', async () => {
    // 본문이 요청 URL 을 되비추는 API 가 실제로 있다(gemini.ts 의 redactKey).
    // 이 문자열은 QuoteSnapshot.errorMessage 로 DB 에 저장되고 화면에도 뜬다.
    stub({ error: { code: 'invalid_access_key', message: 'bad key for access_key=test-key' } }, 401)
    await expect(fetchMarketstackQuotes(['GSK.L'])).rejects.toThrow(/<redacted>/)
    await expect(fetchMarketstackQuotes(['GSK.L'])).rejects.not.toThrow(/test-key/)
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

describe('marketstack + retry.ts 배선 — 월 한도 소진이 실제로 재시도를 건너뛰는가', () => {
  // 분류 함수만 따로 검증하면 두 모듈이 **같은 문자열로 이어져 있는지**는 못 본다.
  // 여기서는 진짜 응답 본문을 stub 으로 물리고 fetch 호출 횟수를 직접 센다.
  // (라이브 검증은 불가능하다 — 월 한도가 이미 소진돼 있고 일부러 더 쓰지 않는다.)
  const EXHAUSTED = {
    error: { code: 'usage_limit_reached', message: 'Your monthly usage limit has been reached.' },
  }

  it('월 한도 소진: fetch 를 한 번만 부르고 61초를 쓰지 않는다', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(EXHAUSTED), { status: 429 }))
    vi.stubGlobal('fetch', fetchSpy)
    const waits: number[] = []

    await expect(
      withQuoteRetry('marketstack', () => fetchMarketstackQuotes(['GSK.L']), async ms => { waits.push(ms) }),
    ).rejects.toThrow(/usage_limit_reached/)

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(waits).toEqual([])
  })

  it('본문 단서 없는 429 는 예전대로 61초 뒤 한 번 더 부른다 — 과잉 교정이 아니다', async () => {
    // 이 짝이 없으면 "429 를 전부 permanent 로" 라는 구현도 위 테스트를 통과한다.
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 429 }))
    vi.stubGlobal('fetch', fetchSpy)
    const waits: number[] = []

    await expect(
      withQuoteRetry('marketstack', () => fetchMarketstackQuotes(['GSK.L']), async ms => { waits.push(ms) }),
    ).rejects.toThrow(/HTTP 429/)

    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(waits).toEqual([61_000])
  })

  it('던져진 사유가 소진이라는 사실을 담고 있다 — 화면에 뜨는 문구다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(EXHAUSTED), { status: 429 })))
    const err = await fetchMarketstackQuotes(['GSK.L']).then(() => null, (e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('usage_limit_reached')
    expect(err!.message).toContain('monthly usage limit')
    expect(classifyQuoteFailure(err)).toBe('permanent')
  })
})
