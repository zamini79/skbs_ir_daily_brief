import { describe, it, expect } from 'vitest'
import { parseKoreanNumber, parseMarketValueToTrillion } from './naverParse'

describe('parseKoreanNumber', () => {
  it('천단위 쉼표를 없앤다', () => {
    expect(parseKoreanNumber('1,592,000')).toBe(1592000)
  })
  it('음수를 읽는다', () => {
    expect(parseKoreanNumber('-7,000')).toBe(-7000)
  })
  it('소수를 읽는다', () => {
    expect(parseKoreanNumber('7,675.70')).toBeCloseTo(7675.7, 4)
  })
  it('빈 값이면 NaN 을 준다', () => {
    expect(Number.isNaN(parseKoreanNumber(''))).toBe(true)
  })
})

describe('parseMarketValueToTrillion', () => {
  it('조와 억이 함께 있으면 합산한다', () => {
    expect(parseMarketValueToTrillion('73조 6,026억')).toBeCloseTo(73.6026, 6)
  })
  it('조만 있으면 그대로 읽는다', () => {
    expect(parseMarketValueToTrillion('44조')).toBeCloseTo(44, 6)
  })
  it('억만 있으면 1조 미만이 된다', () => {
    // 유바이오로직스처럼 소형주는 조 단위가 없다
    expect(parseMarketValueToTrillion('3,300억')).toBeCloseTo(0.33, 6)
  })
  it('읽을 수 없으면 NaN 을 준다', () => {
    expect(Number.isNaN(parseMarketValueToTrillion('N/A'))).toBe(true)
  })
})
