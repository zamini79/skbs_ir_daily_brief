import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchNaverWorldStock } from './naver'
import { classifyQuoteFailure } from './retry'

// 해외 개별주(Wuxi 2269.HK). 실측(2026-08-27 / 2026-08-28 재확인)한 사실만 굳힌다:
//   - **숫자가 전부 문자열이다**: closePrice "50.500", compareToPreviousClosePrice "-0.250".
//   - 통화는 currencyType.code = "HKD".
//   - localTradedAt 은 현지 시각이다: "2026-08-27T16:00:00+08:00".
//   - fluctuationsRatio("-0.49")도 오지만 쓰지 않는다.
//   - 경로는 /stock/{code}/basic 이다(지수의 /index/... 가 아니다).
//   - GSK.L·SAN.PA·LONN.SW 는 HTTP 409 `Not Exist Master` 다.

function wuxi(over: Record<string, unknown> = {}) {
  return {
    stockEndType: 'stock',
    reutersCode: '2269.HK',
    stockName: '야오밍바이오',
    symbolCode: '02269',
    closePrice: '50.500',
    compareToPreviousClosePrice: '-0.250',
    fluctuationsRatio: '-0.49',
    localTradedAt: '2026-08-27T16:00:00+08:00',
    currencyType: { code: 'HKD', text: '홍콩 달러', name: 'HONG_KONG_DOLLAR' },
    stockExchangeType: { code: 'HKG', zoneId: 'Asia/Hong_Kong', nationType: 'HKG' },
    marketStatus: 'CLOSE',
    delayTime: 15,
    ...over,
  }
}

function stubNaver(body: unknown, status = 200) {
  const spy = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchNaverWorldStock', () => {
  it('문자열 숫자를 파싱하고 전일 종가를 뺄셈으로 구한다', async () => {
    stubNaver(wuxi())
    const q = await fetchNaverWorldStock('2269.HK')
    expect(q.close).toBeCloseTo(50.5, 4)
    expect(q.prevClose).toBeCloseTo(50.75, 4) // 50.500 − (−0.250)
    expect(q.currency).toBe('HKD')
    expect(q.asOf).toBe('2026-08-27')
  })

  it('콤마가 섞인 문자열도 읽는다', async () => {
    stubNaver(wuxi({ closePrice: '1,234.50', compareToPreviousClosePrice: '-12.50' }))
    const q = await fetchNaverWorldStock('2269.HK')
    expect(q.close).toBeCloseTo(1234.5, 4)
    expect(q.prevClose).toBeCloseTo(1247, 4)
  })

  it('fluctuationsRatio 를 쓰지 않는다 — 등락률은 domain/calc.ts 가 계산한다', async () => {
    // 응답의 등락률을 일부러 모순되게 둔다. 그걸 쓴다면 전일 종가가 달라진다.
    stubNaver(wuxi({ fluctuationsRatio: '99.99' }))
    const q = await fetchNaverWorldStock('2269.HK')
    expect(q.prevClose).toBeCloseTo(50.75, 4)
    expect(Object.keys(q).sort()).toEqual(['asOf', 'close', 'currency', 'prevClose'])
  })

  it('기준일은 localTradedAt 앞 10자다 — Date 로 파싱해 KST 로 밀지 않는다', async () => {
    // 이 함수는 홍콩만 쓰는 게 아니다. 뉴욕 시각(-04:00)은 KST 로 다음 날이 된다:
    // 2026-08-27T16:39:23-04:00 → UTC 20:39 → KST 2026-08-28 05:39.
    // 그 시각의 거래일은 어디까지나 08-27 이다. 하루 밀면 담당자가 「어제 값이
    // 오늘로 찍혔다」고 읽는다.
    stubNaver(wuxi({ localTradedAt: '2026-08-27T16:39:23-04:00' }))
    expect((await fetchNaverWorldStock('X')).asOf).toBe('2026-08-27')
  })

  it('연말 경계에서도 기준일이 밀리지 않는다', async () => {
    // 2026-12-31T16:36:05-05:00 → UTC 21:36 → KST 2027-01-01 06:36. **연도까지 바뀐다.**
    // ytdBase.ts 의 naverIndexYtdBase 가 문자열을 그대로 읽는 이유와 같은 값이다.
    // 연도가 밀리면 연초대비 기준가 비교가 통째로 어긋난다.
    stubNaver(wuxi({ localTradedAt: '2026-12-31T16:36:05-05:00' }))
    expect((await fetchNaverWorldStock('X')).asOf).toBe('2026-12-31')

    // 홍콩(+08:00)에서도 늦은 시각이면 KST 로는 다음 날이 된다.
    stubNaver(wuxi({ localTradedAt: '2026-12-31T23:30:00+08:00' }))
    expect((await fetchNaverWorldStock('2269.HK')).asOf).toBe('2026-12-31')
  })

  it('지수가 아니라 종목 경로를 부른다', async () => {
    const spy = stubNaver(wuxi())
    await fetchNaverWorldStock('2269.HK')
    const url = String(spy.mock.calls[0][0])
    expect(url).toBe('https://api.stock.naver.com/stock/2269.HK/basic')
    expect(url).not.toContain('/index/')
  })

  it('네이버에 없는 심볼(409 Not Exist Master)은 실패로 남고 재시도하지 않는다', async () => {
    // GSK.L·SAN.PA·LONN.SW 가 이 경우다. 재시도해도 같은 답이 온다.
    stubNaver({ code: 'StockConflict', message: 'Not Exist Master [GSK.L]' }, 409)
    const e = (await fetchNaverWorldStock('GSK.L').catch(err => err)) as Error
    expect(e.message).toMatch(/HTTP 409/)
    expect(classifyQuoteFailure(e)).toBe('permanent')
  })

  it('통화가 없으면 실패한다 — 시드 통화로 슬쩍 채우지 않는다', async () => {
    stubNaver(wuxi({ currencyType: null }))
    await expect(fetchNaverWorldStock('2269.HK')).rejects.toThrow(/currencyType.code 없음/)
  })

  it('종가나 전일대비가 비면 실패한다 — 0 으로 둔갑하지 않는다', async () => {
    stubNaver(wuxi({ closePrice: '' }))
    await expect(fetchNaverWorldStock('2269.HK')).rejects.toThrow(/closePrice 파싱 실패/)
    // 전일대비를 0 으로 읽으면 prevClose === close 가 되어 「보합」으로 찍힌다.
    stubNaver(wuxi({ compareToPreviousClosePrice: null }))
    await expect(fetchNaverWorldStock('2269.HK')).rejects.toThrow(
      /compareToPreviousClosePrice 파싱 실패/,
    )
  })

  it('localTradedAt 이 없거나 형식이 다르면 실패한다', async () => {
    stubNaver(wuxi({ localTradedAt: undefined }))
    await expect(fetchNaverWorldStock('2269.HK')).rejects.toThrow(/localTradedAt 파싱 실패/)
    stubNaver(wuxi({ localTradedAt: '20260827' }))
    await expect(fetchNaverWorldStock('2269.HK')).rejects.toThrow(/localTradedAt 파싱 실패/)
  })

  it('5xx 는 일시적 실패로 분류돼 재시도 대상이 된다', async () => {
    stubNaver('', 503)
    const e = (await fetchNaverWorldStock('2269.HK').catch(err => err)) as Error
    expect(classifyQuoteFailure(e)).toBe('transient')
  })
})
