import { describe, it, expect, vi } from 'vitest'
import {
  resolveAliases,
  resolveFxRate,
  resolveMarketCap,
  computeSameEventAsRank,
  isQuotaExhaustedMessage,
  createQuotaGuard,
  attemptSummary,
  computeRunStatus,
} from './collectHelpers'

const LONG_BODY = 'x'.repeat(30)
const okSummary = { numeric: 'n', context: 'c', implication: 'i' }

describe('resolveAliases', () => {
  it('콤마로 구분된 별칭을 배열로 만든다', () => {
    expect(resolveAliases({ name: '삼성바이오로직스', newsAliases: '삼성바이오로직스,삼성바이오,삼바' }))
      .toEqual(['삼성바이오로직스', '삼성바이오', '삼바'])
  })

  it('앞뒤 공백을 제거한다', () => {
    expect(resolveAliases({ name: 'GSK', newsAliases: ' GSK , 지에스케이 ' })).toEqual(['GSK', '지에스케이'])
  })

  it('비어 있으면 name 하나로 폴백한다', () => {
    expect(resolveAliases({ name: '셀트리온', newsAliases: '' })).toEqual(['셀트리온'])
  })

  it('공백뿐이어도 name 으로 폴백한다', () => {
    expect(resolveAliases({ name: '셀트리온', newsAliases: '   ' })).toEqual(['셀트리온'])
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
  it('본문이 짧으면 summarizeFn을 호출하지 않고 건너뛴다', async () => {
    const guard = createQuotaGuard()
    const summarizeFn = vi.fn()
    const r = await attemptSummary({ title: 't', body: '짧음' }, guard, summarizeFn)
    expect(r).toEqual({ outcome: 'skipped-empty-body' })
    expect(summarizeFn).not.toHaveBeenCalled()
  })

  it('성공하면 generated와 요약을 준다', async () => {
    const guard = createQuotaGuard()
    const summarizeFn = vi.fn().mockResolvedValue(okSummary)
    const r = await attemptSummary({ title: 't', body: LONG_BODY }, guard, summarizeFn)
    expect(r).toEqual({ outcome: 'generated', summary: okSummary })
  })

  it('요약이 던지면 failed와 메시지를 남기고 후보는 지우지 않는다(후보 삭제는 이 함수 책임이 아니다)', async () => {
    const guard = createQuotaGuard()
    const summarizeFn = vi.fn().mockRejectedValue(new Error('gemini: 파싱 실패'))
    const r = await attemptSummary({ title: 't', body: LONG_BODY }, guard, summarizeFn)
    expect(r).toEqual({ outcome: 'failed', error: 'gemini: 파싱 실패' })
    expect(guard.tripped).toBe(false)
  })

  it('429 실패는 guard를 트립시킨다', async () => {
    const guard = createQuotaGuard()
    const summarizeFn = vi.fn().mockRejectedValue(new Error('gemini HTTP 429: RESOURCE_EXHAUSTED'))
    await attemptSummary({ title: 't', body: LONG_BODY }, guard, summarizeFn)
    expect(guard.tripped).toBe(true)
  })

  it('guard가 이미 트립된 상태면 summarizeFn을 호출하지 않고 건너뛴다', async () => {
    const guard = createQuotaGuard()
    guard.tripped = true
    const summarizeFn = vi.fn()
    const r = await attemptSummary({ title: 't', body: LONG_BODY }, guard, summarizeFn)
    expect(r).toEqual({ outcome: 'skipped-quota-exhausted' })
    expect(summarizeFn).not.toHaveBeenCalled()
  })

  it('연속 호출: 첫 429 이후로는 summarizeFn이 다시 호출되지 않는다', async () => {
    const guard = createQuotaGuard()
    const summarizeFn = vi
      .fn()
      .mockRejectedValueOnce(new Error('gemini HTTP 429: RESOURCE_EXHAUSTED'))
      .mockResolvedValue(okSummary)

    const r1 = await attemptSummary({ title: 'a', body: LONG_BODY }, guard, summarizeFn)
    const r2 = await attemptSummary({ title: 'b', body: LONG_BODY }, guard, summarizeFn)
    const r3 = await attemptSummary({ title: 'c', body: LONG_BODY }, guard, summarizeFn)

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
    const r = await attemptSummary({ title: 't', body: '짧음' }, guard, summarizeFn)
    expect(r).toEqual({ outcome: 'skipped-empty-body' })
  })
})

describe('computeRunStatus', () => {
  it('요약 실패가 하나라도 있으면 PARTIAL이다', () => {
    expect(computeRunStatus(1)).toBe('PARTIAL')
    expect(computeRunStatus(20)).toBe('PARTIAL')
  })

  it('요약 실패가 없으면 READY이다', () => {
    expect(computeRunStatus(0)).toBe('READY')
  })
})
