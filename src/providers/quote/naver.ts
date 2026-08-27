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

/**
 * 해외 개별주(홍콩 2269.HK — Wuxi). marketstack 에서 옮겨 왔다.
 *
 * **왜 별도 파일이 아니라 여기인가**(Task 31 판단 근거): 응답이 국내 종목과 다른 구조가
 * 아니라 **같은 계열**이다 — 숫자가 전부 문자열이고, `closePrice`·
 * `compareToPreviousClosePrice`·`localTradedAt` 키가 위 국내 지수 경로와 그대로 같으며,
 * 호스트도 이미 이 파일이 쓰는 `api.stock.naver.com` 이다. 별도 파일로 빼면 `HEADERS`·
 * `getJson`(StockConflict 판정 포함)·`asOfFrom` 을 복제하거나 import 로 되가져와야 하고,
 * 네이버가 스키마를 바꿀 때 고쳐야 할 자리가 두 곳으로 늘어난다. 한 벤더 = 한 파일이
 * 스펙 §4 의 "소스가 바뀌어도 providers/ 하위 파일 하나만 교체한다"에 더 맞는다.
 *
 * **경로는 `/stock/{code}/basic` 이고 지수 경로(`/index/...`)와 다르다.**
 *
 * 심볼 주의(실측 2026-08-28):
 *   - `GSK.L`·`SAN.PA`·`LONN.SW` 는 네이버에 없다 — HTTP 409 `Not Exist Master`.
 *   - 접미사 없는 `GSK`·`SAN` 은 **미국 ADR 이라 값이 다르다. 쓰면 안 된다.**
 *
 * `fluctuationsRatio`(네이버가 준 등락률)는 일부러 쓰지 않는다 — 전 종목을
 * `domain/calc.ts` 의 `changePct` 로 계산한다(krx.ts 가 `FLUC_RT` 를 안 쓰는 것과
 * 같은 이유). 전일 종가는 `closePrice - compareToPreviousClosePrice` 로 구한다.
 *
 * 통화는 응답(`currencyType.code`)에서 받는다. 시드값을 provider 안에 하드코딩하면
 * `collectHelpers.currencyMismatchReason` 이 자기 자신을 검사하게 되어 무력해진다.
 */
export async function fetchNaverWorldStock(code: string): Promise<RawQuote> {
  const j = await getJson(`https://api.stock.naver.com/stock/${code}/basic`, code)

  const close = parseKoreanNumber(j.closePrice)
  const diff = parseKoreanNumber(j.compareToPreviousClosePrice)
  if (!Number.isFinite(close)) throw new QuoteError(code, `closePrice 파싱 실패: ${j.closePrice}`)
  if (!Number.isFinite(diff)) {
    throw new QuoteError(code, `compareToPreviousClosePrice 파싱 실패: ${j.compareToPreviousClosePrice}`)
  }

  const currency = typeof j.currencyType?.code === 'string' ? j.currencyType.code.trim() : ''
  if (currency === '') throw new QuoteError(code, 'currencyType.code 없음')

  // `localTradedAt` 은 현지 시각이다("2026-08-27T16:00:00+08:00"). 앞 10자를 문자열
  // 그대로 쓴다 — `new Date()` 로 파싱하면 `+08:00` 이 KST 로 옮겨지며 날짜가 밀린다.
  // (ytdBase.ts 의 naverIndexYtdBase 가 같은 이유로 문자열을 그대로 읽는다.)
  const asOf = asOfFrom(j.localTradedAt)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new QuoteError(code, `localTradedAt 파싱 실패: ${j.localTradedAt}`)
  }

  return { close, prevClose: close - diff, currency, asOf }
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
