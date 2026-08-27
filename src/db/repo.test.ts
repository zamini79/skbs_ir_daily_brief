import { describe, it, expect } from 'vitest'
import {
  rowDisplayState,
  rowStateLabel,
  runStatusLabel,
  sameEventBadgeLabel,
  groupByCategory,
  resolveDisplayQuote,
} from './repo'

describe('rowDisplayState', () => {
  it('후보가 없으면 NO_NEWS 다', () => {
    expect(
      rowDisplayState({ candidateCount: 0, decision: 'PENDING', chosenCandidateId: null, chosenSummaryId: null }),
    ).toBe('NO_NEWS')
  })
  it('후보가 없으면 담당자가 아직 안 봤어도 NO_NEWS 다', () => {
    expect(
      rowDisplayState({ candidateCount: 0, decision: 'OMITTED', chosenCandidateId: null, chosenSummaryId: null }),
    ).toBe('NO_NEWS')
  })
  it('담당자가 뺐으면 OMITTED 다', () => {
    expect(
      rowDisplayState({ candidateCount: 3, decision: 'OMITTED', chosenCandidateId: null, chosenSummaryId: null }),
    ).toBe('OMITTED')
  })
  it('아직 안 봤으면 PENDING 이다', () => {
    expect(
      rowDisplayState({ candidateCount: 3, decision: 'PENDING', chosenCandidateId: null, chosenSummaryId: null }),
    ).toBe('PENDING')
  })
  it('골랐으면 SELECTED 다', () => {
    expect(
      rowDisplayState({ candidateCount: 3, decision: 'SELECTED', chosenCandidateId: 'c1', chosenSummaryId: 's1' }),
    ).toBe('SELECTED')
  })
  it('SELECTED인데 재수집으로 chosenCandidateId가 null로 되돌아갔으면 STALE_SELECTION이다', () => {
    expect(
      rowDisplayState({ candidateCount: 3, decision: 'SELECTED', chosenCandidateId: null, chosenSummaryId: null }),
    ).toBe('STALE_SELECTION')
  })
  it('후보는 고른 채로 유효한데 그 후보에 애초에 요약이 없어 chosenSummaryId만 null이면, 무효화가 아니라 정상 종결된 SELECTED다', () => {
    // 재수집이 후보를 지운 것과 "고른 후보에 원래 요약이 없던 것"은 다르다. 후자를
    // STALE_SELECTION으로 잘못 표시하면 안 된다 — 2026-08-27 실행에서 후보 26건
    // 중 20건이 요약 없이 존재했으므로, 이 케이스는 드문 예외가 아니라 흔한 상황이다.
    expect(
      rowDisplayState({ candidateCount: 3, decision: 'SELECTED', chosenCandidateId: 'c1', chosenSummaryId: null }),
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
