import type { RawQuote } from '@/domain/types'
import { fetchNaverStock, fetchNaverDomesticIndex, fetchNaverWorldIndex } from './naver'
import { fetchTwelveDataQuotes } from './twelvedata'
import { fetchMarketstackQuotes } from './marketstack'
import { fetchKrxIndexQuote } from './krx'

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
    ['naver-stock', 'naver-index', 'krx-index'].includes(i.quoteSource),
  )
  const td = instruments.filter(i => i.quoteSource === 'twelvedata')
  const ms = instruments.filter(i => i.quoteSource === 'marketstack')

  // manual 은 의도적으로 결과에서 제외한다. 그 외 알려지지 않은 quoteSource 는
  // 설정 오류이므로 manual 과 구분되도록 Error 로 남긴다(조용히 사라지면 안 됨).
  //
  // manual 은 지금 쓰는 종목이 없다(코스피200 헬스케어가 krx-index 로 옮겨갔다).
  // 그래도 경로는 남겨 둔다 — 다른 종목이 나중에 쓸 수 있고, 지우면 되돌리기가 번거롭다.
  const known = ['naver-stock', 'naver-index', 'krx-index', 'twelvedata', 'marketstack', 'manual']
  for (const i of instruments) {
    if (!known.includes(i.quoteSource)) {
      out.set(i.id, new Error(`알 수 없는 quoteSource: ${i.quoteSource}`))
    }
  }

  await Promise.all([
    // 개별 호출 소스
    ...perItem.map(async i => {
      try {
        let q: RawQuote
        if (i.quoteSource === 'krx-index') {
          q = await fetchKrxIndexQuote(i.quoteSymbol)
        } else if (i.quoteSource === 'naver-stock') {
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
        const { quotes, failures } = await fetchTwelveDataQuotes(td.map(i => i.quoteSymbol))
        for (const i of td) {
          const q = quotes.get(i.quoteSymbol)
          if (q) {
            out.set(i.id, q)
            continue
          }
          // provider 가 사유를 줬으면 그것을 그대로 싣는다. 여기서 '응답 없음'으로
          // 뭉개면 한도 초과(내일이면 낫는다)와 심볼 오타(고쳐야 한다)가 화면에서
          // 같은 문장이 된다. 사유가 없을 때만 관찰한 사실("응답 없음")을 적는다.
          const reason = failures.get(i.quoteSymbol) ?? '응답 없음'
          out.set(i.id, new Error(`twelvedata: ${i.quoteSymbol} ${reason}`))
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
