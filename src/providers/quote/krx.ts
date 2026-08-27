import type { RawQuote } from '@/domain/types'
import { kstDateString } from '@/domain/date'
import { QuoteError } from './types'

/**
 * KRX Open API — KOSPI 일별 지수 시세.
 * 하루치 KOSPI 계열 지수 전체(실측 51행)를 한 번에 준다. HTTPS 필수(http 는 리다이렉트).
 */
const BASE = 'https://data-dbg.krx.co.kr/svc/apis/idx/kospi_dd_trd'

/**
 * KRX 응답의 `IDX_NM` 과 정확히 일치시켜야 하는 문자열.
 *
 * **우리 `Instrument.name` 은 `'코스피200 헬스케어'`(코스피와 200 사이 공백 없음)이고
 * KRX 표기는 `'코스피 200 헬스케어'`(공백 있음)로 서로 다르다.** 우리 표기는 원본 브리프
 * 엑셀을 따른 것이라 바꾸지 않는다. 그래서 종목 이름으로 매칭하면 51행 중 어느 것도
 * 걸리지 않는다 — 매칭은 반드시 이 상수(= `Instrument.quoteSymbol`)로 한다.
 * `prisma/instruments.ts` 의 quoteSymbol 이 이 값과 같은지는 테스트가 지킨다.
 */
export const KRX_IDX_NM_KOSPI200_HEALTHCARE = '코스피 200 헬스케어'

/**
 * 휴장일은 오류가 아니라 **빈 `OutBlock_1`** 로 온다(실측: 20251231, 20260827 둘 다 0행).
 * 잘못된 날짜 문자열도 똑같이 빈 배열이라 "빈 응답"만으로는 휴장인지 오타인지 구분되지
 * 않는다. 그래서 하루씩 거슬러 올라가되 반드시 상한을 두고, 상한에 걸리면 조용히 null 을
 * 주지 않고 실패로 던진다. 연말연시 최장 휴장(12/31~1/1 + 주말)도 10일이면 넘어간다.
 */
const MAX_LOOKBACK_DAYS = 10

/** 실제로 읽는 필드만 적는다. 응답에는 시가·고가·저가·거래량·시총도 함께 온다. */
type KrxIndexRow = {
  BAS_DD?: string
  IDX_NM?: string
  CLSPRC_IDX?: string
  CMPPREVDD_IDX?: string
}

/** `YYYY-MM-DD` → `YYYYMMDD`. basDd 파라미터 형식이다. */
function toBasDd(isoDate: string): string {
  return isoDate.replace(/-/g, '')
}

/** `YYYYMMDD` → `YYYY-MM-DD`. 8자리 숫자가 아니면 null(호출자가 실패로 남긴다). */
function fromBasDd(basDd: string | undefined): string | null {
  if (!basDd || !/^\d{8}$/.test(basDd)) return null
  return `${basDd.slice(0, 4)}-${basDd.slice(4, 6)}-${basDd.slice(6, 8)}`
}

/**
 * `YYYYMMDD` 에서 하루 단위로 이동한다. UTC 로 계산해 서머타임·로컬 타임존의 영향을
 * 받지 않게 한다 — 여기서 다루는 건 시각이 아니라 거래일 라벨이다.
 */
function shiftBasDd(basDd: string, days: number): string {
  const y = Number(basDd.slice(0, 4))
  const m = Number(basDd.slice(4, 6))
  const d = Number(basDd.slice(6, 8))
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000
  const shifted = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${shifted.getUTCFullYear()}${pad(shifted.getUTCMonth() + 1)}${pad(shifted.getUTCDate())}`
}

/**
 * 문자열 → 숫자. **KRX 는 모든 값을 문자열로 준다.**
 * 빈 문자열은 `Number('')` 가 0 이라 그럴듯한 숫자로 둔갑한다 — 명시적으로 걸러 NaN 을
 * 돌려주고 호출자가 실패로 남기게 한다. 콤마도 일부러 처리하지 않는다(실측 응답에는
 * 없다). 형식이 바뀌면 조용히 틀린 값이 아니라 NaN 으로 시끄럽게 실패하는 편이 낫다.
 */
function toNumber(raw: string | undefined): number {
  if (typeof raw !== 'string' || raw.trim() === '') return NaN
  return Number(raw)
}

/**
 * 하루치 응답을 가져온다.
 *
 * 인증 실패·HTTP 오류는 **여기서 즉시 던진다.** 거슬러 올라가는 루프는 "빈 배열(휴장)"
 * 에만 반응해야 한다 — 401 을 휴장처럼 취급하면 키가 틀렸을 때 같은 오류로 10번 재시도한
 * 뒤 "거래일을 못 찾았다"는 엉뚱한 사유가 남는다.
 *
 * 키는 헤더로만 보낸다(URL 에 싣지 않는다). 오류 메시지에도 키 값을 넣지 않는다 —
 * KRX 가 주는 `respMsg` 는 `"Unauthorized Key"` 같은 상수 문구이지 키 값이 아니다(실측).
 */
async function fetchKrxDay(basDd: string, symbol: string): Promise<KrxIndexRow[]> {
  const authKey = process.env.KRX_AUTH_KEY
  if (!authKey) throw new QuoteError(symbol, 'KRX_AUTH_KEY 없음')

  const res = await fetch(`${BASE}?basDd=${basDd}`, {
    headers: { AUTH_KEY: authKey, Accept: 'application/json' },
  })

  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }

  if (!res.ok) {
    const msg = (body as { respMsg?: string } | null)?.respMsg
    throw new QuoteError(symbol, `KRX HTTP ${res.status}${msg ? ` ${msg}` : ''} (basDd=${basDd})`)
  }

  const rows = (body as { OutBlock_1?: unknown } | null)?.OutBlock_1
  if (!Array.isArray(rows)) throw new QuoteError(symbol, `OutBlock_1 이 배열이 아님 (basDd=${basDd})`)
  return rows as KrxIndexRow[]
}

/**
 * `from`(YYYYMMDD) 부터 하루씩 거슬러 올라가며 거래일 한 건을 찾아 그 날의 대상 지수
 * 행을 돌려준다.
 *
 * 실패 세 가지를 서로 다른 문구로 구분한다 — 화면에 똑같은 공란으로 뭉개지면 안 된다.
 *   1) 거래일을 상한까지 못 찾음  (휴장 연속 / 미래 날짜 / 날짜 형식 오류)
 *   2) 거래일은 찾았는데 그 안에 대상 지수가 없음 (KRX 가 지수명을 바꿨을 가능성)
 *   3) HTTP·인증 오류 (fetchKrxDay 가 즉시 던진다)
 */
async function findIndexRow(idxNm: string, from: string): Promise<KrxIndexRow> {
  for (let back = 0; back < MAX_LOOKBACK_DAYS; back++) {
    const basDd = shiftBasDd(from, -back)
    const rows = await fetchKrxDay(basDd, idxNm)
    if (rows.length === 0) continue // 휴장일(또는 아직 미게시). 하루 더 거슬러 올라간다.

    const row = rows.find(r => r.IDX_NM === idxNm)
    if (!row) {
      throw new QuoteError(idxNm, `${basDd} 응답 ${rows.length}행에 해당 지수가 없음`)
    }
    return row
  }
  throw new QuoteError(idxNm, `${from} 부터 ${MAX_LOOKBACK_DAYS}일을 거슬러 올라가도 거래일을 찾지 못함`)
}

/**
 * KRX 지수 시세. `symbol` 은 KRX 의 `IDX_NM` 문자열이다(위 상수 참고).
 *
 * `prevClose` 는 전일대비(`CMPPREVDD_IDX`)를 종가에서 빼서 얻는다 — 네이버 국내지수
 * 경로와 같은 방식이다. 대비값이 음수여도 뺄셈 하나로 똑같이 맞는다.
 *
 * **`FLUC_RT`(KRX 가 준 등락률)는 일부러 쓰지 않는다.** 등락률은 이미 우리가
 * `domain/calc.ts` 의 `changePct` 로 전 종목 동일하게 계산한다. KRX 의 반올림 규칙이
 * 우리 것과 다르면 이 한 행만 소수점 끝자리가 미묘하게 어긋나 "왜 이 행만 다르지"라는
 * 재현 안 되는 의심을 낳는다. 값 하나를 아끼는 것보다 일관성이 낫다.
 *
 * 시가총액은 채우지 않는다. 응답에 `MKTCAP` 이 오지만 원본 브리프 엑셀은 지수 행의
 * 시총 칸을 `-` 로 비우고, 다른 지수 3행도 그렇다(파이프라인의 `resolveMarketCap` 도
 * `isIndex` 면 null 을 준다). 표를 지수 4행끼리 일관되게 유지한다.
 */
export async function fetchKrxIndexQuote(symbol: string, now: Date = new Date()): Promise<RawQuote> {
  // 기준일은 KST 오늘이다. 08:00 브리프는 개장 전이라 오늘 행은 아직 없고, 위 루프가
  // 전영업일로 내려간다(실측: 20260827 은 저녁에도 0행이었다).
  const row = await findIndexRow(symbol, toBasDd(kstDateString(now)))

  const close = toNumber(row.CLSPRC_IDX)
  if (!Number.isFinite(close)) throw new QuoteError(symbol, `CLSPRC_IDX 파싱 실패: ${row.CLSPRC_IDX}`)

  const diff = toNumber(row.CMPPREVDD_IDX)
  if (!Number.isFinite(diff)) throw new QuoteError(symbol, `CMPPREVDD_IDX 파싱 실패: ${row.CMPPREVDD_IDX}`)

  const asOf = fromBasDd(row.BAS_DD)
  if (asOf === null) throw new QuoteError(symbol, `BAS_DD 파싱 실패: ${row.BAS_DD}`)

  return {
    close,
    prevClose: close - diff,
    currency: 'KRW',
    asOf,
  }
}

/**
 * 연초대비(YTD) 기준가 = **전년도 마지막 거래일의 종가** (스펙 §3.5).
 *
 * 날짜를 가정하지 않는다. 국내 증시의 2025년 마지막 거래일은 12/31 이 아니라 **12/30**
 * 이고(실측: 20251231 은 0행), 해가 바뀌면 또 달라진다. 12/31 부터 거슬러 올라가
 * 처음 만나는 거래일이 정의상 전년 마지막 거래일이다.
 *
 * 실패하면 던진다. 호출자(`ytdBase.ts`)가 사유를 `failures` 에 실어 운영자에게 남긴다.
 */
export async function fetchKrxIndexYtdBase(symbol: string, year: number): Promise<number> {
  const row = await findIndexRow(symbol, `${year - 1}1231`)
  const close = toNumber(row.CLSPRC_IDX)
  if (!Number.isFinite(close)) throw new QuoteError(symbol, `CLSPRC_IDX 파싱 실패: ${row.CLSPRC_IDX}`)
  return close
}
