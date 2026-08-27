import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseNaverSiseJson, fetchYtdBase } from './ytdBase'

// 스펙 §3.5: YTD 기준가 = **전년도 마지막 거래일의 종가**.
// 이 파일의 모든 기대값은 그 정의에서 나온다. 픽스처를 "통과하게" 맞추지 말 것.

/** 테스트에서 61초를 실제로 기다리지 않도록 주입한다. 호출 인자를 검사해 대기 시간도 고정한다. */
function fakeSleep() {
  const calls: number[] = []
  return { fn: async (ms: number) => { calls.push(ms) }, calls }
}

const naverStock = (id = 'a', symbol = '302440') =>
  ({ id, quoteSource: 'naver-stock', quoteSymbol: symbol })
const naverIndex = (id: string, symbol: string) =>
  ({ id, quoteSource: 'naver-index', quoteSymbol: symbol })
const td = (id: string, symbol: string) =>
  ({ id, quoteSource: 'twelvedata', quoteSymbol: symbol })

const SISE_HEADER_ONLY = `[['날짜','시가','고가','저가','종가','거래량','외국인소진율']]`

describe('parseNaverSiseJson', () => {
  const raw = `
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20251229", 1695000, 1709000, 1679000, 1683000, 46684, 12.62],
["20251230", 1673000, 1724000, 1671000, 1713000, 51390, 12.67]]`

  it('헤더를 건너뛰고 데이터 행만 읽는다', () => {
    expect(parseNaverSiseJson(raw)).toHaveLength(2)
  })
  it('시가와 종가를 구분해 읽는다', () => {
    expect(parseNaverSiseJson(raw)[0]).toEqual({ date: '20251229', open: 1695000, close: 1683000 })
  })
  it('소수를 가진 지수 행도 읽는다', () => {
    const rows = parseNaverSiseJson(`[["20251230", 4224.53, 4313.55, 4216.68, 4309.63, 406339, 0.0]]`)
    expect(rows[0].open).toBeCloseTo(4224.53, 2)
    expect(rows[0].close).toBeCloseTo(4309.63, 2)
  })
  it('데이터가 없으면 빈 배열을 준다', () => {
    expect(parseNaverSiseJson(SISE_HEADER_ONLY)).toEqual([])
  })
})

describe('fetchYtdBase — naver 국내(siseJson)', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stubNaver(text: string, status = 200) {
    const spy = vi.fn(async (_url: string) => new Response(text, { status }))
    vi.stubGlobal('fetch', spy)
    return spy
  }

  it('종가를 쓰고 시가를 쓰지 않는다 — 둘을 일부러 다르게 둬야 바꿔치기를 잡아낸다', async () => {
    // 48,200 은 스펙 §3.5 표의 SK바이오사이언스 2025-12-30 종가다.
    stubNaver(`
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20251230", 48000, 49000, 47900, 48200, 1000, 10]]`)
    const r = await fetchYtdBase([naverStock()], 2026)
    expect(r.prices.get('a')).toBe(48200)
    expect(r.failures).toEqual([])
  })

  it('전년 마지막 거래일을 쓴다 — 응답 순서가 뒤섞여 있어도', async () => {
    // "첫 행"(1220), "가장 이른 날"(1220), "시가"(1900) 버그가 각각 다른 값으로 드러난다.
    stubNaver(`
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20251220", 1200, 1300, 1150, 1220, 500, 5],
["20251230", 1900, 2100, 1850, 2000, 500, 5],
["20251226", 1500, 1600, 1450, 1550, 500, 5]]`)
    const r = await fetchYtdBase([naverStock()], 2026)
    expect(r.prices.get('a')).toBe(2000)
  })

  it('전년 12월을 조회한다 — 창이 틀리면 값은 그럴듯한데 조용히 틀린다', async () => {
    const spy = stubNaver(`
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20251230", 48000, 49000, 47900, 48200, 1000, 10]]`)
    await fetchYtdBase([naverStock()], 2026)
    const url = String(spy.mock.calls[0][0])
    expect(url).toContain('startTime=20251201')
    expect(url).toContain('endTime=20251231')
    expect(url).not.toContain('20260101')
  })

  it('국내 종목은 데이터가 없어도 지수 폴백을 타지 않는다 — 사유를 남기고 끝낸다', async () => {
    const spy = stubNaver(SISE_HEADER_ONLY)
    const r = await fetchYtdBase([naverStock()], 2026)
    expect(r.prices.has('a')).toBe(false)
    expect(r.failures).toHaveLength(1)
    expect(spy).toHaveBeenCalledTimes(1) // 폴백 호출이 없었다
  })

  it('HTTP 오류여도 던지지 않고 사유를 남긴다', async () => {
    stubNaver('', 500)
    const r = await fetchYtdBase([naverStock()], 2026)
    expect(r.prices.has('a')).toBe(false)
    expect(r.failures[0].symbol).toBe('302440')
  })
})

// ── 결함 B: 해외 지수는 siseJson 이 오류가 아니라 "헤더만 있는 빈 응답"을 준다 ──
describe('fetchYtdBase — 해외 지수 폴백(index/price)', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** localTradedAt 은 현지 타임존이다. KST 로 변환하면 연도가 밀리는 값을 일부러 쓴다. */
  const row = (date: string, close: string, tz = '-05:00') => ({
    localTradedAt: `${date}T16:36:05${tz}`,
    closePrice: close,
    openPrice: '1.00',
  })

  /** siseJson 은 빈 응답, index/price 는 page 번호에 따라 지정한 배열을 준다. */
  function stubIndex(pages: Record<number, unknown>) {
    const spy = vi.fn(async (url: string) => {
      if (url.includes('siseJson')) return new Response(SISE_HEADER_ONLY, { status: 200 })
      const page = Number(new URL(url).searchParams.get('page'))
      const body = pages[page]
      if (body === undefined) return new Response('[]', { status: 200 })
      return new Response(JSON.stringify(body), { status: 200 })
    })
    vi.stubGlobal('fetch', spy)
    return spy
  }

  it('연도 경계를 넘는 첫 행의 종가를 쓴다 — 콤마 포함 문자열을 파싱한다', async () => {
    // 실측값: .INX 2025-12-31 종가 6,845.50
    stubIndex({
      1: [row('2026-01-05', '6,900.00'), row('2026-01-02', '6,880.00'), row('2025-12-31', '6,845.50'), row('2025-12-30', '6,820.00')],
    })
    const r = await fetchYtdBase([naverIndex('inx', '.INX')], 2026)
    expect(r.prices.get('inx')).toBe(6845.5)
    expect(r.failures).toEqual([])
  })

  it('12/31 23:00 -05:00 처럼 KST 로는 다음 해가 되는 값도 전년으로 센다', async () => {
    // new Date(...).getFullYear() 를 쓰면 KST 로 2026 이 되어 이 행을 건너뛴다.
    // 문자열 앞 4자를 쓰면 2025 로 올바르게 잡힌다.
    stubIndex({
      1: [row('2026-01-02', '100.00'), row('2025-12-31', '6,845.50', '-05:00')],
    })
    const inputs = [row('2025-12-31', '6,845.50', '-05:00')]
    expect(new Date(inputs[0].localTradedAt).getFullYear()).toBe(2026) // KST 로는 다음 해다
    const r = await fetchYtdBase([naverIndex('inx', '.INX')], 2026)
    expect(r.prices.get('inx')).toBe(6845.5)
  })

  it('1페이지에 경계가 없으면 다음 페이지로 넘어간다', async () => {
    stubIndex({
      1: [row('2026-03-05', '7,000.00'), row('2026-03-04', '6,990.00')],
      2: [row('2026-01-02', '6,880.00'), row('2025-12-31', '6,845.50'), row('2025-12-30', '6,820.00')],
    })
    const r = await fetchYtdBase([naverIndex('inx', '.INX')], 2026)
    expect(r.prices.get('inx')).toBe(6845.5)
  })

  it('페이지 상한(5)에 걸리면 사유를 남기고 멈춘다 — 무한 페이징 금지', async () => {
    const allCurrentYear = [row('2026-03-05', '7,000.00')]
    const spy = stubIndex({ 1: allCurrentYear, 2: allCurrentYear, 3: allCurrentYear, 4: allCurrentYear, 5: allCurrentYear, 6: allCurrentYear })
    const r = await fetchYtdBase([naverIndex('inx', '.INX')], 2026)
    expect(r.prices.has('inx')).toBe(false)
    expect(r.failures).toHaveLength(1)
    const indexCalls = spy.mock.calls.filter(c => String(c[0]).includes('index/'))
    expect(indexCalls).toHaveLength(5) // 6페이지는 부르지 않는다
  })

  it('pageSize 는 API 최대치 60으로 부른다 — 10이면 연중에 전년까지 닿지 못한다', async () => {
    const spy = stubIndex({ 1: [row('2025-12-31', '6,845.50')] })
    await fetchYtdBase([naverIndex('inx', '.INX')], 2026)
    const indexUrl = String(spy.mock.calls.find(c => String(c[0]).includes('index/'))![0])
    expect(indexUrl).toContain('pageSize=60')
  })

  it('종가가 파싱되지 않으면 값을 지어내지 않고 사유를 남긴다', async () => {
    stubIndex({ 1: [{ localTradedAt: '2025-12-31T16:36:05-05:00', closePrice: '' }] })
    const r = await fetchYtdBase([naverIndex('inx', '.INX')], 2026)
    expect(r.prices.has('inx')).toBe(false)
    expect(r.failures).toHaveLength(1)
  })

  // 회귀 고정: 세 지수 중 KOSPI 만 동작하던 상태를 다시 만들지 않는다.
  it('KOSPI 는 기존 siseJson 경로로 계속 동작하고 폴백을 타지 않는다', async () => {
    const spy = vi.fn(async (url: string) => {
      if (url.includes('siseJson')) {
        return new Response(`
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20251230", 3920.37, 3977.31, 3892.08, 3950.11, 296915, 0.0]]`, { status: 200 })
      }
      throw new Error('KOSPI 는 지수 폴백 엔드포인트를 부르면 안 된다')
    })
    vi.stubGlobal('fetch', spy)
    const r = await fetchYtdBase([naverIndex('kospi', 'KOSPI')], 2026)
    expect(r.prices.get('kospi')).toBe(3950.11)
    expect(r.failures).toEqual([])
    expect(spy.mock.calls.every(c => String(c[0]).includes('siseJson'))).toBe(true)
  })

  it('해외 지수와 KOSPI 를 함께 넘겨도 각자 맞는 경로로 간다', async () => {
    const spy = vi.fn(async (url: string) => {
      if (url.includes('siseJson')) {
        if (url.includes('symbol=KOSPI')) {
          return new Response(`
 [['날짜','시가','고가','저가','종가','거래량','외국인소진율'],
["20251230", 3920.37, 3977.31, 3892.08, 3950.11, 296915, 0.0]]`, { status: 200 })
        }
        return new Response(SISE_HEADER_ONLY, { status: 200 }) // 해외 지수엔 빈 응답
      }
      return new Response(JSON.stringify([row('2025-12-31', '23,241.99')]), { status: 200 })
    })
    vi.stubGlobal('fetch', spy)
    const r = await fetchYtdBase(
      [naverIndex('kospi', 'KOSPI'), naverIndex('ixic', '.IXIC')],
      2026,
    )
    expect(r.prices.get('kospi')).toBe(3950.11)
    expect(r.prices.get('ixic')).toBe(23241.99)
    expect(r.failures).toEqual([])
  })
})

// ── 결함 A: 분당 크레딧 초과로 일부 종목이 조용히 실패하던 경로 ──
describe('fetchYtdBase — twelvedata 배치와 429 재시도', () => {
  beforeEach(() => { process.env.TWELVEDATA_API_KEY = 'test-key' })
  afterEach(() => vi.unstubAllGlobals())

  const series = (rows: Array<[string, string]>) => ({
    status: 'ok',
    values: rows.map(([datetime, close]) => ({ datetime, close })),
  })
  const rateLimited = () =>
    new Response(JSON.stringify({ code: 429, status: 'error', message: 'You have run out of API credits' }), { status: 429 })

  it('여러 심볼을 한 요청으로 묶는다 — 요청 수가 종목 수만큼 늘지 않는다', async () => {
    const spy = vi.fn(async (_url: string) =>
      new Response(JSON.stringify({
        PFE: series([['2025-12-29', '25.00'], ['2025-12-30', '24.99']]),
        MRK: series([['2025-12-29', '105.00'], ['2025-12-30', '106.059998']]),
      }), { status: 200 }))
    vi.stubGlobal('fetch', spy)

    const r = await fetchYtdBase([td('p', 'PFE'), td('m', 'MRK')], 2026)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0][0])).toContain('symbol=PFE,MRK')
    expect(r.prices.get('p')).toBe(24.99)
    expect(r.prices.get('m')).toBe(106.059998)
    expect(r.failures).toEqual([])
  })

  it('심볼이 하나면 응답이 시계열 객체로 온다 — 그 구조도 읽는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string) =>
      new Response(JSON.stringify(series([['2025-12-01', '20.00'], ['2025-12-30', '24.99']])), { status: 200 })))
    const r = await fetchYtdBase([td('p', 'PFE')], 2026)
    expect(r.prices.get('p')).toBe(24.99)
  })

  it('429 면 61초 뒤 정확히 한 번 재시도하고, 성공하면 값을 채운다', async () => {
    const sleep = fakeSleep()
    const spy = vi.fn()
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(new Response(JSON.stringify({
        PFE: series([['2025-12-30', '24.99']]),
        MRK: series([['2025-12-30', '106.059998']]),
      }), { status: 200 }))
    vi.stubGlobal('fetch', spy)

    const r = await fetchYtdBase([td('p', 'PFE'), td('m', 'MRK')], 2026, { sleep: sleep.fn })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(sleep.calls).toEqual([61_000])
    expect(r.prices.get('p')).toBe(24.99)
    expect(r.prices.get('m')).toBe(106.059998)
    expect(r.failures).toEqual([])
  })

  it('재시도도 429 면 사유를 남기고 멈춘다 — 무한 재시도 금지', async () => {
    const sleep = fakeSleep()
    const spy = vi.fn(async (_url: string) => rateLimited())
    vi.stubGlobal('fetch', spy)

    const r = await fetchYtdBase([td('p', 'PFE'), td('m', 'MRK')], 2026, { sleep: sleep.fn })
    expect(spy).toHaveBeenCalledTimes(2) // 최초 1회 + 재시도 1회. 그 이상 없다.
    expect(sleep.calls).toHaveLength(1)
    expect(r.prices.size).toBe(0)
    expect(r.failures.map(f => f.symbol).sort()).toEqual(['MRK', 'PFE'])
    expect(r.failures[0].reason).toContain('429')
  })

  it('HTTP 200 인데 본문에만 code 429 가 실려 와도 한도 초과로 본다', async () => {
    const sleep = fakeSleep()
    const spy = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 429, status: 'error', message: 'out of credits' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(series([['2025-12-30', '24.99']])), { status: 200 }))
    vi.stubGlobal('fetch', spy)

    const r = await fetchYtdBase([td('p', 'PFE')], 2026, { sleep: sleep.fn })
    expect(sleep.calls).toEqual([61_000])
    expect(r.prices.get('p')).toBe(24.99)
  })

  it('twelvedata 가 통째로 실패해도 다른 소스 종목은 계속 채워진다', async () => {
    const sleep = fakeSleep()
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('twelvedata')) return rateLimited()
      return new Response(`
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20251230", 48000, 49000, 47900, 48200, 1000, 10]]`, { status: 200 })
    }))

    const r = await fetchYtdBase([td('p', 'PFE'), naverStock('kr', '302440')], 2026, { sleep: sleep.fn })
    expect(r.prices.get('kr')).toBe(48200) // 국내는 멀쩡히 채워진다
    expect(r.prices.has('p')).toBe(false)
    expect(r.failures.map(f => f.symbol)).toEqual(['PFE'])
  })

  it('배치 응답에서 특정 심볼만 오류면 그 심볼만 실패로 남는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string) =>
      new Response(JSON.stringify({
        PFE: series([['2025-12-30', '24.99']]),
        BAD: { status: 'error', message: 'symbol not found' },
      }), { status: 200 })))
    const r = await fetchYtdBase([td('p', 'PFE'), td('b', 'BAD')], 2026)
    expect(r.prices.get('p')).toBe(24.99)
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0].symbol).toBe('BAD')
    expect(r.failures[0].reason).toContain('symbol not found')
  })

  it('키가 없으면 호출하지 않고 사유를 남긴다 — 키 값은 사유에 넣지 않는다', async () => {
    delete process.env.TWELVEDATA_API_KEY
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const r = await fetchYtdBase([td('p', 'PFE')], 2026)
    expect(spy).not.toHaveBeenCalled()
    expect(r.failures[0].reason).toContain('TWELVEDATA_API_KEY')
    process.env.TWELVEDATA_API_KEY = 'test-key'
  })
})

describe('fetchYtdBase — KRX 지수', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  const HEALTHCARE = '코스피 200 헬스케어'
  const krxTarget = { id: 'h', quoteSource: 'krx-index', quoteSymbol: HEALTHCARE }

  /** 실측: 20251231 은 0행(연말 휴장), 20251230 은 51행이고 종가 2392.04. */
  function stubKrx(byDate: Record<string, unknown>) {
    const calls: string[] = []
    const spy = vi.fn(async (url: string) => {
      const basDd = new URL(url).searchParams.get('basDd') ?? ''
      calls.push(basDd)
      return new Response(JSON.stringify(byDate[basDd] ?? { OutBlock_1: [] }), { status: 200 })
    })
    vi.stubGlobal('fetch', spy)
    return calls
  }

  it('전년 마지막 거래일(12/30)의 종가를 쓴다 — 12/31 이 휴장이어도', async () => {
    vi.stubEnv('KRX_AUTH_KEY', 'TEST-KEY')
    const calls = stubKrx({
      '20251230': { OutBlock_1: [{ BAS_DD: '20251230', IDX_NM: HEALTHCARE, CLSPRC_IDX: '2392.04', CMPPREVDD_IDX: '-6.67' }] },
    })
    const r = await fetchYtdBase([krxTarget], 2026)
    expect(r.prices.get('h')).toBeCloseTo(2392.04, 2)
    expect(r.failures).toEqual([])
    expect(calls).toEqual(['20251231', '20251230'])
  })

  it('기준가를 못 구하면 조용히 비우지 않고 사유를 남긴다', async () => {
    vi.stubEnv('KRX_AUTH_KEY', 'TEST-KEY')
    stubKrx({}) // 전부 휴장 응답
    const r = await fetchYtdBase([krxTarget], 2026)
    expect(r.prices.has('h')).toBe(false)
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0].id).toBe('h')
    expect(r.failures[0].reason).toContain('거래일을 찾지 못함')
  })

  it('AUTH_KEY 가 없으면 사유에 그렇게 적히고 키 값은 실리지 않는다', async () => {
    vi.stubEnv('KRX_AUTH_KEY', '')
    stubKrx({})
    const r = await fetchYtdBase([krxTarget], 2026)
    expect(r.failures[0].reason).toContain('KRX_AUTH_KEY 없음')
  })
})

describe('fetchYtdBase — 라우팅과 실패 정책', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('manual 종목은 완전히 건너뛴다 — fetch 도, 실패 기록도 없다', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const r = await fetchYtdBase([{ id: 'a', quoteSource: 'manual', quoteSymbol: 'x' }], 2026)
    expect(r.prices.has('a')).toBe(false)
    expect(r.failures).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  it('모르는 quoteSource 는 조용히 사라지지 않고 실패로 남는다', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const r = await fetchYtdBase([{ id: 'a', quoteSource: 'bogus', quoteSymbol: 'x' }], 2026)
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0].reason).toContain('bogus')
    expect(spy).not.toHaveBeenCalled()
  })

  it('한 종목이 실패해도 나머지는 살아남고, 실패한 쪽만 사유가 남는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('symbol=FAIL')) return new Response('', { status: 500 })
      return new Response(`
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20251230", 48000, 49000, 47900, 48200, 1000, 10]]`, { status: 200 })
    }))
    const r = await fetchYtdBase([naverStock('bad', 'FAIL'), naverStock('good', '302440')], 2026)
    expect(r.prices.has('bad')).toBe(false)
    expect(r.prices.get('good')).toBe(48200)
    expect(r.failures.map(f => f.id)).toEqual(['bad'])
  })
})
