export type Category = '국내사' | '해외사' | 'Index'
export type QuoteSource =
  | 'naver-stock'
  /** 해외 개별주(홍콩 2269.HK). 국내주와 응답 계열이 같아 naver.ts 가 함께 다룬다. */
  | 'naver-world-stock'
  | 'naver-index'
  | 'krx-index'
  /** 런던증권거래소 공식 엔드포인트. 키 없음. 연초 기준가는 여전히 marketstack. */
  | 'lse'
  /** SIX Swiss Exchange 공식 엔드포인트. 키 없음. 연초 기준가는 여전히 marketstack. */
  | 'six'
  /**
   * FT(markets.ft.com) HTML 스크래핑. **2차(폴백) 전용이다** — 비미국 4종목의
   * 1차가 실패한 날에만 부른다. 1차로 쓰지 마라(src/providers/quote/ft.ts).
   */
  | 'ft'
  | 'twelvedata'
  | 'marketstack'
  /** 지금 쓰는 종목은 없다. 검수 화면의 수기 입력 경로를 위해 남겨 둔다. */
  | 'manual'
export type Decision = 'PENDING' | 'SELECTED' | 'OMITTED'

export type RawQuote = {
  close: number
  prevClose: number
  currency: string
  /** 소스가 알려준 시세 기준일 YYYY-MM-DD. 소스마다 다를 수 있다. */
  asOf: string
  /** 소스가 시총을 직접 준 경우에만 채운다(네이버 국내주식). 단위: 조원 */
  marketCapKrwTrillion?: number
}
