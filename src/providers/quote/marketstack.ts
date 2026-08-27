import type { RawQuote } from '@/domain/types'
// 순수 함수 하나를 재사용한다(gemini.ts 에서 export). 오류 본문을 DB·화면으로
// 흘리는 경로는 provider 가 달라도 위험이 같으므로 같은 처리를 쓴다.
import { redactKey } from '@/providers/summarize/gemini'

const BASE = 'https://api.marketstack.com/v2'

/** 사유 문구가 DB(QuoteSnapshot.errorMessage)와 화면에 실린다. 본문을 통째로 싣지 않는다. */
const MAX_ERROR_DETAIL_CHARS = 200

type MsRow = { symbol: string; close: number; open: number; price_currency?: string; date: string }

function assertOk(json: any) {
  if (json?.error) {
    throw new Error(`marketstack: ${json.error.code ?? ''} ${json.error.message ?? ''}`.trim())
  }
}

/**
 * 실패 응답의 본문에서 `error.code` / `error.message` 를 꺼내 괄호로 덧붙일 문자열을 만든다.
 * 꺼낼 것이 없거나 본문이 JSON 이 아니면 빈 문자열 — 그러면 예전과 같은
 * `marketstack HTTP {status}` 메시지가 된다. **여기서 절대 던지지 않는다**:
 * 이 함수는 이미 실패한 경로에서만 불리므로, 여기서 던지면 원래 사유를 덮어쓴다.
 */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } }
    const parts = [body?.error?.code, body?.error?.message]
      .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    if (parts.length === 0) return ''
    // 키는 쿼리스트링(access_key=)으로 나간다. 본문이 요청 URL 을 되비추는 API 가
    // 실제로 있어서(gemini.ts 의 redactKey 주석) 자르기 **전에** 지운다 —
    // 나중에 지우면 잘린 꼬리에 키 조각이 남는다.
    const detail = redactKey(parts.join(': '), process.env.MARKETSTACK_API_KEY ?? '')
    return ` (${detail.slice(0, MAX_ERROR_DETAIL_CHARS)})`
  } catch {
    return ''
  }
}

/**
 * HTTP 실패면 **본문까지 읽어서** 던진다.
 *
 * marketstack 은 월 한도 소진을 분당 속도 제한과 **같은 429** 로 알린다. 구분은
 * 본문에만 있다(실측 2026-08-27):
 *
 *     HTTP 429  {"error":{"code":"usage_limit_reached",
 *                         "message":"Your monthly usage limit has been reached."}}
 *
 * 예전에는 `!res.ok` 에서 본문을 읽지 않고 곧바로 던져서 이 구분이 통째로 사라졌다.
 * 결과가 두 가지로 나빴다:
 *   - retry.ts 가 상태 코드만 보고 `rate-limit` 으로 분류해 **61초를 기다렸다가
 *     확실히 실패할 호출을 한 번 더** 했다. 20분 수집 창에서 순수한 낭비다.
 *   - 화면에는 「marketstack HTTP 429」만 떠서 몇 분 뒤 나아질 일처럼 읽혔다.
 *     실제로는 다음 달 리셋까지 낫지 않는다.
 *
 * **이 함수를 다시 `if (!res.ok) throw` 한 줄로 줄이지 마라.** 본문이 유일한 단서다.
 */
async function assertHttpOk(res: Response): Promise<void> {
  if (res.ok) return
  throw new Error(`marketstack HTTP ${res.status}${await errorDetail(res)}`)
}

function key(): string {
  const k = process.env.MARKETSTACK_API_KEY
  if (!k) throw new Error('MARKETSTACK_API_KEY 없음')
  return k
}

/**
 * 비미국 종목 전용. 심볼은 거래소 약칭 접미사를 써야 한다(GSK.L, SAN.PA, LONN.SW, 2269.HK).
 * MIC 접미사(GSK.XLON)는 뉴욕 ADR 값이 오므로 절대 쓰지 않는다.
 */
export async function fetchMarketstackQuotes(symbols: string[]): Promise<Map<string, RawQuote>> {
  const out = new Map<string, RawQuote>()
  if (symbols.length === 0) return out

  // limit은 심볼 전체에 걸친 전역 캡이라 심볼별 개수를 보장하지 않는다.
  // 심볼당 최소 2거래일이 필요하므로, 주말·거래소 휴장을 감안해 여유 있게 잡는다.
  const limit = symbols.length * 12
  const url = `${BASE}/eod?access_key=${key()}&symbols=${symbols.join(',')}&limit=${limit}`
  const res = await fetch(url)
  await assertHttpOk(res)
  const json = await res.json()
  assertOk(json)

  const rows: MsRow[] = json.data ?? []
  for (const symbol of symbols) {
    const mine = rows
      .filter(r => r.symbol === symbol)
      .sort((a, b) => b.date.localeCompare(a.date))
    if (mine.length < 2) continue
    out.set(symbol, {
      close: mine[0].close,
      prevClose: mine[1].close,
      currency: mine[0].price_currency ?? '',
      asOf: mine[0].date.slice(0, 10),
    })
  }
  return out
}

/**
 * 연초대비(YTD) 기준가 = 전년도 마지막 거래일의 종가 (스펙 §3.5).
 * 연 1회만 호출하고 DB에 캐시한다.
 */
export async function fetchMarketstackYtdBase(
  symbols: string[],
  year: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (symbols.length === 0) return out

  const prev = year - 1
  // limit은 심볼 전체에 걸친 전역 캡이다. 12월 창은 31일이므로 심볼당 31행을 잡는다.
  const url =
    `${BASE}/eod?access_key=${key()}&symbols=${symbols.join(',')}` +
    `&date_from=${prev}-12-01&date_to=${prev}-12-31&limit=${symbols.length * 31}`
  const res = await fetch(url)
  await assertHttpOk(res)
  const json = await res.json()
  assertOk(json)

  const rows: MsRow[] = json.data ?? []
  for (const symbol of symbols) {
    const mine = rows
      .filter(r => r.symbol === symbol)
      .sort((a, b) => a.date.localeCompare(b.date))
    if (mine.length === 0) continue
    out.set(symbol, mine[mine.length - 1].close) // 전년 마지막 거래일 종가 (스펙 §3.5)
  }
  return out
}
