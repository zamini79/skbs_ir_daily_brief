import { describe, it, expect } from 'vitest'
import {
  WEEKDAY_LABELS,
  daysInMonth,
  isValidDateString,
  isValidMonthKey,
  monthGrid,
  monthKeyOf,
  monthRange,
  monthTitle,
  shiftMonth,
  weekdayLabelOf,
} from './calendar'

describe('isValidDateString', () => {
  it('정상 날짜를 받는다', () => {
    expect(isValidDateString('2026-08-28')).toBe(true)
    expect(isValidDateString('2024-02-29')).toBe(true) // 윤년
  })

  it('형식이 다르거나 존재하지 않는 날짜를 거른다', () => {
    expect(isValidDateString('2026-8-28')).toBe(false)
    expect(isValidDateString('2026-13-01')).toBe(false)
    expect(isValidDateString('2026-08-32')).toBe(false)
    expect(isValidDateString('2025-02-29')).toBe(false) // 평년
    expect(isValidDateString('오늘')).toBe(false)
    expect(isValidDateString('')).toBe(false)
  })
})

describe('isValidMonthKey', () => {
  it('YYYY-MM 만 받는다', () => {
    expect(isValidMonthKey('2026-08')).toBe(true)
    expect(isValidMonthKey('2026-12')).toBe(true)
    expect(isValidMonthKey('2026-00')).toBe(false)
    expect(isValidMonthKey('2026-13')).toBe(false)
    expect(isValidMonthKey('2026-08-01')).toBe(false)
    expect(isValidMonthKey('../etc')).toBe(false)
  })
})

describe('monthKeyOf', () => {
  it('날짜에서 월을 뽑는다', () => {
    expect(monthKeyOf('2026-08-28')).toBe('2026-08')
  })

  it('날짜가 아니면 null 이다 — 호출자가 폴백을 정하게 한다', () => {
    expect(monthKeyOf('2026-08')).toBeNull()
    expect(monthKeyOf('nope')).toBeNull()
  })
})

describe('daysInMonth', () => {
  it('월별 일수를 안다', () => {
    expect(daysInMonth(2026, 1)).toBe(31)
    expect(daysInMonth(2026, 2)).toBe(28)
    expect(daysInMonth(2024, 2)).toBe(29)
    expect(daysInMonth(2000, 2)).toBe(29) // 400년 예외
    expect(daysInMonth(1900, 2)).toBe(28) // 100년 예외
    expect(daysInMonth(2026, 4)).toBe(30)
    expect(daysInMonth(2026, 12)).toBe(31)
  })
})

describe('shiftMonth', () => {
  it('같은 해 안에서 움직인다', () => {
    expect(shiftMonth('2026-08', -1)).toBe('2026-07')
    expect(shiftMonth('2026-08', 1)).toBe('2026-09')
    expect(shiftMonth('2026-08', 0)).toBe('2026-08')
  })

  it('연 경계를 넘는다', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12')
    expect(shiftMonth('2026-12', 1)).toBe('2027-01')
    expect(shiftMonth('2026-01', -13)).toBe('2024-12')
    expect(shiftMonth('2026-12', 13)).toBe('2028-01')
  })
})

describe('monthTitle', () => {
  it('앞자리 0 을 떼고 한국어로 쓴다', () => {
    expect(monthTitle('2026-08')).toBe('2026년 8월')
    expect(monthTitle('2026-12')).toBe('2026년 12월')
  })
})

describe('monthRange', () => {
  it('월의 첫날과 마지막날을 준다', () => {
    expect(monthRange('2026-08')).toEqual({ first: '2026-08-01', last: '2026-08-31' })
    expect(monthRange('2026-02')).toEqual({ first: '2026-02-01', last: '2026-02-28' })
    expect(monthRange('2024-02')).toEqual({ first: '2024-02-01', last: '2024-02-29' })
  })
})

describe('monthGrid', () => {
  it('주는 항상 7칸이고 첫 칸은 일요일이다', () => {
    for (const key of ['2026-01', '2026-02', '2026-08', '2027-05']) {
      const weeks = monthGrid(key)
      expect(weeks.every(w => w.length === 7)).toBe(true)
    }
    expect(WEEKDAY_LABELS).toHaveLength(7)
    expect(WEEKDAY_LABELS[0]).toBe('일')
    expect(WEEKDAY_LABELS[6]).toBe('토')
  })

  it('2026-08 은 토요일에 시작하므로 앞에 빈 칸이 6개다', () => {
    const weeks = monthGrid('2026-08')
    const first = weeks[0]
    expect(first.slice(0, 6).every(c => c === null)).toBe(true)
    expect(first[6]).toMatchObject({ date: '2026-08-01', day: 1, weekend: true })
  })

  it('이번 달 날짜를 하나도 빠뜨리지 않고 순서대로 담는다', () => {
    const dates = monthGrid('2026-08')
      .flat()
      .filter(c => c !== null)
      .map(c => c.date)
    expect(dates).toHaveLength(31)
    expect(dates[0]).toBe('2026-08-01')
    expect(dates[30]).toBe('2026-08-31')
    expect([...dates].sort()).toEqual(dates)
  })

  it('이웃 달 날짜는 채우지 않는다 — 빈 칸이다', () => {
    const cells = monthGrid('2026-08').flat()
    expect(cells.every(c => c === null || c.date.startsWith('2026-08'))).toBe(true)
    // 마지막 주의 남는 칸도 9월이 아니라 null 이다.
    const last = monthGrid('2026-08').at(-1)!
    expect(last.filter(c => c === null).length).toBeGreaterThan(0)
  })

  it('주말만 weekend 다', () => {
    // 2026-08-01(토), 02(일), 08(토), 09(일) …
    const byDate = new Map(
      monthGrid('2026-08')
        .flat()
        .filter(c => c !== null)
        .map(c => [c.date, c.weekend]),
    )
    expect(byDate.get('2026-08-01')).toBe(true)
    expect(byDate.get('2026-08-02')).toBe(true)
    expect(byDate.get('2026-08-03')).toBe(false)
    expect(byDate.get('2026-08-07')).toBe(false)
    expect(byDate.get('2026-08-08')).toBe(true)
    expect(byDate.get('2026-08-28')).toBe(false) // 금요일
    expect(byDate.get('2026-08-30')).toBe(true) // 일요일
  })

  it('2월 1일이 일요일인 달은 빈 칸 없이 시작한다', () => {
    // 2026-02-01 은 일요일이다.
    const first = monthGrid('2026-02')[0]
    expect(first[0]).toMatchObject({ date: '2026-02-01', day: 1 })
  })

  it('잘못된 월 키에는 조용히 빈 달력을 주지 않고 던진다', () => {
    expect(() => monthGrid('2026-13')).toThrow()
    expect(() => monthGrid('nope')).toThrow()
  })
})

describe('weekdayLabelOf', () => {
  it('요일을 한 글자로 준다', () => {
    expect(weekdayLabelOf('2026-08-28')).toBe('금')
    expect(weekdayLabelOf('2026-08-29')).toBe('토')
    expect(weekdayLabelOf('2026-08-30')).toBe('일')
    expect(weekdayLabelOf('2026-08-31')).toBe('월')
  })

  it('monthGrid 의 weekend 판정과 어긋나지 않는다', () => {
    const cells = monthGrid('2026-08').flat().filter(c => c !== null)
    for (const c of cells) {
      const label = weekdayLabelOf(c.date)
      expect(c.weekend).toBe(label === '토' || label === '일')
    }
  })

  it('날짜가 아니면 던진다', () => {
    expect(() => weekdayLabelOf('2026-08')).toThrow()
  })
})
