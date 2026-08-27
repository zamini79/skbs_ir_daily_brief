import { describe, it, expect } from 'vitest'
import { formatPrice, formatPrevDiff } from './format'

describe('formatPrice', () => {
  it('국내 종목을 샘플처럼 만든다', () => {
    expect(formatPrice(37550, 'KRW', false)).toBe('KRW 37,550')
  })
  it('미국 종목은 소수 둘째 자리까지 만든다', () => {
    expect(formatPrice(28.57, 'USD', false)).toBe('USD 28.57')
  })
  it('런던 펜스는 표시상 그대로 둔다', () => {
    expect(formatPrice(1905.5, 'GBP', false)).toBe('GBP 1,905.5')
  })
  it('지수는 통화 없이 숫자만 만든다', () => {
    expect(formatPrice(7677.28, 'USD', true)).toBe('7,677.28')
  })
})

describe('formatPrevDiff', () => {
  it('상승은 ▲ 를 붙인다', () => {
    expect(formatPrevDiff(1597000, 1585000)).toBe('▲ 12,000')
  })
  it('하락은 ▼ 를 붙이고 절대값을 쓴다', () => {
    expect(formatPrevDiff(37550, 38300)).toBe('▼ 750')
  })
  it('보합(diff===0)은 0을 준다 — 값 없음(-)과 겹치면 안 된다', () => {
    expect(formatPrevDiff(100, 100)).toBe('0')
  })
  it('상승(diff>0)은 여전히 ▲ 를 준다', () => {
    expect(formatPrevDiff(101, 100)).toBe('▲ 1')
  })
  it('하락(diff<0)은 여전히 ▼ 를 준다', () => {
    expect(formatPrevDiff(99, 100)).toBe('▼ 1')
  })
  it('close 나 prevClose 가 없으면(시세를 못 구했으면) - 를 준다 — 보합(0)과 다른 문자열이어야 한다', () => {
    expect(formatPrevDiff(null, 100)).toBe('-')
    expect(formatPrevDiff(100, null)).toBe('-')
    expect(formatPrevDiff(null, null)).toBe('-')
  })
  it('소수 차이를 유지한다', () => {
    expect(formatPrevDiff(28.57, 27.97)).toBe('▲ 0.6')
  })
  it('Twelve Data 노이즈를 제거한다 (2소수 반올림)', () => {
    // Real API data: 153.10001 should display as 153.1, not 153.10001
    expect(formatPrice(153.10001, 'USD', false)).toBe('USD 153.1')
  })
  it('가격 차이도 2소수로 반올림한다', () => {
    expect(formatPrevDiff(153.10001, 156.45)).toBe('▼ 3.35')
  })
  it('후행 0을 제거한다', () => {
    // 28.30 should display as 28.3, not 28.30
    expect(formatPrice(28.30, 'USD', false)).toBe('USD 28.3')
  })
  it('샘플값이 여전히 정확하다', () => {
    expect(formatPrice(37550, 'KRW', false)).toBe('KRW 37,550')
    expect(formatPrice(28.57, 'USD', false)).toBe('USD 28.57')
    expect(formatPrice(1905.5, 'GBP', false)).toBe('GBP 1,905.5')
    expect(formatPrice(7677.28, 'USD', true)).toBe('7,677.28')
  })
})
