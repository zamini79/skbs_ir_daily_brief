import type { RawQuote } from '@/domain/types'

type TdQuote = {
  symbol?: string
  close?: string
  previous_close?: string
  currency?: string
  datetime?: string
  status?: string
  code?: number
  message?: string
}

/**
 * 시세를 얻었거나, 못 얻은 **사유**를 들고 있다. null 로 뭉개지 않는 것이 요점이다 —
 * `symbol not found`(설정 오류, 심볼을 고쳐야 한다)와 `You have run out of API
 * credits`(한도, 내일이면 낫는다)와 "응답에 그 심볼이 없음"이 전부 같은 문자열이
 * 되면, 화면에 뜬 사유를 보고도 무엇을 해야 할지 알 수 없다.
 */
type QuoteOrReason = { ok: true; quote: RawQuote } | { ok: false; reason: string }

export type TwelveDataQuotes = {
  quotes: Map<string, RawQuote>
  /** 심볼 -> 실패 사유. 성공한 심볼은 여기 없다. 사유를 지어내지 않는다 —
   * API 가 message 를 줬으면 그 원문이고, 안 줬으면 우리가 관찰한 사실만 적는다. */
  failures: Map<string, string>
}

/**
 * 문자열 → 숫자. 빈 문자열은 `Number('')` 가 0 이라 그럴듯한 가격으로 둔갑한다 —
 * 명시적으로 걸러 NaN 을 돌려주고 호출자가 사유와 함께 실패로 남기게 한다.
 * (krx.ts 의 `toNumber` 와 같은 이유·같은 규칙이다.)
 */
function toNumber(raw: string | undefined): number {
  if (typeof raw !== 'string' || raw.trim() === '') return NaN
  return Number(raw)
}

function toRawQuote(q: TdQuote): QuoteOrReason {
  // status==='error' 이면 message 가 유일한 단서다. 버리지 마라(ytdBase.ts:206 과 같은 처리).
  if (q.status === 'error') return { ok: false, reason: q.message ?? 'twelvedata 오류 응답' }
  const close = toNumber(q.close)
  const prevClose = toNumber(q.previous_close)
  if (!Number.isFinite(close) || !Number.isFinite(prevClose)) {
    return { ok: false, reason: 'close/previous_close 가 없거나 숫자가 아님' }
  }
  return {
    ok: true,
    quote: {
      close,
      prevClose,
      currency: q.currency ?? 'USD',
      asOf: q.datetime ?? '',
    },
  }
}

/**
 * 미국 종목 전용. 무료 플랜은 비미국 상장을 차단하므로 넣지 말 것.
 * 심볼을 콤마로 묶어 한 번에 호출한다.
 *
 * 실패한 심볼은 조용히 사라지지 않는다 — `failures` 에 사유와 함께 남는다.
 */
export async function fetchTwelveDataQuotes(symbols: string[]): Promise<TwelveDataQuotes> {
  const quotes = new Map<string, RawQuote>()
  const failures = new Map<string, string>()
  if (symbols.length === 0) return { quotes, failures }

  const key = process.env.TWELVEDATA_API_KEY
  if (!key) throw new Error('TWELVEDATA_API_KEY 없음')

  // URL 에 키가 들어간다. 이 문자열을 로그·에러 메시지에 절대 싣지 마라.
  const url = `https://api.twelvedata.com/quote?symbol=${symbols.join(',')}&apikey=${key}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`twelvedata HTTP ${res.status}`)
  const json = (await res.json()) as Record<string, TdQuote> | TdQuote

  // 심볼이 하나면 객체를 그대로, 여럿이면 심볼을 키로 하는 맵을 준다.
  if (symbols.length === 1) {
    const r = toRawQuote(json as TdQuote)
    if (r.ok) quotes.set(symbols[0], r.quote)
    else failures.set(symbols[0], r.reason)
    return { quotes, failures }
  }

  // **한도 초과는 심볼별 맵이 아니라 평면 오류 객체로 온다** (HTTP 200 +
  // `{"code":429,"status":"error","message":"You have run out of API credits..."}`).
  // 심볼 루프에 그대로 들어가면 `json[s]` 가 전부 undefined 라서 미국 5행이
  // 한꺼번에 "응답 없음"이 된다 — 원인이 한도라는 사실이 통째로 사라진다.
  // 그래서 루프 전에 감지해 배치 전체의 사유로 승격시킨다.
  const flat = json as TdQuote
  if (flat.status === 'error') {
    // 심볼별 실패가 아니라 **배치 전체의 실패**다. marketstack 의 assertOk 와 같은
    // 상황이므로 같은 방식으로 던진다 — 호출부(index.ts)의 catch 가 이 메시지를
    // 그대로 배치 전 종목의 사유로 싣고, 재시도 판단(retry.ts)도 code 를 볼 수 있다.
    // 던지지 않고 failures 로만 돌려주면 한도 초과가 재시도 대상에서 빠진다.
    const code = flat.code ? ` (code ${flat.code})` : ''
    throw new Error(`twelvedata 오류 응답${code}: ${flat.message ?? '사유 없음'}`)
  }

  for (const s of symbols) {
    const entry = (json as Record<string, TdQuote>)[s]
    if (!entry) {
      failures.set(s, '응답에 심볼 없음')
      continue
    }
    const r = toRawQuote(entry)
    if (r.ok) quotes.set(s, r.quote)
    else failures.set(s, r.reason)
  }
  return { quotes, failures }
}
