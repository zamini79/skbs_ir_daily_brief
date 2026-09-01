import type { RawQuote } from '@/domain/types'
import { kstDateString } from '@/domain/date'
import { QuoteError } from './types'
import { parseKoreanNumber, parseMarketValueToTrillion, parseNaverSiseJson } from './naverParse'

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
 * 일별 시세(`siseJson.naver`)용 헤더. 위 `HEADERS` 와 `Referer` 가 다르다 — 이
 * 엔드포인트는 `m.stock.naver.com` 이 아니라 `finance.naver.com` 계열이다.
 * (`ytdBase.ts` 의 연초 기준가 조회가 같은 값을 쓴다.)
 */
const SERIES_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  Referer: 'https://finance.naver.com/',
}

/**
 * 일별 시세를 몇 **달력일**치 받을지.
 *
 * 필요한 것은 마지막 두 **거래일**인데, 휴장이 며칠 이어질지는 가정하지 않는다 —
 * 추석·설이 주말에 붙으면 국내장은 엿새 넘게 쉰다. 40일이면 그런 연휴가 창 안에
 * 통째로 들어와도 거래일 두 개가 남는다. 한 행이 40바이트 남짓이라 창을 넓히는
 * 비용은 사실상 없다(실측: 7행에 약 550바이트). **"정리"한다고 좁히지 마라.**
 */
const SERIES_WINDOW_DAYS = 40

/** 일별 시세 한 행. `date` 는 `YYYY-MM-DD`. */
type DailyBar = { date: string; close: number }

/** `YYYY-MM-DD` → `YYYYMMDD` (siseJson 의 startTime/endTime 형식) */
function toCompactYmd(iso: string): string {
  return iso.replace(/-/g, '')
}

/** `YYYYMMDD` → `YYYY-MM-DD` */
function fromCompactYmd(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
}

/**
 * 국내 종목·지수의 일별 시세에서 **마지막으로 완결된 두 거래일**을 뽑는다.
 *
 * ## 왜 `basic` 을 더 이상 쓰지 않는가 (Task 35)
 *
 * `m.stock.naver.com/.../basic` 의 `compareToPreviousClosePrice` 는 "전영업일 대비"가
 * 아니라 **"오늘 지금까지의 변동"**이다. 개장 전에는 오늘이 아직 안 움직였으니 당연히
 * 0 이고, `localTradedAt` 은 그래도 **오늘 날짜**로 온다. 실측(2026-08-31 08:56):
 *
 *     302440  closePrice "38,950"  compareToPreviousClosePrice "0"
 *             localTradedAt "2026-08-31T08:56:56+09:00"
 *     KOSPI   closePrice "6,788.88" compareToPreviousClosePrice "0.00"
 *
 * 종가 38,950 은 **금요일 값으로 맞다.** 틀린 것은 변동값(0)과 기준일(오늘)이다.
 * `integration` 의 `lastClosePrice` 도 뜻이 같아서("오늘 기준의 전일") 개장 전에는
 * `closePrice` 와 같은 값이 온다 — 실측으로 둘 다 확인했고, 그래서 뺄셈으로 구하든
 * `lastClosePrice` 를 쓰든 똑같이 0 이 된다.
 *
 * 크론은 07:40 KST 라 **매일 아침 이 상태를 만난다.** 국내 11행 전부가 "전일대비 0",
 * 즉 아무도 안 움직인 시장이라는 그럴듯한 거짓말이 매일 나간다. 장중·장 마감 후에만
 * 돌려 보던 동안에는 네이버가 실시간 변동을 줘서 이 결함이 보이지 않았다.
 *
 * ## 왜 시각으로 분기하지 않는가
 *
 * "지금이 09:00 전이면 계열을 쓴다" 같은 분기는 휴장일·반휴장·연휴에서 다시 틀린다.
 * **항상 계열에서 뽑으면 실행 시각과 무관하게 같은 값**이 나온다. 그것이 이 결함이
 * 남긴 교훈이고, `naver.test.ts` 의 불변식 테스트가 그 성질을 지킨다.
 *
 * ## 오늘 행은 언제나 버린다
 *
 * 장중에 부르면 계열의 마지막 행이 **오늘의 진행 중인 값**이다(개장 전에는 오늘 행이
 * 아예 오지 않는다 — 실측). 그 행을 쓰면 07:40 에 만든 브리프와 10:00 에 다시 수집한
 * 브리프의 숫자가 달라진다. 그래서 **KST 오늘 날짜의 행은 무조건 버린다.**
 *
 * **장 마감 뒤(16:00)에도 버린다.** 이건 아침 브리프다 — 날짜 D 의 브리프는 언제
 * 수집하든 D-1 종가를 보여야 한다. 마감 후에만 오늘 행을 받아들이면:
 *
 *   - 담당자가 검토·확정한 가격과 **보관된 브리프가 달라진다.** 메일이 이미 나갔으면
 *     아카이브가 발송본과 어긋난다.
 *   - 같은 날짜를 다시 돌렸을 때 다른 답이 나온다 — **그게 정확히 이번 결함의 성질이다.**
 *
 * "직전 영업일"을 마감 후에는 오늘로 읽을 여지가 있지만, 그건 **저녁 브리프라는 다른
 * 제품**이다. 필요해지면 그때 따로 만든다. **이 규칙을 되돌리지 마라.**
 *
 * 시각이 아니라 **날짜**로 거르므로 09:00·15:30 같은 장 시간 상수를 이 코드가 알 필요가
 * 없고, 반휴장(조기 마감)도 저절로 맞는다. `krx.ts` 도 같은 규칙을 쓴다.
 */
async function fetchLastTwoSessions(
  symbol: string,
  now: Date,
): Promise<{ last: DailyBar; prev: DailyBar }> {
  // KST 는 서머타임이 없으므로, 인스턴트에서 40일을 빼고 KST 로 포맷하면 정확히 40일 전이다.
  const todayKst = kstDateString(now)
  const startKst = kstDateString(new Date(now.getTime() - SERIES_WINDOW_DAYS * 86_400_000))

  const url =
    `https://api.finance.naver.com/siseJson.naver?symbol=${encodeURIComponent(symbol)}` +
    `&requestType=1&startTime=${toCompactYmd(startKst)}&endTime=${toCompactYmd(todayKst)}` +
    `&timeframe=day`

  const res = await fetch(url, { headers: SERIES_HEADERS })
  // 상태 코드를 `HTTP {status}` 형태로 싣는다 — retry.ts 가 이 문자열에서 5xx 를 읽어
  // 재시도 여부를 가린다(다른 provider 들과 같은 형식이다).
  if (!res.ok) throw new QuoteError(symbol, `일별 시세 HTTP ${res.status}`)

  const today = toCompactYmd(todayKst)
  const bars: DailyBar[] = parseNaverSiseJson(await res.text())
    .filter(r => r.date < today) // 오늘 행 제외 — 위 "오늘 행은 언제나 버린다" 참고
    // 0 이나 NaN 은 그럴듯한 숫자로 둔갑한다. 여기서 걸러 아래 행 수 판정에 맡긴다.
    .filter(r => Number.isFinite(r.close) && r.close > 0)
    .map(r => ({ date: fromCompactYmd(r.date), close: r.close }))
    .sort((a, b) => a.date.localeCompare(b.date))

  return pickLastTwoBars(symbol, bars)
}

/**
 * 정렬된(오름차순) 완결 거래일 배열에서 마지막 두 개를 뽑는다.
 *
 * 국내(`fetchLastTwoSessions`)와 해외 개별주(`fetchForeignDailySeries` 를 쓰는
 * `fetchNaverWorldStock`, Task 38)가 이 판정만은 공유한다 — 엔드포인트·스키마는
 * 달라도 "거래일이 몇 개 남았을 때 무엇을 할지"는 같은 규칙이기 때문이다.
 */
function pickLastTwoBars(symbol: string, bars: DailyBar[]): { last: DailyBar; prev: DailyBar } {
  if (bars.length === 0) {
    throw new QuoteError(symbol, `최근 ${SERIES_WINDOW_DAYS}일 일별 시세에 거래일이 없음`)
  }
  if (bars.length === 1) {
    // 신규 상장 등. **전일대비를 지어내지 않는다** — 없는 값을 0 으로 채우면 이 결함이
    // 그대로 되돌아온다(스펙 §3: 「값을 지어내거나 어제 값을 재사용하지 않는다」).
    throw new QuoteError(symbol, `거래일이 ${bars[0].date} 하루뿐이라 전일 종가가 없음`)
  }

  return { last: bars[bars.length - 1], prev: bars[bars.length - 2] }
}

/**
 * 시가총액(단위: 조원). **우리가 고른 거래일 종가 기준으로 되계산한다.**
 *
 * ## 왜 네이버가 준 값을 그대로 쓰지 않는가
 *
 * `integration.totalInfos.marketValue` 는 **그 순간의 현재가로 계산된 값**이다.
 * 실측(2026-08-31, 같은 종목 302440):
 *
 *     08:58 (개장 전)  현재가 38,950   marketValue "3조 559억"
 *     09:19 (장중)     현재가 37,950   marketValue "2조 9,813억"
 *
 * 그대로 쓰면 장중·마감 후 재수집에서 **주가는 금요일인데 시총만 오늘 장중** 값이 되어
 * 한 행 안에 두 시점이 섞인다. 73조짜리가 1% 움직이면 0.73조라 화면에 그대로 보인다.
 *
 * ## 되계산 방법
 *
 *     주식 수   = marketValue / 그 응답 시점의 현재가
 *     시가총액  = 주식 수 × 우리가 고른 거래일 종가
 *
 * 아래 식은 이 둘을 합친 형태다(주식 수를 실제로 만들지 않아 조원/원 단위 혼동이 없다).
 * **시드에 `sharesOutstanding` 을 넣지 않는 이유**: 국내 종목은 분기마다 손으로 갱신해야
 * 하고, 스펙 §3.4 가 국내를 그 목록에서 뺀 것도 같은 이유다. 응답에서 역산하면 유상증자·
 * 자사주 소각이 있어도 저절로 따라온다.
 *
 * ## 현재가는 `basic` 에서 온다 — 그리고 그게 이 방법의 한계다
 *
 * `integration` 에는 현재가가 없다(실측: `totalInfos` 에 `lastClosePrice`·`openPrice`·
 * `highPrice`·`lowPrice` 는 있어도 현재가는 없고, `dealTrendInfos[0]` 은 현재가가 아니라
 * **직전 거래일** 종가다). 그래서 현재가는 `basic.closePrice` 에서 받는다.
 *
 * 두 값이 **서로 다른 응답**에서 오므로 장중에는 표본 시각이 조금 어긋난다 — 실측으로
 * 역산 주식 수가 78,456,996(08:58) 대 78,558,630(09:19)으로 **약 0.13%** 차이났다.
 * 그래도 아무것도 안 했을 때의 오차(위 예에서 2.4%)보다 한 자릿수 작고, 무엇보다
 * **개장 전에는 현재가 = 직전 종가라 오차가 0 이다** — 07:40 정기 실행에서 이 되계산은
 * 값을 바꾸지 않는다. 바로잡는 대상은 어디까지나 장중·마감 후 재수집이다.
 *
 * 현재가가 없거나 0 이면 **역산하지 않고 실패로 던진다.** 호출부가 시총 칸만 비운다 —
 * 지어낸 시총을 채우지 않는다.
 *
 * 시세 계열과 **동시에** 부를 수 있도록 조회와 계산을 나눠 놓았다. 여기서는 같은 시점의
 * 두 값만 받아 오고, 거래일 종가를 곱하는 것은 호출부가 한다(`marketCapAtSessionClose`).
 */
async function fetchNaverCapBasis(code: string): Promise<{ capAtPriceNow: number; priceNow: number }> {
  const [basic, integration] = await Promise.all([
    getJson(`https://m.stock.naver.com/api/stock/${code}/basic`, code),
    getJson(`https://m.stock.naver.com/api/stock/${code}/integration`, code),
  ])

  const infos: Array<{ code: string; value: string }> = integration.totalInfos ?? []
  const raw = infos.find(i => i.code === 'marketValue')?.value
  if (!raw) throw new QuoteError(code, 'marketValue 없음')
  const capAtPriceNow = parseMarketValueToTrillion(raw)
  if (!Number.isFinite(capAtPriceNow)) throw new QuoteError(code, `marketValue 파싱 실패: ${raw}`)

  // marketValue 가 계산된 시점의 가격. 0 이나 NaN 이면 나눗셈이 Infinity·NaN 을 낳는다.
  const priceNow = parseKoreanNumber(basic.closePrice)
  if (!Number.isFinite(priceNow) || priceNow <= 0) {
    throw new QuoteError(code, `시총 되계산용 현재가 없음: ${basic.closePrice}`)
  }

  return { capAtPriceNow, priceNow }
}

/** 주식 수(= capAtPriceNow / priceNow)를 거래일 종가로 다시 곱한 시가총액. */
function marketCapAtSessionClose(
  basis: { capAtPriceNow: number; priceNow: number },
  sessionClose: number,
): number {
  return basis.capAtPriceNow * (sessionClose / basis.priceNow)
}

/**
 * 국내 개별주. 시세는 일별 계열에서, 시총은 `integration` 에서 받는다.
 *
 * **엔드포인트 두 개의 실패를 다르게 다룬다.** 시세가 실패하면 그 종목은 실패다 —
 * 주가·전일대비·%·연초대비가 통째로 없다. 시총만 실패하면 **시세는 살린다**: 여섯 칸
 * 중 한 칸이 비는 것을 나머지까지 버릴 이유로 삼을 수 없고, 지수 4행은 원래 시총이
 * 비어 있어 표가 깨지지도 않는다.
 *
 * 다만 **조용히 비우지는 않는다.** 사유를 로그에 남긴다 — 시총 칸이 비는 것은 화면에서
 * 지수 행과 구분되지 않으므로, 로그가 없으면 이 엔드포인트가 몇 주째 죽어 있어도
 * 아무도 모른다(`index.ts` 의 폴백 로그와 같은 취지다).
 *
 * 두 호출은 동시에 나간다(`Promise` 를 먼저 만들고 뒤에서 await 한다).
 */
export async function fetchNaverStock(code: string, now: Date = new Date()): Promise<RawQuote> {
  // 세 호출이 동시에 나간다. 시총 쪽은 실패해도 시세를 죽이지 않도록 여기서 삼킨다.
  const basisPromise = fetchNaverCapBasis(code).catch((e: unknown) => {
    const reason = e instanceof Error ? e.message : String(e)
    console.error(`[quote] ${code}: 시가총액 조회 실패 — 시세는 살리고 시총 칸만 빈다: ${reason}`)
    return undefined
  })

  const { last, prev } = await fetchLastTwoSessions(code, now)
  const basis = await basisPromise
  const cap = basis === undefined ? undefined : marketCapAtSessionClose(basis, last.close)

  return {
    close: last.close,
    prevClose: prev.close,
    currency: 'KRW',
    asOf: last.date,
    marketCapKrwTrillion: cap,
  }
}

/**
 * 국내 지수(KOSPI). 종목과 **같은 계열 엔드포인트**를 쓴다 — `siseJson` 은 지수 심볼
 * (`KOSPI`)에도 정상 응답한다(실측 2026-08-31: 마지막 행 `20260828` 종가 6788.88 로
 * `basic` 의 종가와 일치). 지수는 시총이 없으므로 호출은 계열 하나뿐이다.
 *
 * 해외 지수(`.INX`/`.IXIC`)는 여기로 오지 않는다 — `index.ts` 가 심볼 앞의 `.` 로 갈라
 * `fetchNaverWorldIndex` 로 보낸다. 그 경로는 개장 전에도 정상이다(Task 35 실측:
 * 08:56 KST 에 `localTradedAt 2026-08-28`, 변동 -19.23/-138.93 — 미국장이 이미 마감해
 * "오늘"이 곧 그 시장의 마지막 세션이기 때문이다).
 */
export async function fetchNaverDomesticIndex(code: string, now: Date = new Date()): Promise<RawQuote> {
  const { last, prev } = await fetchLastTwoSessions(code, now)
  return { close: last.close, prevClose: prev.close, currency: 'KRW', asOf: last.date }
}

/**
 * 해외 개별주(홍콩 2269.HK — Wuxi)의 일별 시세에서 **마지막 두 완결 거래일**을 뽑는다.
 * 규칙은 `fetchLastTwoSessions`(Task 35)와 같다 — KST 오늘 날짜의 행은 언제나 버린다.
 * 이유도 같다: 크론이 07:40 KST 인데 홍콩거래소 개장은 09:30 HKT(= 10:30 KST) 라
 * **정상 운영 시각에는 항상 개장 전**이다(Task 38 실측). 시각으로 분기하지 않는
 * 이유도 위 주석과 같다 — 휴장일에 다시 틀린다.
 *
 * **엔드포인트·스키마가 국내와 다르다.** `chart/foreign/item/{code}/day` 는 JSON
 * **배열**을 그대로 반환하고, 한 행이 `{"localDate":"20260831","closePrice":48.84,...}`
 * 다 — 숫자가 **문자열이 아니라 number** 다(`siseJson.naver` 와 반대). 그래서
 * `parseNaverSiseJson`/`SERIES_HEADERS` 를 재사용하지 않는다: 헤더는 호스트가
 * `api.stock.naver.com`(이 파일의 `basic`·`chart/foreign/item` 이 다 같은 호스트다)
 * 이라 `finance.naver.com` 용 `SERIES_HEADERS` 가 아니라 이 파일의 `HEADERS` 가
 * 맞다(Task 38 실측). `getJson` 을 그대로 쓴다 — `HTTP {status}` 형식과
 * `StockConflict` 판정을 여기서도 그대로 받는다.
 *
 * 거래일 판정(0 개·1 개일 때 무엇을 할지)은 국내와 같은 규칙이라 `pickLastTwoBars`
 * 를 공유한다. 억지로 하나의 함수로 합치지 않은 이유는 파싱·엔드포인트가 다르기
 * 때문이다 — 네이버가 한쪽 스키마를 바꿔도 고칠 자리가 하나로 남는다.
 */
async function fetchForeignDailySeries(code: string, now: Date): Promise<DailyBar[]> {
  const todayKst = kstDateString(now)
  const startKst = kstDateString(new Date(now.getTime() - SERIES_WINDOW_DAYS * 86_400_000))
  const today = toCompactYmd(todayKst)

  const url =
    `https://api.stock.naver.com/chart/foreign/item/${encodeURIComponent(code)}/day` +
    `?startDateTime=${toCompactYmd(startKst)}0000&endDateTime=${today}0000`

  const json = await getJson(url, code)
  if (!Array.isArray(json)) throw new QuoteError(code, '일별 시세 응답이 배열이 아님')

  return (json as unknown[])
    .map(row => {
      const r = row as { localDate?: unknown; closePrice?: unknown }
      if (typeof r.localDate !== 'string' || !/^\d{8}$/.test(r.localDate)) {
        throw new QuoteError(code, `localDate 파싱 실패: ${JSON.stringify(r.localDate)}`)
      }
      const close = Number(r.closePrice)
      if (!Number.isFinite(close) || close <= 0) {
        throw new QuoteError(code, `closePrice 파싱 실패: ${JSON.stringify(r.closePrice)}`)
      }
      return { date: r.localDate, close }
    })
    .filter(r => r.date < today) // 오늘 행 제외 — 위 "언제나 버린다" 참고
    .map(r => ({ date: fromCompactYmd(r.date), close: r.close }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * 해외 개별주(홍콩 2269.HK — Wuxi). marketstack 에서 옮겨 왔다(Task 31).
 *
 * **왜 별도 파일이 아니라 여기인가**: `basic` 호출은 국내 지수 경로와 같은 계열이다
 * (`HEADERS`·`getJson`(StockConflict 판정 포함)·호스트 `api.stock.naver.com` 을
 * 그대로 공유한다). 별도 파일로 빼면 이들을 복제하거나 import 로 되가져와야 하고,
 * 네이버가 스키마를 바꿀 때 고쳐야 할 자리가 두 곳으로 늘어난다. 한 벤더 = 한 파일이
 * 스펙 §4 의 "소스가 바뀌어도 providers/ 하위 파일 하나만 교체한다"에 더 맞는다.
 *
 * **왜 두 엔드포인트를 부르는가**(Task 38): 시세(종가·전일종가·기준일)는 일별 시세
 * (`fetchForeignDailySeries`)에서, 통화(`currencyType.code`)는 `basic` 에서 받는다.
 * `basic` 은 일별 시세에 없는 필드 하나 때문에 남겨 뒀다 — 통화를 provider 안에
 * 하드코딩하면 `collectHelpers.currencyMismatchReason` 이 자기 자신을 검사하게 되어
 * 무력해진다(기존 결정, Task 31). 종목이 하나뿐이라 두 번 호출하는 비용은 무의미하다.
 * `basic` 의 `closePrice`·`compareToPreviousClosePrice`·`localTradedAt` 은 더 이상
 * 읽지 않는다 — 그 값들이 이 결함의 원인이었다(아래 §"실패 사례" 참고).
 *
 * ## 실패 사례 (2026-09-01 실측)
 *
 * 개장 5분 전(09:25 HKT) `basic` 응답은 `compareToPreviousClosePrice = 0.000`,
 * `localTradedAt` 이 **오늘**이었다 — `fetchLastTwoSessions` 위 주석의 국내 결함과
 * 정확히 같다. `closePrice`(48.84)는 08-31 종가로 맞았지만 변동값과 기준일이 거짓이라
 * 매일 아침 전일대비 0 / 0.00% 가 메일에 나갔다. 일별 시세로 옮기고 나면 같은 시각
 * 응답의 마지막 행이 `20260831`(마감된 거래일)이라 08-31 종가/기준일이 그대로 나오고,
 * 그 앞 행 `20260828`(50.65)로 전일대비가 정상 계산된다.
 *
 * 심볼 주의(Task 31 실측, 2026-08-28):
 *   - `GSK.L`·`SAN.PA`·`LONN.SW` 는 네이버에 없다 — HTTP 409 `Not Exist Master`.
 *   - 접미사 없는 `GSK`·`SAN` 은 **미국 ADR 이라 값이 다르다. 쓰면 안 된다.**
 *
 * `fluctuationsRatio`(네이버가 준 등락률)는 일부러 쓰지 않는다 — 전 종목을
 * `domain/calc.ts` 의 `changePct` 로 계산한다(krx.ts 가 `FLUC_RT` 를 안 쓰는 것과
 * 같은 이유).
 */
export async function fetchNaverWorldStock(code: string, now: Date = new Date()): Promise<RawQuote> {
  const bars = await fetchForeignDailySeries(code, now)
  const { last, prev } = pickLastTwoBars(code, bars)

  const j = await getJson(`https://api.stock.naver.com/stock/${code}/basic`, code)
  const currency = typeof j.currencyType?.code === 'string' ? j.currencyType.code.trim() : ''
  if (currency === '') throw new QuoteError(code, 'currencyType.code 없음')

  return { close: last.close, prevClose: prev.close, currency, asOf: last.date }
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
