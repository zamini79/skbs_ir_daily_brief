import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchNaverWorldStock, fetchNaverStock, fetchNaverDomesticIndex } from './naver'
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

// ---------------------------------------------------------------------------
// 국내 경로(Task 35) — 일별 시세 계열에서 뽑는다
// ---------------------------------------------------------------------------

/**
 * SK바이오사이언스(302440) 일별 시세. **2026-08-31 08:57 KST 실측 응답이다**
 * (홑따옴표 헤더 행·탭 들여쓰기까지 온 그대로 옮겼다 — 이 응답은 유효한 JSON 이
 * 아니고, 파서가 그 사실을 견디는지가 여기서 같이 검증된다).
 *
 * 목 08-27 종가 38,450 / 금 08-28 종가 38,950 → **전일대비 +500 (+1.30%)**.
 * 브리프에 적힌 실측 기대값과 같은 숫자다.
 */
const SISE_302440_PREOPEN = `
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],

	
		
["20260825", 37750, 37800, 36400, 37550, 87866, 5.91],
		
["20260826", 37900, 38250, 37050, 38100, 85009, 5.93],
		
["20260827", 37900, 38650, 37750, 38450, 81128, 5.9],
		
["20260828", 38300, 38950, 38000, 38950, 57833, 5.97]
		
	
]
`

/** `integration` 응답(실측 2026-08-31): 시총은 여기에만 있다. */
function integration(over: Record<string, unknown> = {}) {
  return {
    itemCode: '302440',
    stockName: 'SK바이오사이언스',
    totalInfos: [
      { code: 'lastClosePrice', key: '전일', value: '38,950' },
      { code: 'marketValue', key: '시가총액', value: '3조 559억' },
    ],
    ...over,
  }
}

/**
 * URL 로 갈라 응답하는 stub. 국내 경로는 엔드포인트가 둘(계열·시총)이라
 * 하나의 고정 응답으로는 검증이 안 된다.
 */
function stubDomestic(opts: {
  series?: string | { body: string; status: number }
  integrationBody?: unknown | { body: unknown; status: number }
} = {}) {
  const spy = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('siseJson.naver')) {
      const s = opts.series ?? SISE_302440_PREOPEN
      const { body, status } = typeof s === 'string' ? { body: s, status: 200 } : s
      return new Response(body, { status })
    }
    if (u.includes('/integration')) {
      const i = opts.integrationBody ?? integration()
      const { body, status } =
        i && typeof i === 'object' && 'status' in (i as object)
          ? (i as { body: unknown; status: number })
          : { body: i, status: 200 }
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`예상하지 못한 URL: ${u}`)
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

/** KST 시각 리터럴을 Date 로. 테스트가 "몇 시에 돌렸는지"를 명시하게 한다. */
const kst = (s: string) => new Date(`2026-08-31T${s}:00+09:00`)

describe('fetchNaverStock — 개장 전에도 전일대비가 0 이 되지 않는다', () => {
  it('개장 전(월 07:40 KST)에 금-목 차이가 나온다 — 0 이 아니다', async () => {
    stubDomestic()
    const q = await fetchNaverStock('302440', kst('07:40'))

    expect(q.close).toBe(38950)
    expect(q.prevClose).toBe(38450)
    // 이 결함의 증상 그 자체. 0 이면 담당자가 "아무도 안 움직였다"고 읽는다.
    expect(q.close - q.prevClose).toBe(500)
    // 화면의 「기준 2026-08-31」이 「기준 2026-08-28」로 바뀐다. 그게 맞는 값이다.
    expect(q.asOf).toBe('2026-08-28')
    expect(q.asOf).not.toBe('2026-08-31')
  })

  it('시가총액은 계속 integration 에서 온다', async () => {
    stubDomestic()
    const q = await fetchNaverStock('302440', kst('07:40'))
    expect(q.marketCapKrwTrillion).toBeCloseTo(3.0559, 4) // "3조 559억"
  })
})

describe('실행 시각 무관 불변식 — 같은 입력, 다른 실행 시각, 한 답', () => {
  /**
   * **이 파일에서 가장 중요한 테스트다.**
   *
   * 계열이 장중에 오늘 행을 붙이는지는 추측이 아니라 **실측했다**(2026-08-31 09:05,
   * 개장 5분 뒤):
   *
   *     ["20260828", 38300, 38950, 38000, 38950, 57833, 5.97]
   *     ["20260831", 38450, 38450, 37650, 37700,  2612, 5.97]   ← 진행 중
   *
   * 거래량이 2,612 뿐인 데서 보이듯 마지막 행의 "종가" 자리에는 **그 순간의 현재가**가
   * 들어온다. 그 행을 쓰면 07:40 브리프는 +500(+1.30%), 09:05 재수집은 −1,250(−3.21%)
   * 이 되어 **같은 날 같은 브리프의 숫자가 달라진다** — 결함이 방향만 바꿔 되돌아온다.
   * 아래 픽스처의 오늘 행은 그 실측값 그대로다.
   */
  const withTodayRow = SISE_302440_PREOPEN.replace(
    '["20260828", 38300, 38950, 38000, 38950, 57833, 5.97]',
    '["20260828", 38300, 38950, 38000, 38950, 57833, 5.97],\n["20260831", 38450, 38450, 37650, 37700, 2612, 5.97]',
  )

  it('오늘 행이 섞여 와도 개장 전과 같은 값이다', async () => {
    stubDomestic({ series: withTodayRow })
    const q = await fetchNaverStock('302440', kst('10:30'))
    expect(q.close).toBe(38950) // 37,700(진행 중인 현재가)이 아니다
    expect(q.prevClose).toBe(38450)
    // 오늘 행을 쓰면 −1,250 이 된다. 그 값도 "그럴듯한 숫자"라 화면에서 구분되지 않는다.
    expect(q.close - q.prevClose).toBe(500)
    expect(q.asOf).toBe('2026-08-28')
  })

  it('하루 어느 시각에 돌려도 답이 하나다', async () => {
    // 새벽·크론 시각·개장 직후·장중·마감 직후·자정 직전. 마감 후(16:30)도 포함한다 —
    // 아침에 「기준 08-28」로 발송된 브리프가 저녁 재수집에서 바뀌면 안 된다.
    const times = ['00:05', '07:40', '09:01', '13:00', '15:35', '16:30', '23:50']
    const results: string[] = []
    for (const t of times) {
      stubDomestic({ series: withTodayRow })
      const q = await fetchNaverStock('302440', kst(t))
      results.push(`${q.close}/${q.prevClose}/${q.asOf}`)
    }
    expect(new Set(results).size).toBe(1)
    expect(results[0]).toBe('38950/38450/2026-08-28')
  })

  it('조회 창은 40일이고 endTime 은 KST 오늘이다', async () => {
    const spy = stubDomestic()
    await fetchNaverStock('302440', kst('07:40'))
    const url = String(spy.mock.calls.find(c => String(c[0]).includes('siseJson'))![0])
    expect(url).toContain('startTime=20260722') // 08-31 − 40일
    expect(url).toContain('endTime=20260831')
    expect(url).toContain('symbol=302440')
  })

  it('KST 자정 직후에도 조회 창이 어제로 밀리지 않는다', async () => {
    // UTC 로는 아직 08-30 인 시각이다. `new Date()` 를 로컬로 읽으면 창이 하루 밀린다.
    const spy = stubDomestic()
    await fetchNaverStock('302440', new Date('2026-08-30T15:30:00Z')) // = KST 08-31 00:30
    const url = String(spy.mock.calls.find(c => String(c[0]).includes('siseJson'))![0])
    expect(url).toContain('endTime=20260831')
  })
})

describe('계열이 성길 때 — 지어내지 않는다', () => {
  it('연휴로 마지막 두 거래일이 며칠 떨어져 있어도 동작한다', async () => {
    // 추석 연휴를 사이에 둔 계열(09-25 금 → 10-06 화). 날짜 간격을 가정하지 않는다.
    const holiday = `
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20260925", 38000, 38500, 37800, 38450, 81128, 5.9],
["20261006", 38300, 38950, 38000, 38950, 57833, 5.97]
]`
    stubDomestic({ series: holiday })
    const q = await fetchNaverStock('302440', new Date('2026-10-07T07:40:00+09:00'))
    expect(q.close).toBe(38950)
    expect(q.prevClose).toBe(38450)
    expect(q.asOf).toBe('2026-10-06')
  })

  it('거래일이 하루뿐이면(신규 상장) 전일대비를 지어내지 않고 실패한다', async () => {
    const oneRow = `
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20260828", 38300, 38950, 38000, 38950, 57833, 5.97]
]`
    stubDomestic({ series: oneRow })
    await expect(fetchNaverStock('302440', kst('07:40'))).rejects.toThrow(/하루뿐이라 전일 종가가 없음/)
  })

  it('거래일이 하나도 없으면 실패한다 — 빈 응답을 0 으로 읽지 않는다', async () => {
    stubDomestic({ series: `[['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율']]` })
    await expect(fetchNaverStock('302440', kst('07:40'))).rejects.toThrow(/거래일이 없음/)
  })

  it('오늘 행 하나만 있는 계열도 실패한다 — 진행 중인 값으로 때우지 않는다', async () => {
    const onlyToday = `
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20260831", 38450, 38450, 37650, 37700, 2612, 5.97]
]`
    stubDomestic({ series: onlyToday })
    await expect(fetchNaverStock('302440', kst('10:30'))).rejects.toThrow(/거래일이 없음/)
  })

  it('일별 시세 5xx 는 종목 실패이고 재시도 대상이다', async () => {
    stubDomestic({ series: { body: '', status: 503 } })
    const e = (await fetchNaverStock('302440', kst('07:40')).catch(err => err)) as Error
    expect(e.message).toMatch(/일별 시세 HTTP 503/)
    expect(classifyQuoteFailure(e)).toBe('transient')
  })
})

describe('엔드포인트 두 개의 실패를 다르게 다룬다', () => {
  it('시총만 실패하면 시세는 살리고, 사유를 로그에 남긴다', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    stubDomestic({ integrationBody: { body: {}, status: 500 } })

    const q = await fetchNaverStock('302440', kst('07:40'))
    expect(q.close).toBe(38950)
    expect(q.prevClose).toBe(38450)
    expect(q.marketCapKrwTrillion).toBeUndefined()
    // 조용히 비우지 않는다 — 로그가 없으면 몇 주째 비어 있어도 아무도 모른다.
    expect(log).toHaveBeenCalledWith(expect.stringContaining('시가총액 조회 실패'))
    log.mockRestore()
  })

  it('시총 필드가 사라져도 시세는 살아남는다', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    stubDomestic({ integrationBody: integration({ totalInfos: [{ code: 'lastClosePrice', value: '38,950' }] }) })
    const q = await fetchNaverStock('302440', kst('07:40'))
    expect(q.close).toBe(38950)
    expect(q.marketCapKrwTrillion).toBeUndefined()
    log.mockRestore()
  })

  it('시세가 실패하면 시총이 멀쩡해도 그 종목은 실패다', async () => {
    stubDomestic({ series: { body: '', status: 503 } })
    await expect(fetchNaverStock('302440', kst('07:40'))).rejects.toThrow(/일별 시세 HTTP 503/)
  })
})

describe('fetchNaverDomesticIndex — KOSPI', () => {
  /** 실측(2026-08-31 08:57): 금 08-28 종가 6788.88 / 목 08-27 종가 6912.37. */
  const SISE_KOSPI = `
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20260826", 6727.25, 6887.18, 6704.1, 6808.21, 329362, 0.0],
["20260827", 6996.12, 6996.12, 6841.88, 6912.37, 268465, 0.0],
["20260828", 6846.54, 6901.78, 6780.13, 6788.88, 292615, 0.0]
]`

  it('개장 전에 전일대비가 0.00 이 아니라 금-목 차이로 나온다', async () => {
    stubDomestic({ series: SISE_KOSPI })
    const q = await fetchNaverDomesticIndex('KOSPI', kst('07:40'))
    expect(q.close).toBeCloseTo(6788.88, 2)
    expect(q.prevClose).toBeCloseTo(6912.37, 2)
    expect(q.close - q.prevClose).toBeCloseTo(-123.49, 2)
    expect(q.asOf).toBe('2026-08-28')
  })

  it('지수는 시총을 부르지 않는다 — 호출은 계열 하나뿐이다', async () => {
    const spy = stubDomestic({ series: SISE_KOSPI })
    await fetchNaverDomesticIndex('KOSPI', kst('07:40'))
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0][0])).toContain('siseJson.naver')
  })

  it('장중에도 개장 전과 같은 값이다', async () => {
    // 오늘 행은 실측 그대로다(2026-08-31 09:05: 6561.46, 거래량 23,482 — 진행 중).
    const withToday = SISE_KOSPI.replace(
      '["20260828", 6846.54, 6901.78, 6780.13, 6788.88, 292615, 0.0]',
      '["20260828", 6846.54, 6901.78, 6780.13, 6788.88, 292615, 0.0],\n["20260831", 6613.58, 6617.06, 6561.46, 6561.46, 23482, 0.0]',
    )
    stubDomestic({ series: withToday })
    const q = await fetchNaverDomesticIndex('KOSPI', kst('13:00'))
    expect(q.close).toBeCloseTo(6788.88, 2)
    expect(q.prevClose).toBeCloseTo(6912.37, 2)
    expect(q.asOf).toBe('2026-08-28')
  })
})
