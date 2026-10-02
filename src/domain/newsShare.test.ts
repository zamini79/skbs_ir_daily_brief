import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { INSTRUMENTS } from '../../prisma/instruments'
import { NEWS_SHARED_WITH, newsCellSpans, newsGroupEnd, newsOwnerSymbol, ownsNews } from './newsShare'
import {
  EXCEL_NEWS_SUMMARY_FONT,
  EXCEL_NEWS_TITLE_FONT,
  NEWS_SUMMARY_STYLE,
  NEWS_TITLE_STYLE,
} from './newsStyle'

const rows = (...symbols: string[]) => symbols.map(quoteSymbol => ({ quoteSymbol }))

describe('뉴스 칸 공유 표', () => {
  it('Nasdaq(.IXIC) 은 S&P500(.INX) 의 칸을 쓴다', () => {
    expect(NEWS_SHARED_WITH).toEqual({ '.IXIC': '.INX' })
    expect(newsOwnerSymbol('.IXIC')).toBe('.INX')
    expect(ownsNews('.IXIC')).toBe(false)
    expect(ownsNews('.INX')).toBe(true)
    expect(ownsNews('KOSPI')).toBe(true)
  })

  it('표의 키와 값이 실제 시드 종목이고, 시드 순서상 소유 행 바로 아래에 있다', () => {
    // 이게 깨지면(심볼 오타·순서 변경) 병합이 조용히 풀리거나 남의 행을 덮는다.
    const ordered = [...INSTRUMENTS].sort((a, b) => a.displayOrder - b.displayOrder)
    for (const [covered, owner] of Object.entries(NEWS_SHARED_WITH)) {
      const ci = ordered.findIndex(i => i.quoteSymbol === covered)
      const oi = ordered.findIndex(i => i.quoteSymbol === owner)
      expect(ci, covered).toBeGreaterThan(-1)
      expect(oi, owner).toBeGreaterThan(-1)
      expect(ci).toBe(oi + 1)
      expect(ordered[ci].category).toBe(ordered[oi].category)
    }
  })
})

describe('newsCellSpans', () => {
  it('실제 시드 순서에서 S&P500 이 2행을 덮고 Nasdaq 은 0 이다', () => {
    const ordered = [...INSTRUMENTS].sort((a, b) => a.displayOrder - b.displayOrder)
    const spans = newsCellSpans(ordered)
    const at = (sym: string) => spans[ordered.findIndex(i => i.quoteSymbol === sym)]
    expect(at('.INX')).toBe(2)
    expect(at('.IXIC')).toBe(0)
    expect(at('KOSPI')).toBe(1)
    // 나머지는 전부 1 — 표 전체에서 덮인 칸은 하나뿐이다.
    expect(spans.filter(s => s !== 1)).toEqual([2, 0])
  })

  it('공유 행이 소유 행 바로 아래가 아니면 병합하지 않는다', () => {
    expect(newsCellSpans(rows('.INX', 'KOSPI', '.IXIC'))).toEqual([1, 1, 1])
    expect(newsCellSpans(rows('.IXIC', '.INX'))).toEqual([1, 1])
    // 소유 행이 아예 없어도 1 이다(호출부가 참조 문구를 적는다).
    expect(newsCellSpans(rows('.IXIC'))).toEqual([1])
  })

  it('공유가 없는 표는 전부 1 이다', () => {
    expect(newsCellSpans(rows('A', 'B', 'C'))).toEqual([1, 1, 1])
  })
})

describe('newsGroupEnd — 펼침 패널을 묶음 뒤에 그리는 자리', () => {
  const spans = [1, 2, 0, 1]
  it('소유 행을 열어도, 덮인 행을 열어도 묶음의 마지막 행 뒤다', () => {
    expect(newsGroupEnd(spans, 1)).toBe(2)
    expect(newsGroupEnd(spans, 2)).toBe(2)
  })
  it('묶이지 않은 행은 자기 자신이다', () => {
    expect(newsGroupEnd(spans, 0)).toBe(0)
    expect(newsGroupEnd(spans, 3)).toBe(3)
  })
})

describe('뉴스 칸 서식 (2026-10-02 담당자 피드백)', () => {
  it('제목: #0563C1 · 굵게 · 항상 밑줄 · 맑은 고딕 10pt · 기울임 없음', () => {
    expect(NEWS_TITLE_STYLE).toMatchObject({
      color: '#0563C1',
      fontWeight: 700,
      textDecoration: 'underline',
      fontStyle: 'normal',
      fontSize: '10pt',
    })
    expect(NEWS_TITLE_STYLE.fontFamily).toContain('Malgun Gothic')
    expect(NEWS_TITLE_STYLE.fontFamily).toContain('맑은 고딕')
  })

  it('요약: #000000 · 굵게 아님 · 맑은 고딕 10pt · 기울임 없음', () => {
    expect(NEWS_SUMMARY_STYLE).toMatchObject({
      color: '#000000',
      fontWeight: 400,
      fontStyle: 'normal',
      fontSize: '10pt',
    })
    expect(NEWS_SUMMARY_STYLE.fontFamily).toBe(NEWS_TITLE_STYLE.fontFamily)
  })

  it('엑셀 글꼴도 같은 값이다', () => {
    expect(EXCEL_NEWS_TITLE_FONT).toEqual({
      name: 'Malgun Gothic',
      size: 10,
      bold: true,
      italic: false,
      underline: true,
      color: { argb: 'FF0563C1' },
    })
    expect(EXCEL_NEWS_SUMMARY_FONT).toEqual({
      name: 'Malgun Gothic',
      size: 10,
      bold: false,
      italic: false,
      color: { argb: 'FF000000' },
    })
  })

  it('검수 화면의 뉴스 칸·패널은 기울임 클래스를 쓰지 않고 제목·요약에 인라인 style 을 건다', () => {
    // 컴포넌트를 렌더하는 테스트 환경이 없어 소스를 직접 본다. 이탤릭이 되돌아오거나
    // 인라인 style 이 클래스로 바뀌면(복사→Outlook 에서 서식이 빠진다) 여기서 걸린다.
    for (const f of ['BriefTable.tsx', 'RowPanel.tsx']) {
      const src = readFileSync(join(__dirname, '../app/review/[date]', f), 'utf8')
      expect(src, f).not.toMatch(/\bitalic\b/)
      expect(src, f).toContain('style={NEWS_TITLE_STYLE}')
      expect(src, f).toContain('style={NEWS_SUMMARY_STYLE}')
    }
  })
})
