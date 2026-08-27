import type { RawQuote } from '@/domain/types'
import { QuoteError } from './types'

/**
 * SIX Swiss Exchange 공식 화면이 쓰는 조회 엔드포인트(fqs). Lonza 전용으로 들어왔다.
 *
 * **왜 marketstack 에서 옮겼나**: lse.ts 의 같은 주석 참고 — 무료 플랜이 심볼 수로
 * 세는 탓에 월 88회였고 2026-08-27 에 소진됐다. 연초 기준가만 marketstack 에 남긴다.
 *
 * 키가 필요 없다. **문서화된 공개 API 가 아니라 SIX 자기 화면이 쓰는 엔드포인트다**
 * (스펙 §13 리스크 4). 깨지면 이 파일 하나만 고친다.
 *
 * 15분 지연(`delayMinutes: 15`)은 무관하다 — 07:40 KST 실행 시 취리히는 이미 마감이다.
 */
const BASE = 'https://www.six-group.com/fqs/ref.json'

/** 사유 문구가 DB(QuoteSnapshot.errorMessage)와 화면에 실린다. 본문을 통째로 싣지 않는다. */
const MAX_ERROR_DETAIL_CHARS = 200

/**
 * 읽을 컬럼. **`select` 에 존재하지 않는 이름을 넣으면 JSON 이 아니라 HTML 오류 본문이
 * 온다**(실측 2026-08-28: HTTP 400 + `Invalid name 'ClosingDate' in select parameter`).
 * `ClosingDate`·`LastTradedDateTime` 은 없는 이름이다 — 날짜는 `MarketDate` 다.
 *
 * `Currency` 는 브리프가 "응답에 없으니 시드값을 쓰라"고 했던 값인데, 재실측
 * (2026-08-28)에서 유효한 select 이름임을 확인했다(`[588.4,"CHF",20260827]`).
 * 시드값을 되풀이하는 대신 소스가 말한 통화를 그대로 받는다 — 그래야
 * `collectHelpers.currencyMismatchReason` 이 "다른 상장으로 갈아탔다"를 실제로 잡는다.
 * 시드 통화를 provider 안에 하드코딩하면 그 검사가 자기 자신을 검사하게 되어 무력해진다.
 */
const SELECT = ['ClosingPrice', 'PreviousClosingPrice', 'MarketDate', 'Currency'] as const

type FqsResponse = {
  totalRows?: unknown
  colNames?: unknown
  rowData?: unknown
}

/**
 * 문자열·숫자 모두 받는다. 빈 문자열·null 은 `Number()` 가 0 으로 둔갑시키므로
 * 명시적으로 NaN 을 돌려주고 호출자가 실패로 남기게 한다.
 */
function toNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw)
  return NaN
}

/**
 * `colNames` 에서 이름의 위치를 찾아 그 자리의 값을 준다.
 *
 * **위치로 읽지 않는 것이 이 함수의 존재 이유다.** `rowData` 는 값만 담은 배열이라
 * 위 `SELECT` 의 순서를 바꾸거나 SIX 가 컬럼 순서를 바꾸면 종가 자리에 전일 종가가
 * 들어오고, 값이 둘 다 그럴듯한 숫자라 아무도 눈치채지 못한다.
 */
function cell(colNames: string[], row: unknown[], name: string): unknown {
  const idx = colNames.indexOf(name)
  if (idx < 0) return undefined
  return row[idx]
}

/** `20260827` → `2026-08-27`. 8자리 숫자가 아니면 null(호출자가 실패로 남긴다). */
function fromMarketDate(raw: unknown): string | null {
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (!/^\d{8}$/.test(s)) return null
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
}

/**
 * SIX 종목 시세. `valorSymbol` 은 SIX 의 종목 심볼이다(LONN).
 * **marketstack 표기(`LONN.SW`)가 아니다.**
 *
 * 실패로 다루는 것 세 가지 — 어느 것도 조용한 공란이 되어서는 안 된다:
 *   1) HTTP 오류 (`SIX HTTP {status}` — retry.ts 가 이 숫자로 재시도를 가른다)
 *   2) JSON 이 아닌 본문 (없는 select 이름을 보냈을 때 오는 HTML 오류 페이지)
 *   3) `totalRows !== 1` — 심볼이 안 맞았거나(실측: 없는 심볼은 `totalRows: 0` 에
 *      빈 `rowData`) 한 심볼에 여러 상장이 걸린 것이다. 어느 쪽이든 값을 고르면 안 된다.
 *
 * 등락률은 계산하지 않는다 — 전 종목을 `domain/calc.ts` 의 `changePct` 로 계산한다.
 */
export async function fetchSixQuote(valorSymbol: string): Promise<RawQuote> {
  const url =
    `${BASE}?select=${SELECT.join(',')}` +
    `&where=ValorSymbol=${encodeURIComponent(valorSymbol)}`
  const res = await fetch(url)

  const text = await res.text()
  if (!res.ok) {
    // 오류 본문은 HTML 이다. 사람이 읽을 수 있게 태그를 걷어내고 앞부분만 싣는다
    // (`Invalid name '...' in select parameter` 가 여기에 담긴다). 자격증명은 없다.
    const detail = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    throw new QuoteError(
      valorSymbol,
      `SIX HTTP ${res.status}${detail ? ` (${detail.slice(0, MAX_ERROR_DETAIL_CHARS)})` : ''}`,
    )
  }

  let json: FqsResponse
  try {
    json = JSON.parse(text) as FqsResponse
  } catch {
    // HTTP 200 인데 JSON 이 아닌 경우가 실제로 있다(브리프 실측). 파싱 실패를
    // 빈 값이 아니라 실패로 다룬다.
    const detail = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    throw new QuoteError(
      valorSymbol,
      `SIX 응답이 JSON 이 아님${detail ? ` (${detail.slice(0, MAX_ERROR_DETAIL_CHARS)})` : ''}`,
    )
  }

  if (json?.totalRows !== 1) {
    throw new QuoteError(valorSymbol, `totalRows 가 1이 아님: ${String(json?.totalRows)}`)
  }

  const colNames = Array.isArray(json?.colNames) ? (json.colNames as unknown[]).map(String) : []
  const rows = Array.isArray(json?.rowData) ? (json.rowData as unknown[]) : []
  const row = rows[0]
  if (!Array.isArray(row)) throw new QuoteError(valorSymbol, 'rowData 가 비어 있음')

  const close = toNumber(cell(colNames, row, 'ClosingPrice'))
  if (!Number.isFinite(close)) throw new QuoteError(valorSymbol, 'ClosingPrice 파싱 실패')

  const prevClose = toNumber(cell(colNames, row, 'PreviousClosingPrice'))
  if (!Number.isFinite(prevClose)) throw new QuoteError(valorSymbol, 'PreviousClosingPrice 파싱 실패')

  const asOf = fromMarketDate(cell(colNames, row, 'MarketDate'))
  if (asOf === null) throw new QuoteError(valorSymbol, `MarketDate 파싱 실패: ${String(cell(colNames, row, 'MarketDate'))}`)

  const rawCurrency = cell(colNames, row, 'Currency')
  const currency = typeof rawCurrency === 'string' ? rawCurrency.trim() : ''
  if (currency === '') throw new QuoteError(valorSymbol, 'Currency 없음')

  return { close, prevClose, currency, asOf }
}
