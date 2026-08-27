import type { RawQuote } from '@/domain/types'
import { fetchNaverStock, fetchNaverDomesticIndex, fetchNaverWorldIndex } from './naver'
import { fetchTwelveDataQuotes } from './twelvedata'
import { fetchMarketstackQuotes } from './marketstack'

export type QuoteTarget = { id: string; quoteSource: string; quoteSymbol: string }

/**
 * 종목별 시세를 모은다. 실패는 그 종목의 값을 Error 로 남기고 전체는 계속 간다.
 * 배치 소스(twelvedata/marketstack)는 한 번에 묶어 호출해 무료 한도를 아낀다.
 */
export async function fetchAllQuotes(
  instruments: QuoteTarget[],
): Promise<Map<string, RawQuote | Error>> {
  const out = new Map<string, RawQuote | Error>()

  const perItem = instruments.filter(i =>
    ['naver-stock', 'naver-index'].includes(i.quoteSource),
  )
  const td = instruments.filter(i => i.quoteSource === 'twelvedata')
  const ms = instruments.filter(i => i.quoteSource === 'marketstack')

  await Promise.all([
    // 개별 호출 소스
    ...perItem.map(async i => {
      try {
        let q: RawQuote
        if (i.quoteSource === 'naver-stock') {
          q = await fetchNaverStock(i.quoteSymbol)
        } else if (i.quoteSymbol.startsWith('.')) {
          q = await fetchNaverWorldIndex(i.quoteSymbol)
        } else {
          q = await fetchNaverDomesticIndex(i.quoteSymbol)
        }
        out.set(i.id, q)
      } catch (e) {
        out.set(i.id, e instanceof Error ? e : new Error(String(e)))
      }
    }),

    // 배치 소스
    (async () => {
      if (td.length === 0) return
      try {
        const m = await fetchTwelveDataQuotes(td.map(i => i.quoteSymbol))
        for (const i of td) {
          const q = m.get(i.quoteSymbol)
          out.set(i.id, q ?? new Error(`twelvedata: ${i.quoteSymbol} 응답 없음`))
        }
      } catch (e) {
        for (const i of td) out.set(i.id, e instanceof Error ? e : new Error(String(e)))
      }
    })(),

    (async () => {
      if (ms.length === 0) return
      try {
        const m = await fetchMarketstackQuotes(ms.map(i => i.quoteSymbol))
        for (const i of ms) {
          const q = m.get(i.quoteSymbol)
          out.set(i.id, q ?? new Error(`marketstack: ${i.quoteSymbol} 응답 없음`))
        }
      } catch (e) {
        for (const i of ms) out.set(i.id, e instanceof Error ? e : new Error(String(e)))
      }
    })(),
  ])

  return out
}
