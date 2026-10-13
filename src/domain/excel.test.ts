import { describe, it, expect } from 'vitest'
import {
  DASH,
  HEADERS,
  countBlankNewsCells,
  countNewsFailed,
  excelFileName,
  excelMarketCapCell,
  excelNewsCells,
  excelPriceCell,
  isUnconfirmedForExport,
  toExcelRows,
} from './excel'
import type { ClientRow, RowState } from '@/db/repo'

const ALL_ROW_STATES: RowState[] = [
  'NEWS_FAILED',
  'NO_NEWS',
  'OMITTED',
  'PENDING',
  'SELECTED',
  'STALE_SELECTION',
  'NEWS_SHARED',
]

const PREVIEW_TITLE = '유출되면 안 되는 1순위 후보 제목'
const PREVIEW_SUMMARY = '유출되면 안 되는 1순위 후보 요약문'

function candidate(over: Partial<ClientRow['candidates'][number]> = {}): ClientRow['candidates'][number] {
  return {
    id: 'cand-1',
    rank: 1,
    title: PREVIEW_TITLE,
    url: 'https://example.com/a',
    publisher: '연합뉴스',
    publishedAt: '2026-08-28T00:00:00.000Z',
    clusterSize: 3,
    sameEventAsRank: null,
    summaryError: null,
    summaries: [{ id: 'sum-1', variant: 1, text: PREVIEW_SUMMARY, isFallback: false }],
    ...over,
  }
}

function row(over: Partial<ClientRow> = {}): ClientRow {
  return {
    instrument: {
      id: 'inst-1',
      category: '국내사',
      displayOrder: 1,
      name: 'SK바이오사이언스',
      currency: 'KRW',
      isIndex: false,
      quoteSource: 'naver-stock',
      quoteSymbol: '302440',
    },
    quote: {
      close: 48200,
      prevClose: 47700,
      changePct: 0.0105,
      ytdPct: -0.221,
      marketCapKrwTrillion: 3.6841,
      asOf: '2026-08-27',
      errorMessage: null,
      sourceName: 'naver-stock',
      fallbackFrom: null,
    },
    candidates: [candidate()],
    selection: {
      decision: 'PENDING',
      chosenCandidateId: null,
      chosenSummaryId: null,
      editedText: null,
      manualClose: null,
      manualPrevClose: null,
    },
    state: 'PENDING',
    display: { close: 48200, prevClose: 47700, changePct: 0.0105, isManual: false },
    newsFetchError: null,
    marketCapBlankReason: null,
    quoteFailReason: null,
    quoteFallbackSource: null,
    ...over,
  }
}

const selectedRow = () =>
  row({
    state: 'SELECTED',
    candidates: [candidate({ title: '담당자가 고른 제목', summaries: [{ id: 'sum-1', variant: 1, text: '담당자가 고른 요약', isFallback: false }] })],
    selection: {
      decision: 'SELECTED',
      chosenCandidateId: 'cand-1',
      chosenSummaryId: 'sum-1',
      editedText: null,
      manualClose: null,
      manualPrevClose: null,
    },
  })

/* ------------------------------------------------------------------ *
 * 가장 중요한 테스트 — 미확정 미리보기가 파일로 새어 나가지 않는가.
 * ------------------------------------------------------------------ */

describe('미확정 내용은 절대 내보내지 않는다', () => {
  it('PENDING 행의 뉴스 두 칸은 빈 문자열이다', () => {
    const cells = excelNewsCells(row({ state: 'PENDING' }))
    expect(cells).toEqual({ title: '', summary: '', url: null })
  })

  it('PENDING 행의 어떤 칸에도 1순위 후보의 제목·요약이 들어가지 않는다', () => {
    const [out] = toExcelRows([row({ state: 'PENDING' })])
    const everything = Object.values(out).join('\u0000')
    expect(everything).not.toContain(PREVIEW_TITLE)
    expect(everything).not.toContain(PREVIEW_SUMMARY)
  })

  it('STALE_SELECTION(재수집으로 무효화된 선택)도 빈 칸이다', () => {
    // 화면에서는 「선택 무효화됨」 라벨이 뜨는 행이다. 파일에서는 `-`(= 실을 것
    // 없음으로 확정)가 아니라 빈 칸이어야 한다 — 아직 정해지지 않은 행이다.
    const cells = excelNewsCells(
      row({
        state: 'STALE_SELECTION',
        selection: {
          decision: 'SELECTED',
          chosenCandidateId: null,
          chosenSummaryId: null,
          editedText: null,
          manualClose: null,
          manualPrevClose: null,
        },
      }),
    )
    expect(cells).toEqual({ title: '', summary: '', url: null })
  })

  it('isUnconfirmedForExport 는 여섯 상태 중 둘만 미확정으로 본다', () => {
    const unconfirmed = ALL_ROW_STATES.filter(isUnconfirmedForExport)
    expect(unconfirmed).toEqual(['PENDING', 'STALE_SELECTION'])
  })

  it('미확정 행은 「-」 와도 구분된다 — 빈 칸과 `-` 는 다른 뜻이다', () => {
    expect(excelNewsCells(row({ state: 'PENDING' })).title).toBe('')
    expect(excelNewsCells(row({ state: 'NO_NEWS', candidates: [] })).title).toBe(DASH)
  })
})

/* ------------------------------------------------------------------ *
 * 다섯 상태가 각각 어떤 행이 되는가.
 * ------------------------------------------------------------------ */

describe('상태별 뉴스 칸', () => {
  it('SELECTED — 고른 제목과 고른 요약이 두 행으로 나간다', () => {
    expect(excelNewsCells(selectedRow())).toEqual({
      title: '담당자가 고른 제목',
      summary: '담당자가 고른 요약',
      // 확정 기사만 링크를 갖는다 — 워크북이 이 값으로 하이퍼링크를 건다.
      url: selectedRow().candidates[0].url,
    })
  })

  it('SELECTED — 담당자가 직접 고친 문장이 있으면 그것이 최종본이다', () => {
    const r = selectedRow()
    r.selection.editedText = '담당자가 손본 문장'
    expect(excelNewsCells(r).summary).toBe('담당자가 손본 문장')
  })

  it('OMITTED — 담당자가 뺀 행은 「-」 다', () => {
    expect(excelNewsCells(row({ state: 'OMITTED' }))).toEqual({ title: DASH, summary: '', url: null })
  })

  it('후보 없음(NO_NEWS) — 「-」 다', () => {
    expect(excelNewsCells(row({ state: 'NO_NEWS', candidates: [] }))).toEqual({
      title: DASH,
      summary: '',
      url: null,
    })
  })

  // 2026-08-28 변경: 예전에는 이 행도 `-` 였다. 그 `-` 는 "오늘 이 회사 뉴스가
  // 없었다"는 **사실 주장**인데 실제로는 검색을 못 해서 모르는 것이다. 최종 산출물이
  // 메일로 나가는 이상 파일에서도 구분돼야 한다(아래 "다섯 상태" describe 참고).
  it('조회 실패(NEWS_FAILED) — 「-」 가 아니라 사유를 적는다', () => {
    const cells = excelNewsCells(row({ state: 'NEWS_FAILED', candidates: [] }))
    expect(cells.summary).toBe('')
    expect(cells.title).not.toBe(DASH)
    expect(cells.title).toContain('실패')
  })

  // "뉴스 내용"은 기사 제목·요약이다. NEWS_FAILED 의 사유 문구는 내용이 아니라
  // 상태 표시이므로 여기서 세지 않는다 — 요약 칸이 비어 있는 것으로 가른다.
  // (제목 칸이 비어 있지 않다는 이유로 NEWS_FAILED 를 여기 포함시키면, 이 테스트가
  //  잡으려던 것 — 미확정 미리보기 유출 — 과 무관한 이유로 빨개진다.)
  it('여섯 상태 중 기사 내용이 실리는 것은 SELECTED 뿐이다', () => {
    const withArticle = ALL_ROW_STATES.filter(state => {
      const cells = excelNewsCells(row({ state, ...(state === 'SELECTED' ? selectedRow() : {}) }))
      return cells.summary !== ''
    })
    expect(withArticle).toEqual(['SELECTED'])
  })

  it('SELECTED 를 뺀 어느 상태도 후보 제목·요약을 흘리지 않는다', () => {
    for (const state of ALL_ROW_STATES.filter(s => s !== 'SELECTED')) {
      const cells = excelNewsCells(row({ state }))
      expect(cells.title, state).not.toContain(PREVIEW_TITLE)
      expect(cells.summary, state).not.toContain(PREVIEW_SUMMARY)
    }
  })
})

/* ------------------------------------------------------------------ *
 * 숫자 서식 — 문자열이 아니라 소수여야 한다.
 * ------------------------------------------------------------------ */

describe('% 와 연초대비는 소수로 나간다', () => {
  it('"0.92%" 같은 문자열이 아니라 0.0105 / -0.221 이다', () => {
    const [out] = toExcelRows([row()])
    expect(out.changePct).toBe(0.0105)
    expect(out.ytdPct).toBe(-0.221)
    expect(typeof out.changePct).toBe('number')
    expect(typeof out.ytdPct).toBe('number')
    expect(String(out.changePct)).not.toContain('%')
  })

  it('값이 없으면 0 이 아니라 「-」 다 — 0% 와 모름은 다르다', () => {
    const [out] = toExcelRows([
      row({
        display: { close: null, prevClose: null, changePct: null, isManual: false },
        quote: null,
      }),
    ])
    expect(out.changePct).toBe(DASH)
    expect(out.ytdPct).toBe(DASH)
  })

  it('진짜 0 은 「-」 로 뭉개지 않는다', () => {
    const [out] = toExcelRows([
      row({
        display: { close: 100, prevClose: 100, changePct: 0, isManual: false },
        quote: { ...row().quote!, ytdPct: 0 },
      }),
    ])
    expect(out.changePct).toBe(0)
    expect(out.ytdPct).toBe(0)
  })

  it('시가총액은 숫자다(서식이 소수 둘째 자리를 붙인다)', () => {
    const [out] = toExcelRows([row()])
    expect(out.marketCap).toBe(3.6841)
  })
})

/* ------------------------------------------------------------------ *
 * 실패·미상이 평범한 값처럼 보이지 않는가.
 * ------------------------------------------------------------------ */

describe('주가 칸은 화면보다 더 확정된 것처럼 보이지 않는다', () => {
  it('평상시에는 원본과 같은 모양이다', () => {
    expect(excelPriceCell(row())).toBe('KRW 48,200')
  })

  it('시세 조회 실패는 공란이 아니라 「시세 실패」 다', () => {
    const r = row({
      display: { close: null, prevClose: null, changePct: null, isManual: false },
      quoteFailReason: 'naver HTTP 429',
    })
    expect(excelPriceCell(r)).toBe('시세 실패')
  })

  it('사유를 모르는 공란은 실패라고 단정하지 않고 「-」 다', () => {
    const r = row({
      display: { close: null, prevClose: null, changePct: null, isManual: false },
      quoteFailReason: null,
    })
    expect(excelPriceCell(r)).toBe(DASH)
  })

  it('기준일을 모르면 그렇게 적는다', () => {
    const r = row({ quote: { ...row().quote!, asOf: null } })
    expect(excelPriceCell(r)).toBe('KRW 48,200 (기준일 미상)')
  })

  it('수기 입력값은 자동 수집값과 같은 모양이 아니다', () => {
    const r = row({
      quote: null,
      display: { close: 3000, prevClose: 2950, changePct: 0.017, isManual: true },
    })
    // quote 가 없으면 기준일도 모른다 — 두 사실을 다 적는다.
    expect(excelPriceCell(r)).toBe('KRW 3,000 (수기, 기준일 미상)')
  })

  it('폴백 소스는 적지 않는다 — 값의 신뢰도가 아니라 운영 신호다', () => {
    const r = row({ quoteFallbackSource: 'ft' })
    expect(excelPriceCell(r)).toBe('KRW 48,200')
  })

  it('지수는 통화 접두어 없이 숫자만이다', () => {
    const r = row({
      instrument: { ...row().instrument, isIndex: true, name: '코스피200 헬스케어' },
    })
    expect(excelPriceCell(r)).toBe('48,200')
  })
})

describe('시가총액 칸', () => {
  it('환율을 못 받아 못 채운 칸은 「-」 가 아니라 이유를 적는다', () => {
    expect(excelMarketCapCell(row({ quote: null, marketCapBlankReason: 'FX_UNAVAILABLE' }))).toBe(
      '환율 미확보',
    )
  })

  it('지수처럼 개념이 없는 칸은 「-」 다', () => {
    expect(
      excelMarketCapCell(row({ quote: { ...row().quote!, marketCapKrwTrillion: null } })),
    ).toBe(DASH)
  })
})

/* ------------------------------------------------------------------ *
 * 표 전체 / 개수 / 파일명
 * ------------------------------------------------------------------ */

describe('toExcelRows', () => {
  it('행 순서를 바꾸지 않고 종목당 한 항목을 준다(워크북이 이걸 2행으로 편다)', () => {
    const rows = [row({ state: 'PENDING' }), selectedRow(), row({ state: 'OMITTED' })]
    const out = toExcelRows(rows)
    expect(out).toHaveLength(3)
    expect(out.map(r => r.name)).toEqual(rows.map(r => r.instrument.name))
  })

  it('전일대비는 화면과 같은 문자열이다(▲/▼ 와 보합 0 을 그대로 옮긴다)', () => {
    const [up] = toExcelRows([row()])
    expect(up.prevDiff).toBe('▲ 500')
    const [flat] = toExcelRows([
      row({ display: { close: 100, prevClose: 100, changePct: 0, isManual: false } }),
    ])
    expect(flat.prevDiff).toBe('0')
    const [none] = toExcelRows([
      row({ display: { close: null, prevClose: null, changePct: null, isManual: false } }),
    ])
    expect(none.prevDiff).toBe(DASH)
  })

  it('머리글은 원본 브리프 엑셀의 8칸이다', () => {
    expect(HEADERS).toEqual(['구분', '기업', '주가', '전일대비', '%', '연초대비', '시가총액', '뉴스'])
  })
})

describe('다운로드 전 경고에 쓰는 개수', () => {
  it('빈 칸 수는 PENDING 과 STALE_SELECTION 을 함께 센다', () => {
    const rows = [
      row({ state: 'PENDING' }),
      row({ state: 'PENDING' }),
      row({ state: 'STALE_SELECTION' }),
      selectedRow(),
      row({ state: 'OMITTED' }),
      row({ state: 'NO_NEWS', candidates: [] }),
      row({ state: 'NEWS_FAILED', candidates: [] }),
    ]
    expect(countBlankNewsCells(rows)).toBe(3)
    expect(countNewsFailed(rows)).toBe(1)
  })

  it('경고에 적히는 수와 파일에서 실제로 빈 칸 수가 항상 같다', () => {
    // 상태로 따로 세면 언젠가 한쪽만 바뀌어 화면이 파일에 대해 거짓말을 한다.
    const rows = [
      row({ state: 'PENDING' }),
      selectedRow(),
      row({ state: 'NEWS_FAILED', candidates: [] }),
      row({ state: 'STALE_SELECTION' }),
      row({ state: 'OMITTED' }),
    ]
    const blanks = toExcelRows(rows).filter(r => r.newsTitle === '').length
    expect(countBlankNewsCells(rows)).toBe(blanks)
  })

  it('조회 실패 행은 빈 칸으로 세지 않는다 — 비는 게 아니라 문구가 적혀 나간다', () => {
    const rows = [row({ state: 'NEWS_FAILED', candidates: [] })]
    expect(countBlankNewsCells(rows)).toBe(0)
    expect(countNewsFailed(rows)).toBe(1)
  })
})

describe('excelNewsCells — 다섯 상태가 파일에서 서로 구분된다', () => {
  // 이 파일은 전 임원에게 메일로 나간다. 「기사 없음」과 「조회 실패」가 같은 `-` 로
  // 나가면, 담당자가 직접 찾아봐야 하는 행이 아무 할 일 없는 행과 구별되지 않는다.
  it('조회 실패는 `-` 가 아니라 그 사실을 적는다', () => {
    const cells = excelNewsCells(row({ state: 'NEWS_FAILED', candidates: [] }))
    expect(cells.title).not.toBe(DASH)
    expect(cells.title).not.toBe('')
    expect(cells.title).toContain('실패')
  })

  it('기사 없음과 조회 실패가 서로 다른 값이다', () => {
    const none = excelNewsCells(row({ state: 'NO_NEWS', candidates: [] }))
    const failed = excelNewsCells(row({ state: 'NEWS_FAILED', candidates: [] }))
    expect(none.title).toBe(DASH)
    expect(failed.title).not.toBe(none.title)
  })

  it('미확정(PENDING)과 조회 실패가 서로 다른 값이다 — 하나는 공란, 하나는 사유', () => {
    const pending = excelNewsCells(row({ state: 'PENDING' }))
    const failed = excelNewsCells(row({ state: 'NEWS_FAILED', candidates: [] }))
    expect(pending.title).toBe('')
    expect(failed.title).not.toBe(pending.title)
  })

  it('싣지 않음은 기사 없음과 같은 `-` 다 — 둘 다 "실을 것이 없다"로 정해진 상태다', () => {
    expect(excelNewsCells(row({ state: 'OMITTED' })).title).toBe(DASH)
  })

  it('선택 무효화는 공란이다 — 부재가 아니라 미확정이다', () => {
    expect(excelNewsCells(row({ state: 'STALE_SELECTION' })).title).toBe('')
  })

  it('조회 실패 행에도 미확정 미리보기가 새어나가지 않는다', () => {
    const cells = excelNewsCells(row({ state: 'NEWS_FAILED' }))
    expect(cells.title).not.toContain(PREVIEW_TITLE)
    expect(cells.summary).not.toContain(PREVIEW_SUMMARY)
  })

  it('다섯 상태가 네 가지 값이 된다 — 같은 값은 OMITTED 와 후보없음 한 쌍뿐이다', () => {
    const byState = new Map<RowState, string>([
      ['SELECTED', excelNewsCells(selectedRow()).title],
      ['PENDING', excelNewsCells(row({ state: 'PENDING' })).title],
      ['OMITTED', excelNewsCells(row({ state: 'OMITTED' })).title],
      ['NO_NEWS', excelNewsCells(row({ state: 'NO_NEWS', candidates: [] })).title],
      ['NEWS_FAILED', excelNewsCells(row({ state: 'NEWS_FAILED', candidates: [] })).title],
    ])

    // 서로 같아도 되는 쌍은 이 하나뿐이다. 둘 다 "실을 것이 없다고 정해졌다"이고,
    // 왜 없는지는 담당자의 관심사(화면에서 「싣지 않음」으로 갈린다)이지 메일 받는
    // 사람의 관심사가 아니다. 나머지는 전부 서로 달라야 한다.
    expect(byState.get('OMITTED')).toBe(byState.get('NO_NEWS'))
    expect(new Set(byState.values()).size).toBe(4)

    // 특히 이 셋은 서로 다른 사실이라 절대 같은 값이 되면 안 된다.
    const three = ['PENDING', 'NO_NEWS', 'NEWS_FAILED'] as const
    expect(new Set(three.map(st => byState.get(st))).size).toBe(3)
  })

  it('고른 후보가 사라진 SELECTED 행은 라벨이 아니라 공란으로 나간다', () => {
    /*
     * decision 은 SELECTED 인데 chosenCandidateId 가 가리키는 후보가 목록에 없는
     * 방어 경로다(repo.ts 가 STALE_SELECTION 라벨을 돌려준다). 그 라벨은 담당자에게
     * "다시 보라"는 말이지 메일 받는 사람에게 할 말이 아니다. state 가 SELECTED 라
     * 미확정 필터에 걸리지 않으므로 따로 막아 둔 자리다.
     */
    const cells = excelNewsCells(
      row({
        state: 'SELECTED',
        candidates: [],
        selection: {
          decision: 'SELECTED',
          chosenCandidateId: 'gone',
          chosenSummaryId: null,
          editedText: null,
          manualClose: null,
          manualPrevClose: null,
        },
      }),
    )
    expect(cells).toEqual({ title: '', summary: '', url: null })
    expect(cells.title).not.toContain('무효화')
  })
})

describe('excelFileName', () => {
  it('날짜가 들어간 ASCII 파일명이다', () => {
    expect(excelFileName('2026-08-28')).toBe('IR_Daily_Brief_2026-08-28.xlsx')
  })
})

/* ------------------------------------------------------------------ *
 * S&P500 + Nasdaq 뉴스 한 칸 (2026-10-02 담당자 피드백, domain/newsShare.ts)
 * ------------------------------------------------------------------ */

describe('뉴스 칸 공유 — S&P500 과 Nasdaq', () => {
  const index = (name: string, quoteSymbol: string, over: Partial<ClientRow> = {}) =>
    row({
      instrument: {
        id: `inst-${quoteSymbol}`,
        category: 'Index',
        displayOrder: 20,
        name,
        currency: 'USD',
        isIndex: true,
        quoteSource: 'naver-index',
        quoteSymbol,
      },
      ...over,
    })
  const sp = (over: Partial<ClientRow> = {}) => index('S&P500', '.INX', over)
  // 공유 이전 날짜처럼 Nasdaq 후보가 DB 에 남아 있는 경우도 같은 규칙이다.
  const nq = () => index('Nasdaq', '.IXIC', { state: 'NEWS_SHARED' })

  it('S&P500 칸이 Nasdaq 까지 덮고(2), Nasdaq 은 0 이다', () => {
    const out = toExcelRows([sp(), nq()])
    expect(out.map(r => r.newsSpan)).toEqual([2, 0])
  })

  it('S&P500 이 미확정이면 공란 경고는 1건이다 — Nasdaq 을 따로 세지 않는다', () => {
    expect(countBlankNewsCells([sp({ state: 'PENDING' }), nq()])).toBe(1)
  })

  it('S&P500 이 확정이면 공란 경고는 0건이다', () => {
    const s = selectedRow()
    expect(countBlankNewsCells([sp({ state: 'SELECTED', candidates: s.candidates, selection: s.selection }), nq()])).toBe(0)
  })

  it('Nasdaq 의 남은 후보는 어느 칸에도 새지 않는다', () => {
    const [, out] = toExcelRows([sp(), nq()])
    expect(Object.values(out).join(' ')).not.toContain(PREVIEW_TITLE)
  })

  it('붙어 있지 않아 병합할 수 없으면 「-」·공란이 아니라 참조 문구를 적는다', () => {
    const between = row({ state: 'NO_NEWS', candidates: [] })
    const [, , out] = toExcelRows([sp(), between, nq()])
    expect(out.newsSpan).toBe(1)
    expect(out.newsTitle).not.toBe('')
    expect(out.newsTitle).not.toBe(DASH)
    expect(out.newsTitle).toContain('S&P500')
    expect(out.newsUrl).toBeNull()
  })

  it('조회 실패 집계에도 들어가지 않는다', () => {
    expect(countNewsFailed([sp({ state: 'NEWS_FAILED', candidates: [] }), nq()])).toBe(1)
  })
})

describe('하이퍼링크 — 확정 기사에만', () => {
  it('SELECTED 행은 기사 URL 을 싣는다', () => {
    const [out] = toExcelRows([selectedRow()])
    expect(out.newsUrl).toBe('https://example.com/a')
  })

  it.each(['PENDING', 'NO_NEWS', 'OMITTED', 'NEWS_FAILED', 'STALE_SELECTION'] as const)(
    '%s 행은 URL 이 없다 — 링크가 아닌 칸이 링크처럼 보이면 안 된다',
    state => {
      const [out] = toExcelRows([row({ state, candidates: state === 'PENDING' ? [candidate()] : [] })])
      expect(out.newsUrl).toBeNull()
    },
  )
})
