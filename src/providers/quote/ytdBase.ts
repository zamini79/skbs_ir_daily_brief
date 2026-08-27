import type { QuoteTarget } from './index'
import { fetchMarketstackYtdBase } from './marketstack'
import { parseKoreanNumber } from './naverParse'

/** 기준가를 얻지 못한 종목 하나. 조용히 사라지지 않도록 반드시 호출자에게 돌려준다. */
export type YtdBaseFailure = { id: string; symbol: string; reason: string }

export type YtdBaseResult = {
  prices: Map<string, number>
  failures: YtdBaseFailure[]
}

/** Twelve Data 무료 티어는 분당 크레딧으로 한도를 리셋한다. 1분 + 여유 1초. */
const RATE_LIMIT_RETRY_DELAY_MS = 61_000

/**
 * 해외 지수 일별 시세 페이징 상한. pageSize 60(API 최대)이므로 5페이지 = 약 300거래일,
 * 즉 14개월치다. 운영은 1월에 도니 1페이지로 끝나고, 연중에 처음 캐시를 채우는 경우에도
 * 전년 말까지 닿는다(8월 실행 시 3페이지에서 경계를 만난다 — 실측 확인).
 */
const INDEX_PAGE_SIZE = 60
const INDEX_MAX_PAGES = 5

const NAVER_INDEX_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  Referer: 'https://m.stock.naver.com/',
}

const realSleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/**
 * 네이버 siseJson 은 헤더 행에 홑따옴표를 써서 유효한 JSON 이 아니다.
 * 데이터 행만 정규식으로 뽑는다.
 */
export function parseNaverSiseJson(raw: string): Array<{ date: string; open: number; close: number }> {
  const out: Array<{ date: string; open: number; close: number }> = []
  const re = /\["(\d{8})",\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    out.push({ date: m[1], open: Number(m[2]), close: Number(m[5]) })
  }
  return out
}

/**
 * 국내 종목·지수. siseJson 은 국내 전용이라 해외 지수(.INX/.IXIC)에는 오류가 아니라
 * 헤더 행만 있는 빈 응답을 준다 — 그 경우 null 을 주고 호출자가 폴백하게 한다.
 */
async function naverYtdBase(symbol: string, year: number): Promise<number | null> {
  const prev = year - 1
  const url =
    `https://api.finance.naver.com/siseJson.naver?symbol=${symbol}` +
    `&requestType=1&startTime=${prev}1201&endTime=${prev}1231&timeframe=day`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.naver.com/' },
  })
  if (!res.ok) return null
  const rows = parseNaverSiseJson(await res.text())
  if (rows.length === 0) return null
  rows.sort((a, b) => a.date.localeCompare(b.date))
  return rows[rows.length - 1].close // 전년 마지막 거래일 종가 (스펙 §3.5)
}

/**
 * 해외 지수(.INX/.IXIC) 전용. siseJson 이 못 받는 심볼을 여기로 보낸다.
 * 최신순 페이징이므로 "연도가 대상 연도보다 작은 첫 행" = 전년 마지막 거래일이다.
 *
 * 날짜는 `localTradedAt` 문자열 앞 4자를 그대로 읽는다. `new Date()` 로 파싱하면
 * `2025-12-31T16:36:05-05:00` 이 KST 로 2026-01-01 이 되어 연도 비교가 뒤집힌다 —
 * 그 문자열의 날짜는 이미 그 시장의 거래일이므로 변환하면 안 된다.
 *
 * 마지막 거래일이 며칠인지 가정하지 않는다. 미국 지수의 2025년 마지막 거래일은
 * 12/31 이고 국내는 12/30 이다 — 날짜가 아니라 연도 경계로 찾는다.
 */
async function naverIndexYtdBase(code: string, year: number): Promise<number | null> {
  for (let page = 1; page <= INDEX_MAX_PAGES; page++) {
    const url =
      `https://api.stock.naver.com/index/${encodeURIComponent(code)}/price` +
      `?pageSize=${INDEX_PAGE_SIZE}&page=${page}`
    const res = await fetch(url, { headers: NAVER_INDEX_HEADERS })
    if (!res.ok) return null

    const json: unknown = await res.json()
    if (!Array.isArray(json) || json.length === 0) return null

    const rows = json as Array<{ localTradedAt?: string; closePrice?: string }>
    for (const row of rows) {
      const stamp = row.localTradedAt ?? ''
      if (stamp.length < 4) continue
      if (Number(stamp.slice(0, 4)) >= year) continue
      // 전년의 첫 등장 행 = 전년 마지막 거래일 (응답이 최신순이므로)
      const close = parseKoreanNumber(row.closePrice ?? '') // "6,845.50" — 콤마 제거 필요
      return Number.isFinite(close) ? close : null
    }
  }
  return null // 상한까지 못 찾음. 호출자가 사유를 남긴다.
}

type TdSeries = { status?: string; message?: string; values?: Array<{ datetime: string; close: string }> }

/** 429 는 HTTP 상태로도, 본문 `code` 로도 온다(실측: 둘 다 함께 온다). 양쪽을 본다. */
function isRateLimited(status: number, body: unknown): boolean {
  if (status === 429) return true
  return (body as { code?: number } | null)?.code === 429
}

/** 전년 12월 마지막 거래일 종가를 뽑는다. 값이 없거나 이상하면 null. */
function lastCloseOf(series: TdSeries | undefined): number | null {
  const values = series?.values ?? []
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a.datetime.localeCompare(b.datetime))
  const close = Number(sorted[sorted.length - 1].close)
  return Number.isFinite(close) ? close : null
}

/**
 * 미국 종목. **심볼을 한 요청으로 묶는다.**
 *
 * 크레딧은 배치로 묶어도 심볼당 1이라 총량은 줄지 않는다(무료 티어 분당 8).
 * 묶는 목적은 재시도를 단순하게 만드는 것이다 — 요청이 하나면 한도 초과가
 * 전부-성공/전부-429 로 결정적으로 갈리므로, 재시도 1회로 전체가 복구된다.
 * 개별 호출로 쏘면 어느 종목이 429 를 맞을지가 매번 달라져 재현되지 않는다.
 */
async function twelveDataYtdBase(
  symbols: string[],
  year: number,
  sleep: (ms: number) => Promise<void>,
): Promise<{ prices: Map<string, number>; failures: Array<{ symbol: string; reason: string }> }> {
  const prices = new Map<string, number>()
  const failures: Array<{ symbol: string; reason: string }> = []
  if (symbols.length === 0) return { prices, failures }

  const key = process.env.TWELVEDATA_API_KEY
  if (!key) {
    for (const s of symbols) failures.push({ symbol: s, reason: 'TWELVEDATA_API_KEY 없음' })
    return { prices, failures }
  }

  const prev = year - 1
  // URL 에 키가 들어간다. 이 문자열을 로그·에러 메시지에 절대 싣지 마라.
  const url =
    `https://api.twelvedata.com/time_series?symbol=${symbols.join(',')}&interval=1day` +
    `&start_date=${prev}-12-01&end_date=${prev}-12-31&apikey=${key}`

  let json: unknown = null
  let lastReason = ''
  // 시도 2회까지: 한도 초과는 분당 리셋이므로 61초 기다린 뒤 딱 한 번만 다시 부른다.
  // 이 경로는 연 1회(그 해 첫 실행)만 도는데다 수집 창이 20분이라 여유가 있다.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(url)
    let body: unknown = null
    try {
      body = await res.json()
    } catch {
      body = null
    }

    if (isRateLimited(res.status, body)) {
      lastReason = '분당 API 크레딧 소진(429)'
      if (attempt === 1) {
        await sleep(RATE_LIMIT_RETRY_DELAY_MS)
        continue
      }
      break
    }
    if (!res.ok) {
      lastReason = `twelvedata HTTP ${res.status}`
      break
    }
    json = body
    break
  }

  if (json === null) {
    const reason = lastReason || 'twelvedata 응답 없음'
    for (const s of symbols) failures.push({ symbol: s, reason })
    return { prices, failures }
  }

  // 심볼이 하나면 시계열을 그대로, 여럿이면 심볼을 키로 하는 맵을 준다
  // (fetchTwelveDataQuotes 와 같은 분기다).
  const seriesOf = (s: string): TdSeries | undefined =>
    symbols.length === 1 ? (json as TdSeries) : (json as Record<string, TdSeries>)[s]

  for (const s of symbols) {
    const series = seriesOf(s)
    if (!series) {
      failures.push({ symbol: s, reason: '응답에 심볼 없음' })
      continue
    }
    if (series.status === 'error') {
      failures.push({ symbol: s, reason: series.message ?? 'twelvedata 오류 응답' })
      continue
    }
    const close = lastCloseOf(series)
    if (close === null) {
      failures.push({ symbol: s, reason: `${prev}년 12월 거래일 데이터 없음` })
      continue
    }
    prices.set(s, close)
  }
  return { prices, failures }
}

/**
 * 연초대비(YTD) 기준가 = 전년도 마지막 거래일의 종가 (스펙 §3.5).
 * 연 1회만 부르고 DB(YtdBasePrice)에 캐시한다. 키는 instrument.id.
 *
 * 실패를 삼키지 않는다. 기준가가 없어도 나머지 열은 계속 채우지만(그 판단은 옳다),
 * 어느 종목이 왜 비었는지는 반드시 `failures` 로 돌려준다 — 재현되지 않는 공란이
 * 이 결함의 본질이었다.
 */
export async function fetchYtdBase(
  targets: QuoteTarget[],
  year: number,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<YtdBaseResult> {
  const sleep = opts.sleep ?? realSleep
  const prices = new Map<string, number>()
  const failures: YtdBaseFailure[] = []

  const ms = targets.filter(t => t.quoteSource === 'marketstack')
  const td = targets.filter(t => t.quoteSource === 'twelvedata')
  const naver = targets.filter(t => t.quoteSource === 'naver-stock' || t.quoteSource === 'naver-index')

  // manual 은 의도적으로 건너뛴다(수기 입력 대상). 그 외 모르는 소스는 설정 오류이므로
  // 조용히 사라지지 않도록 실패로 남긴다.
  for (const t of targets) {
    const known = ['marketstack', 'twelvedata', 'naver-stock', 'naver-index', 'manual']
    if (!known.includes(t.quoteSource)) {
      failures.push({ id: t.id, symbol: t.quoteSymbol, reason: `알 수 없는 quoteSource: ${t.quoteSource}` })
    }
  }

  await Promise.all([
    (async () => {
      if (ms.length === 0) return
      try {
        const m = await fetchMarketstackYtdBase(ms.map(t => t.quoteSymbol), year)
        for (const t of ms) {
          const v = m.get(t.quoteSymbol)
          if (v !== undefined) prices.set(t.id, v)
          else failures.push({ id: t.id, symbol: t.quoteSymbol, reason: 'marketstack 응답에 데이터 없음' })
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        for (const t of ms) failures.push({ id: t.id, symbol: t.quoteSymbol, reason })
      }
    })(),

    (async () => {
      if (td.length === 0) return
      try {
        const r = await twelveDataYtdBase(td.map(t => t.quoteSymbol), year, sleep)
        for (const t of td) {
          const v = r.prices.get(t.quoteSymbol)
          if (v !== undefined) {
            prices.set(t.id, v)
            continue
          }
          const f = r.failures.find(x => x.symbol === t.quoteSymbol)
          failures.push({ id: t.id, symbol: t.quoteSymbol, reason: f?.reason ?? 'twelvedata 응답 없음' })
        }
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        for (const t of td) failures.push({ id: t.id, symbol: t.quoteSymbol, reason })
      }
    })(),

    ...naver.map(async t => {
      try {
        let v = await naverYtdBase(t.quoteSymbol, year)

        // siseJson 은 국내 전용이다. 해외 지수는 오류가 아니라 빈 응답을 주므로
        // 심볼 문자열로 분기하지 않고 "빈 결과면 지수 전용 경로로 폴백"한다.
        // KOSPI 는 siseJson 이 정상 응답하므로 여기까지 오지 않는다.
        if (v === null && t.quoteSource === 'naver-index') {
          v = await naverIndexYtdBase(t.quoteSymbol, year)
        }

        if (v !== null && Number.isFinite(v)) prices.set(t.id, v)
        else failures.push({ id: t.id, symbol: t.quoteSymbol, reason: '네이버 전년 12월 종가 없음' })
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        failures.push({ id: t.id, symbol: t.quoteSymbol, reason })
      }
    }),
  ])

  return { prices, failures }
}
