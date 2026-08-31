import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchKrxIndexQuote, fetchKrxIndexYtdBase, KRX_IDX_NM_KOSPI200_HEALTHCARE } from './krx'

// 실측(2026-08-27)한 사실만 픽스처로 굳힌다:
//   - 하루치 응답은 KOSPI 계열 지수 **51행**이고 우리 행은 그중 하나다.
//   - 우리 행의 IDX_NM 은 '코스피 200 헬스케어'(코스피와 200 사이 공백 있음).
//   - 휴장일은 오류가 아니라 빈 OutBlock_1 이다(20251231, 20260827).
//   - 모든 값이 문자열이다.
//   - 2025년 마지막 거래일은 12/31 이 아니라 12/30 이고 종가는 2392.04 다.

const HEALTHCARE = KRX_IDX_NM_KOSPI200_HEALTHCARE

/** 실측 응답 한 행. 우리가 안 읽는 필드도 그대로 둔다 — 무시하는지 확인해야 하므로. */
function healthcareRow(basDd: string, close: string, cmpPrevDd: string, flucRt: string) {
  return {
    BAS_DD: basDd,
    IDX_CLSS: 'KOSPI',
    IDX_NM: HEALTHCARE,
    CLSPRC_IDX: close,
    CMPPREVDD_IDX: cmpPrevDd,
    FLUC_RT: flucRt,
    OPNPRC_IDX: '2157.10',
    HGPRC_IDX: '2194.27',
    LWPRC_IDX: '2125.18',
    ACC_TRDVOL: '3494799',
    ACC_TRDVAL: '610623155850',
    MKTCAP: '164415589853460',
  }
}

/**
 * 하루치 51행을 만든다. 우리 행은 한가운데(25번째)에 둔다 — 첫 행이나 마지막 행을
 * 집어도 우연히 통과하는 구현을 걸러내기 위함이다. 이름이 비슷한 미끼 행도 섞는다.
 */
function fullDay(row: Record<string, string>): { OutBlock_1: Array<Record<string, string>> } {
  const decoys = [
    // 표기가 한 글자만 다른 미끼들. 우리 Instrument.name 표기(공백 없음)로 매칭하면
    // 걸리지 않고, 부분 문자열 매칭을 쓰면 잘못 걸린다.
    { IDX_NM: '코스피200 헬스케어', CLSPRC_IDX: '9999.99', CMPPREVDD_IDX: '0.00', BAS_DD: String(row.BAS_DD) },
    { IDX_NM: '코스피 200 헬스케어 TR', CLSPRC_IDX: '8888.88', CMPPREVDD_IDX: '0.00', BAS_DD: String(row.BAS_DD) },
    { IDX_NM: '코스피 200', CLSPRC_IDX: '7777.77', CMPPREVDD_IDX: '0.00', BAS_DD: String(row.BAS_DD) },
  ]
  const filler = (i: number) => ({
    IDX_NM: `기타지수${i}`,
    CLSPRC_IDX: String(1000 + i),
    CMPPREVDD_IDX: '1.00',
    BAS_DD: String(row.BAS_DD),
  })

  const rows: Array<Record<string, string>> = []
  for (let i = 0; i < 24; i++) rows.push(filler(i))
  rows.push(row)
  rows.push(...decoys)
  while (rows.length < 51) rows.push(filler(rows.length))
  return { OutBlock_1: rows }
}

const EMPTY = { OutBlock_1: [] }

/** basDd → 응답 본문. 없는 날짜는 휴장(빈 배열)으로 본다. */
function stubKrx(byDate: Record<string, unknown>, opts: { status?: number } = {}) {
  const calls: string[] = []
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    const basDd = new URL(url).searchParams.get('basDd') ?? ''
    calls.push(basDd)
    const status = opts.status ?? 200
    const body = status === 200 ? (byDate[basDd] ?? EMPTY) : { respMsg: 'Unauthorized Key', respCode: '401' }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  })
  vi.stubGlobal('fetch', spy)
  return { calls, spy }
}

function withKey(key = 'TEST-KRX-AUTH-KEY-0123456789') {
  vi.stubEnv('KRX_AUTH_KEY', key)
  return key
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

// **날짜 규칙(Task 35 후속)**: `fetchKrxIndexQuote` 는 **KST 오늘 행을 쓰지 않고**
// 어제부터 거슬러 올라간다(국내 네이버 경로와 같은 규칙, 스펙 §3.0). 그래서 아래 테스트는
// 거래일 D 의 행을 얻으려고 `now` 를 **D+1** 로 준다. `now` 를 D 로 주면 조회가 D-1 에서
// 시작해 D 행에 닿지 않는다 — 그게 의도된 동작이다.

describe('fetchKrxIndexQuote — 51행에서 우리 지수 고르기', () => {
  it('51행 중 IDX_NM 이 정확히 일치하는 행을 고른다', async () => {
    withKey()
    const day = fullDay(healthcareRow('20260826', '2173.53', '65.33', '3.10'))
    expect(day.OutBlock_1).toHaveLength(51)
    stubKrx({ '20260826': day })

    const q = await fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-27T10:00:00+09:00'))
    expect(q.close).toBeCloseTo(2173.53, 2)
  })

  it('우리 Instrument.name 표기(공백 없음)와 KRX 표기(공백 있음)는 서로 다르다', () => {
    // 이 차이가 이 종목의 유일한 함정이다. 상수가 KRX 표기인지 못박아 둔다.
    expect(HEALTHCARE).toBe('코스피 200 헬스케어')
    expect(HEALTHCARE).not.toBe('코스피200 헬스케어')
  })

  it('반환값은 close/prevClose/currency/asOf 뿐이다 — FLUC_RT 도 MKTCAP 도 싣지 않는다', async () => {
    withKey()
    // FLUC_RT 를 말이 안 되는 값으로 둔다. 그대로 쓰는 구현이면 여기서 드러난다.
    stubKrx({ '20260826': fullDay(healthcareRow('20260826', '2173.53', '65.33', '99.99')) })

    const q = await fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-27T10:00:00+09:00'))
    // 키 목록 자체를 못박는다 — FLUC_RT·MKTCAP 을 나중에 슬쩍 끼워 넣으면 여기서 걸린다.
    expect(Object.keys(q).sort()).toEqual(['asOf', 'close', 'currency', 'prevClose'])
    expect(q.close).toBeCloseTo(2173.53, 2)
    expect(q.prevClose).toBeCloseTo(2108.2, 2) // FLUC_RT 99.99 를 썼다면 여기 안 맞는다
    expect(q.currency).toBe('KRW')
    expect(q.asOf).toBe('2026-08-26')
    // 시총은 응답에 MKTCAP 이 와도 채우지 않는다(지수 4행을 일관되게 비운다).
    expect(q.marketCapKrwTrillion).toBeUndefined()
  })

  it('asOf 는 응답의 BAS_DD 를 쓴다 — 요청한 날짜가 아니라', async () => {
    withKey()
    // 요청은 08-27 부터 시작하지만 그날은 휴장이라 08-26 행이 온다.
    stubKrx({ '20260826': fullDay(healthcareRow('20260826', '2173.53', '65.33', '3.10')) })
    const q = await fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-27T19:00:00+09:00'))
    expect(q.asOf).toBe('2026-08-26')
  })

  it('BAS_DD 가 8자리 숫자가 아니면 실패로 던진다', async () => {
    withKey()
    const row = healthcareRow('2026-08-26', '2173.53', '65.33', '3.10')
    stubKrx({ '20260826': fullDay(row) })
    await expect(fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-27T10:00:00+09:00'))).rejects.toThrow(
      /BAS_DD 파싱 실패/,
    )
  })
})

describe('fetchKrxIndexQuote — 문자열 → 숫자 변환', () => {
  it('prevClose = close - CMPPREVDD_IDX', async () => {
    withKey()
    stubKrx({ '20260826': fullDay(healthcareRow('20260826', '2173.53', '65.33', '3.10')) })
    const q = await fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-27T10:00:00+09:00'))
    expect(q.prevClose).toBeCloseTo(2108.2, 2)
  })

  it('전일대비가 음수여도 맞는다 (실측 20251230: -6.67)', async () => {
    withKey()
    stubKrx({ '20251230': fullDay(healthcareRow('20251230', '2392.04', '-6.67', '-0.28')) })
    const q = await fetchKrxIndexQuote(HEALTHCARE, new Date('2025-12-31T10:00:00+09:00'))
    expect(q.close).toBeCloseTo(2392.04, 2)
    expect(q.prevClose).toBeCloseTo(2398.71, 2)
  })

  it('CLSPRC_IDX 가 빈 문자열이면 0 이 아니라 실패다', async () => {
    withKey()
    // Number('') === 0 이라 그냥 Number() 로 바꾸면 종가 0 이 그럴듯하게 저장된다.
    stubKrx({ '20260826': fullDay(healthcareRow('20260826', '', '65.33', '3.10')) })
    await expect(fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-27T10:00:00+09:00'))).rejects.toThrow(
      /CLSPRC_IDX 파싱 실패/,
    )
  })

  it('CLSPRC_IDX 가 숫자가 아니면 실패다', async () => {
    withKey()
    stubKrx({ '20260826': fullDay(healthcareRow('20260826', 'N/A', '65.33', '3.10')) })
    await expect(fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-27T10:00:00+09:00'))).rejects.toThrow(
      /CLSPRC_IDX 파싱 실패/,
    )
  })

  it('CMPPREVDD_IDX 가 없으면 실패다 — prevClose 를 close 와 같게 두지 않는다', async () => {
    withKey()
    const row = healthcareRow('20260826', '2173.53', '65.33', '3.10')
    delete (row as Record<string, unknown>).CMPPREVDD_IDX
    stubKrx({ '20260826': fullDay(row) })
    await expect(fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-27T10:00:00+09:00'))).rejects.toThrow(
      /CMPPREVDD_IDX 파싱 실패/,
    )
  })
})

describe('fetchKrxIndexQuote — 휴장일 거슬러 올라가기', () => {
  it('빈 응답이면 하루 거슬러 올라간다', async () => {
    withKey()
    // 실측 그대로: 20260827 은 0행, 20260826 은 51행.
    // now 가 08-28 인 것은 **오늘 행을 쓰지 않기 때문**이다 — 조회는 어제(08-27)부터 시작한다.
    const { calls } = stubKrx({ '20260826': fullDay(healthcareRow('20260826', '2173.53', '65.33', '3.10')) })
    const q = await fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-28T19:00:00+09:00'))
    expect(calls).toEqual(['20260827', '20260826'])
    expect(q.close).toBeCloseTo(2173.53, 2)
  })

  it('연말 연휴처럼 여러 날이 비어 있어도 월 경계를 넘어 내려간다', async () => {
    withKey()
    const { calls } = stubKrx({ '20251230': fullDay(healthcareRow('20251230', '2392.04', '-6.67', '-0.28')) })
    const q = await fetchKrxIndexQuote(HEALTHCARE, new Date('2026-01-02T08:00:00+09:00'))
    expect(calls).toEqual(['20260101', '20251231', '20251230'])
    expect(q.close).toBeCloseTo(2392.04, 2)
  })

  it('상한(10일)까지 못 찾으면 조용히 넘어가지 않고 실패로 던진다', async () => {
    withKey()
    const { calls } = stubKrx({}) // 전부 빈 응답
    await expect(fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-27T19:00:00+09:00'))).rejects.toThrow(
      /10일을 거슬러 올라가도 거래일을 찾지 못함/,
    )
    expect(calls).toHaveLength(10) // 무한히 내려가지 않는다
  })

  it('거래일은 찾았는데 그 안에 우리 지수가 없으면 휴장과 다른 사유로 실패한다', async () => {
    withKey()
    // 51행이 오는데 IDX_NM 이 하나도 안 맞는 경우 = KRX 가 지수명을 바꿨을 가능성.
    // 이걸 휴장처럼 취급해 계속 내려가면 열흘 뒤 엉뚱한 사유가 남는다.
    const day = { OutBlock_1: fullDay(healthcareRow('20260826', '1', '1', '1')).OutBlock_1.filter(r => r.IDX_NM !== HEALTHCARE) }
    const { calls } = stubKrx({ '20260826': day })
    await expect(fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-27T10:00:00+09:00'))).rejects.toThrow(
      /응답 50행에 해당 지수가 없음/,
    )
    expect(calls).toEqual(['20260826'])
  })

  it('기준일은 KST 다 — UTC 로 계산하면 하루가 밀린다', async () => {
    withKey()
    // 2026-08-26T22:00Z 는 KST 로 08-27 07:00 이다. 오늘(08-27) 행은 쓰지 않으므로
    // 조회는 08-26 부터 시작한다. UTC 로 읽었다면 오늘이 08-26 이 되어 08-25 부터 시작한다.
    const { calls } = stubKrx({ '20260826': fullDay(healthcareRow('20260826', '2173.53', '65.33', '3.10')) })
    await fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-26T22:00:00Z'))
    expect(calls[0]).toBe('20260826')
    expect(calls[0]).not.toBe('20260825')
  })
})

describe('fetchKrxIndexQuote — KST 오늘 행은 쓰지 않는다 (실행 시각 무관 불변식)', () => {
  /**
   * KRX 는 장 마감 후 당일치를 게시한다. 예전에는 조회가 KST 오늘부터 시작해서, 마감 후
   * 재수집하면 **이 한 행만 오늘 날짜**를 집었다 — 나머지 22행이 금요일 기준인데 코스피200
   * 헬스케어만 월요일이 되어 표 안에서 기준일이 어긋난다. 국내 네이버 경로와 같은 규칙으로
   * 맞춘다(스펙 §3.0).
   */
  const FRI = fullDay(healthcareRow('20260828', '2113.20', '-18.60', '-0.87'))
  const MON = fullDay(healthcareRow('20260831', '2098.40', '-14.80', '-0.70'))

  it('오늘 행이 이미 게시돼 있어도 어제 행을 쓴다', async () => {
    withKey()
    const { calls } = stubKrx({ '20260831': MON, '20260828': FRI })
    const q = await fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-31T16:30:00+09:00'))

    expect(q.asOf).toBe('2026-08-28') // 2026-08-31 이 아니다
    expect(q.close).toBeCloseTo(2113.2, 2)
    expect(q.prevClose).toBeCloseTo(2131.8, 2)
    // 오늘치는 **아예 조회하지 않는다.** 08-31 은 월요일이라 주말(08-30·08-29)을
    // 빈 응답으로 지나 금요일에 닿는다 — 그 경로가 곧 MAX_LOOKBACK_DAYS 가 있는 이유다.
    expect(calls).toEqual(['20260830', '20260829', '20260828'])
    expect(calls).not.toContain('20260831')
  })

  it('하루 어느 시각에 돌려도 답이 하나다', async () => {
    const times = ['00:05', '07:40', '09:01', '13:00', '15:35', '16:30', '23:50']
    const results: string[] = []
    for (const t of times) {
      withKey()
      stubKrx({ '20260831': MON, '20260828': FRI })
      const q = await fetchKrxIndexQuote(HEALTHCARE, new Date(`2026-08-31T${t}:00+09:00`))
      // 소수점 이하는 부동소수 잔차가 남는다(2113.20 − (−18.60) = 2131.7999…).
      // 불변식이 보려는 것은 값이 같은지이지 그 잔차가 아니다.
      results.push(`${q.close.toFixed(2)}/${q.prevClose.toFixed(2)}/${q.asOf}`)
      vi.unstubAllGlobals()
    }
    expect(new Set(results).size).toBe(1)
    expect(results[0]).toBe('2113.20/2131.80/2026-08-28')
  })

  it('개장 전에는 동작이 달라지지 않는다 — 오늘 행이 아직 없으므로 결과가 같다', async () => {
    withKey()
    // 07:40 실측 상황: 오늘치는 아직 0행이다. 위 16:30 케이스와 같은 답이 나와야 한다.
    const { calls } = stubKrx({ '20260828': FRI })
    const q = await fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-31T07:40:00+09:00'))
    expect(q.asOf).toBe('2026-08-28')
    expect(q.close).toBeCloseTo(2113.2, 2)
    expect(calls).toEqual(['20260830', '20260829', '20260828'])
  })

  it('연초 기준가는 이 규칙과 무관하다 — 전년 12/31 부터 찾는다', async () => {
    withKey()
    const { calls } = stubKrx({ '20251230': fullDay(healthcareRow('20251230', '2392.04', '-6.67', '-0.28')) })
    const v = await fetchKrxIndexYtdBase(HEALTHCARE, 2026)
    expect(v).toBeCloseTo(2392.04, 2)
    expect(calls[0]).toBe('20251231') // 오늘과 무관하게 전년 말부터
  })
})

describe('fetchKrxIndexQuote — 인증과 오류', () => {
  it('AUTH_KEY 가 없으면 네트워크를 치기 전에 실패한다', async () => {
    vi.stubEnv('KRX_AUTH_KEY', '')
    const { calls } = stubKrx({})
    await expect(fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-27T10:00:00+09:00'))).rejects.toThrow(
      /KRX_AUTH_KEY 없음/,
    )
    expect(calls).toHaveLength(0)
  })

  it('키 값이 오류 메시지에 절대 실리지 않는다', async () => {
    const key = withKey('SUPER-SECRET-KRX-KEY-DO-NOT-LEAK')
    stubKrx({}, { status: 401 })
    await expect(fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-27T10:00:00+09:00'))).rejects.toThrow(
      /KRX HTTP 401 Unauthorized Key/,
    )
    // 던져진 메시지 전문을 다시 확인한다.
    const err: unknown = await fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-27T10:00:00+09:00')).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).not.toContain(key)
  })

  it('키는 URL 이 아니라 헤더로 보낸다', async () => {
    const key = withKey()
    const { spy } = stubKrx({ '20260826': fullDay(healthcareRow('20260826', '2173.53', '65.33', '3.10')) })
    await fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-27T10:00:00+09:00'))
    const [url, init] = spy.mock.calls[0]
    expect(String(url)).not.toContain(key)
    expect(String(url)).toMatch(/^https:\/\/data-dbg\.krx\.co\.kr\//) // http 는 리다이렉트로 빠진다
    expect((init as RequestInit).headers).toMatchObject({ AUTH_KEY: key })
  })

  it('HTTP 오류는 휴장과 구분해 즉시 던진다 — 10번 재시도하지 않는다', async () => {
    withKey()
    const { calls } = stubKrx({}, { status: 401 })
    await expect(fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-27T10:00:00+09:00'))).rejects.toThrow(/HTTP 401/)
    expect(calls).toHaveLength(1)
  })

  it('OutBlock_1 이 배열이 아니면 빈 하루로 보지 않고 실패한다', async () => {
    withKey()
    const { calls } = stubKrx({ '20260826': { respMsg: '점검 중' } })
    await expect(fetchKrxIndexQuote(HEALTHCARE, new Date('2026-08-27T10:00:00+09:00'))).rejects.toThrow(
      /OutBlock_1 이 배열이 아님/,
    )
    expect(calls).toHaveLength(1)
  })
})

describe('fetchKrxIndexYtdBase — 전년 마지막 거래일 종가', () => {
  it('12/31 이 휴장이면 12/30 종가를 쓴다 (실측 2392.04)', async () => {
    withKey()
    // 12/31 은 빈 응답, 12/30 은 51행. 날짜를 가정한 구현이면 여기서 갈린다.
    const { calls } = stubKrx({ '20251230': fullDay(healthcareRow('20251230', '2392.04', '-6.67', '-0.28')) })
    const v = await fetchKrxIndexYtdBase(HEALTHCARE, 2026)
    expect(v).toBeCloseTo(2392.04, 2)
    expect(calls).toEqual(['20251231', '20251230'])
  })

  it('전년 12/31 부터 조회한다 — 창이 틀리면 값은 그럴듯한데 조용히 틀린다', async () => {
    withKey()
    const { calls } = stubKrx({ '20241231': fullDay(healthcareRow('20241231', '1500.00', '1.00', '0.07')) })
    const v = await fetchKrxIndexYtdBase(HEALTHCARE, 2025)
    expect(calls[0]).toBe('20241231')
    expect(v).toBeCloseTo(1500, 2)
  })

  it('12/30 이 아니라 12/29 가 마지막 거래일이어도 찾아낸다 — 날짜를 못박지 않는다', async () => {
    withKey()
    const { calls } = stubKrx({ '20291229': fullDay(healthcareRow('20291229', '3000.00', '2.00', '0.07')) })
    const v = await fetchKrxIndexYtdBase(HEALTHCARE, 2030)
    expect(calls).toEqual(['20291231', '20291230', '20291229'])
    expect(v).toBeCloseTo(3000, 2)
  })

  it('상한까지 못 찾으면 실패로 던진다 — 기준가 없이 조용히 넘어가지 않는다', async () => {
    withKey()
    stubKrx({})
    await expect(fetchKrxIndexYtdBase(HEALTHCARE, 2026)).rejects.toThrow(/거래일을 찾지 못함/)
  })
})
