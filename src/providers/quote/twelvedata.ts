import type { RawQuote } from '@/domain/types'

type TdQuote = {
  symbol?: string
  close?: string
  previous_close?: string
  currency?: string
  datetime?: string
  status?: string
  message?: string
}

function toRawQuote(q: TdQuote): RawQuote | null {
  if (q.status === 'error') return null
  const close = Number(q.close)
  const prevClose = Number(q.previous_close)
  if (!Number.isFinite(close) || !Number.isFinite(prevClose)) return null
  return {
    close,
    prevClose,
    currency: q.currency ?? 'USD',
    asOf: q.datetime ?? '',
  }
}

/**
 * 미국 종목 전용. 무료 플랜은 비미국 상장을 차단하므로 넣지 말 것.
 * 심볼을 콤마로 묶어 한 번에 호출한다.
 */
export async function fetchTwelveDataQuotes(symbols: string[]): Promise<Map<string, RawQuote>> {
  const out = new Map<string, RawQuote>()
  if (symbols.length === 0) return out

  const key = process.env.TWELVEDATA_API_KEY
  if (!key) throw new Error('TWELVEDATA_API_KEY 없음')

  const url = `https://api.twelvedata.com/quote?symbol=${symbols.join(',')}&apikey=${key}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`twelvedata HTTP ${res.status}`)
  const json = (await res.json()) as Record<string, TdQuote> | TdQuote

  // 심볼이 하나면 객체를 그대로, 여럿이면 심볼을 키로 하는 맵을 준다.
  if (symbols.length === 1) {
    const q = toRawQuote(json as TdQuote)
    if (q) out.set(symbols[0], q)
    return out
  }

  for (const s of symbols) {
    const entry = (json as Record<string, TdQuote>)[s]
    if (!entry) continue
    const q = toRawQuote(entry)
    if (q) out.set(s, q)
  }
  return out
}
