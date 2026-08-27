import { describe, it, expect } from 'vitest'
import { INSTRUMENTS } from './instruments'
import { KRX_IDX_NM_KOSPI200_HEALTHCARE } from '@/providers/quote/krx'

describe('INSTRUMENTS', () => {
  it('23행이다', () => {
    expect(INSTRUMENTS).toHaveLength(23)
  })
  it('구분별 개수가 샘플과 같다', () => {
    const count = (c: string) => INSTRUMENTS.filter(i => i.category === c).length
    expect(count('국내사')).toBe(10)
    expect(count('해외사')).toBe(9)
    expect(count('Index')).toBe(4)
  })
  it('displayOrder 가 1..23 중복 없이 채워진다', () => {
    const orders = INSTRUMENTS.map(i => i.displayOrder).sort((a, b) => a - b)
    expect(orders).toEqual(Array.from({ length: 23 }, (_, i) => i + 1))
  })
  it('GSK 만 펜스 보정을 갖는다', () => {
    const divisors = INSTRUMENTS.filter(i => (i.priceDivisorForMarketCap ?? 1) !== 1)
    expect(divisors.map(i => i.name)).toEqual(['GSK'])
    expect(divisors[0].priceDivisorForMarketCap).toBe(100)
  })
  it('국내 종목코드는 6자리 숫자다', () => {
    for (const i of INSTRUMENTS.filter(i => i.quoteSource === 'naver-stock')) {
      expect(i.quoteSymbol).toMatch(/^\d{6}$/)
    }
  })
  it('코스피200 헬스케어는 KRX 자동 수집이고 quoteSymbol 이 KRX 표기와 정확히 같다', () => {
    // 표기가 두 가지다. 우리 name 은 원본 브리프 엑셀을 따른 '코스피200 헬스케어'(공백
    // 없음)이고, KRX 응답의 IDX_NM 은 '코스피 200 헬스케어'(공백 있음)다. quoteSymbol 은
    // **KRX 쪽 표기**여야 한다 — name 을 그대로 넣으면 51행 중 아무것도 안 걸린다.
    const hc = INSTRUMENTS.find(i => i.name === '코스피200 헬스케어')
    expect(hc).toBeDefined()
    expect(hc!.quoteSource).toBe('krx-index')
    expect(hc!.quoteSymbol).toBe(KRX_IDX_NM_KOSPI200_HEALTHCARE)
    expect(hc!.quoteSymbol).not.toBe(hc!.name)
    expect(hc!.isIndex).toBe(true)
  })

  it('수기 입력에 의존하는 종목은 더 이상 없다', () => {
    // 'manual' 경로 자체는 남겨 뒀지만(검수 화면의 수기 입력), 이제 쓰는 종목은 없다.
    expect(INSTRUMENTS.filter(i => i.quoteSource === 'manual')).toEqual([])
  })

  it('비미국 4종목은 MIC 접미사를 쓰지 않는다', () => {
    for (const i of INSTRUMENTS.filter(i => i.quoteSource === 'marketstack')) {
      expect(i.quoteSymbol).not.toMatch(/\.X[A-Z]{3}$/)
    }
  })
})

describe('newsAliases 일관성', () => {
  // 지수는 종종 좁은 자기 이름으로는 기사가 거의 안 잡혀 넓은 시황 검색어로 기사 풀을
  // 넓힌 뒤 별칭으로 좁힌다. 실측(2026-08-27)으로 확인됨: '뉴욕증시' 검색 결과 100건을
  // S&P500 별칭으로 필터링하면 실제로 관련 기사가 남는다 — 별칭이 검색어 자체를
  // 포함하지 않아도 정상 동작이다. Task 15 fix round 2 리뷰에서 확인된 유일한 예외.
  const DOCUMENTED_BROAD_QUERY_EXCEPTIONS = new Set(['S&P500'])

  it('모든 종목의 newsAliases는 비어있지 않다', () => {
    for (const i of INSTRUMENTS) {
      expect(i.newsAliases?.trim().length ?? 0, i.name).toBeGreaterThan(0)
    }
  })

  it('newsAliases는 newsQuery를 포함한다(문서화된 예외 제외) — Vaxcyte류 오타 재발을 막는다', () => {
    for (const i of INSTRUMENTS) {
      if (DOCUMENTED_BROAD_QUERY_EXCEPTIONS.has(i.name)) continue
      expect(i.newsAliases, i.name).toContain(i.newsQuery)
    }
  })
})
