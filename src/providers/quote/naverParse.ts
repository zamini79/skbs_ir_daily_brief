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

/**
 * 네이버 `siseJson.naver` 일별 시세 파서.
 *
 * 응답은 헤더 행에 홑따옴표를 써서 **유효한 JSON 이 아니다.** 데이터 행만 정규식으로
 * 뽑는다. 행 형식(실측): `["20260828", 38300, 38950, 38000, 38950, 57833, 5.97]`
 * = 날짜·시가·고가·저가·종가·거래량·외국인소진율.
 *
 * **여기 있는 이유**: 연초 기준가(`ytdBase.ts`)와 매일 도는 국내 시세(`naver.ts`)가
 * 둘 다 이 엔드포인트를 읽는다. `ytdBase.ts` 에 두면 `naver.ts` 가 그것을 import 하고
 * `ytdBase.ts` 는 `index.ts` 를, `index.ts` 는 다시 `naver.ts` 를 import 해 순환이 된다.
 * 이 파일은 아무것도 import 하지 않는 네이버 전용 파싱 모듈이라 양쪽이 안전하게 쓴다.
 */
export function parseNaverSiseJson(raw: string): Array<{ date: string; open: number; close: number }> {
  const out: Array<{ date: string; open: number; close: number }> = []
  const re = /\["(\d{8})",\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    out.push({ date: m[1], open: Number(m[2]), close: Number(m[5]) })
  }
  return out
}
