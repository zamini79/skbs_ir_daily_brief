import { describe, it, expect, vi } from 'vitest'
import { formatSummary } from '@/domain/summaryFormat'
import { charLength } from '@/domain/text'
import {
  resolveAliases,
  wantsMarketWrapNews,
  MARKET_WRAP_ROWS,
  missingFxCurrencies,
  resolveFxRate,
  currencyMismatchReason,
  normalizeAsOf,
  resolveMarketCap,
  computeSameEventAsRank,
  isQuotaExhaustedMessage,
  createQuotaGuard,
  attemptSummary,
  computeRunStatus,
  buildStatusDetail,
  isolate,
  needsPendingRevert,
  buildFallbackSummaries,
  briefRunStartData,
  createDeadline,
  type RunStatusCounts,
} from './collectHelpers'
import { SUMMARY_VARIANTS } from '@/providers/summarize/prompt'

const LONG_BODY = 'x'.repeat(30)
const okSummary = { numeric: 'n', context: 'c' }

describe('resolveAliases', () => {
  it('콤마로 구분된 별칭을 배열로 만든다', () => {
    expect(resolveAliases({ newsQuery: '삼성바이오로직스', newsAliases: '삼성바이오로직스,삼성바이오,삼바' }))
      .toEqual(['삼성바이오로직스', '삼성바이오', '삼바'])
  })

  it('앞뒤 공백을 제거한다', () => {
    expect(resolveAliases({ newsQuery: 'GSK', newsAliases: ' GSK , 지에스케이 ' })).toEqual(['GSK', '지에스케이'])
  })

  it('비어 있으면 newsQuery 하나로 폴백한다', () => {
    expect(resolveAliases({ newsQuery: '셀트리온', newsAliases: '' })).toEqual(['셀트리온'])
  })

  it('공백뿐이어도 newsQuery 로 폴백한다', () => {
    expect(resolveAliases({ newsQuery: '셀트리온', newsAliases: '   ' })).toEqual(['셀트리온'])
  })

  it('해외사처럼 name 이 영문이어도 폴백은 한국어 newsQuery 다', () => {
    // 호출부(collect.ts)는 Instrument 전체를 그대로 넘긴다. name 이 함께 들어와도
    // 무시되고 한국어 newsQuery 가 나와야 한다 — name 으로 폴백하면 'Pfizer' 가
    // 한국어 헤드라인에 등장하지 않아 관련성 필터가 후보를 전량 탈락시킨다.
    const pfizer = { name: 'Pfizer', newsQuery: '화이자', newsAliases: '' }
    const merck = { name: 'Merck', newsQuery: '머크', newsAliases: '' }
    expect(resolveAliases(pfizer)).toEqual(['화이자'])
    expect(resolveAliases(merck)).toEqual(['머크'])
  })
})

describe('missingFxCurrencies', () => {
  const REQUESTED = ['KRW', 'USD', 'GBP', 'EUR', 'CHF', 'HKD']

  it('정상이면 비어 있다', () => {
    const fx = { KRW: 1, USD: 1383, GBP: 1885, EUR: 1610, CHF: 1730, HKD: 177 }
    expect(missingFxCurrencies(REQUESTED, fx)).toEqual([])
  })

  it('전체 실패(빈 객체)면 KRW를 뺀 나머지 통화가 전부 담긴다', () => {
    // fetchFxToKrw 가 던져서 호출부가 {} 를 들고 있는 경우다. KRW는 애초에 국내 종목의
    // 시가총액 계산에 쓰이지 않으므로(네이버가 직접 준다) 여기 담기면 안 된다.
    expect(missingFxCurrencies(REQUESTED, {})).toEqual(['USD', 'GBP', 'EUR', 'CHF', 'HKD'])
  })

  it('부분 결손이면 빠진 통화만 담긴다 — 나머지는 멀쩡하다', () => {
    // frankfurter 가 200 을 주지만 특정 통화 rate 가 없는 경우(`if (!usdToC) continue`).
    const fx = { KRW: 1, USD: 1383, GBP: 1885, EUR: 1610 }
    expect(missingFxCurrencies(REQUESTED, fx)).toEqual(['CHF', 'HKD'])
  })

  it('중복 통화를 두 번 세지 않는다 — 단위는 종목이 아니라 통화다', () => {
    // 23종목이 6통화를 쓴다. 종목 수로 세면 같은 통화가 여러 번 잡혀 부풀려진다.
    expect(missingFxCurrencies(['USD', 'USD', 'USD'], {})).toEqual(['USD'])
  })

  it('KRW는 fx에 없어도, 심지어 요청 목록에 여러 번 들어 있어도 결코 담기지 않는다', () => {
    // 국내 종목은 fx['KRW']를 들여다보지 않는다(resolveMarketCap이 네이버 시총을
    // fxRate 검사보다 먼저 반환한다) — 그래서 환율 조회가 통째로 실패해도 국내 행은
    // 전혀 영향받지 않는다. KRW를 이 목록에 실으면 있지도 않은 문제를 보고하는 셈이다.
    expect(missingFxCurrencies(['KRW'], {})).toEqual([])
    expect(missingFxCurrencies(['KRW', 'KRW'], {})).toEqual([])
    expect(missingFxCurrencies(['KRW'], { KRW: 1 })).toEqual([])
  })

  it('KRW만 요청한 전형적인 국내 전용 구성이면 환율이 통째로 없어도 결손이 0건이다', () => {
    // fxFailed = missingFxCurrencies(...).length 로 계산된다(collect.ts). 전부 국내
    // 종목인 실행에서는 fx 조회가 아예 실패해도 fxFailed가 0이어야 PARTIAL로 잘못
    // 떨어지지 않는다.
    expect(missingFxCurrencies(['KRW'], {}).length).toBe(0)
  })
})

describe('resolveFxRate', () => {
  it('환율이 있으면 그 값을 준다', () => {
    expect(resolveFxRate('USD', { USD: 1350, KRW: 1 })).toBe(1350)
  })

  it('환율이 없으면 null을 준다 (1로 대체하지 않는다)', () => {
    expect(resolveFxRate('GBP', { USD: 1350, KRW: 1 })).toBeNull()
  })

  it('환율 조회가 통째로 실패해 빈 객체가 와도 null을 준다', () => {
    expect(resolveFxRate('USD', {})).toBeNull()
  })
})

describe('currencyMismatchReason', () => {
  it('같은 통화면 null 이다', () => {
    expect(currencyMismatchReason('USD', 'USD')).toBeNull()
    expect(currencyMismatchReason('KRW', 'KRW')).toBeNull()
  })

  it('대소문자 차이는 불일치가 아니다', () => {
    expect(currencyMismatchReason('USD', 'usd')).toBeNull()
  })

  it('펜스 표기(GBX/GBp)는 GBP 와 같은 통화로 본다', () => {
    // 단위 차이는 priceDivisorForMarketCap 이 처리한다(스펙 §3.2 주의 1).
    // 여기서 불일치로 보면 지금 정상인 GSK 행을 표기 변경만으로 버리게 된다.
    expect(currencyMismatchReason('GBP', 'GBX')).toBeNull()
    expect(currencyMismatchReason('GBP', 'GBp')).toBeNull()
  })

  it('ADR 전환처럼 통화 자체가 다르면 두 통화를 모두 담은 사유를 준다', () => {
    // 스펙 §3.2 가 경고한 사고: GSK.L 에 뉴욕 ADR(USD) 값이 오는 경우.
    const r = currencyMismatchReason('GBP', 'USD')
    expect(r).not.toBeNull()
    expect(r).toContain('GBP')
    expect(r).toContain('USD')
  })

  it('소스가 통화를 알려주지 않으면 단정하지 않는다', () => {
    // marketstack 의 `price_currency ?? ''` 경로. 모르는 것을 불일치라고 말하면
    // 멀쩡한 행이 매일 실패로 뜬다.
    expect(currencyMismatchReason('EUR', '')).toBeNull()
    expect(currencyMismatchReason('EUR', '   ')).toBeNull()
  })
})

describe('normalizeAsOf', () => {
  it('날짜가 있으면 그대로 둔다', () => {
    expect(normalizeAsOf('2026-08-26')).toBe('2026-08-26')
  })

  it('빈 문자열·공백은 null 이다 — 화면이 "미상"이라고 말할 수 있게', () => {
    // ''를 그대로 저장하면 화면의 falsy 검사가 기준일 줄을 통째로 지워버린다.
    // 그러면 담당자는 표시된 가격을 오늘 종가로 읽는다.
    expect(normalizeAsOf('')).toBeNull()
    expect(normalizeAsOf('   ')).toBeNull()
    expect(normalizeAsOf(undefined)).toBeNull()
  })
})

describe('resolveMarketCap', () => {
  it('지수는 항상 null이다', () => {
    expect(resolveMarketCap({
      isIndex: true, close: 7000, shares: null, fxRate: 1, priceDivisor: 1,
    })).toBeNull()
  })

  it('소스가 시총을 직접 주면 환율과 무관하게 그 값을 쓴다', () => {
    expect(resolveMarketCap({
      isIndex: false, quoteMarketCap: 55.3, close: 100000, shares: null, fxRate: null, priceDivisor: 1,
    })).toBe(55.3)
  })

  it('환율이 없으면 null이다 — 1383배 축소 같은 왜곡된 숫자를 만들지 않는다', () => {
    expect(resolveMarketCap({
      isIndex: false, close: 25, shares: 5_694_180_000, fxRate: null, priceDivisor: 1,
    })).toBeNull()
  })

  it('환율이 있으면 계산한다', () => {
    const cap = resolveMarketCap({
      isIndex: false, close: 25, shares: 5_694_180_000, fxRate: 1580, priceDivisor: 1,
    })
    expect(cap).toBeCloseTo((25 * 5_694_180_000 * 1580) / 1e12, 6)
  })

  it('펜스 보정을 적용한다', () => {
    const withDivisor = resolveMarketCap({
      isIndex: false, close: 1500, shares: 4_046_530_000, fxRate: 1700, priceDivisor: 100,
    })
    const withoutDivisor = resolveMarketCap({
      isIndex: false, close: 1500, shares: 4_046_530_000, fxRate: 1700, priceDivisor: 1,
    })
    expect(withDivisor).toBeCloseTo(withoutDivisor! / 100, 6)
  })

  it('GSK 는 1차(LSE)로 오든 2차(FT)로 오든 같은 규칙으로 계산된다', () => {
    // 두 소스 모두 GBX(펜스)로 같은 가격을 준다(실측 2026-08-28: LSE 1852, FT 1,852.00).
    // 통화 검사가 GBX 를 GBP 로 접어 주므로 폴백 값이 버려지지 않고, 시총은 같은
    // priceDivisorForMarketCap(100)을 탄다. 여기가 틀리면 폴백이 도는 날만 시총이 100배다.
    // 1) FT 가 주는 통화(GBX)가 시드(GBP)와 어긋난 것으로 판정되면 폴백 값이 통째로
    //    버려진다 — 폴백이 돌아도 그 행은 빈다.
    expect(currencyMismatchReason('GBP', 'GBX')).toBeNull()
    // 2) 보정값을 태운 시총과 안 태운 시총은 정확히 100배 차이여야 한다. FT 파서가
    //    「1,852.00」을 1852(펜스)로 읽으므로 LSE 의 1852 와 같은 단위다.
    const args = { isIndex: false, close: 1852, shares: 4_046_530_000, fxRate: 1700 }
    const corrected = resolveMarketCap({ ...args, priceDivisor: 100 })
    const uncorrected = resolveMarketCap({ ...args, priceDivisor: 1 })
    expect(corrected).toBeCloseTo((1852 / 100) * 4_046_530_000 * 1700 / 1e12, 6)
    expect(uncorrected!).toBeCloseTo(corrected! * 100, 6)
  })
})

describe('resolveMarketCap — 환율 미확보 시 국내/해외 영향 분리', () => {
  // 환율이 통째로 없을 때 해외사만 공란이 되어야 한다. 국내 행까지 번지면 안 된다.
  it('국내 종목은 환율이 없어도 시총이 나온다 — 네이버가 시총을 직접 준다', () => {
    expect(resolveMarketCap({
      isIndex: false, quoteMarketCap: 73.37, close: 1_585_000,
      shares: null, fxRate: null, priceDivisor: 1,
    })).toBeCloseTo(73.37, 2)
  })

  it('해외 종목은 환율이 없으면 null 이다 — 1로 대체하지 않는다', () => {
    expect(resolveMarketCap({
      isIndex: false, close: 28.3, shares: 5_694_180_000, fxRate: null, priceDivisor: 1,
    })).toBeNull()
  })

  it('지수는 환율과 무관하게 항상 null 이다 — 시총 개념이 없다', () => {
    expect(resolveMarketCap({
      isIndex: true, close: 7675.7, shares: null, fxRate: null, priceDivisor: 1,
    })).toBeNull()
  })
})

describe('computeSameEventAsRank', () => {
  it('rank 1은 항상 null이다', () => {
    const r = computeSameEventAsRank([{ rank: 1, title: '셀트리온 램시마SC 실적 호조' }])
    expect(r.get(1)).toBeNull()
  })

  it('제목이 비슷한 하위 순위는 상위 rank를 가리킨다', () => {
    const r = computeSameEventAsRank([
      { rank: 1, title: '셀트리온 램시마SC·짐펜트라 글로벌 톱3 굳힌다' },
      { rank: 2, title: '셀트리온, 램시마SC 짐펜트라로 글로벌 톱3 지위 굳혀' },
      { rank: 3, title: '셀트리온 신규 공장 착공' },
    ])
    expect(r.get(1)).toBeNull()
    expect(r.get(2)).toBe(1)
    expect(r.get(3)).toBeNull()
  })

  it('임계값 0.3 미만이면 서로 다른 사건으로 본다', () => {
    const r = computeSameEventAsRank([
      { rank: 1, title: '가나다라마바사' },
      { rank: 2, title: '아자차카타파하' },
    ])
    expect(r.get(2)).toBeNull()
  })

  it('여러 상위 순위와 매칭되면 더 높은(작은) rank를 남긴다', () => {
    const r = computeSameEventAsRank([
      { rank: 1, title: '셀트리온 램시마SC 짐펜트라 글로벌 톱3' },
      { rank: 2, title: '셀트리온 램시마SC 짐펜트라 톱3 굳혀' },
      { rank: 3, title: '셀트리온 램시마SC 짐펜트라 글로벌 톱3 확정' },
    ])
    expect(r.get(3)).toBe(1)
  })
})

describe('isQuotaExhaustedMessage', () => {
  it('429를 포함하면 참이다', () => {
    expect(isQuotaExhaustedMessage('gemini HTTP 429: quota exceeded')).toBe(true)
  })

  it('RESOURCE_EXHAUSTED를 포함하면 참이다', () => {
    expect(isQuotaExhaustedMessage('... "status": "RESOURCE_EXHAUSTED" ...')).toBe(true)
  })

  it('무관한 실패 메시지는 거짓이다', () => {
    expect(isQuotaExhaustedMessage('gemini: candidates 가 비어있다')).toBe(false)
  })

  it('4290 처럼 429가 부분 문자열인 숫자는 걸리지 않는다', () => {
    expect(isQuotaExhaustedMessage('gemini HTTP 4290: 알수없음')).toBe(false)
  })
})

describe('attemptSummary', () => {
  /** 마감이 아직 멀었다 — 기존 테스트들이 보던 상황 그대로. */
  const OPEN = { exceeded: () => false }
  /** 마감이 지났다. */
  const PASSED = { exceeded: () => true }

  it('마감이 지났으면 summarizeFn 을 호출하지 않는다', async () => {
    const guard = createQuotaGuard()
    const summarizeFn = vi.fn()

    const r = await attemptSummary({ title: 't', body: LONG_BODY }, guard, summarizeFn, PASSED)

    expect(r).toEqual({ outcome: 'skipped-deadline' })
    // 아끼려는 것이 바로 이 호출이다(6초 간격 + Gemini 호출 + 분당 한도 재시도).
    expect(summarizeFn).not.toHaveBeenCalled()
  })

  it('마감은 실패가 아니라 별도 사유다 — failed 와 섞이지 않는다', async () => {
    const guard = createQuotaGuard()
    const r = await attemptSummary({ title: 't', body: LONG_BODY }, createQuotaGuard(), vi.fn(), PASSED)

    expect(r.outcome).not.toBe('failed')
    expect(r.outcome).toBe('skipped-deadline')
    // 마감은 할당량과도 다르다 — 담당자가 볼 곳이 다르다.
    expect(guard.tripped).toBe(false)
  })

  it('본문이 짧은 것이 마감보다 먼저다 — 같은 후보가 날마다 다른 사유를 달면 안 된다', async () => {
    const r = await attemptSummary({ title: 't', body: '짧음' }, createQuotaGuard(), vi.fn(), PASSED)
    expect(r).toEqual({ outcome: 'skipped-empty-body' })
  })

  it('마감 전이면 예전과 똑같이 요약한다', async () => {
    const summarizeFn = vi.fn().mockResolvedValue(okSummary)

    const r = await attemptSummary({ title: 't', body: LONG_BODY }, createQuotaGuard(), summarizeFn, OPEN)

    expect(r).toEqual({ outcome: 'generated', summary: okSummary })
    expect(summarizeFn).toHaveBeenCalledOnce()
  })

  it('마감은 후보마다 다시 확인된다 — 도중에 지나면 그 뒤부터 멈춘다', async () => {
    let passed = false
    const deadline = { exceeded: () => passed }
    const guard = createQuotaGuard()
    const summarizeFn = vi.fn().mockResolvedValue(okSummary)

    const r1 = await attemptSummary({ title: 'a', body: LONG_BODY }, guard, summarizeFn, deadline)
    passed = true
    const r2 = await attemptSummary({ title: 'b', body: LONG_BODY }, guard, summarizeFn, deadline)

    expect(r1.outcome).toBe('generated')
    expect(r2.outcome).toBe('skipped-deadline')
    expect(summarizeFn).toHaveBeenCalledTimes(1)
  })

  it('본문이 짧으면 summarizeFn을 호출하지 않고 건너뛴다', async () => {
    const guard = createQuotaGuard()
    const summarizeFn = vi.fn()
    const r = await attemptSummary({ title: 't', body: '짧음' }, guard, summarizeFn, OPEN)
    expect(r).toEqual({ outcome: 'skipped-empty-body' })
    expect(summarizeFn).not.toHaveBeenCalled()
  })

  it('성공하면 generated와 요약을 준다', async () => {
    const guard = createQuotaGuard()
    const summarizeFn = vi.fn().mockResolvedValue(okSummary)
    const r = await attemptSummary({ title: 't', body: LONG_BODY }, guard, summarizeFn, OPEN)
    expect(r).toEqual({ outcome: 'generated', summary: okSummary })
  })

  it('요약이 던지면 failed와 메시지를 남기고 후보는 지우지 않는다(후보 삭제는 이 함수 책임이 아니다)', async () => {
    const guard = createQuotaGuard()
    const summarizeFn = vi.fn().mockRejectedValue(new Error('gemini: 파싱 실패'))
    const r = await attemptSummary({ title: 't', body: LONG_BODY }, guard, summarizeFn, OPEN)
    expect(r).toEqual({ outcome: 'failed', error: 'gemini: 파싱 실패' })
    expect(guard.tripped).toBe(false)
  })

  it('429 실패는 guard를 트립시킨다', async () => {
    const guard = createQuotaGuard()
    const summarizeFn = vi.fn().mockRejectedValue(new Error('gemini HTTP 429: RESOURCE_EXHAUSTED'))
    await attemptSummary({ title: 't', body: LONG_BODY }, guard, summarizeFn, OPEN)
    expect(guard.tripped).toBe(true)
  })

  it('guard가 이미 트립된 상태면 summarizeFn을 호출하지 않고 건너뛴다', async () => {
    const guard = createQuotaGuard()
    guard.tripped = true
    const summarizeFn = vi.fn()
    const r = await attemptSummary({ title: 't', body: LONG_BODY }, guard, summarizeFn, OPEN)
    expect(r).toEqual({ outcome: 'skipped-quota-exhausted' })
    expect(summarizeFn).not.toHaveBeenCalled()
  })

  it('연속 호출: 첫 429 이후로는 summarizeFn이 다시 호출되지 않는다', async () => {
    const guard = createQuotaGuard()
    const summarizeFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('gemini HTTP 429: RESOURCE_EXHAUSTED'))
      .mockResolvedValue(okSummary)

    const r1 = await attemptSummary({ title: 'a', body: LONG_BODY }, guard, summarizeFn, OPEN)
    const r2 = await attemptSummary({ title: 'b', body: LONG_BODY }, guard, summarizeFn, OPEN)
    const r3 = await attemptSummary({ title: 'c', body: LONG_BODY }, guard, summarizeFn, OPEN)

    expect(r1.outcome).toBe('failed')
    expect(r2).toEqual({ outcome: 'skipped-quota-exhausted' })
    expect(r3).toEqual({ outcome: 'skipped-quota-exhausted' })
    // 트립 이후에는 다시 불리지 않는다 — 죽은 할당량에 나머지를 쏘지 않는다.
    expect(summarizeFn).toHaveBeenCalledTimes(1)
  })

  it('빈 본문 건너뛰기는 quota 상태와 무관하다 — 이미 트립된 상태에서도 empty-body가 우선한다', async () => {
    const guard = createQuotaGuard()
    guard.tripped = true
    const summarizeFn = vi.fn()
    const r = await attemptSummary({ title: 't', body: '짧음' }, guard, summarizeFn, OPEN)
    expect(r).toEqual({ outcome: 'skipped-empty-body' })
  })
})

describe('createDeadline', () => {
  it('예산 안이면 지나지 않았다', () => {
    let t = 1000
    const d = createDeadline(1000, 60_000, () => t)

    t = 1000 + 59_999
    expect(d.exceeded()).toBe(false)
  })

  it('경계는 >= 다 — 정확히 마감이면 지난 것으로 본다', () => {
    let t = 1000
    const d = createDeadline(1000, 60_000, () => t)

    t = 1000 + 60_000
    expect(d.exceeded()).toBe(true)
  })

  it('시계를 주입받는다 — 테스트가 실제로 20분을 기다리지 않는다', () => {
    let t = 0
    const d = createDeadline(0, 20 * 60 * 1000, () => t)

    expect(d.exceeded()).toBe(false)
    t = 21 * 60 * 1000
    expect(d.exceeded()).toBe(true)
  })

  it('한 번 지나면 계속 지난 상태다 — 되돌아가지 않는다', () => {
    let t = 100_000
    const d = createDeadline(0, 60_000, () => t)

    expect(d.exceeded()).toBe(true)
    t = 200_000
    expect(d.exceeded()).toBe(true)
  })
})

/** 실패 카운터가 전부 0 인 입력. 테스트는 여기에 한 필드만 덮어 그 필드의 효과를 본다. */
const NO_FAILURES: RunStatusCounts = {
  summariesFailed: 0,
  ytdBaseFailed: 0,
  newsFailed: 0,
  fxFailed: 0,
  quoteFailed: 0,
  newsRecordFailed: 0,
  summariesSkippedDeadline: 0,
}

describe('computeRunStatus', () => {
  it('요약 실패가 하나라도 있으면 PARTIAL이다', () => {
    expect(computeRunStatus({ ...NO_FAILURES, summariesFailed: 1 })).toBe('PARTIAL')
    expect(computeRunStatus({ ...NO_FAILURES, summariesFailed: 20 })).toBe('PARTIAL')
  })

  it('요약 실패가 없으면 READY이다', () => {
    expect(computeRunStatus(NO_FAILURES)).toBe('READY')
  })

  it('연초 기준가 조회 실패도 PARTIAL로 본다 — 요약 실패와 같은 규칙이다', () => {
    // 이 실패는 API 분당 한도 경합이라 어느 종목이 빌지가 매일 달라진다.
    // 상태에 남기지 않으면 재현되지 않는 공란이 되어 아무도 눈치채지 못한다.
    expect(computeRunStatus({ ...NO_FAILURES, ytdBaseFailed: 1 })).toBe('PARTIAL')
    expect(computeRunStatus({ ...NO_FAILURES, ytdBaseFailed: 4 })).toBe('PARTIAL')
  })

  it('둘 다 없어야 READY이다', () => {
    expect(computeRunStatus(NO_FAILURES)).toBe('READY')
  })

  it('다른 카운터가 0 이면 요약 실패만으로 갈린다', () => {
    expect(computeRunStatus(NO_FAILURES)).toBe('READY')
    expect(computeRunStatus({ ...NO_FAILURES, summariesFailed: 2 })).toBe('PARTIAL')
  })

  it('뉴스 검색 실패도 PARTIAL로 본다', () => {
    // 실패한 행은 화면에서 "당일·D-1 기사 없음"이라는 단정으로 보였다 — 모르는 것을
    // 아는 것처럼 표시한 것이다. 운영자가 실행 단위로도 알 수 있어야 한다.
    expect(computeRunStatus({ ...NO_FAILURES, newsFailed: 1 })).toBe('PARTIAL')
    expect(computeRunStatus({ ...NO_FAILURES, newsFailed: 8 })).toBe('PARTIAL')
  })

  it('셋 다 없어야 READY이다', () => {
    expect(computeRunStatus(NO_FAILURES)).toBe('READY')
  })

  it('환율 미확보도 PARTIAL로 본다', () => {
    // 해외사 시가총액이 통째로 공란이 되는데 아무 표시가 없으면 아무도 모른다.
    expect(computeRunStatus({ ...NO_FAILURES, fxFailed: 1 })).toBe('PARTIAL')
    expect(computeRunStatus({ ...NO_FAILURES, fxFailed: 6 })).toBe('PARTIAL')
  })

  it('넷 다 없어야 READY이다', () => {
    expect(computeRunStatus(NO_FAILURES)).toBe('READY')
  })

  it('시세 수집 실패도 PARTIAL로 본다 — 나머지가 전부 성공이어도', () => {
    // 이게 없으면 다섯 칸이 전부 공란인 행이 초록색 「준비 완료」 배너 아래에 놓인다.
    // Twelve Data 분당 크레딧 초과면 미국 5행이 통째로 빠지는데 배너는 초록이었다.
    expect(computeRunStatus({ ...NO_FAILURES, quoteFailed: 1 })).toBe('PARTIAL')
    expect(computeRunStatus({ ...NO_FAILURES, quoteFailed: 5 })).toBe('PARTIAL')
  })

  it('다섯 가지가 다 없어야 READY이다', () => {
    expect(computeRunStatus(NO_FAILURES)).toBe('READY')
  })

  it('뉴스 상태 기록 실패도 PARTIAL로 본다 — 화면이 근거 없이 「기사 없음」을 단정한다', () => {
    expect(computeRunStatus({ ...NO_FAILURES, newsRecordFailed: 1 })).toBe('PARTIAL')
  })

  it('여섯 가지가 다 없어야 READY이다', () => {
    expect(computeRunStatus(NO_FAILURES)).toBe('READY')
  })

  it('다른 카운터가 0 이면 환율만으로 갈린다', () => {
    expect(computeRunStatus(NO_FAILURES)).toBe('READY')
    expect(computeRunStatus({ ...NO_FAILURES, fxFailed: 1 })).toBe('PARTIAL')
  })

  it('마감으로 못 한 건이 있으면 PARTIAL 이다 — 초록 배너 아래 빈 요약을 두지 않는다', () => {
    expect(computeRunStatus({ ...NO_FAILURES, summariesSkippedDeadline: 4 })).toBe('PARTIAL')
  })

  it('마감 카운터가 0이면 다른 조건에 영향을 주지 않는다', () => {
    expect(computeRunStatus(NO_FAILURES)).toBe('READY')
  })

  // 위치 인자였을 때는 가운데 한 칸이 빠지면 뒤 값이 밀려 다른 카운터로 읽혔다.
  // 이름 붙은 필드는 어느 것이든 혼자서 PARTIAL 을 만들어야 한다 — 하나라도 판정에서
  // 빠지면 여기서 그 이름으로 걸린다.
  it.each(Object.keys(NO_FAILURES) as Array<keyof RunStatusCounts>)('%s 하나만 1 이어도 PARTIAL 이다', key => {
    expect(computeRunStatus({ ...NO_FAILURES, [key]: 1 })).toBe('PARTIAL')
  })

  it('필드 순서는 결과에 영향이 없다', () => {
    const forward: RunStatusCounts = { ...NO_FAILURES, newsFailed: 2 }
    const reversed = Object.fromEntries(Object.entries(forward).reverse()) as RunStatusCounts
    expect(computeRunStatus(reversed)).toBe(computeRunStatus(forward))
    expect(computeRunStatus(reversed)).toBe('PARTIAL')
  })
})

describe('buildStatusDetail', () => {
  const clean = {
    quoteFailed: 0,
    summariesFailed: 0,
    candidatesCreated: 43,
    ytdBaseFailed: 0,
    newsFailed: 0,
    newsRecordFailed: 0,
    priorityNewsFailed: 0,
    missingCurrencies: [] as string[],
  }

  it('실패가 없으면 null 이다 — 배너에 붙일 말이 없다', () => {
    expect(buildStatusDetail(clean)).toBeNull()
  })

  it('마감으로 못 한 건을 「실패」와 다른 말로 적는다', () => {
    const d = buildStatusDetail({ ...clean, summariesSkippedDeadline: 7 })
    expect(d).toContain('요약 시간 초과로 7건 미생성')
    // "실패"라고 말하면 담당자가 원인을 찾으러 간다. 이쪽은 다시 돌리면 되는 일이다.
    expect(d).not.toContain('요약 7건 실패')
  })

  it('요약 실패와 마감 미생성을 **갈라서** 적는다 — 할 일이 다르다', () => {
    const d = buildStatusDetail({ ...clean, summariesFailed: 3, summariesSkippedDeadline: 7 })
    expect(d).toContain('요약 3건 실패')
    expect(d).toContain('요약 시간 초과로 7건 미생성')
  })

  it('재시도 예산이 걸린 날은 다 성공했어도 사실을 적는다', () => {
    // 이 사실은 다음 사람이 예산 값을 조정할 유일한 근거다. 로그와 크론 응답에만
    // 남기면 화면을 보는 사람은 영영 모른다.
    const d = buildStatusDetail({ ...clean, rateLimitRetriesDenied: 4 })
    expect(d).toContain('재시도를 4회 포기함')
    // 다만 「실패」라고 말하지 않는다 — 요약은 실제로 채워졌다.
    expect(d).not.toContain('실패')
  })

  it('예산만 걸린 날은 status 를 낮추지 않는다 — 할 일 없는 날의 노란 배너는 배너를 무디게 한다', () => {
    expect(computeRunStatus(NO_FAILURES)).toBe('READY')
    expect(buildStatusDetail({ ...clean, rateLimitRetriesDenied: 4 })).not.toBeNull()
  })

  it('실패가 함께 있으면 예산 문구는 맨 뒤다 — 관측이지 실패가 아니다', () => {
    const d = buildStatusDetail({ ...clean, quoteFailed: 2, rateLimitRetriesDenied: 4 })
    expect(d?.startsWith('시세 2종목 수집 실패')).toBe(true)
    expect(d?.endsWith('(요약 자체는 채워졌습니다)')).toBe(true)
  })

  it('시세 실패를 종목 수와 함께 말한다', () => {
    expect(buildStatusDetail({ ...clean, quoteFailed: 5 })).toBe('시세 5종목 수집 실패')
  })

  it('시세 실패를 맨 앞에 둔다 — 한 행의 숫자가 통째로 없다는 뜻이라 가장 무겁다', () => {
    const d = buildStatusDetail({
      ...clean, quoteFailed: 5, summariesFailed: 2, ytdBaseFailed: 1, newsFailed: 3,
      missingCurrencies: ['USD'],
    })
    expect(d?.startsWith('시세 5종목 수집 실패')).toBe(true)
  })

  it('여러 실패를 콤마로 잇는다', () => {
    expect(buildStatusDetail({ ...clean, quoteFailed: 1, newsFailed: 2 }))
      .toBe('시세 1종목 수집 실패, 뉴스 검색 2종목 실패')
  })

  it('환율은 통화 이름을 그대로 적는다 — 어느 행이 비었는지 짚을 수 있게', () => {
    expect(buildStatusDetail({ ...clean, missingCurrencies: ['USD', 'GBP'] }))
      .toBe('환율 미확보: USD, GBP (시가총액 공란)')
  })

  it('기존 네 항목의 문구는 그대로다 — 시세 항목만 새로 붙는다', () => {
    expect(buildStatusDetail({ ...clean, summariesFailed: 12, candidatesCreated: 43 }))
      .toBe('요약 12건 실패(후보 43건 중)')
    expect(buildStatusDetail({ ...clean, ytdBaseFailed: 2 })).toBe('연초 기준가 2종목 조회 실패')
  })

  it('뉴스 상태 기록 실패는 검색 실패와 다른 문구로 말한다', () => {
    // 둘이 같은 문구면 "검색이 실패했다"와 "검색은 했는데 그 사실을 못 남겼다"가
    // 뭉개진다. 후자는 그 행의 「기사 없음」 표시 자체를 믿을 수 없다는 뜻이다.
    const record = buildStatusDetail({ ...clean, newsRecordFailed: 2 })
    const search = buildStatusDetail({ ...clean, newsFailed: 2 })
    expect(record).toContain('기록 실패')
    expect(record).not.toBe(search)
  })

  // 이 짝이 깨지면 「부분 완료」인데 사유가 비거나, 사유가 있는데 「준비 완료」가 된다.
  it('computeRunStatus 와 항상 짝을 이룬다 — PARTIAL 이면 사유가 있고, READY 면 없다', () => {
    const cases = [
      { ...clean, quoteFailed: 1 },
      { ...clean, summariesFailed: 1 },
      { ...clean, ytdBaseFailed: 1 },
      { ...clean, newsFailed: 1 },
      { ...clean, newsRecordFailed: 1 },
      { ...clean, missingCurrencies: ['USD'] },
      clean,
    ]
    for (const c of cases) {
      const status = computeRunStatus({
        summariesFailed: c.summariesFailed,
        ytdBaseFailed: c.ytdBaseFailed,
        newsFailed: c.newsFailed,
        fxFailed: c.missingCurrencies.length,
        quoteFailed: c.quoteFailed,
        newsRecordFailed: c.newsRecordFailed,
        summariesSkippedDeadline: 0,
      })
      const detail = buildStatusDetail(c)
      expect(status === 'PARTIAL', JSON.stringify(c)).toBe(detail !== null)
    }
  })
})

describe('isolate', () => {
  it('worker가 성공하면 { ok: true }를 준다', async () => {
    const r = await isolate(async () => {})
    expect(r).toEqual({ ok: true })
  })

  it('worker가 던지면 예외를 밖으로 새어나가게 하지 않고 { ok: false }를 준다', async () => {
    const r = await isolate(async () => {
      throw new Error('DB 쓰기 실패')
    })
    expect(r).toEqual({ ok: false })
  })

  it('Promise.all로 묶인 여러 isolate 중 하나가 실패해도 나머지는 전부 완료된다', async () => {
    const completed: number[] = []
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map(n =>
        isolate(async () => {
          if (n === 3) throw new Error('후보 3만 실패')
          completed.push(n)
        }),
      ),
    )
    expect(completed.sort()).toEqual([1, 2, 4, 5])
    expect(results.map(r => r.ok)).toEqual([true, true, false, true, true])
  })

  it('순차 for 루프에서도 중간 실패가 나머지 반복을 막지 않는다 — 루프가 끝까지 간다', async () => {
    const processed: number[] = []
    let failedCount = 0
    for (const n of [1, 2, 3, 4, 5]) {
      const { ok } = await isolate(async () => {
        if (n === 3) throw new Error('시세 쓰기 실패')
        processed.push(n)
      })
      if (!ok) failedCount++
    }
    expect(processed).toEqual([1, 2, 4, 5])
    expect(failedCount).toBe(1)
  })
})

describe('needsPendingRevert', () => {
  it('SELECTED인데 chosenCandidateId가 null이면 되돌려야 한다', () => {
    expect(needsPendingRevert({ decision: 'SELECTED', chosenCandidateId: null, chosenSummaryId: null })).toBe(true)
  })

  it('SELECTED이고 chosenCandidateId가 있으면 되돌리지 않는다', () => {
    expect(needsPendingRevert({ decision: 'SELECTED', chosenCandidateId: 'c1', chosenSummaryId: 's1' })).toBe(false)
  })

  // 후보는 여전히 유효한데(chosenCandidateId 있음) 그 후보에 애초에 요약이 없어
  // (chosenSummaryId가 null) 요약을 고르지 못한 채 선택을 끝낸 경우 — 무효화가
  // 아니라 정상 종결이다. 2026-08-27 실행 검수 화면에서 실제로 이 상태가
  // STALE_SELECTION으로 잘못 표시됐던 결함과 같은 상황이므로, chosenSummaryId가
  // null이어도 chosenCandidateId만 유효하면 되돌려지지 않는다는 것을 고정해 둔다.
  it('후보 있음 + 요약 참조 null이면 무효화가 아니다 — 되돌리지 않는다', () => {
    expect(needsPendingRevert({ decision: 'SELECTED', chosenCandidateId: 'c1', chosenSummaryId: null })).toBe(false)
  })

  it('PENDING은 참조가 null이어도 정상 상태다 — 되돌리지 않는다', () => {
    expect(needsPendingRevert({ decision: 'PENDING', chosenCandidateId: null, chosenSummaryId: null })).toBe(false)
  })

  it('OMITTED는 애초에 후보를 참조하지 않는 정상 상태다 — 되돌리지 않는다', () => {
    expect(needsPendingRevert({ decision: 'OMITTED', chosenCandidateId: null, chosenSummaryId: null })).toBe(false)
  })
})

describe('briefRunStartData', () => {
  it('재실행이면 status를 COLLECTING으로 되돌리고 statusDetail을 null로 비운다', () => {
    // 비우지 않으면 재실행 도중(status=COLLECTING) 화면에 어제 실행의 실패 사유가
    // 그대로 남아, 그 사이 화면을 연 검수자가 그것을 오늘 것으로 오인한다.
    const { update } = briefRunStartData('2026-08-27')
    expect(update.status).toBe('COLLECTING')
    expect(update.statusDetail).toBeNull()
    expect(update.finishedAt).toBeNull()
  })

  it('진행 문구도 함께 비운다 — 지난 실행의 단계가 남으면 새 실행이 뒷걸음질친다', () => {
    // 「요약 생성 중 (31/47)」이 남아 있으면 방금 시작한 실행이 이미 요약 단계에
    // 와 있는 것처럼 보이고, 몇 초 뒤 「환율 수집 중」으로 되돌아간다.
    const { update } = briefRunStartData('2026-08-27')
    expect(update.progressDetail).toBeNull()
  })

  it('처음 생성하는 경우에도 COLLECTING으로 시작한다', () => {
    const { create } = briefRunStartData('2026-08-27')
    expect(create).toEqual({ runDate: '2026-08-27', tradeDate: '2026-08-27', status: 'COLLECTING' })
  })
})

describe('buildFallbackSummaries', () => {
  // 문장 경계(.)가 있는 긴 본문 — truncateAtSentence 가 실제로 자를 구간이 있어야
  // "본문 선두"와 "다음 구간"이 우연히 같은 지점에서 끊기지 않는다.
  const LONG_SENTENCE_BODY = Array.from({ length: 30 }, (_, i) => `이것은 문장 번호 ${i + 1}입니다.`).join(' ')
  const SNIPPET = '이것은 검색 스니펫으로 본문과는 전혀 다른 문장입니다.'

  it('긴 본문에서 서로 다른 두 구간(선두/다음)을 뽑는다 — 정상 요약과 개수가 같다', () => {
    const r = buildFallbackSummaries(LONG_SENTENCE_BODY, SNIPPET)
    expect(r).toHaveLength(2)
    expect(new Set(r).size).toBe(2) // 둘 다 다르다
    // 상한이 2라서 스니펫(세 번째 슬라이스)까지는 가지 않는다.
    expect(r).not.toContain(SNIPPET)
  })

  it('개수 상한이 SUMMARY_VARIANTS 와 묶여 있다 — 폴백만 개수가 달라지지 않는다', () => {
    // 발췌만 3안이 되면 담당자는 그 차이를 "요약 실패"로 읽지 않는다 — 그냥 행마다
    // 개수가 다른 화면으로 보인다. 이 테스트는 상한을 숫자로 되돌리는 변경을 잡는다.
    const inputs: Array<[string, string]> = [
      [LONG_SENTENCE_BODY, SNIPPET],
      [LONG_SENTENCE_BODY, ''],
      ['짧은 본문 하나뿐인 문장입니다', SNIPPET],
      ['', SNIPPET],
    ]
    for (const [body, snippet] of inputs) {
      expect(buildFallbackSummaries(body, snippet).length).toBeLessThanOrEqual(SUMMARY_VARIANTS.length)
    }
  })

  it('폴백 개수가 정상 경로의 variant 개수를 넘지 않아, collect.ts 의 인덱스 매핑이 항상 성립한다', () => {
    // collect.ts 는 `variant: SUMMARY_VARIANTS[i].variant` 로 저장한다.
    // 폴백이 더 많으면 SUMMARY_VARIANTS[i] 가 undefined 가 되어 저장이 터진다.
    const r = buildFallbackSummaries(LONG_SENTENCE_BODY, SNIPPET)
    for (let i = 0; i < r.length; i++) {
      expect(SUMMARY_VARIANTS[i]).toBeDefined()
    }
  })

  it('각 슬라이스는 100 코드포인트를 넘지 않는다', () => {
    const r = buildFallbackSummaries(LONG_SENTENCE_BODY, SNIPPET)
    for (const s of r) expect(charLength(s)).toBeLessThanOrEqual(100)
  })

  it('본문이 짧으면(다음 구간이 없으면) 복제하지 않고 개수를 줄인다', () => {
    const shortBody = '짧은 본문 하나뿐인 문장입니다'
    const r = buildFallbackSummaries(shortBody, SNIPPET)
    // 본문 선두 1개 + 스니펫 1개 = 2개. "다음 구간"은 본문을 다 써버려서 없다.
    expect(r).toHaveLength(2)
    expect(new Set(r).size).toBe(2)
  })

  it('스니펫이 본문과 같으면 중복을 만들지 않는다', () => {
    const body = '본문과 스니펫이 완전히 같은 경우'
    const r = buildFallbackSummaries(body, body)
    expect(r).toHaveLength(1)
  })

  it('스니펫이 없으면 본문에서만 뽑는다', () => {
    const r = buildFallbackSummaries(LONG_SENTENCE_BODY, '')
    expect(r.length).toBeGreaterThan(0)
    expect(r.length).toBeLessThanOrEqual(2)
  })

  it('본문이 비어 있으면 스니펫만으로 만든다', () => {
    const r = buildFallbackSummaries('', SNIPPET)
    expect(r).toEqual([formatSummary(SNIPPET)])
  })

  it('본문과 스니펫이 둘 다 비어 있으면 빈 배열을 준다', () => {
    expect(buildFallbackSummaries('', '')).toEqual([])
  })

  // Fix round 4: 네이버 스니펫은 대개 기사 도입부라서 본문 선두와 "거의 같지만
  // 미세하게 다른" 경우가 흔하다 — 정확히 같은 문자열만 걸러내면 담당자에게
  // 사실상 같은 선택지가 두 개 간다.
  it('스니펫이 본문 선두의 접두사면 사실상 중복으로 보고 버린다', () => {
    const prefixSnippet = LONG_SENTENCE_BODY.slice(0, 20)
    const r = buildFallbackSummaries(LONG_SENTENCE_BODY, prefixSnippet)
    // 스니펫이 본문 선두 슬라이스에 포함되므로 버려진다 — 본문에서 나온 두 구간만 남는다.
    expect(r).toHaveLength(2)
    for (const s of r) expect(s).not.toBe(prefixSnippet)
  })

  it('본문이 한 구간뿐이면 스니펫이 두 번째 자리를 채운다 — 상한 안에서 살아 있다', () => {
    // 세 번째 슬라이스 경로가 죽지 않았는지 확인한다. 상한을 2로 줄이면서 스니펫
    // 경로가 영영 도달 불가가 됐다면, 본문이 짧은 날 폴백이 1개로 쪼그라든다.
    const shortBody = '짧은 본문 하나뿐인 문장입니다'
    const r = buildFallbackSummaries(shortBody, SNIPPET)
    expect(r).toEqual([shortBody, formatSummary(SNIPPET)])
  })

  it('공백 하나만 다른 경우도 중복으로 보고 버린다', () => {
    const body = '짧은 본문 문장입니다'
    const snippetWithExtraSpace = '짧은  본문   문장입니다' // 공백만 더 들어간, 사실상 같은 문장
    const r = buildFallbackSummaries(body, snippetWithExtraSpace)
    expect(r).toHaveLength(1)
  })

  it('발췌도 모델 요약과 같은 문장부호·금액 표기를 따른다 (담당자 피드백 2026-10-02)', () => {
    // 담당자는 화면의 요약을 출처와 무관하게 메일에 그대로 붙인다. 발췌만 마침표로
    // 끝나거나 `1000억원` 으로 나오면 그 칸만 손으로 고쳐야 한다.
    const body = '셀트리온이 1000억원 규모 자사주를 매입한다. 올해 누적 매입액은 4000억 규모다. ' +
      Array.from({ length: 20 }, (_, i) => `추가 문장 ${i + 1}이다.`).join(' ')
    const r = buildFallbackSummaries(body, SNIPPET)
    expect(r).toHaveLength(2)
    for (const s of r) {
      expect(s).not.toMatch(/[.。,…]$/)
      expect(s).not.toMatch(/(?<![0-9])\.|\.(?![0-9])/)
      expect((s.match(/…/g) ?? []).length).toBeLessThanOrEqual(1)
      expect(charLength(s)).toBeLessThanOrEqual(100)
    }
    expect(r[0]).toContain('1,000억원')
    expect(r[0]).toContain('4,000억원 규모')
  })

  it('서식이 콤마·원을 붙여 100자를 넘기면 그 뒤에 다시 자른다 — 원문 절삭만으로는 부족하다', () => {
    // cap() 은 원문을 100자로 먼저 자르므로, 서식만 하고 절삭을 빼먹어도 대부분의
    // 입력에서는 티가 안 난다(리뷰 2026-10-02). 금액이 몰린 본문만 새어 나간다.
    // `1000억 1000억` 처럼 숫자가 이어지면 원·콤마가 안 붙으므로, 금액 뒤에 단어를 둔다.
    const body = '1000억원 계약 '.repeat(30)
    expect(charLength(formatSummary([...body].slice(0, 100).join('')))).toBeGreaterThan(100) // 전제
    const r = buildFallbackSummaries(body, '')
    expect(r.length).toBeGreaterThan(0)
    for (const s of r) expect(charLength(s)).toBeLessThanOrEqual(100)
  })

  it('두 번째 구간은 원문 기준으로 이어진다 — 서식이 글자 수를 바꿔도 겹치지 않는다', () => {
    // (2)의 시작점은 (1)이 **원문에서** 소비한 글자 수다. 서식 후 글자 수로 잡으면
    // 위치가 어긋나 문장 중간에서 시작한다.
    //
    // 실측한 성질: 원문 100자 이내로 자른 (1)에 금액 콤마가 붙어 100자를 넘으면
    // `finalizeSummary` 가 끝 문장을 한 번 더 떨군다. 그 문장은 (2)로 넘어가지 않는다
    // (여기서는 문장 5). 겹치지는 않고 빠질 뿐이며, 발췌는 원래 본문 일부만 싣는다.
    const sentences = Array.from({ length: 30 }, (_, i) => `문장 ${i + 1}에서 1000억원 달성이다.`)
    const r = buildFallbackSummaries(sentences.join(' '), '')
    expect(r).toHaveLength(2)
    const nums = (t: string) => [...t.matchAll(/문장 (\d+)에서/g)].map(m => Number(m[1]))
    const a = nums(r[0])
    const b = nums(r[1])
    expect(a[0]).toBe(1)
    expect(Math.min(...b)).toBeGreaterThan(Math.max(...a))
    for (const part of r[1].split(', ')) expect(part).toMatch(/^문장 \d+에서 1,000억원 달성이다$/)
  })

  it('정말로 다른 스니펫은 살아남는다 (과잉 제거 방지)', () => {
    const body = '가나다라마바사아자차카타파하 문장입니다'
    const distinctSnippet = '이것은 본문과 전혀 겹치지 않는 완전히 다른 스니펫 문장입니다'
    const r = buildFallbackSummaries(body, distinctSnippet)
    expect(r).toContain(distinctSnippet)
    expect(r.length).toBeGreaterThanOrEqual(2)
  })
})

describe('wantsMarketWrapNews', () => {
  // 감점 예외의 기준이 `isIndex` 가 아니라 "이 행이 원하는 것이 시황인가"라는 것을
  // 고정한다. 네 지수 행이 서로 다른 것을 원한다 — 그게 이 함수가 존재하는 이유다.
  it('KOSPI·S&P500·Nasdaq 은 시황을 원한다', () => {
    expect(wantsMarketWrapNews({ name: 'KOSPI' })).toBe(true)
    expect(wantsMarketWrapNews({ name: 'S&P500' })).toBe(true)
    expect(wantsMarketWrapNews({ name: 'Nasdaq' })).toBe(true)
  })

  it('코스피200 헬스케어는 지수지만 시황이 아니라 업종 동향을 원한다', () => {
    // 여기가 요점이다. isIndex 로 갈랐을 때 이 행이 잘못된 쪽에 들어갔다 —
    // 실측(2026-08-27)에서 미국 증시 시황이 업종 기사를 밀어냈다.
    expect(wantsMarketWrapNews({ name: '코스피200 헬스케어' })).toBe(false)
  })

  it('개별 기업 행은 시황을 원하지 않는다', () => {
    for (const name of ['셀트리온', '알테오젠', 'Pfizer', 'Lonza']) {
      expect(wantsMarketWrapNews({ name }), name).toBe(false)
    }
  })

  it('목록은 세 행뿐이다 — 늘리려면 그 행이 정말 시황을 원하는지 따져야 한다', () => {
    expect([...MARKET_WRAP_ROWS].sort()).toEqual(['KOSPI', 'Nasdaq', 'S&P500'])
  })
})
