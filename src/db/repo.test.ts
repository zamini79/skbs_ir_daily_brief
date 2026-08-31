import { describe, it, expect } from 'vitest'
import {
  quoteFallbackSourceUsed,
  rowDisplayState,
  rowStateLabel,
  runStatusLabel,
  sameEventBadgeLabel,
  summaryErrorShortLabel,
  newsColumnContent,
  groupByCategory,
  resolveDisplayQuote,
  marketCapBlankReason,
  quoteFailureReason,
  briefDayMark,
  briefDayMarkLabel,
  type ClientCandidate,
  type RowState,
} from './repo'
import { STALLED_AFTER_MS } from '@/domain/runProgress'

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

function candidate(overrides: Partial<ClientCandidate> = {}): ClientCandidate {
  return {
    id: 'c1',
    rank: 1,
    title: '기본 제목',
    url: 'https://example.com/1',
    publisher: 'example',
    publishedAt: '2026-08-27T00:00:00.000Z',
    clusterSize: 1,
    sameEventAsRank: null,
    summaryError: null,
    summaries: [],
    ...overrides,
  }
}

describe('newsColumnContent', () => {
  it('NO_NEWS와 NEWS_FAILED는 절대 같은 문자열로 수렴하지 않는다 — 이번 세션의 핵심 결함', () => {
    const noNews = newsColumnContent({
      state: 'NO_NEWS',
      candidates: [],
      chosenCandidateId: null,
      chosenSummaryId: null,
      editedText: null,
    })
    const failed = newsColumnContent({
      state: 'NEWS_FAILED',
      candidates: [],
      chosenCandidateId: null,
      chosenSummaryId: null,
      editedText: null,
    })
    expect(noNews).toEqual({ kind: 'none' })
    expect(failed).toEqual({ kind: 'label', text: rowStateLabel('NEWS_FAILED') })
    expect(noNews).not.toEqual(failed)
  })

  it('OMITTED는 NO_NEWS와 다른 kind다 — 둘 다 화면상 "-"로 보일 수 있어도 구조적으로 갈라 둔다', () => {
    const omitted = newsColumnContent({
      state: 'OMITTED',
      candidates: [],
      chosenCandidateId: null,
      chosenSummaryId: null,
      editedText: null,
    })
    expect(omitted).toEqual({ kind: 'omitted' })
  })

  it('STALE_SELECTION은 지금의 경고 라벨을 그대로 쓴다', () => {
    const result = newsColumnContent({
      state: 'STALE_SELECTION',
      candidates: [candidate()],
      chosenCandidateId: null,
      chosenSummaryId: null,
      editedText: null,
    })
    expect(result).toEqual({ kind: 'label', text: rowStateLabel('STALE_SELECTION') })
  })

  it('SELECTED는 editedText가 있으면 요약 원문 대신 editedText를 쓴다 — 최종 출력이 그 값이므로', () => {
    const cand = candidate({
      id: 'c1',
      title: '제목A',
      url: 'https://example.com/a',
      summaries: [{ id: 's1', variant: 1, text: '원본 요약', isFallback: false }],
    })
    const result = newsColumnContent({
      state: 'SELECTED',
      candidates: [cand],
      chosenCandidateId: 'c1',
      chosenSummaryId: 's1',
      editedText: '담당자가 고친 요약',
    })
    expect(result).toEqual({
      kind: 'article',
      confirmed: true,
      title: '제목A',
      url: 'https://example.com/a',
      summary: '담당자가 고친 요약',
      isFallback: false,
    })
  })

  it('editedText 가 빈 문자열이면 편집분으로 치지 않고 선택한 요약을 보여준다', () => {
    // 담당자가 텍스트를 지우고 blur 하면 ''가 저장될 수 있다(옛 데이터).
    // `?? ` 만 쓰면 ''가 값으로 취급돼 고른 요약이 영구히 가려지는데, 행은 여전히
    // 「선택 완료」라서 화면만 보고는 왜 비었는지 알 수 없다.
    const cand = candidate({
      id: 'c1',
      summaries: [{ id: 's1', variant: 1, text: '원본 요약', isFallback: false }],
    })
    for (const empty of ['', '   ']) {
      const result = newsColumnContent({
        state: 'SELECTED',
        candidates: [cand],
        chosenCandidateId: 'c1',
        chosenSummaryId: 's1',
        editedText: empty,
      })
      expect(result).toMatchObject({ kind: 'article', summary: '원본 요약' })
    }
  })

  it('SELECTED인데 editedText가 없으면 선택된 요약 원문을 쓴다', () => {
    const cand = candidate({
      id: 'c1',
      summaries: [{ id: 's1', variant: 1, text: '원본 요약', isFallback: false }],
    })
    const result = newsColumnContent({
      state: 'SELECTED',
      candidates: [cand],
      chosenCandidateId: 'c1',
      chosenSummaryId: 's1',
      editedText: null,
    })
    expect(result.kind).toBe('article')
    expect((result as { summary: string | null }).summary).toBe('원본 요약')
  })

  it('SELECTED인데 고른 후보에 요약이 아예 없으면(실제로 흔하다) 제목만 나오고 깨지지 않는다', () => {
    const cand = candidate({ id: 'c1', title: '요약 없는 제목', summaries: [] })
    const result = newsColumnContent({
      state: 'SELECTED',
      candidates: [cand],
      chosenCandidateId: 'c1',
      chosenSummaryId: null,
      editedText: null,
    })
    expect(result).toEqual({
      kind: 'article',
      confirmed: true,
      title: '요약 없는 제목',
      url: cand.url,
      summary: null,
      isFallback: false,
    })
  })

  it('SELECTED가 발췌 요약(isFallback)을 가리키면 결과도 isFallback: true 다 — editedText 유무와 무관하다', () => {
    const cand = candidate({
      id: 'c1',
      title: '발췌 기사',
      summaries: [{ id: 's1', variant: 1, text: '본문에서 뽑은 문장', isFallback: true }],
    })
    const withoutEdit = newsColumnContent({
      state: 'SELECTED',
      candidates: [cand],
      chosenCandidateId: 'c1',
      chosenSummaryId: 's1',
      editedText: null,
    })
    const withEdit = newsColumnContent({
      state: 'SELECTED',
      candidates: [cand],
      chosenCandidateId: 'c1',
      chosenSummaryId: 's1',
      editedText: '담당자가 손본 텍스트',
    })
    expect((withoutEdit as { isFallback: boolean }).isFallback).toBe(true)
    // editedText는 표시 텍스트만 바꿀 뿐, 원본이 발췌였다는 사실 자체는 지우지 않는다.
    expect((withEdit as { isFallback: boolean }).isFallback).toBe(true)
  })

  it('PENDING은 1순위 후보의 ①안 요약을 미리보기로 보여주되 confirmed: false 다', () => {
    const rank1 = candidate({
      id: 'c1',
      rank: 1,
      title: '1순위 제목',
      url: 'https://example.com/rank1',
      summaries: [
        { id: 's1', variant: 1, text: '①안 요약', isFallback: false },
        { id: 's2', variant: 2, text: '②안 요약', isFallback: false },
      ],
    })
    const rank2 = candidate({ id: 'c2', rank: 2, title: '2순위 제목' })
    const result = newsColumnContent({
      state: 'PENDING',
      candidates: [rank1, rank2],
      chosenCandidateId: null,
      chosenSummaryId: null,
      editedText: null,
    })
    expect(result).toEqual({
      kind: 'article',
      confirmed: false,
      title: '1순위 제목',
      url: 'https://example.com/rank1',
      summary: '①안 요약',
      isFallback: false,
    })
  })

  it('PENDING 미리보기가 발췌 요약(①안)을 가리키면 isFallback: true 다', () => {
    const rank1 = candidate({
      id: 'c1',
      rank: 1,
      title: '1순위 제목',
      summaries: [{ id: 's1', variant: 1, text: '본문에서 뽑은 문장', isFallback: true }],
    })
    const result = newsColumnContent({
      state: 'PENDING',
      candidates: [rank1],
      chosenCandidateId: null,
      chosenSummaryId: null,
      editedText: null,
    })
    expect((result as { isFallback: boolean }).isFallback).toBe(true)
  })

  it('PENDING 미리보기는 SELECTED 확정본과 confirmed 플래그가 다르다 — 화면이 절대 같아 보이면 안 된다', () => {
    const cand = candidate({
      id: 'c1',
      rank: 1,
      summaries: [{ id: 's1', variant: 1, text: '요약', isFallback: false }],
    })
    const pending = newsColumnContent({
      state: 'PENDING',
      candidates: [cand],
      chosenCandidateId: null,
      chosenSummaryId: null,
      editedText: null,
    })
    const selected = newsColumnContent({
      state: 'SELECTED',
      candidates: [cand],
      chosenCandidateId: 'c1',
      chosenSummaryId: 's1',
      editedText: null,
    })
    expect(pending.kind).toBe('article')
    expect(selected.kind).toBe('article')
    expect((pending as { confirmed: boolean }).confirmed).toBe(false)
    expect((selected as { confirmed: boolean }).confirmed).toBe(true)
  })

  it('PENDING인데 1순위 후보에 요약이 없으면 제목만 나오고 깨지지 않는다', () => {
    const cand = candidate({ id: 'c1', rank: 1, title: '요약 없는 1순위', summaries: [] })
    const result = newsColumnContent({
      state: 'PENDING',
      candidates: [cand],
      chosenCandidateId: null,
      chosenSummaryId: null,
      editedText: null,
    })
    expect(result).toEqual({
      kind: 'article',
      confirmed: false,
      title: '요약 없는 1순위',
      url: cand.url,
      summary: null,
      isFallback: false,
    })
  })

  it('모든 RowState가 예외 없이 하나의 kind를 반환한다', () => {
    const ALL: RowState[] = ['NEWS_FAILED', 'NO_NEWS', 'OMITTED', 'PENDING', 'SELECTED', 'STALE_SELECTION']
    for (const state of ALL) {
      const cand = candidate({ id: 'c1', rank: 1 })
      const result = newsColumnContent({
        state,
        candidates: state === 'NO_NEWS' || state === 'NEWS_FAILED' ? [] : [cand],
        chosenCandidateId: state === 'SELECTED' ? 'c1' : null,
        chosenSummaryId: null,
        editedText: null,
      })
      expect(['article', 'omitted', 'none', 'label']).toContain(result.kind)
    }
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

describe('marketCapBlankReason', () => {
  const foreign = { isIndex: false, currency: 'USD', marketCapKrwTrillion: null, fxRate: null, close: 28.3 }

  it('해외사 시총이 비고 환율도 없으면 환율 미확보로 단정한다', () => {
    expect(marketCapBlankReason(foreign)).toBe('FX_UNAVAILABLE')
  })

  // 국내 행까지 경고가 번지면 안 된다 — 이 작업의 명시적 요구사항이다.
  it('국내 종목은 환율이 통째로 없어도 이유를 붙이지 않는다', () => {
    // resolveMarketCap 이 네이버 시총을 fxRate 검사보다 먼저 반환하므로 값이 차 있다.
    expect(marketCapBlankReason({
      isIndex: false, currency: 'KRW', marketCapKrwTrillion: 73.37, fxRate: null, close: 1_585_000,
    })).toBeNull()
  })

  // 위 테스트는 네이버가 시총을 준 경우만 본다 — "값이 있으니 설명할 게 없다"에
  // 걸려서, 통화를 보지 않는 구현도 그대로 통과한다. 진짜 위험한 조합은 이쪽이다:
  // 네이버가 marketValue 를 빠뜨려(naver.ts:45,52) 시총이 null 인 국내 행 +
  // 환율 조회 전체 실패로 fxRate 가 null. 통화를 보지 않으면 여기서 국내 행에
  // 「환율 미확보」가 뜬다 — KRW 는 환율이 필요 없는 통화다.
  it('국내 종목은 시총이 비고 환율도 없는 조합에서도 환율 탓을 하지 않는다', () => {
    expect(marketCapBlankReason({
      isIndex: false, currency: 'KRW', marketCapKrwTrillion: null, fxRate: null, close: 1_585_000,
    })).toBeNull()
  })

  it('지수는 시총 개념이 없으므로 이유를 붙이지 않는다', () => {
    expect(marketCapBlankReason({
      isIndex: true, currency: 'USD', marketCapKrwTrillion: null, fxRate: null, close: 7675.7,
    })).toBeNull()
  })

  it('시세 자체가 실패한 행은 환율 탓으로 돌리지 않는다', () => {
    // close 가 없으면 수집이 그 종목에서 실패한 것이다. 원인을 환율로 단정할 수 없다.
    expect(marketCapBlankReason({ ...foreign, close: null })).toBeNull()
  })

  it('환율은 있는데 시총이 없으면 원인을 지어내지 않는다', () => {
    // 예: sharesOutstanding 미등록. 모르는 것을 안다고 말하지 않는다.
    expect(marketCapBlankReason({ ...foreign, fxRate: 1383.49 })).toBeNull()
  })

  it('시총이 있으면 환율이 없어도 이유를 붙이지 않는다', () => {
    expect(marketCapBlankReason({ ...foreign, marketCapKrwTrillion: 12.3 })).toBeNull()
  })
})

describe('quoteFailureReason', () => {
  // 자동 소스가 실패해 표시할 값이 아무것도 없는 행.
  const failed = {
    quoteSource: 'twelvedata',
    displayClose: null,
    errorMessage: 'twelvedata: PFE 응답 없음',
  }

  it('수집이 실패하고 표시할 값도 없으면 사유 원문을 그대로 준다', () => {
    // 지어내지 않는다 — errorMessage 를 요약하거나 바꾸지 않고 그대로 넘긴다.
    expect(quoteFailureReason(failed)).toBe('twelvedata: PFE 응답 없음')
  })

  it('krx provider 가 구분해 놓은 세 사유가 각각 그대로 전달된다', () => {
    // provider 가 휴장 상한 초과 / 지수명 불일치 / 인증을 서로 다른 문구로 갈라 놨다.
    // 화면까지 그 구분이 살아 있어야 이 작업이 의미가 있다.
    const reasons = [
      '[코스피 200 헬스케어] 20260827 부터 10일을 거슬러 올라가도 거래일을 찾지 못함',
      '[코스피 200 헬스케어] 20260826 응답 51행에 해당 지수가 없음',
      '[코스피 200 헬스케어] KRX HTTP 401 Unauthorized Key (basDd=20260826)',
    ]
    for (const r of reasons) {
      expect(quoteFailureReason({ ...failed, quoteSource: 'krx-index', errorMessage: r })).toBe(r)
    }
  })

  it("quoteSource 가 'manual' 이면 실패라고 하지 않는다", () => {
    // 수집을 시도조차 하지 않은 행이다. 파이프라인이 남기는 '소스 없음(수기 입력 대상)'은
    // 기록이지 장애가 아니다 — 이걸 실패로 그리면 정상인 행에 매일 딱지가 붙는다.
    expect(quoteFailureReason({
      quoteSource: 'manual',
      displayClose: null,
      errorMessage: '소스 없음(수기 입력 대상)',
    })).toBeNull()
  })

  it('수기 입력값이 대신 채워졌으면 실패라고 하지 않는다', () => {
    // 담당자가 지금 조치할 것이 없고, 그 행은 이미 '(수기)' 표시로 구분된다.
    expect(quoteFailureReason({ ...failed, displayClose: 2173.53 })).toBeNull()
  })

  it('시세가 정상이면 아무 말도 하지 않는다', () => {
    expect(quoteFailureReason({
      quoteSource: 'naver-stock',
      displayClose: 1_585_000,
      errorMessage: null,
    })).toBeNull()
  })

  it('값도 없고 사유도 기록되지 않았으면 원인을 지어내지 않는다', () => {
    // 예: QuoteSnapshot 쓰기 자체가 실패해 행이 아예 없는 경우. 화면은 '-' 로 두고
    // 배너가 대신 말한다(collect.ts 의 quoteFailed 는 이 경우도 센다).
    expect(quoteFailureReason({ ...failed, errorMessage: null })).toBeNull()
  })
})

describe('quoteFallbackSourceUsed', () => {
  // 폴백은 값을 채우기 때문에 **실패처럼 보이지 않는다.** 배너는 초록색이고 다섯 칸이
  // 다 차 있다. 이 판정이 없으면 1차 소스가 몇 주째 죽어 있어도 아무도 모른다.
  const fellBack = {
    quoteSource: 'marketstack',
    snapshotSource: 'ft',
    displayClose: 77.28,
    displayIsManual: false,
  }

  it('실제로 값을 가져온 소스가 설정된 1차와 다르면 그 이름을 준다', () => {
    expect(quoteFallbackSourceUsed(fellBack)).toBe('ft')
  })

  it('1차가 채운 평소의 행에는 아무 말도 하지 않는다', () => {
    expect(quoteFallbackSourceUsed({ ...fellBack, snapshotSource: 'marketstack' })).toBeNull()
    expect(quoteFallbackSourceUsed({
      quoteSource: 'lse', snapshotSource: 'lse', displayClose: 1852, displayIsManual: false,
    })).toBeNull()
  })

  it('표시할 값이 없으면 폴백이 아니다 — 그 행은 이미 「시세 실패」로 뜬다', () => {
    // 폴백까지 실패했거나 통화 불일치로 값을 버린 행이다. 사유에 두 소스가 모두 있다.
    expect(quoteFallbackSourceUsed({ ...fellBack, displayClose: null })).toBeNull()
  })

  it('수기 입력값으로 채워진 행은 폴백이 아니다 — 이미 (수기) 로 구분된다', () => {
    expect(quoteFallbackSourceUsed({ ...fellBack, displayIsManual: true })).toBeNull()
  })

  it('스냅샷이 아예 없으면 아무 말도 하지 않는다', () => {
    expect(quoteFallbackSourceUsed({ ...fellBack, snapshotSource: null })).toBeNull()
  })
})

describe('briefDayMark', () => {
  it('네 상태를 서로 다른 표시로 가른다', () => {
    expect(briefDayMark('READY')).toBe('DONE')
    expect(briefDayMark('PARTIAL')).toBe('PARTIAL')
    expect(briefDayMark('COLLECTING')).toBe('RUNNING')
    expect(briefDayMark('FAILED')).toBe('FAILED')
    const marks = ['READY', 'PARTIAL', 'COLLECTING', 'FAILED'].map(s => briefDayMark(s))
    expect(new Set(marks).size).toBe(4)
  })

  it('부분 완료를 완료로 합치지 않는다', () => {
    expect(briefDayMark('PARTIAL')).not.toBe(briefDayMark('READY'))
  })

  it('모르는 상태는 완료가 아니라 UNKNOWN 이다', () => {
    // 조용히 DONE 으로 떨어지면 달력이 "이 날은 다 됐다"고 거짓말을 하게 된다.
    expect(briefDayMark('WHATEVER')).toBe('UNKNOWN')
    expect(briefDayMark('')).toBe('UNKNOWN')
    expect(briefDayMark('ready')).toBe('UNKNOWN') // 대소문자도 지어내 맞추지 않는다
  })

  it('시작한 지 얼마 안 된 COLLECTING 은 도는 중이다', () => {
    expect(briefDayMark('COLLECTING', { startedAtMs: 0, nowMs: 202_000 })).toBe('RUNNING')
  })

  it('오래된 COLLECTING 은 도는 중과 다른 표시다 — 달력에서도 갈라야 한다', () => {
    // 몇 달 전에 죽은 실행이 오늘 07:40 에 시작한 실행과 같은 점으로 그려지면,
    // 담당자는 그 날짜를 열어 보지도 않은 채 「돌고 있구나」로 읽는다.
    const stalled = briefDayMark('COLLECTING', { startedAtMs: 0, nowMs: STALLED_AFTER_MS })
    expect(stalled).toBe('STALLED')
    expect(stalled).not.toBe(briefDayMark('COLLECTING', { startedAtMs: 0, nowMs: 1000 }))
  })

  it('시작 시각을 모르면 멈췄다고 말하지 않는다', () => {
    // 판단 근거가 없을 때 단정하지 않는다는 이 코드베이스의 규칙 그대로다.
    expect(briefDayMark('COLLECTING')).toBe('RUNNING')
  })

  it('COLLECTING 이 아닌 상태는 시각을 줘도 판정이 바뀌지 않는다', () => {
    expect(briefDayMark('READY', { startedAtMs: 0, nowMs: STALLED_AFTER_MS * 100 })).toBe('DONE')
    expect(briefDayMark('FAILED', { startedAtMs: 0, nowMs: STALLED_AFTER_MS * 100 })).toBe('FAILED')
  })
})

describe('briefDayMarkLabel', () => {
  it('멈춘 것으로 보이는 실행에 「수집 중」이라고 적지 않는다', () => {
    // 점 색만 가르고 글자는 같으면 구분이 반쪽만 산다.
    expect(briefDayMarkLabel('RUNNING', 'COLLECTING')).toBe('수집 중')
    expect(briefDayMarkLabel('STALLED', 'COLLECTING')).not.toBe('수집 중')
    expect(briefDayMarkLabel('STALLED', 'COLLECTING')).toContain('중단됐을 수 있음')
  })

  it('표시마다 서로 다른 말을 쓴다', () => {
    const labels = (['DONE', 'PARTIAL', 'RUNNING', 'STALLED', 'FAILED'] as const).map(m =>
      briefDayMarkLabel(m, 'COLLECTING'),
    )
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('모르는 상태는 원문을 그대로 보여준다 — 아는 척하지 않는다', () => {
    expect(briefDayMarkLabel('UNKNOWN', 'WHATEVER')).toBe('WHATEVER')
  })
})
