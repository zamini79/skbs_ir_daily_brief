export function changePct(close: number, prevClose: number): number {
  if (!prevClose) return 0
  return (close - prevClose) / prevClose
}

/** 기준가는 전년도 마지막 거래일의 종가다 — 당해 첫 거래일 시가가 아니다 (스펙 §3.5). */
export function ytdPct(close: number, ytdBase: number): number {
  if (!ytdBase) return 0
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
