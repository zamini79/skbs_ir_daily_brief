/** 부동소수 오차를 없애고 유효 소수만 남긴다. 1905.5 -> "1,905.5" */
function numberToDisplay(n: number): string {
  const rounded = Math.round(n * 100) / 100
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

export function formatPrice(close: number, currency: string, isIndex: boolean): string {
  if (isIndex) return numberToDisplay(close)
  return `${currency} ${numberToDisplay(close)}`
}

/**
 * close/prevClose가 없으면(시세 자체를 못 구했으면) '-' 를 준다 — 표의 다른 칸(연초대비,
 * 시가총액)이 이미 값 없음을 '-' 로 표시하는 것과 맞춘다.
 * 보합(diff === 0)은 '-' 와 겹치면 안 된다 — 둘 다 '-' 를 쓰면 "값이 0이다"와
 * "값을 모른다"가 화면에서 구분이 안 된다. 그래서 보합은 '0'을 준다(옆 % 칸이 0.00%로
 * 진짜 0을 보여주는 것과 같은 방식).
 */
export function formatPrevDiff(close: number | null, prevClose: number | null): string {
  if (close === null || prevClose === null) return '-'
  const diff = Math.round((close - prevClose) * 100) / 100
  if (diff === 0) return '0'
  const mark = diff > 0 ? '▲' : '▼'
  return `${mark} ${numberToDisplay(Math.abs(diff))}`
}
