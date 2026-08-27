import { describe, it, expect } from 'vitest'
import {
  rowDisplayState,
  rowStateLabel,
  runStatusLabel,
  sameEventBadgeLabel,
  summaryErrorShortLabel,
  groupByCategory,
  resolveDisplayQuote,
} from './repo'

const ALL_ROW_STATES = ['NEWS_FAILED', 'NO_NEWS', 'OMITTED', 'PENDING', 'SELECTED', 'STALE_SELECTION'] as const

describe('rowStateLabel 완전성', () => {
  it('모든 행 상태에 라벨이 있고 서로 다르다', () => {
    const labels = ALL_ROW_STATES.map(s => rowStateLabel(s))
    expect(labels.every(l => typeof l === 'string' && l.length > 0)).toBe(true)
    expect(new Set(labels).size).toBe(ALL_ROW_STATES.length)
  })
})

describe('rowDisplayState', () => {
  it('후보가 없으면 NO_NEWS 다', () => {
    expect(
      rowDisplayState({ candidateCount: 0, decision: 'PENDING', chosenCandidateId: null }),
    ).toBe('NO_NEWS')
  })
  it('후보가 없으면 담당자가 아직 안 봤어도 NO_NEWS 다', () => {
    expect(
      rowDisplayState({ candidateCount: 0, decision: 'OMITTED', chosenCandidateId: null }),
    ).toBe('NO_NEWS')
  })
  // 이 작업의 핵심. 이 두 케이스가 같은 값으로 수렴하면 결함이 되돌아온 것이다.
  it('검색 성공 + 후보 0건 은 NO_NEWS 다 — 정말로 기사가 없었다', () => {
    expect(
      rowDisplayState({ candidateCount: 0, decision: 'PENDING', chosenCandidateId: null, newsFetchStatus: 'OK' }),
    ).toBe('NO_NEWS')
  })
  it('검색 실패 + 후보 0건 은 NEWS_FAILED 다 — 기사가 없는지 알 수 없다', () => {
    expect(
      rowDisplayState({ candidateCount: 0, decision: 'PENDING', chosenCandidateId: null, newsFetchStatus: 'FAILED' }),
    ).toBe('NEWS_FAILED')
  })
  it('두 경우가 절대 같은 상태로 수렴하지 않는다', () => {
    const ok = rowDisplayState({ candidateCount: 0, decision: 'PENDING', chosenCandidateId: null, newsFetchStatus: 'OK' })
    const failed = rowDisplayState({ candidateCount: 0, decision: 'PENDING', chosenCandidateId: null, newsFetchStatus: 'FAILED' })
    expect(ok).not.toBe(failed)
    expect(rowStateLabel(ok)).not.toBe(rowStateLabel(failed))
  })
  it('검색 실패라도 후보가 있으면 평소대로 판정한다', () => {
    expect(
      rowDisplayState({ candidateCount: 3, decision: 'PENDING', chosenCandidateId: null, newsFetchStatus: 'FAILED' }),
    ).toBe('PENDING')
  })
  it('기록이 없으면(구 실행) 기존 동작 그대로 NO_NEWS 다', () => {
    expect(
      rowDisplayState({ candidateCount: 0, decision: 'PENDING', chosenCandidateId: null, newsFetchStatus: null }),
    ).toBe('NO_NEWS')
  })

  it('담당자가 뺐으면 OMITTED 다', () => {
    expect(
      rowDisplayState({ candidateCount: 3, decision: 'OMITTED', chosenCandidateId: null }),
    ).toBe('OMITTED')
  })
  it('아직 안 봤으면 PENDING 이다', () => {
    expect(
      rowDisplayState({ candidateCount: 3, decision: 'PENDING', chosenCandidateId: null }),
    ).toBe('PENDING')
  })
  it('골랐으면 SELECTED 다', () => {
    expect(
      rowDisplayState({ candidateCount: 3, decision: 'SELECTED', chosenCandidateId: 'c1' }),
    ).toBe('SELECTED')
  })
  it('SELECTED인데 재수집으로 chosenCandidateId가 null로 되돌아갔으면 STALE_SELECTION이다', () => {
    expect(
      rowDisplayState({ candidateCount: 3, decision: 'SELECTED', chosenCandidateId: null }),
    ).toBe('STALE_SELECTION')
  })
  it('후보는 고른 채로 유효한데 그 후보에 애초에 요약이 없어 chosenSummaryId만 null이면, 무효화가 아니라 정상 종결된 SELECTED다', () => {
    // 재수집이 후보를 지운 것과 "고른 후보에 원래 요약이 없던 것"은 다르다. 후자를
    // STALE_SELECTION으로 잘못 표시하면 안 된다 — 2026-08-27 실행에서 후보 26건
    // 중 20건이 요약 없이 존재했으므로, 이 케이스는 드문 예외가 아니라 흔한 상황이다.
    // rowDisplayState는 이제 chosenSummaryId를 아예 받지 않는다 — chosenCandidateId
    // 만으로 판정이 충분하다는 것이 이 테스트의 요지이므로 여기서는 넘기지 않는다.
    expect(
      rowDisplayState({ candidateCount: 3, decision: 'SELECTED', chosenCandidateId: 'c1' }),
    ).toBe('SELECTED')
  })
})

describe('rowStateLabel', () => {
  it('다섯 가지 상태 문구가 스펙 표와 일치한다', () => {
    expect(rowStateLabel('NO_NEWS')).toBe('당일·D-1 기사 없음')
    expect(rowStateLabel('OMITTED')).toBe('싣지 않음 (담당자 결정)')
    expect(rowStateLabel('PENDING')).toBe('미검토')
    expect(rowStateLabel('SELECTED')).toBe('선택 완료')
    expect(rowStateLabel('STALE_SELECTION')).toBe('선택 무효화됨 (재수집으로 초기화 — 다시 검토 필요)')
  })
})

describe('summaryErrorShortLabel', () => {
  it('실제 발생한 할당량 소진 메시지를 짧게 줄인다', () => {
    // 2026-08-27 실행에서 실제로 화면에 뜬 원문 (녹십자 등)
    const raw =
      'gemini: 모든 모델이 실패했다 (쿼터 소진: gemini-3.5-flash-lite, gemini-flash-lite-latest, gemini-3.5-flash, gemini-3.1-flash-lite)'
    expect(summaryErrorShortLabel(raw)).toBe('모델 요약 실패 — 할당량 소진')
  })
  it('gemini.ts의 다른 소진 문구("쿼터가 소진")도 잡아낸다', () => {
    expect(summaryErrorShortLabel('gemini: 모든 모델의 쿼터가 소진됐다 (시도: gemini-3.5-flash)')).toBe(
      '모델 요약 실패 — 할당량 소진',
    )
  })
  it('영문 429/RESOURCE_EXHAUSTED 도 소진으로 인식한다', () => {
    expect(summaryErrorShortLabel('gemini HTTP 429: RESOURCE_EXHAUSTED')).toBe('모델 요약 실패 — 할당량 소진')
  })
  it('원인을 모르는 gemini 실패는 사유를 지어내지 않고 일반화만 한다', () => {
    expect(summaryErrorShortLabel('gemini: 응답이 차단됐다 (blockReason=SAFETY)')).toBe('모델 요약 실패')
    expect(summaryErrorShortLabel('gemini: candidates 가 비어있다')).toBe('모델 요약 실패')
  })
  it('collect.ts가 이미 담당자용으로 쓴 짧은 한국어 문장은 그대로 둔다', () => {
    // "모델 요약 실패"로 뭉뚱그리면 "본문이 짧아 시도조차 안 한 것"을
    // "모델이 시도했다가 실패한 것"으로 잘못 말하게 된다.
    expect(summaryErrorShortLabel('본문이 너무 짧아 요약을 생략함')).toBe('본문이 너무 짧아 요약을 생략함')
    expect(summaryErrorShortLabel('할당량 소진 이후 요약을 건너뜀')).toBe('할당량 소진 이후 요약을 건너뜀')
  })
})

describe('runStatusLabel', () => {
  it('알려진 상태를 한글로 바꾼다', () => {
    expect(runStatusLabel('COLLECTING')).toBe('수집 중')
    expect(runStatusLabel('READY')).toBe('준비 완료')
    expect(runStatusLabel('PARTIAL')).toBe('부분 완료')
    expect(runStatusLabel('FAILED')).toBe('실패')
  })
  it('모르는 상태는 원문 그대로 돌려준다', () => {
    expect(runStatusLabel('WEIRD')).toBe('WEIRD')
  })
})

describe('sameEventBadgeLabel', () => {
  it('상위 순위를 문구에 넣는다', () => {
    expect(sameEventBadgeLabel(1)).toBe('1위와 같은 사건')
    expect(sameEventBadgeLabel(2)).toBe('2위와 같은 사건')
  })
})

describe('groupByCategory', () => {
  it('인접한 같은 구분끼리만 묶고 순서를 지킨다', () => {
    const rows = [
      { instrument: { category: '국내사' } },
      { instrument: { category: '국내사' } },
      { instrument: { category: '해외사' } },
      { instrument: { category: 'Index' } },
    ]
    const groups = groupByCategory(rows)
    expect(groups.map(g => g.category)).toEqual(['국내사', '해외사', 'Index'])
    expect(groups[0].rows).toHaveLength(2)
    expect(groups[1].rows).toHaveLength(1)
    expect(groups[2].rows).toHaveLength(1)
  })
  it('빈 배열이면 빈 그룹을 돌려준다', () => {
    expect(groupByCategory([])).toEqual([])
  })
})

describe('resolveDisplayQuote', () => {
  it('자동 시세가 둘 다 있으면 그걸 쓴다', () => {
    const result = resolveDisplayQuote({
      quoteClose: 100, quotePrevClose: 90, quoteChangePct: 0.111,
      manualClose: 999, manualPrevClose: 999,
    })
    expect(result).toEqual({ close: 100, prevClose: 90, changePct: 0.111, isManual: false })
  })
  it('자동 시세가 없으면(코스피200 헬스케어처럼 소스가 없거나 실패) 수기 입력을 쓴다', () => {
    const result = resolveDisplayQuote({
      quoteClose: null, quotePrevClose: null, quoteChangePct: null,
      manualClose: 1200, manualPrevClose: 1000,
    })
    expect(result.isManual).toBe(true)
    expect(result.close).toBe(1200)
    expect(result.prevClose).toBe(1000)
    expect(result.changePct).toBeCloseTo(0.2)
  })
  it('자동 시세도 수기 입력도 없으면 전부 null 이다', () => {
    const result = resolveDisplayQuote({
      quoteClose: null, quotePrevClose: null, quoteChangePct: null,
      manualClose: null, manualPrevClose: null,
    })
    expect(result).toEqual({ close: null, prevClose: null, changePct: null, isManual: false })
  })
  it('자동 시세가 절반만 있으면(비정상) 무시하고 수기 입력으로 폴백한다', () => {
    const result = resolveDisplayQuote({
      quoteClose: 100, quotePrevClose: null, quoteChangePct: null,
      manualClose: 50, manualPrevClose: 45,
    })
    expect(result.isManual).toBe(true)
    expect(result.close).toBe(50)
  })
})
