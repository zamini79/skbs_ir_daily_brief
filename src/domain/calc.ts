/**
 * 전일대비 변동률. 기준(전일 종가)이 0 이면 **계산할 수 없으므로 null** 이다.
 *
 * 0 을 돌려주면 화면에 `0.00%` 로 찍혀 **진짜 보합과 구분되지 않는다** — format.ts 가
 * 보합(`0`)과 값 없음(`-`)을 애써 갈라 둔 원칙과 정면으로 어긋난다. 발생 조건이
 * 좁다는 것은(전일 종가 0) 이유가 되지 않는다. 드물게 일어나면서 조용히 틀리는 값이
 * 오히려 알아채기 어렵다.
 */
export function changePct(close: number, prevClose: number): number | null {
  if (!prevClose) return null
  return (close - prevClose) / prevClose
}

/** 기준가는 전년도 마지막 거래일의 종가다 — 당해 첫 거래일 시가가 아니다 (스펙 §3.5).
 * 기준가가 0 이면 changePct 와 같은 이유로 null 이다(0% 로 찍혀 보합처럼 보이면 안 된다). */
export function ytdPct(close: number, ytdBase: number): number | null {
  if (!ytdBase) return null
  return (close - ytdBase) / ytdBase
}

export function marketCapKrwTrillion(args: {
  close: number
  shares: number | null
  fxToKrw: number
  /** 런던 펜스 호가 보정. GSK=100, 그 외=1 */
  priceDivisor: number
}): number | null {
  const { close, shares, fxToKrw, priceDivisor } = args
  if (shares === null || shares <= 0) return null
  const unitPrice = close / priceDivisor
  return (unitPrice * shares * fxToKrw) / 1e12
}
