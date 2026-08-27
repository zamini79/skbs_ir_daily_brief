import { describe, it, expect } from 'vitest'
import { parseNaverSiseJson } from './yearOpen'

describe('parseNaverSiseJson', () => {
  const raw = `
 [['날짜', '시가', '고가', '저가', '종가', '거래량', '외국인소진율'],
["20260102", 1695000, 1709000, 1679000, 1683000, 46684, 12.62],
["20260105", 1673000, 1724000, 1671000, 1713000, 51390, 12.67]]`

  it('헤더를 건너뛰고 데이터 행만 읽는다', () => {
    const rows = parseNaverSiseJson(raw)
    expect(rows).toHaveLength(2)
  })
  it('시가와 종가를 구분해 읽는다', () => {
    const rows = parseNaverSiseJson(raw)
    expect(rows[0]).toEqual({ date: '20260102', open: 1695000, close: 1683000 })
  })
  it('소수를 가진 지수 행도 읽는다', () => {
    const rows = parseNaverSiseJson(`[["20260102", 4224.53, 4313.55, 4216.68, 4309.63, 406339, 0.0]]`)
    expect(rows[0].open).toBeCloseTo(4224.53, 2)
    expect(rows[0].close).toBeCloseTo(4309.63, 2)
  })
  it('데이터가 없으면 빈 배열을 준다', () => {
    expect(parseNaverSiseJson(`[['날짜','시가','고가','저가','종가']]`)).toEqual([])
  })
})
