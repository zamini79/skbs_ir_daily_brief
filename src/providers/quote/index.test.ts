import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./naver', () => ({
  fetchNaverStock: vi.fn(async (c: string) => ({ close: 100, prevClose: 90, currency: 'KRW', asOf: '2026-08-26' })),
  fetchNaverDomesticIndex: vi.fn(async () => ({ close: 6800, prevClose: 6700, currency: 'KRW', asOf: '2026-08-26' })),
  fetchNaverWorldIndex: vi.fn(async () => ({ close: 7675, prevClose: 7677, currency: 'USD', asOf: '2026-08-26' })),
  fetchNaverWorldStock: vi.fn(async () => ({ close: 50.5, prevClose: 50.75, currency: 'HKD', asOf: '2026-08-27' })),
}))
vi.mock('./lse', () => ({
  fetchLseQuote: vi.fn(async () => ({ close: 1852, prevClose: 1899.5, currency: 'GBX', asOf: '2026-08-27' })),
}))
vi.mock('./six', () => ({
  fetchSixQuote: vi.fn(async () => ({ close: 588.4, prevClose: 587.8, currency: 'CHF', asOf: '2026-08-27' })),
}))
vi.mock('./ft', () => ({
  // FT 는 2차 전용이다. 값을 1차와 **일부러 다르게** 둔다 — 어느 쪽이 쓰였는지
  // 테스트가 값으로도 구분할 수 있어야 한다.
  fetchFtQuote: vi.fn(async () => ({ close: 77.28, prevClose: 78.29, currency: 'EUR', asOf: '2026-08-27' })),
}))
vi.mock('./twelvedata', () => ({
  fetchTwelveDataQuotes: vi.fn(async () => ({
    quotes: new Map([['PFE', { close: 28.3, prevClose: 28.57, currency: 'USD', asOf: '2026-08-26' }]]),
    failures: new Map(),
  })),
}))
vi.mock('./krx', () => ({
  fetchKrxIndexQuote: vi.fn(async () => ({ close: 2173.53, prevClose: 2108.2, currency: 'KRW', asOf: '2026-08-26' })),
}))
vi.mock('./marketstack', () => ({
  fetchMarketstackQuotes: vi.fn(async () => new Map([['GSK.L', { close: 1890.5, prevClose: 1875, currency: 'GBP', asOf: '2026-08-25' }]])),
  fetchMarketstackYtdBase: vi.fn(async () => new Map()),
}))

import { fetchAllQuotes } from './index'
import { INSTRUMENTS } from '../../../prisma/instruments'
import {
  fetchNaverStock,
  fetchNaverDomesticIndex,
  fetchNaverWorldIndex,
  fetchNaverWorldStock,
} from './naver'
import { fetchTwelveDataQuotes } from './twelvedata'
import { fetchMarketstackQuotes } from './marketstack'
import { fetchKrxIndexQuote } from './krx'
import { fetchLseQuote } from './lse'
import { fetchSixQuote } from './six'
import { fetchFtQuote } from './ft'

beforeEach(() => vi.clearAllMocks())

describe('fetchAllQuotes', () => {
  it('소스별로 알맞은 fetcher 를 부른다', async () => {
    const r = await fetchAllQuotes([
      { id: 'a', quoteSource: 'naver-stock', quoteSymbol: '207940' },
      { id: 'b', quoteSource: 'twelvedata', quoteSymbol: 'PFE' },
      { id: 'c', quoteSource: 'marketstack', quoteSymbol: 'GSK.L' },
    ])
    expect((r.get('a') as any).close).toBe(100)
    expect((r.get('b') as any).close).toBeCloseTo(28.3, 4)
    expect((r.get('c') as any).close).toBeCloseTo(1890.5, 4)
  })

  it('krx-index 는 KRX 지수 fetcher 로 간다 — 심볼이 . 로 시작하지 않아도 네이버로 새지 않는다', async () => {
    const r = await fetchAllQuotes([
      { id: 'h', quoteSource: 'krx-index', quoteSymbol: '코스피 200 헬스케어' },
    ])
    expect((r.get('h') as any).close).toBeCloseTo(2173.53, 2)
    expect(fetchKrxIndexQuote).toHaveBeenCalledWith('코스피 200 헬스케어')
    expect(fetchNaverDomesticIndex).not.toHaveBeenCalled()
    expect(fetchNaverStock).not.toHaveBeenCalled()
  })

  it('krx-index 가 실패해도 다른 종목은 살아남고 사유가 Error 로 남는다', async () => {
    vi.mocked(fetchKrxIndexQuote).mockRejectedValueOnce(new Error('[코스피 200 헬스케어] 거래일을 찾지 못함'))
    const r = await fetchAllQuotes([
      { id: 'h', quoteSource: 'krx-index', quoteSymbol: '코스피 200 헬스케어' },
      { id: 'a', quoteSource: 'naver-stock', quoteSymbol: '207940' },
    ])
    expect(r.get('h')).toBeInstanceOf(Error)
    expect((r.get('h') as Error).message).toContain('거래일을 찾지 못함')
    expect((r.get('a') as any).close).toBe(100)
  })

  // ── Task 31: GSK·Lonza·Wuxi 를 marketstack 에서 무료 거래소 엔드포인트로 옮겼다 ──

  it('lse·six·naver-world-stock 은 각자의 fetcher 로 가고 marketstack 을 부르지 않는다', async () => {
    // 이 셋이 marketstack 으로 새면 옮긴 의미가 없다(월 88회로 되돌아간다).
    const r = await fetchAllQuotes([
      { id: 'gsk', quoteSource: 'lse', quoteSymbol: 'GSK' },
      { id: 'lonn', quoteSource: 'six', quoteSymbol: 'LONN' },
      { id: 'wuxi', quoteSource: 'naver-world-stock', quoteSymbol: '2269.HK' },
    ])
    expect((r.get('gsk') as any).close).toBe(1852)
    expect((r.get('lonn') as any).close).toBeCloseTo(588.4, 4)
    expect((r.get('wuxi') as any).close).toBeCloseTo(50.5, 4)
    expect(fetchLseQuote).toHaveBeenCalledWith('GSK')
    expect(fetchSixQuote).toHaveBeenCalledWith('LONN')
    expect(fetchNaverWorldStock).toHaveBeenCalledWith('2269.HK')
    expect(fetchMarketstackQuotes).not.toHaveBeenCalled()
  })

  it('naver-world-stock 은 국내주·지수 fetcher 로 새지 않는다', async () => {
    // 같은 파일(naver.ts)에 있고 심볼이 . 을 포함하므로(2269.HK) 분기가 헷갈리기 쉽다.
    await fetchAllQuotes([{ id: 'wuxi', quoteSource: 'naver-world-stock', quoteSymbol: '2269.HK' }])
    expect(fetchNaverStock).not.toHaveBeenCalled()
    expect(fetchNaverDomesticIndex).not.toHaveBeenCalled()
    expect(fetchNaverWorldIndex).not.toHaveBeenCalled()
  })

  it('marketstack 1차 종목이 한도 소진으로 실패해도 lse·six·naver 종목은 영향이 없다', async () => {
    // 소스를 넷으로 쪼갠 이유가 이것이다 — 한 소스의 한도 소진이 네 행을 통째로
    // 비우지 않는다. (Task 43 이후 사노피의 1차는 FT 다. 이 테스트는 소스 단위 격리를
    // 지키는 것이고, 시드 구성은 아래 Task 43 절이 지킨다.)
    vi.mocked(fetchMarketstackQuotes).mockRejectedValueOnce(
      new Error('marketstack HTTP 429 (usage_limit_reached: Your monthly usage limit has been reached.)'),
    )
    const r = await fetchAllQuotes(
      [
        { id: 'gsk', quoteSource: 'lse', quoteSymbol: 'GSK' },
        { id: 'san', quoteSource: 'marketstack', quoteSymbol: 'SAN.PA' },
        { id: 'lonn', quoteSource: 'six', quoteSymbol: 'LONN' },
        { id: 'wuxi', quoteSource: 'naver-world-stock', quoteSymbol: '2269.HK' },
      ],
      { sleep: async () => {} },
    )
    expect(r.get('san')).toBeInstanceOf(Error)
    expect((r.get('san') as Error).message).toContain('usage_limit_reached')
    expect((r.get('gsk') as any).close).toBe(1852)
    expect((r.get('lonn') as any).close).toBeCloseTo(588.4, 4)
    expect((r.get('wuxi') as any).close).toBeCloseTo(50.5, 4)
    // 한도 소진은 기다려도 안 풀린다 — 재시도하지 않는다.
    expect(fetchMarketstackQuotes).toHaveBeenCalledTimes(1)
  })

  it('새 소스도 일시적 실패면 한 번 더 부른다', async () => {
    vi.mocked(fetchSixQuote).mockRejectedValueOnce(new Error('[LONN] SIX HTTP 502'))
    const r = await fetchAllQuotes(
      [{ id: 'lonn', quoteSource: 'six', quoteSymbol: 'LONN' }],
      { sleep: async () => {} },
    )
    expect((r.get('lonn') as any).close).toBeCloseTo(588.4, 4)
    expect(fetchSixQuote).toHaveBeenCalledTimes(2)
  })

  it('새 소스가 끝내 실패하면 그 행만 사유와 함께 남는다', async () => {
    vi.mocked(fetchLseQuote).mockRejectedValueOnce(new Error('[GSK] LSE HTTP 404 (Not found instrument with tidm: GSK)'))
    const r = await fetchAllQuotes(
      [
        { id: 'gsk', quoteSource: 'lse', quoteSymbol: 'GSK' },
        { id: 'lonn', quoteSource: 'six', quoteSymbol: 'LONN' },
      ],
      { sleep: async () => {} },
    )
    expect(r.get('gsk')).toBeInstanceOf(Error)
    expect((r.get('gsk') as Error).message).toContain('HTTP 404')
    expect((r.get('lonn') as any).close).toBeCloseTo(588.4, 4)
    expect(fetchLseQuote).toHaveBeenCalledTimes(1) // 404 는 재시도하지 않는다
  })

  // ── Task 32: 1차가 실패하면 2차(FT)로 채운다 ──
  //
  // 폴백은 실패 **확률을 낮추는** 장치다. 실패를 없애지 않는다 — 둘 다 죽으면
  // 그 행은 여전히 실패이고, 그때 두 사유가 모두 남아야 원인 추적이 끊기지 않는다.

  // Task 43 이전의 사노피 구성(1차 marketstack, 2차 ft)이다. 지금 시드와는 다르지만
  // **배치 소스의 실패가 폴백을 받는가**를 지키는 유일한 자리라 남긴다(index.ts 의
  // 두 단계 구조 주석). 지금 시드 구성은 아래 Task 43 절이 지킨다.
  const SANOFI = {
    id: 'san',
    quoteSource: 'marketstack',
    quoteSymbol: 'SAN.PA',
    quoteFallbackSource: 'ft',
    quoteFallbackSymbol: 'SAN:PAR',
  }

  it('1차가 성공하면 2차를 아예 부르지 않는다', async () => {
    // 평소에 FT 를 부르면 우리는 아무것도 얻지 못하면서 남의 부하만 두 배로 만든다.
    const r = await fetchAllQuotes([
      { id: 'gsk', quoteSource: 'lse', quoteSymbol: 'GSK', quoteFallbackSource: 'ft', quoteFallbackSymbol: 'GSK:LSE' },
      { id: 'lonn', quoteSource: 'six', quoteSymbol: 'LONN', quoteFallbackSource: 'ft', quoteFallbackSymbol: 'LONN:SWX' },
    ])
    expect((r.get('gsk') as any).close).toBe(1852)
    expect((r.get('lonn') as any).close).toBeCloseTo(588.4, 4)
    expect(fetchFtQuote).not.toHaveBeenCalled()
  })

  it('1차가 성공한 행의 sourceName 은 1차 소스이고 fallbackFrom 은 null 이다', async () => {
    const r = await fetchAllQuotes([{ id: 'gsk', quoteSource: 'lse', quoteSymbol: 'GSK', quoteFallbackSource: 'ft', quoteFallbackSymbol: 'GSK:LSE' }])
    expect((r.get('gsk') as any).sourceName).toBe('lse')
    expect((r.get('gsk') as any).fallbackFrom).toBeNull()
  })

  it('1차(marketstack 소진)가 실패하면 2차 값으로 채우고 sourceName 이 2차 소스가 된다', async () => {
    // 이것이 이 작업의 성공 조건이다 — marketstack 월 한도가 소진돼도 사노피 행이 빈다.
    vi.mocked(fetchMarketstackQuotes).mockRejectedValueOnce(
      new Error('marketstack HTTP 429 (usage_limit_reached: Your monthly usage limit has been reached.)'),
    )
    const r = await fetchAllQuotes([SANOFI], { sleep: async () => {} })
    const hit = r.get('san') as any
    expect(hit).not.toBeInstanceOf(Error)
    expect(hit.close).toBeCloseTo(77.28, 4)
    // **설정값(marketstack)이 아니라 실제로 값을 가져온 소스**여야 한다.
    expect(hit.sourceName).toBe('ft')
    expect(hit.fallbackFrom).toBe('marketstack')
  })

  it('2차는 1차 심볼이 아니라 quoteFallbackSymbol 로 부른다', async () => {
    // 표기가 다르다(`SAN.PA` ↔ `SAN:PAR`). 1차 심볼을 그대로 넘기면 FT 는 오류가
    // 아니라 검색 페이지로 302 를 준다 — 폴백이 있으나 마나가 된다.
    vi.mocked(fetchMarketstackQuotes).mockRejectedValueOnce(new Error('marketstack HTTP 401'))
    await fetchAllQuotes([SANOFI], { sleep: async () => {} })
    expect(fetchFtQuote).toHaveBeenCalledWith('SAN:PAR')
  })

  it('둘 다 실패하면 사유에 **두 소스가 모두** 남는다', async () => {
    vi.mocked(fetchMarketstackQuotes).mockRejectedValueOnce(new Error('marketstack HTTP 401'))
    // 2차는 **재시도해도 소용없는** 실패로 둔다(HTML 구조 변경). 5xx 로 두면 재시도
    // 한 번에 성공해 버려서 "둘 다 실패"를 확인하지 못한다.
    vi.mocked(fetchFtQuote).mockRejectedValueOnce(new Error('[SAN:PAR] FT: Price 라벨을 찾지 못함'))
    const r = await fetchAllQuotes([SANOFI], { sleep: async () => {} })
    const err = r.get('san') as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('marketstack HTTP 401') // 1차 사유
    expect(err.message).toContain('Price 라벨을 찾지 못함') // 2차 사유
    expect(err.message).toContain('폴백')
  })

  it('폴백이 설정되지 않은 종목은 폴백하지 않는다 — 실패가 그대로 남는다', async () => {
    vi.mocked(fetchNaverStock).mockRejectedValueOnce(new Error('[207940] HTTP 401'))
    const r = await fetchAllQuotes(
      [{ id: 'a', quoteSource: 'naver-stock', quoteSymbol: '207940' }],
      { sleep: async () => {} },
    )
    expect(r.get('a')).toBeInstanceOf(Error)
    expect(fetchFtQuote).not.toHaveBeenCalled()
  })

  it('모르는 폴백 소스는 조용히 건너뛰지 않고 사유에 남는다', async () => {
    // 조용히 건너뛰면 "폴백이 설정돼 있는데 왜 안 도나"를 알아낼 방법이 없다.
    vi.mocked(fetchSixQuote).mockRejectedValueOnce(new Error('[LONN] SIX HTTP 401'))
    const r = await fetchAllQuotes(
      [{ id: 'lonn', quoteSource: 'six', quoteSymbol: 'LONN', quoteFallbackSource: 'yahoo', quoteFallbackSymbol: 'LONN.SW' }],
      { sleep: async () => {} },
    )
    const err = r.get('lonn') as Error
    expect(err.message).toContain('SIX HTTP 401')
    expect(err.message).toContain('알 수 없는 폴백 소스: yahoo')
    expect(fetchFtQuote).not.toHaveBeenCalled()
  })

  it('폴백 심볼이 비어 있으면 사유에 남는다', async () => {
    vi.mocked(fetchSixQuote).mockRejectedValueOnce(new Error('[LONN] SIX HTTP 401'))
    const r = await fetchAllQuotes(
      [{ id: 'lonn', quoteSource: 'six', quoteSymbol: 'LONN', quoteFallbackSource: 'ft', quoteFallbackSymbol: '' }],
      { sleep: async () => {} },
    )
    expect((r.get('lonn') as Error).message).toContain('폴백 심볼이 비어 있음')
    expect(fetchFtQuote).not.toHaveBeenCalled()
  })

  it('2차도 재시도를 태운다 — 1차가 이미 죽은 상태라 여기가 마지막 기회다', async () => {
    vi.mocked(fetchMarketstackQuotes).mockRejectedValueOnce(new Error('marketstack HTTP 401'))
    vi.mocked(fetchFtQuote).mockRejectedValueOnce(new Error('[SAN:PAR] FT HTTP 503'))
    const r = await fetchAllQuotes([SANOFI], { sleep: async () => {} })
    expect((r.get('san') as any).close).toBeCloseTo(77.28, 4)
    expect(fetchFtQuote).toHaveBeenCalledTimes(2)
  })

  it('2차의 재시도 불가 실패(302)는 한 번만 부른다', async () => {
    vi.mocked(fetchMarketstackQuotes).mockRejectedValueOnce(new Error('marketstack HTTP 401'))
    vi.mocked(fetchFtQuote).mockRejectedValueOnce(new Error('[SAN:PAR] FT HTTP 302 (심볼을 찾지 못해 검색 페이지로 리다이렉트)'))
    const r = await fetchAllQuotes([SANOFI], { sleep: async () => {} })
    expect(r.get('san')).toBeInstanceOf(Error)
    expect(fetchFtQuote).toHaveBeenCalledTimes(1)
  })

  it('한 종목이 폴백으로 채워져도 다른 종목의 결과는 그대로다', async () => {
    vi.mocked(fetchMarketstackQuotes).mockRejectedValueOnce(new Error('marketstack HTTP 429 (usage_limit_reached)'))
    const r = await fetchAllQuotes(
      [
        { id: 'gsk', quoteSource: 'lse', quoteSymbol: 'GSK', quoteFallbackSource: 'ft', quoteFallbackSymbol: 'GSK:LSE' },
        SANOFI,
        { id: 'lonn', quoteSource: 'six', quoteSymbol: 'LONN', quoteFallbackSource: 'ft', quoteFallbackSymbol: 'LONN:SWX' },
      ],
      { sleep: async () => {} },
    )
    expect((r.get('gsk') as any).sourceName).toBe('lse')
    expect((r.get('lonn') as any).sourceName).toBe('six')
    expect((r.get('san') as any).sourceName).toBe('ft')
    // 1차가 살아 있는 두 종목 때문에 FT 를 부르지는 않는다.
    expect(fetchFtQuote).toHaveBeenCalledTimes(1)
    expect(fetchFtQuote).toHaveBeenCalledWith('SAN:PAR')
  })

  // ── Task 43: 유럽 3종목의 1차가 FT 다. 2차는 각자 원래 쓰던 소스 ──
  //
  // 대상을 **시드에서 그대로** 만든다. 손으로 적은 대상으로 테스트하면 시드와 배선이
  // 서로 어긋나도(시드는 `lse` 를 가리키는데 폴백 표에 없다 등) 둘 다 초록으로 남는다.

  const EU = ['GSK', 'Sanofi', 'Lonza'].map(name => {
    const i = INSTRUMENTS.find(x => x.name === name)!
    return {
      id: name,
      quoteSource: i.quoteSource,
      quoteSymbol: i.quoteSymbol,
      quoteFallbackSource: i.quoteFallbackSource ?? null,
      quoteFallbackSymbol: i.quoteFallbackSymbol ?? null,
    }
  })

  /**
   * FT 가 HTML 구조 변경으로 죽은 날. 재시도해도 소용없는 실패라 세 종목에 한 번씩
   * 불린다. `…Once` 로 건다 — clearAllMocks 는 구현을 되돌리지 않으므로 영구 구현을
   * 걸면 뒤 테스트로 샌다.
   */
  const ftBroken = () => {
    for (let n = 0; n < 3; n++) {
      vi.mocked(fetchFtQuote).mockImplementationOnce(async (code: string) => {
        throw new Error(`[${code}] FT: Price 라벨을 찾지 못함`)
      })
    }
  }

  it('유럽 3종목은 FT 1차로 디스패치되고, 1차가 성공하면 2차를 부르지 않는다', async () => {
    const r = await fetchAllQuotes(EU)
    expect(vi.mocked(fetchFtQuote).mock.calls.map(c => c[0]).sort()).toEqual(['GSK:LSE', 'LONN:SWX', 'SAN:PAR'])
    for (const id of ['GSK', 'Sanofi', 'Lonza']) {
      const hit = r.get(id) as any
      expect(hit, id).not.toBeInstanceOf(Error)
      expect(hit.sourceName, id).toBe('ft')
      expect(hit.fallbackFrom, id).toBeNull()
    }
    expect(fetchLseQuote).not.toHaveBeenCalled()
    expect(fetchSixQuote).not.toHaveBeenCalled()
    expect(fetchMarketstackQuotes).not.toHaveBeenCalled()
  })

  it('FT 가 죽으면 세 종목이 각자의 2차(lse·marketstack·six)로 채워지고 배지·로그용 표시가 정확하다', async () => {
    ftBroken()
    vi.mocked(fetchMarketstackQuotes).mockResolvedValueOnce(
      new Map([['SAN.PA', { close: 71.52, prevClose: 70.93, currency: 'EUR', asOf: '2026-10-09' }]]),
    )
    const r = await fetchAllQuotes(EU, { sleep: async () => {} })

    const gsk = r.get('GSK') as any
    expect(gsk.close).toBe(1852) // lse mock 값
    expect([gsk.sourceName, gsk.fallbackFrom]).toEqual(['lse', 'ft'])
    expect(fetchLseQuote).toHaveBeenCalledWith('GSK')

    const lonn = r.get('Lonza') as any
    expect(lonn.close).toBeCloseTo(588.4, 4) // six mock 값
    expect([lonn.sourceName, lonn.fallbackFrom]).toEqual(['six', 'ft'])
    expect(fetchSixQuote).toHaveBeenCalledWith('LONN')

    const san = r.get('Sanofi') as any
    expect(san.close).toBeCloseTo(71.52, 4)
    // 2차 marketstack 은 하루 늦을 수 있다 — 기준일을 그대로 실어야 화면이 드러낸다.
    expect(san.asOf).toBe('2026-10-09')
    expect([san.sourceName, san.fallbackFrom]).toEqual(['marketstack', 'ft'])
    // 배치 API 지만 2차로는 그 종목 한 심볼만 부른다(한도는 심볼 수로 센다).
    expect(fetchMarketstackQuotes).toHaveBeenCalledTimes(1)
    expect(fetchMarketstackQuotes).toHaveBeenCalledWith(['SAN.PA'])
  })

  it('2차 marketstack 응답에 그 심볼이 없으면 지어내지 않고 두 사유를 남긴다', async () => {
    ftBroken()
    vi.mocked(fetchMarketstackQuotes).mockResolvedValueOnce(new Map())
    const r = await fetchAllQuotes(EU, { sleep: async () => {} })
    const err = r.get('Sanofi') as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toContain('[SAN:PAR] FT: Price 라벨을 찾지 못함')
    expect(err.message).toContain('폴백(marketstack) 실패: marketstack: SAN.PA 응답 없음')
  })

  it('FT 와 2차가 함께 죽으면 세 종목 모두 두 사유가 남는다', async () => {
    ftBroken()
    vi.mocked(fetchLseQuote).mockRejectedValueOnce(new Error('[GSK] LSE HTTP 404'))
    vi.mocked(fetchSixQuote).mockRejectedValueOnce(new Error('[LONN] SIX HTTP 404'))
    vi.mocked(fetchMarketstackQuotes).mockRejectedValueOnce(
      new Error('marketstack HTTP 429 (usage_limit_reached: Your monthly usage limit has been reached.)'),
    )
    const r = await fetchAllQuotes(EU, { sleep: async () => {} })
    const msg = (id: string) => (r.get(id) as Error).message
    expect(msg('GSK')).toContain('[GSK:LSE] FT: Price 라벨을 찾지 못함')
    expect(msg('GSK')).toContain('폴백(lse) 실패: [GSK] LSE HTTP 404')
    expect(msg('Lonza')).toContain('[LONN:SWX] FT: Price 라벨을 찾지 못함')
    expect(msg('Lonza')).toContain('폴백(six) 실패: [LONN] SIX HTTP 404')
    expect(msg('Sanofi')).toContain('[SAN:PAR] FT: Price 라벨을 찾지 못함')
    expect(msg('Sanofi')).toContain('폴백(marketstack) 실패: marketstack HTTP 429 (usage_limit_reached')
  })

  it('Wuxi 는 그대로 네이버 1차이고 FT 를 부르지 않는다', async () => {
    const w = INSTRUMENTS.find(x => x.name === 'Wuxi')!
    const r = await fetchAllQuotes([
      { id: 'wuxi', quoteSource: w.quoteSource, quoteSymbol: w.quoteSymbol, quoteFallbackSource: w.quoteFallbackSource, quoteFallbackSymbol: w.quoteFallbackSymbol },
    ])
    expect((r.get('wuxi') as any).sourceName).toBe('naver-world-stock')
    expect(fetchNaverWorldStock).toHaveBeenCalledWith('2269.HK')
    expect(fetchFtQuote).not.toHaveBeenCalled()
  })

  it('manual 소스는 결과에 넣지 않는다', async () => {
    const r = await fetchAllQuotes([{ id: 'z', quoteSource: 'manual', quoteSymbol: '' }])
    expect(r.has('z')).toBe(false)
  })

  it('한 종목이 실패해도 나머지를 살린다', async () => {
    vi.mocked(fetchNaverStock).mockRejectedValueOnce(new Error('boom'))
    const r = await fetchAllQuotes([
      { id: 'a', quoteSource: 'naver-stock', quoteSymbol: '207940' },
      { id: 'b', quoteSource: 'twelvedata', quoteSymbol: 'PFE' },
    ])
    expect(r.get('a')).toBeInstanceOf(Error)
    expect((r.get('b') as any).close).toBeCloseTo(28.3, 4)
  })

  it('배치 소스에서 빠진 심볼은 Error 로 남긴다', async () => {
    const r = await fetchAllQuotes([{ id: 'x', quoteSource: 'twelvedata', quoteSymbol: 'NOPE' }])
    expect(r.get('x')).toBeInstanceOf(Error)
  })

  it('twelvedata 가 준 실패 사유를 "응답 없음"으로 뭉개지 않고 그대로 싣는다', async () => {
    // 한도 초과와 심볼 오타가 화면에서 같은 문장이 되면 안 된다.
    vi.mocked(fetchTwelveDataQuotes).mockResolvedValueOnce({
      quotes: new Map(),
      failures: new Map([
        ['PFE', 'You have run out of API credits for the current minute.'],
        ['WXIBY', 'symbol not found'],
      ]),
    })
    const r = await fetchAllQuotes([
      { id: 'p', quoteSource: 'twelvedata', quoteSymbol: 'PFE' },
      { id: 'w', quoteSource: 'twelvedata', quoteSymbol: 'WXIBY' },
    ])
    expect((r.get('p') as Error).message).toContain('API credits')
    expect((r.get('w') as Error).message).toContain('symbol not found')
    expect((r.get('p') as Error).message).not.toBe((r.get('w') as Error).message)
  })

  it('사유가 없는 심볼만 "응답 없음"으로 남는다', async () => {
    vi.mocked(fetchTwelveDataQuotes).mockResolvedValueOnce({
      quotes: new Map(),
      failures: new Map(),
    })
    const r = await fetchAllQuotes([{ id: 'x', quoteSource: 'twelvedata', quoteSymbol: 'NOPE' }])
    expect((r.get('x') as Error).message).toBe('twelvedata: NOPE 응답 없음')
  })

  it('알 수 없는 quoteSource 는 Error 로 남기고 값이 사라지지 않는다', async () => {
    const r = await fetchAllQuotes([{ id: 'typo', quoteSource: 'naver-stok', quoteSymbol: '207940' }])
    expect(r.has('typo')).toBe(true)
    expect(r.get('typo')).toBeInstanceOf(Error)
    expect((r.get('typo') as Error).message).toContain('naver-stok')
  })

  it('naver-index 이고 심볼이 . 로 시작하면 해외지수 fetcher 를 부른다', async () => {
    const r = await fetchAllQuotes([{ id: 'w', quoteSource: 'naver-index', quoteSymbol: '.INX' }])
    expect((r.get('w') as any).close).toBe(7675)
    expect(fetchNaverWorldIndex).toHaveBeenCalledWith('.INX')
    expect(fetchNaverDomesticIndex).not.toHaveBeenCalled()
  })

  it('naver-index 이고 심볼이 . 로 시작하지 않으면 국내지수 fetcher 를 부른다', async () => {
    const r = await fetchAllQuotes([{ id: 'k', quoteSource: 'naver-index', quoteSymbol: 'KOSPI' }])
    expect((r.get('k') as any).close).toBe(6800)
    expect(fetchNaverDomesticIndex).toHaveBeenCalledWith('KOSPI')
    expect(fetchNaverWorldIndex).not.toHaveBeenCalled()
  })

  it('twelvedata 가 전체 실패하면 해당 배치의 모든 종목이 Error 이고 다른 그룹은 영향받지 않는다', async () => {
    vi.mocked(fetchTwelveDataQuotes).mockRejectedValueOnce(new Error('td down'))
    const r = await fetchAllQuotes([
      { id: 'a', quoteSource: 'naver-stock', quoteSymbol: '207940' },
      { id: 'b', quoteSource: 'twelvedata', quoteSymbol: 'PFE' },
      { id: 'c', quoteSource: 'twelvedata', quoteSymbol: 'JNJ' },
      { id: 'd', quoteSource: 'marketstack', quoteSymbol: 'GSK.L' },
    ])
    expect(r.get('b')).toBeInstanceOf(Error)
    expect(r.get('c')).toBeInstanceOf(Error)
    expect((r.get('a') as any).close).toBe(100)
    expect((r.get('d') as any).close).toBeCloseTo(1890.5, 4)
  })

  it('일시적 실패(522)는 같은 소스를 한 번 더 불러 하루치 공란을 막는다', async () => {
    // 실측: twelvedata 522 로 미국 5행이 통째로 비었고, 몇 분 뒤 손으로 부르니 정상이었다.
    // 수집은 07:40 한 번뿐이라 재시도가 없으면 그 공란이 하루 종일 남는다.
    vi.mocked(fetchTwelveDataQuotes).mockRejectedValueOnce(new Error('twelvedata HTTP 522'))
    const r = await fetchAllQuotes(
      [{ id: 'b', quoteSource: 'twelvedata', quoteSymbol: 'PFE' }],
      { sleep: async () => {} },
    )
    expect((r.get('b') as any).close).toBeCloseTo(28.3, 4)
    expect(fetchTwelveDataQuotes).toHaveBeenCalledTimes(2)
  })

  it('marketstack 429 도 같은 규칙으로 한 번 더 부른다', async () => {
    vi.mocked(fetchMarketstackQuotes).mockRejectedValueOnce(new Error('marketstack HTTP 429'))
    const r = await fetchAllQuotes(
      [{ id: 'c', quoteSource: 'marketstack', quoteSymbol: 'GSK.L' }],
      { sleep: async () => {} },
    )
    expect((r.get('c') as any).close).toBeCloseTo(1890.5, 4)
    expect(fetchMarketstackQuotes).toHaveBeenCalledTimes(2)
  })

  it('재시도해도 소용없는 실패(401)는 한 번만 부르고 사유를 남긴다', async () => {
    vi.mocked(fetchNaverStock).mockRejectedValueOnce(new Error('[207940] HTTP 401'))
    const r = await fetchAllQuotes(
      [{ id: 'a', quoteSource: 'naver-stock', quoteSymbol: '207940' }],
      { sleep: async () => {} },
    )
    expect(r.get('a')).toBeInstanceOf(Error)
    expect((r.get('a') as Error).message).toContain('401')
    expect(fetchNaverStock).toHaveBeenCalledTimes(1)
  })

  it('끝내 실패하면 사유가 그대로 남는다 — 재시도가 실패를 지우지 않는다', async () => {
    vi.mocked(fetchTwelveDataQuotes)
      .mockRejectedValueOnce(new Error('twelvedata HTTP 522'))
      .mockRejectedValueOnce(new Error('twelvedata HTTP 522'))
      .mockRejectedValueOnce(new Error('twelvedata HTTP 522'))
    const r = await fetchAllQuotes(
      [{ id: 'b', quoteSource: 'twelvedata', quoteSymbol: 'PFE' }],
      { sleep: async () => {} },
    )
    expect(r.get('b')).toBeInstanceOf(Error)
    expect((r.get('b') as Error).message).toContain('522')
    expect(fetchTwelveDataQuotes).toHaveBeenCalledTimes(3)
  })

  it('marketstack 가 전체 실패하면 해당 배치의 모든 종목이 Error 이고 다른 그룹은 영향받지 않는다', async () => {
    vi.mocked(fetchMarketstackQuotes).mockRejectedValueOnce(new Error('ms down'))
    const r = await fetchAllQuotes([
      { id: 'a', quoteSource: 'naver-stock', quoteSymbol: '207940' },
      { id: 'c', quoteSource: 'marketstack', quoteSymbol: 'GSK.L' },
      { id: 'd', quoteSource: 'marketstack', quoteSymbol: 'AZN.L' },
      { id: 'b', quoteSource: 'twelvedata', quoteSymbol: 'PFE' },
    ])
    expect(r.get('c')).toBeInstanceOf(Error)
    expect(r.get('d')).toBeInstanceOf(Error)
    expect((r.get('a') as any).close).toBe(100)
    expect((r.get('b') as any).close).toBeCloseTo(28.3, 4)
  })
})
