import type { QuoteTarget } from './index'
import { fetchMarketstackYearOpen } from './marketstack'

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

async function naverYearOpen(symbol: string, year: number): Promise<number | null> {
  const url =
    `https://api.finance.naver.com/siseJson.naver?symbol=${symbol}` +
    `&requestType=1&startTime=${year}0101&endTime=${year}0120&timeframe=day`
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://finance.naver.com/' },
  })
  if (!res.ok) return null
  const rows = parseNaverSiseJson(await res.text())
  if (rows.length === 0) return null
  rows.sort((a, b) => a.date.localeCompare(b.date))
  return rows[0].open // 첫 거래일 '시가'. 종가가 아니다.
}

async function twelveDataYearOpen(symbol: string, year: number): Promise<number | null> {
  const key = process.env.TWELVEDATA_API_KEY
  if (!key) return null
  const url =
    `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1day` +
    `&start_date=${year}-01-01&end_date=${year}-01-20&apikey=${key}`
  const res = await fetch(url)
  if (!res.ok) return null
  const json = (await res.json()) as { values?: Array<{ datetime: string; open: string }> }
  const values = json.values ?? []
  if (values.length === 0) return null
  values.sort((a, b) => a.datetime.localeCompare(b.datetime))
  return Number(values[0].open)
}

/** 연 1회만 부르고 DB(YearOpenPrice)에 캐시한다. 키는 instrument.id. */
export async function fetchYearOpen(
  targets: QuoteTarget[],
  year: number,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()

  const ms = targets.filter(t => t.quoteSource === 'marketstack')
  const others = targets.filter(t => t.quoteSource !== 'marketstack' && t.quoteSource !== 'manual')

  await Promise.all([
    (async () => {
      if (ms.length === 0) return
      try {
        const m = await fetchMarketstackYearOpen(ms.map(t => t.quoteSymbol), year)
        for (const t of ms) {
          const v = m.get(t.quoteSymbol)
          if (v !== undefined) out.set(t.id, v)
        }
      } catch {
        // 연초가는 없어도 나머지 열은 채워야 한다. 조용히 건너뛴다.
      }
    })(),
    ...others.map(async t => {
      try {
        const v =
          t.quoteSource === 'twelvedata'
            ? await twelveDataYearOpen(t.quoteSymbol, year)
            : await naverYearOpen(t.quoteSymbol, year)
        if (v !== null && Number.isFinite(v)) out.set(t.id, v)
      } catch {
        // 위와 같다
      }
    }),
  ])

  return out
}
