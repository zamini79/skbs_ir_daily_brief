import type { RawQuote } from '@/domain/types'

const BASE = 'https://api.marketstack.com/v2'

type MsRow = { symbol: string; close: number; open: number; price_currency?: string; date: string }

function assertOk(json: any) {
  if (json?.error) {
    throw new Error(`marketstack: ${json.error.code ?? ''} ${json.error.message ?? ''}`.trim())
  }
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
  if (!res.ok) throw new Error(`marketstack HTTP ${res.status}`)
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
  if (!res.ok) throw new Error(`marketstack HTTP ${res.status}`)
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
