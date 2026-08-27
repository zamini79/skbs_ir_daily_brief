export type Category = '국내사' | '해외사' | 'Index'
export type QuoteSource = 'naver-stock' | 'naver-index' | 'twelvedata' | 'marketstack' | 'manual'
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
