import type { RawQuote } from '@/domain/types'
import { QuoteError } from './types'

/**
 * 런던증권거래소(LSE) 공식 화면이 쓰는 종목 상세 엔드포인트. GSK 전용으로 들어왔다.
 *
 * **왜 marketstack 에서 옮겼나**: marketstack 무료 플랜은 호출 수가 아니라 **심볼 수**로
 * 센다. 비미국 4종목을 한 요청에 묶어도 4회가 빠져나가 월 88회였고 한도가 100이라
 * 마진이 사흘치뿐이었다 — 2026-08-27 에 실제로 소진됐다(운영.md §2.6). 매일 도는
 * 시세만 무료 거래소 엔드포인트로 옮기고 연 1회짜리 연초 기준가는 marketstack 에
 * 남긴다. 라우팅은 ytdBase.ts 의 MARKETSTACK_YTD_SUFFIX 참고.
 *
 * 키가 필요 없다. **문서화된 공개 API 가 아니라 LSE 자기 화면이 쓰는 엔드포인트다** —
 * 네이버 비공개 엔드포인트와 같은 성격의 의존이고 같은 리스크를 진다(스펙 §13 리스크 4).
 * 깨지면 이 파일 하나만 고친다.
 */
const BASE = 'https://api.londonstockexchange.com/api/gw/lse/instruments/alldata'

/** 사유 문구가 DB(QuoteSnapshot.errorMessage)와 화면에 실린다. 본문을 통째로 싣지 않는다. */
const MAX_ERROR_DETAIL_CHARS = 200

/**
 * 일반 브라우저 User-Agent. 실측(2026-08-28)으로는 `curl/8` 로도 200 이 왔지만,
 * 자기 화면용 엔드포인트라 언제든 걸러질 수 있으므로 화면과 같은 모양으로 부른다.
 */
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  Accept: 'application/json',
}

/** 실제로 읽는 필드만 적는다. 응답에는 60개 넘는 필드가 함께 온다. */
type LseInstrument = {
  currency?: unknown
  lastclose?: unknown
  netchange?: unknown
  lastclosedate?: unknown
}

/**
 * 숫자만 받는다. **문자열로 바뀌어 와도 받아 준다** — 실측 응답은 JSON 숫자지만
 * (`lastclose: 1852`), 이 엔드포인트는 같은 응답 안에서 `openingprice` 를
 * `1.89E+3` 로 주는 등 표기가 일정하지 않다. 빈 문자열·null·undefined 는
 * `Number()` 가 0 이나 NaN 으로 둔갑시키므로 명시적으로 NaN 을 돌려준다.
 */
function toNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw)
  return NaN
}

/** 실패 본문에서 사람이 읽을 사유만 꺼낸다. 이 엔드포인트에는 자격증명이 없다. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown }
    const msg = body?.message
    if (typeof msg !== 'string' || msg.trim() === '') return ''
    return ` (${msg.slice(0, MAX_ERROR_DETAIL_CHARS)})`
  } catch {
    return ''
  }
}

/**
 * LSE 종목 시세. `tidm` 은 거래소 티커다(GSK). **marketstack 표기(`GSK.L`)가 아니다.**
 *
 * **전일 종가를 응답에서 그대로 받지 않는다.** 이 응답의 `previousclose`·`closeprice`·
 * `tradingdate` 는 실측에서 전부 null 이었다 — 그럴듯한 이름이라 그대로 쓰면 전일대비가
 * 통째로 사라진다. `lastclose - netchange` 로 구한다(krx.ts·네이버 지수 경로와 같은 방식).
 * 검산(실측 2026-08-27): 1852 − (−47.5) = 1899.5, −47.5 / 1899.5 = −2.5007% 로
 * 응답의 `percentualchange` 와 일치한다.
 *
 * 응답에 `previousreferenceprice`(실측 1899.5)도 있고 오늘은 위 계산과 값이 같았지만
 * 쓰지 않는다 — 배당락(`specialconditions: "XD"`) 조정 기준가일 수 있어 `netchange` 와
 * 어긋나는 날이 있을 수 있고, 그러면 이 행의 전일대비만 응답의 등락률과 안 맞는다.
 * 하나의 사실(`netchange`)에서 전부 유도하는 편이 일관된다.
 *
 * **등락률(`percentualchange`)은 쓰지 않는다.** 전 종목을 `domain/calc.ts` 의
 * `changePct` 로 계산한다(krx.ts 가 `FLUC_RT` 를 안 쓰는 것과 같은 이유 — 반올림
 * 규칙이 다르면 이 행만 끝자리가 어긋난다).
 *
 * **통화는 GBX(펜스)로 온다.** 접어서 GBP 로 바꾸지 않고 응답 그대로 돌려준다 —
 * `collectHelpers.currencyMismatchReason` 이 GBX 와 GBP 를 같은 통화로 접어 주므로
 * 시드(GBP)와 어긋나지 않고, 값이 정말 다른 통화로 바뀌면 그때는 걸린다.
 * 표시 가격은 펜스 그대로, 시총 계산에서만 100 으로 나눈다
 * (`Instrument.priceDivisorForMarketCap = 100`, 스펙 §3.2 주의 1).
 */
export async function fetchLseQuote(tidm: string): Promise<RawQuote> {
  const res = await fetch(`${BASE}/${encodeURIComponent(tidm)}`, { headers: HEADERS })
  // 형식은 다른 provider 와 같은 `... HTTP {status}` 다. retry.ts 의
  // classifyQuoteFailure 가 이 숫자를 보고 재시도 여부를 가른다(404 는 재시도하지 않는다).
  if (!res.ok) throw new QuoteError(tidm, `LSE HTTP ${res.status}${await errorDetail(res)}`)

  let json: LseInstrument | null = null
  try {
    json = (await res.json()) as LseInstrument
  } catch {
    throw new QuoteError(tidm, 'LSE 응답이 JSON 이 아님')
  }

  const close = toNumber(json?.lastclose)
  if (!Number.isFinite(close)) throw new QuoteError(tidm, `lastclose 파싱 실패: ${String(json?.lastclose)}`)

  const netChange = toNumber(json?.netchange)
  if (!Number.isFinite(netChange)) throw new QuoteError(tidm, `netchange 파싱 실패: ${String(json?.netchange)}`)

  const currency = typeof json?.currency === 'string' ? json.currency.trim() : ''
  if (currency === '') throw new QuoteError(tidm, 'currency 없음')

  // `lastclosedate` 는 "2026-08-27T15:35:27.000" 형태의 현지 시각이다. 앞 10자를 그대로
  // 쓴다 — `new Date()` 로 파싱하면 KST 로 옮겨지며 날짜가 밀릴 수 있다.
  const stamp = typeof json?.lastclosedate === 'string' ? json.lastclosedate : ''
  const asOf = stamp.slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    throw new QuoteError(tidm, `lastclosedate 파싱 실패: ${stamp || String(json?.lastclosedate)}`)
  }

  return {
    close,
    prevClose: close - netChange,
    currency,
    asOf,
  }
}
