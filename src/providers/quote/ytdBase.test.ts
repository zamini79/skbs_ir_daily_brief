import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseNaverSiseJson, fetchYtdBase } from './ytdBase'

// 스펙 §3.5: YTD 기준가 = **전년도 마지막 거래일의 종가**.
// 이 파일의 모든 기대값은 그 정의에서 나온다. 픽스처를 "통과하게" 맞추지 말 것.

describe('parseNaverSiseJson', () => {
  const raw = `
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20251229", 1695000, 1709000, 1679000, 1683000, 46684, 12.62],
["20251230", 1673000, 1724000, 1671000, 1713000, 51390, 12.67]]`

  it('헤더를 건너뛰고 데이터 행만 읽는다', () => {
    const rows = parseNaverSiseJson(raw)
    expect(rows).toHaveLength(2)
  })
  it('시가와 종가를 구분해 읽는다', () => {
    const rows = parseNaverSiseJson(raw)
    expect(rows[0]).toEqual({ date: '20251229', open: 1695000, close: 1683000 })
  })
  it('소수를 가진 지수 행도 읽는다', () => {
    const rows = parseNaverSiseJson(`[["20251230", 4224.53, 4313.55, 4216.68, 4309.63, 406339, 0.0]]`)
    expect(rows[0].open).toBeCloseTo(4224.53, 2)
    expect(rows[0].close).toBeCloseTo(4309.63, 2)
  })
  it('데이터가 없으면 빈 배열을 준다', () => {
    expect(parseNaverSiseJson(`[['날짜','시가','고가','저가','종가']]`)).toEqual([])
  })
})

describe('fetchYtdBase — naver', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stubNaver(text: string, status = 200) {
    const spy = vi.fn(async (_url: string) => new Response(text, { status }))
    vi.stubGlobal('fetch', spy)
    return spy
  }

  it('종가를 쓰고 시가를 쓰지 않는다 — 시가/종가를 일부러 다르게 둬야 바꿔치기를 잡아낸다', async () => {
    // 시가(48000)와 종가(48200)를 다르게 둔다. 둘이 같으면 open<->close를
    // 바꿔치기해도 테스트가 그대로 통과해버려 회귀를 잡아내지 못한다.
    // 48,200 은 스펙 §3.5 표의 SK바이오사이언스 2025-12-30 종가다.
    stubNaver(`
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20251230", 48000, 49000, 47900, 48200, 1000, 10]]`)
    const r = await fetchYtdBase(
      [{ id: 'a', quoteSource: 'naver-stock', quoteSymbol: '302440' }],
      2026,
    )
    expect(r.get('a')).toBe(48200)
  })

  it('전년 마지막 거래일을 쓴다 — 응답 순서가 뒤섞여 있어도', async () => {
    // 3거래일. 날짜 순서를 일부러 뒤섞고, 각 행의 시가와 종가도 서로 다르게 둔다.
    // "첫 행"을 고르는 버그(1220), "가장 이른 날"을 고르는 버그(1220),
    // 시가를 고르는 버그(1900)가 전부 다른 값으로 드러난다.
    stubNaver(`
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20251220", 1200, 1300, 1150, 1220, 500, 5],
["20251230", 1900, 2100, 1850, 2000, 500, 5],
["20251226", 1500, 1600, 1450, 1550, 500, 5]]`)
    const r = await fetchYtdBase(
      [{ id: 'a', quoteSource: 'naver-stock', quoteSymbol: '302440' }],
      2026,
    )
    expect(r.get('a')).toBe(2000)
  })

  it('전년 12월을 조회한다 — 창이 틀리면 값은 그럴듯한데 조용히 틀린다', async () => {
    const spy = stubNaver(`
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20251230", 48000, 49000, 47900, 48200, 1000, 10]]`)
    await fetchYtdBase([{ id: 'a', quoteSource: 'naver-stock', quoteSymbol: '302440' }], 2026)
    const url = String(spy.mock.calls[0][0])
    expect(url).toContain('startTime=20251201')
    expect(url).toContain('endTime=20251231')
    // 당해 1월 창(이번 결함의 원인)으로 되돌아가면 즉시 실패한다.
    expect(url).not.toContain('20260101')
  })

  it('데이터 행이 없으면 맵에 항목을 넣지 않는다', async () => {
    stubNaver(`[['날짜','시가','고가','저가','종가']]`)
    const r = await fetchYtdBase(
      [{ id: 'a', quoteSource: 'naver-stock', quoteSymbol: '302440' }],
      2026,
    )
    expect(r.has('a')).toBe(false)
  })

  it('HTTP 오류 응답이면 맵에 항목을 넣지 않고, 던지지도 않는다', async () => {
    stubNaver('', 500)
    const r = await fetchYtdBase(
      [{ id: 'a', quoteSource: 'naver-stock', quoteSymbol: '302440' }],
      2026,
    )
    expect(r.has('a')).toBe(false)
  })
})

describe('fetchYtdBase — twelvedata', () => {
  beforeEach(() => { process.env.TWELVEDATA_API_KEY = 'test-key' })
  afterEach(() => vi.unstubAllGlobals())

  function stubTd(values: Array<{ datetime: string; open?: string; close: string }>) {
    const spy = vi.fn(async (_url: string) => new Response(JSON.stringify({ values }), { status: 200 }))
    vi.stubGlobal('fetch', spy)
    return spy
  }

  it('종가를 쓰고 시가를 쓰지 않는다', async () => {
    stubTd([{ datetime: '2025-12-31', open: '24.98', close: '25.50' }])
    const r = await fetchYtdBase([{ id: 'a', quoteSource: 'twelvedata', quoteSymbol: 'PFE' }], 2026)
    expect(r.get('a')).toBe(25.5)
  })

  it('전년 마지막 날짜를 쓴다 — Twelve Data 기본 정렬이 최신순(desc)이어도', async () => {
    stubTd([
      { datetime: '2025-12-31', open: '31', close: '30' },
      { datetime: '2025-12-30', open: '26', close: '25' },
      { datetime: '2025-12-01', open: '21', close: '20' },
    ])
    const r = await fetchYtdBase([{ id: 'a', quoteSource: 'twelvedata', quoteSymbol: 'PFE' }], 2026)
    expect(r.get('a')).toBe(30)
  })

  it('오름차순으로 와도 같은 값을 준다 — 응답 순서에 기대지 않는다', async () => {
    stubTd([
      { datetime: '2025-12-01', open: '21', close: '20' },
      { datetime: '2025-12-30', open: '26', close: '25' },
      { datetime: '2025-12-31', open: '31', close: '30' },
    ])
    const r = await fetchYtdBase([{ id: 'a', quoteSource: 'twelvedata', quoteSymbol: 'PFE' }], 2026)
    expect(r.get('a')).toBe(30)
  })

  it('전년 12월을 조회한다', async () => {
    const spy = stubTd([{ datetime: '2025-12-31', close: '30' }])
    await fetchYtdBase([{ id: 'a', quoteSource: 'twelvedata', quoteSymbol: 'PFE' }], 2026)
    const url = String(spy.mock.calls[0][0])
    expect(url).toContain('start_date=2025-12-01')
    expect(url).toContain('end_date=2025-12-31')
    expect(url).not.toContain('2026-01-01')
  })

  it('키가 없으면 호출하지 않고 맵도 비운다', async () => {
    delete process.env.TWELVEDATA_API_KEY
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const r = await fetchYtdBase([{ id: 'a', quoteSource: 'twelvedata', quoteSymbol: 'PFE' }], 2026)
    expect(r.has('a')).toBe(false)
    expect(spy).not.toHaveBeenCalled()
    process.env.TWELVEDATA_API_KEY = 'test-key'
  })
})

describe('fetchYtdBase — 라우팅과 실패 정책', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('manual 종목은 완전히 건너뛴다 — fetch도 호출하지 않는다', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const r = await fetchYtdBase([{ id: 'a', quoteSource: 'manual', quoteSymbol: 'x' }], 2026)
    expect(r.has('a')).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('한 종목이 실패해도 나머지는 살아남는다', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('symbol=FAIL')) return new Response('', { status: 500 })
        return new Response(
          `
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20251230", 48000, 49000, 47900, 48200, 1000, 10]]`,
          { status: 200 },
        )
      }),
    )
    const r = await fetchYtdBase(
      [
        { id: 'bad', quoteSource: 'naver-stock', quoteSymbol: 'FAIL' },
        { id: 'good', quoteSource: 'naver-stock', quoteSymbol: '302440' },
      ],
      2026,
    )
    expect(r.has('bad')).toBe(false)
    expect(r.get('good')).toBe(48200)
  })
})
