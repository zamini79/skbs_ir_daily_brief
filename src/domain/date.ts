const KST = 'Asia/Seoul'

/** Asia/Seoul 기준 YYYY-MM-DD */
export function kstDateString(d: Date): string {
  // en-CA 로케일은 YYYY-MM-DD 를 준다.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: KST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

/** 뉴스 검색 범위: KST 기준 당일과 전일 */
export function kstTodayAndYesterday(now: Date): { today: string; yesterday: string } {
  const today = kstDateString(now)
  const yesterday = kstDateString(new Date(now.getTime() - 24 * 60 * 60 * 1000))
  return { today, yesterday }
}
