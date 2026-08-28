/**
 * 달력 그리드 계산. **날짜 문자열 산수만** 한다 — DB 도 시간대도 모른다.
 *
 * 로컬 시간대의 `Date` 를 쓰지 않는다. `new Date('2026-08-01')` 은 UTC 자정으로
 * 파싱되고 `getDate()` 는 실행 머신의 시간대로 되돌려 읽으므로, KST 서버와 UTC
 * 서버(Vercel)에서 달력의 첫 칸이 하루씩 어긋난다. 여기서는 전부 `Date.UTC` 로
 * 만들고 `getUTC*` 로만 읽어 실행 환경과 무관하게 같은 결과를 낸다.
 * "오늘이 며칠인가"라는 시간대 질문은 이 모듈이 답하지 않는다 —
 * 호출자가 `kstDateString(new Date())` 로 구해서 넘긴다(domain/date.ts).
 */

/** 'YYYY-MM' */
export type MonthKey = string

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_RE = /^(\d{4})-(\d{2})$/

/** 일요일 시작. 그리드의 열 순서와 반드시 같아야 하므로 여기서 함께 정의한다. */
export const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토'] as const

export function isValidDateString(v: string): boolean {
  const m = DATE_RE.exec(v)
  if (!m) return false
  const [, y, mo, d] = m
  const year = Number(y)
  const month = Number(mo)
  const day = Number(d)
  if (month < 1 || month > 12) return false
  return day >= 1 && day <= daysInMonth(year, month)
}

export function isValidMonthKey(v: string): boolean {
  const m = MONTH_RE.exec(v)
  if (!m) return false
  const month = Number(m[2])
  return month >= 1 && month <= 12
}

/**
 * 월 키를 숫자로 쪼갠다. 형식이 틀리면 **던진다.**
 * 조용히 1월로 폴백하지 않는다 — 그러면 달력이 요청한 달이 아닌 달을 요청한 달인
 * 것처럼 그리게 되고, 그 화면은 "이 달에는 브리프가 없다"고 거짓으로 말한다.
 * 사용자 입력(URL 쿼리)은 화면에 닿기 전에 isValidMonthKey 로 걸러진다.
 */
function parseMonthKey(monthKey: MonthKey): { year: number; month: number } {
  if (!isValidMonthKey(monthKey)) throw new Error(`잘못된 월 키: ${monthKey}`)
  const m = MONTH_RE.exec(monthKey)!
  return { year: Number(m[1]), month: Number(m[2]) }
}

/** '2026-08-28' → '2026-08'. 날짜 형식이 아니면 null — 호출자가 폴백을 정한다. */
export function monthKeyOf(date: string): MonthKey | null {
  if (!isValidDateString(date)) return null
  return date.slice(0, 7)
}

export function daysInMonth(year: number, month: number): number {
  // 다음 달 0일 = 이번 달 마지막 날. UTC 로 계산해 시간대 영향을 받지 않는다.
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** 월 이동. 연 경계를 넘어간다(2026-01 에서 -1 → 2025-12). */
export function shiftMonth(monthKey: MonthKey, delta: number): MonthKey {
  const { year, month } = parseMonthKey(monthKey)
  const zero = year * 12 + (month - 1) + delta
  const ny = Math.floor(zero / 12)
  const nm = zero - ny * 12 + 1
  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}`
}

/** '2026-08' → '2026년 8월' */
export function monthTitle(monthKey: MonthKey): string {
  const { year, month } = parseMonthKey(monthKey)
  return `${year}년 ${month}월`
}

export type CalendarCell = {
  /** 'YYYY-MM-DD' */
  date: string
  day: number
  /** 토·일. 수집이 평일에만 돌기 때문에 화면에서 흐리게 둔다. */
  weekend: boolean
}

/**
 * 해당 월의 주 배열. 각 주는 일요일부터 7칸이고, 이번 달이 아닌 칸은 `null` 이다.
 *
 * 이웃 달 날짜를 회색으로 채우지 않는다. 이 달력의 유일한 용도가 "이 날짜에
 * 브리프가 있나"를 누르기 전에 알려주는 것인데, 이웃 달 칸까지 그리면 그 칸들의
 * 브리프 유무는 조회하지 않은 상태라 "없음"으로 보인다 — 화면이 모르는 것을
 * 아는 것처럼 말하게 된다. 빈 칸은 그런 주장을 하지 않는다.
 */
export function monthGrid(monthKey: MonthKey): (CalendarCell | null)[][] {
  const { year, month } = parseMonthKey(monthKey)

  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay() // 0=일
  const total = daysInMonth(year, month)

  const cells: (CalendarCell | null)[] = []
  for (let i = 0; i < firstWeekday; i++) cells.push(null)
  for (let day = 1; day <= total; day++) {
    const weekday = (firstWeekday + day - 1) % 7
    cells.push({
      date: `${monthKey}-${String(day).padStart(2, '0')}`,
      day,
      weekend: weekday === 0 || weekday === 6,
    })
  }
  while (cells.length % 7 !== 0) cells.push(null)

  const weeks: (CalendarCell | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}

/** 월의 첫날/마지막날. DB 를 월 단위로 조회할 때 쓴다. */
export function monthRange(monthKey: MonthKey): { first: string; last: string } {
  const { year, month } = parseMonthKey(monthKey)
  return {
    first: `${monthKey}-01`,
    last: `${monthKey}-${String(daysInMonth(year, month)).padStart(2, '0')}`,
  }
}

/** '2026-08-28' → '금'. 시간대 영향을 받지 않도록 UTC 로만 계산한다. */
export function weekdayLabelOf(date: string): string {
  if (!isValidDateString(date)) throw new Error(`잘못된 날짜: ${date}`)
  const m = DATE_RE.exec(date)!
  const wd = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay()
  return WEEKDAY_LABELS[wd]
}
