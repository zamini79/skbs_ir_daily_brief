import { describe, it, expect } from 'vitest'
import { INSTRUMENTS } from './instruments'

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
  it('비미국 4종목은 MIC 접미사를 쓰지 않는다', () => {
    for (const i of INSTRUMENTS.filter(i => i.quoteSource === 'marketstack')) {
      expect(i.quoteSymbol).not.toMatch(/\.X[A-Z]{3}$/)
    }
  })
})
