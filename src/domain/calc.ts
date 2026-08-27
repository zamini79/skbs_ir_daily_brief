export function changePct(close: number, prevClose: number): number {
  if (!prevClose) return 0
  return (close - prevClose) / prevClose
}

export function ytdPct(close: number, yearOpen: number): number {
  if (!yearOpen) return 0
  return (close - yearOpen) / yearOpen
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
