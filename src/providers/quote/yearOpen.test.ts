import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { parseNaverSiseJson, fetchYearOpen } from './yearOpen'

describe('parseNaverSiseJson', () => {
  const raw = `
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20260102", 1695000, 1709000, 1679000, 1683000, 46684, 12.62],
["20260105", 1673000, 1724000, 1671000, 1713000, 51390, 12.67]]`

  it('헤더를 건너뛰고 데이터 행만 읽는다', () => {
    const rows = parseNaverSiseJson(raw)
    expect(rows).toHaveLength(2)
  })
  it('시가와 종가를 구분해 읽는다', () => {
    const rows = parseNaverSiseJson(raw)
    expect(rows[0]).toEqual({ date: '20260102', open: 1695000, close: 1683000 })
  })
  it('소수를 가진 지수 행도 읽는다', () => {
    const rows = parseNaverSiseJson(`[["20260102", 4224.53, 4313.55, 4216.68, 4309.63, 406339, 0.0]]`)
    expect(rows[0].open).toBeCloseTo(4224.53, 2)
    expect(rows[0].close).toBeCloseTo(4309.63, 2)
  })
  it('데이터가 없으면 빈 배열을 준다', () => {
    expect(parseNaverSiseJson(`[['날짜','시가','고가','저가','종가']]`)).toEqual([])
  })
})

describe('fetchYearOpen — naver', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stubNaver(text: string, status = 200) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(text, { status })))
  }

  it('시가를 쓰고 종가를 쓰지 않는다 — 시가/종가를 일부러 다르게 둬야 바꿔치기를 잡아낸다', async () => {
    // 시가(48200)와 종가(48000)를 다르게 둔다. 둘이 같으면 open<->close를
    // 바꿔치기해도 테스트가 그대로 통과해버려 회귀를 잡아내지 못한다.
    stubNaver(`
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20260102", 48200, 49000, 48000, 48000, 1000, 10]]`)
    const r = await fetchYearOpen(
      [{ id: 'a', quoteSource: 'naver-stock', quoteSymbol: '302440' }],
      2026,
    )
    expect(r.get('a')).toBe(48200)
  })

  it('가장 이른 거래일을 쓴다 — 응답 순서가 뒤집혀 있어도', async () => {
    stubNaver(`
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20260105", 2000, 2100, 1950, 1900, 500, 5],
["20260102", 1000, 1100, 950, 900, 500, 5]]`)
    const r = await fetchYearOpen(
      [{ id: 'a', quoteSource: 'naver-stock', quoteSymbol: '302440' }],
      2026,
    )
    expect(r.get('a')).toBe(1000)
  })

  it('데이터 행이 없으면 맵에 항목을 넣지 않는다', async () => {
    stubNaver(`[['날짜','시가','고가','저가','종가']]`)
    const r = await fetchYearOpen(
      [{ id: 'a', quoteSource: 'naver-stock', quoteSymbol: '302440' }],
      2026,
    )
    expect(r.has('a')).toBe(false)
  })

  it('HTTP 오류 응답이면 맵에 항목을 넣지 않고, 던지지도 않는다', async () => {
    stubNaver('', 500)
    const r = await fetchYearOpen(
      [{ id: 'a', quoteSource: 'naver-stock', quoteSymbol: '302440' }],
      2026,
    )
    expect(r.has('a')).toBe(false)
  })
})

describe('fetchYearOpen — twelvedata', () => {
  beforeEach(() => { process.env.TWELVEDATA_API_KEY = 'test-key' })
  afterEach(() => vi.unstubAllGlobals())

  function stubTd(values: Array<{ datetime: string; open: string; close?: string }>) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ values }), { status: 200 })))
  }

  it('시가를 쓰고 종가를 쓰지 않는다', async () => {
    stubTd([{ datetime: '2026-01-02', open: '24.98', close: '25.50' }])
    const r = await fetchYearOpen([{ id: 'a', quoteSource: 'twelvedata', quoteSymbol: 'PFE' }], 2026)
    expect(r.get('a')).toBe(24.98)
  })

  it('가장 이른 날짜를 쓴다 — 응답 순서가 뒤집혀 있어도', async () => {
    stubTd([
      { datetime: '2026-01-05', open: '30' },
      { datetime: '2026-01-02', open: '20' },
    ])
    const r = await fetchYearOpen([{ id: 'a', quoteSource: 'twelvedata', quoteSymbol: 'PFE' }], 2026)
    expect(r.get('a')).toBe(20)
  })
})

describe('fetchYearOpen — 라우팅과 실패 정책', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('manual 종목은 완전히 건너뛴다 — fetch도 호출하지 않는다', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const r = await fetchYearOpen([{ id: 'a', quoteSource: 'manual', quoteSymbol: 'x' }], 2026)
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
["20260102", 48200, 49000, 48000, 48000, 1000, 10]]`,
          { status: 200 },
        )
      }),
    )
    const r = await fetchYearOpen(
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
