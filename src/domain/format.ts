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
 * 시가총액(조원)을 소수 둘째 자리까지 고정해서 보여준다.
 * null이면(코스피200 헬스케어처럼 지수라 시가총액 개념이 없거나, 계산에 필요한 값이
 * 없으면) '-' 를 준다. 0은 이론상 나올 일이 거의 없지만, formatPrevDiff에서 보합(0)과
 * 값 없음(-)을 구분한 것과 같은 원칙으로 여기서도 구분돼야 한다 — toFixed(2)는 0을
 * '0.00'으로 그대로 보여주므로 별도 분기 없이 이미 '-'와 다르다.
 * 쉼표(천단위 구분)는 넣지 않는다 — 조원 단위라 이 표에 실제로 나오는 값(가장 큰
 * 값이 500대)이 네 자리(1,000 이상)에 이를 일이 거의 없고, 이 칸은 원래도 쉼표 없이
 * 표시돼 있었다. 소수 자릿수 요청과 쉼표 삽입은 별개의 변경이라 여기서 같이 묶지 않는다.
 */
export function formatMarketCap(v: number | null): string {
  if (v === null) return '-'
  return v.toFixed(2)
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
