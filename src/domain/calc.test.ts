import { describe, it, expect } from 'vitest'
import { changePct, ytdPct, marketCapKrwTrillion } from './calc'

describe('changePct', () => {
  it('샘플의 SK바이오사이언스를 재현한다', () => {
    // 37,550 / 전일 38,300 => -0.0196
    expect(changePct(37550, 38300)).toBeCloseTo(-0.0196, 4)
  })
  it('전일가가 0이면 0을 준다', () => {
    expect(changePct(100, 0)).toBe(0)
  })
})

describe('ytdPct', () => {
  it('연초 대비 상승을 계산한다', () => {
    expect(ytdPct(110, 100)).toBeCloseTo(0.1, 6)
  })
  it('연초가가 0이면 0을 준다', () => {
    expect(ytdPct(110, 0)).toBe(0)
  })
})

describe('marketCapKrwTrillion', () => {
  it('원화 종목은 환율 1로 조원을 만든다', () => {
    // 1,585,000원 * 46,290,000주 = 73.4조
    const v = marketCapKrwTrillion({
      close: 1_585_000, shares: 46_290_000, fxToKrw: 1, priceDivisor: 1,
    })
    expect(v).toBeCloseTo(73.37, 1)
  })

  it('런던 펜스 종목은 100으로 나눈다', () => {
    // GSK 1,890.5 GBX = £18.905, 40억주, GBP/KRW 1885.7
    const v = marketCapKrwTrillion({
      close: 1890.5, shares: 4_000_000_000, fxToKrw: 1885.7, priceDivisor: 100,
    })
    expect(v).toBeGreaterThan(130)
    expect(v).toBeLessThan(155)
  })

  it('보정을 빠뜨리면 100배가 된다는 것을 고정한다', () => {
    const wrong = marketCapKrwTrillion({
      close: 1890.5, shares: 4_000_000_000, fxToKrw: 1885.7, priceDivisor: 1,
    })
    const right = marketCapKrwTrillion({
      close: 1890.5, shares: 4_000_000_000, fxToKrw: 1885.7, priceDivisor: 100,
    })
    expect(wrong / right).toBeCloseTo(100, 6)
  })

  it('주식수가 없으면 null 을 준다', () => {
    const v = marketCapKrwTrillion({
      close: 100, shares: null, fxToKrw: 1, priceDivisor: 1,
    })
    expect(v).toBeNull()
  })
})
