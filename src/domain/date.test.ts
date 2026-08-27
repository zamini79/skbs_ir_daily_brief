import { describe, it, expect } from 'vitest'
import { kstDateString, kstTodayAndYesterday } from './date'

describe('kstDateString', () => {
  it('UTC 자정 직후를 KST 같은 날로 넘긴다', () => {
    // 2026-08-26T22:40Z = KST 2026-08-27 07:40 (수집 시각)
    expect(kstDateString(new Date('2026-08-26T22:40:00Z'))).toBe('2026-08-27')
  })
  it('UTC 오전을 KST 같은 날로 본다', () => {
    expect(kstDateString(new Date('2026-08-27T03:00:00Z'))).toBe('2026-08-27')
  })
})

describe('kstTodayAndYesterday', () => {
  it('당일과 전일을 준다', () => {
    const r = kstTodayAndYesterday(new Date('2026-08-26T22:40:00Z'))
    expect(r).toEqual({ today: '2026-08-27', yesterday: '2026-08-26' })
  })
  it('월초 경계를 넘긴다', () => {
    const r = kstTodayAndYesterday(new Date('2026-08-31T22:40:00Z'))
    expect(r).toEqual({ today: '2026-09-01', yesterday: '2026-08-31' })
  })
})
