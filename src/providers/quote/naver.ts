import type { RawQuote } from '@/domain/types'
import { QuoteError } from './types'
import { parseKoreanNumber, parseMarketValueToTrillion } from './naverParse'

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  Referer: 'https://m.stock.naver.com/',
}

async function getJson(url: string, symbol: string): Promise<any> {
  const res = await fetch(url, { headers: HEADERS })
  if (!res.ok) throw new QuoteError(symbol, `HTTP ${res.status}`)
  const json = await res.json()
  if (json?.code === 'StockConflict') throw new QuoteError(symbol, json.message ?? 'StockConflict')
  return json
}

/** localTradedAt("2026-08-26T16:39:23-04:00") 에서 날짜만 뽑는다 */
function asOfFrom(localTradedAt: string | undefined): string {
  if (!localTradedAt) return ''
  return localTradedAt.slice(0, 10)
}

/**
 * 국내 개별주. /basic 과 /integration 을 합친다.
 * /basic 에는 시총이 없고 /integration 에는 현재가가 없다.
 */
export async function fetchNaverStock(code: string): Promise<RawQuote> {
  const [basic, integration] = await Promise.all([
    getJson(`https://m.stock.naver.com/api/stock/${code}/basic`, code),
    getJson(`https://m.stock.naver.com/api/stock/${code}/integration`, code),
  ])

  const close = parseKoreanNumber(basic.closePrice)
  if (Number.isNaN(close)) throw new QuoteError(code, 'closePrice 없음')

  const infos: Array<{ code: string; value: string }> = integration.totalInfos ?? []
  const lastClose = infos.find(i => i.code === 'lastClosePrice')?.value
  const marketValue = infos.find(i => i.code === 'marketValue')?.value

  const prevClose = parseKoreanNumber(lastClose ?? '')
  if (Number.isNaN(prevClose)) throw new QuoteError(code, 'lastClosePrice 없음')

  const cap = marketValue ? parseMarketValueToTrillion(marketValue) : NaN

  return {
    close,
    prevClose,
    currency: 'KRW',
    asOf: asOfFrom(basic.localTradedAt),
    marketCapKrwTrillion: Number.isNaN(cap) ? undefined : cap,
  }
}

/** 국내 지수(KOSPI). 전일 종가는 현재가에서 전일대비를 빼서 얻는다. */
export async function fetchNaverDomesticIndex(code: string): Promise<RawQuote> {
  const j = await getJson(`https://m.stock.naver.com/api/index/${code}/basic`, code)
  const close = parseKoreanNumber(j.closePrice)
  const diff = parseKoreanNumber(j.compareToPreviousClosePrice)
  if (Number.isNaN(close) || Number.isNaN(diff)) throw new QuoteError(code, '지수 시세 파싱 실패')
  return {
    close,
    prevClose: close - diff,
    currency: 'KRW',
    asOf: asOfFrom(j.localTradedAt),
  }
}

/** 해외 지수(.INX/.IXIC). stockItemTotalInfos 안에 전일 종가가 있다. */
export async function fetchNaverWorldIndex(code: string): Promise<RawQuote> {
  const j = await getJson(`https://api.stock.naver.com/index/${code}/basic`, code)
  const close = parseKoreanNumber(j.closePrice)
  if (Number.isNaN(close)) throw new QuoteError(code, 'closePrice 없음')

  const infos: Array<{ code: string; value: string }> = j.stockItemTotalInfos ?? []
  const lastClose = parseKoreanNumber(infos.find(i => i.code === 'lastClosePrice')?.value ?? '')
  const diff = parseKoreanNumber(j.compareToPreviousClosePrice)
  const prevClose = Number.isNaN(lastClose) ? close - diff : lastClose
  if (Number.isNaN(prevClose)) throw new QuoteError(code, '전일 종가 파싱 실패')

  return {
    close,
    prevClose,
    currency: 'USD',
    asOf: asOfFrom(j.localTradedAt),
  }
}
