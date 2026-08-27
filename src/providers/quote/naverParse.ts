export function parseKoreanNumber(s: string): number {
  if (!s) return NaN
  return Number(s.replace(/,/g, '').trim())
}

/** "73조 6,026억" -> 73.6026 (단위: 조원) */
export function parseMarketValueToTrillion(s: string): number {
  if (!s) return NaN
  const jo = s.match(/([\d,]+)\s*조/)
  const eok = s.match(/([\d,]+)\s*억/)
  if (!jo && !eok) return NaN
  const joVal = jo ? parseKoreanNumber(jo[1]) : 0
  const eokVal = eok ? parseKoreanNumber(eok[1]) : 0
  // 1조 = 10,000억
  return joVal + eokVal / 10_000
}
