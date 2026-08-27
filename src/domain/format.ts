/** 부동소수 오차를 없애고 유효 소수만 남긴다. 1905.5 -> "1,905.5" */
function numberToDisplay(n: number): string {
  const rounded = Math.round(n * 100) / 100
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

export function formatPrice(close: number, currency: string, isIndex: boolean): string {
  if (isIndex) return numberToDisplay(close)
  return `${currency} ${numberToDisplay(close)}`
}

export function formatPrevDiff(close: number, prevClose: number): string {
  const diff = Math.round((close - prevClose) * 100) / 100
  if (diff === 0) return '-'
  const mark = diff > 0 ? '▲' : '▼'
  return `${mark} ${numberToDisplay(Math.abs(diff))}`
}
