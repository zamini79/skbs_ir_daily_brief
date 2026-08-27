import { describe, it, expect, vi } from 'vitest'
import { charLength } from '@/domain/text'
import {
  resolveAliases,
  resolveFxRate,
  resolveMarketCap,
  computeSameEventAsRank,
  isQuotaExhaustedMessage,
  createQuotaGuard,
  attemptSummary,
  computeRunStatus,
  isolate,
  needsPendingRevert,
  buildFallbackSummaries,
} from './collectHelpers'

const LONG_BODY = 'x'.repeat(30)
const okSummary = { numeric: 'n', context: 'c', implication: 'i' }

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

  it('연초 기준가 조회 실패도 PARTIAL로 본다 — 요약 실패와 같은 규칙이다', () => {
    // 이 실패는 API 분당 한도 경합이라 어느 종목이 빌지가 매일 달라진다.
    // 상태에 남기지 않으면 재현되지 않는 공란이 되어 아무도 눈치채지 못한다.
    expect(computeRunStatus(0, 1)).toBe('PARTIAL')
    expect(computeRunStatus(0, 4)).toBe('PARTIAL')
  })

  it('둘 다 없어야 READY이다', () => {
    expect(computeRunStatus(0, 0)).toBe('READY')
  })

  it('기준가 인자를 생략하면 기존 동작 그대로다', () => {
    expect(computeRunStatus(0)).toBe('READY')
    expect(computeRunStatus(2)).toBe('PARTIAL')
  })

  it('뉴스 검색 실패도 PARTIAL로 본다', () => {
    // 실패한 행은 화면에서 "당일·D-1 기사 없음"이라는 단정으로 보였다 — 모르는 것을
    // 아는 것처럼 표시한 것이다. 운영자가 실행 단위로도 알 수 있어야 한다.
    expect(computeRunStatus(0, 0, 1)).toBe('PARTIAL')
    expect(computeRunStatus(0, 0, 8)).toBe('PARTIAL')
  })

  it('셋 다 없어야 READY이다', () => {
    expect(computeRunStatus(0, 0, 0)).toBe('READY')
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

describe('buildFallbackSummaries', () => {
  // 문장 경계(.)가 있는 긴 본문 — truncateAtSentence 가 실제로 자를 구간이 있어야
  // "본문 선두"와 "다음 구간"이 우연히 같은 지점에서 끊기지 않는다.
  const LONG_SENTENCE_BODY = Array.from({ length: 30 }, (_, i) => `이것은 문장 번호 ${i + 1}입니다.`).join(' ')
  const SNIPPET = '이것은 검색 스니펫으로 본문과는 전혀 다른 문장입니다.'

  it('긴 본문에서 서로 다른 세 구간(선두/다음/스니펫)을 뽑는다', () => {
    const r = buildFallbackSummaries(LONG_SENTENCE_BODY, SNIPPET)
    expect(r).toHaveLength(3)
    expect(new Set(r).size).toBe(3) // 셋 다 다르다
    expect(r[2]).toBe(SNIPPET)
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
    expect(r).toEqual([SNIPPET])
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

  it('공백 하나만 다른 경우도 중복으로 보고 버린다', () => {
    const body = '짧은 본문 문장입니다'
    const snippetWithExtraSpace = '짧은  본문   문장입니다' // 공백만 더 들어간, 사실상 같은 문장
    const r = buildFallbackSummaries(body, snippetWithExtraSpace)
    expect(r).toHaveLength(1)
  })

  it('정말로 다른 스니펫은 살아남는다 (과잉 제거 방지)', () => {
    const body = '가나다라마바사아자차카타파하 문장입니다'
    const distinctSnippet = '이것은 본문과 전혀 겹치지 않는 완전히 다른 스니펫 문장입니다'
    const r = buildFallbackSummaries(body, distinctSnippet)
    expect(r).toContain(distinctSnippet)
    expect(r.length).toBeGreaterThanOrEqual(2)
  })
})
