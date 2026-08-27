export type Category = '국내사' | '해외사' | 'Index'
export type QuoteSource =
  | 'naver-stock'
  | 'naver-index'
  | 'krx-index'
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
