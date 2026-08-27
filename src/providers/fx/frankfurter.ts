const BASE = 'https://api.frankfurter.dev/v1/latest'

/**
 * 각 통화 1단위가 몇 원인지 반환한다.
 * Frankfurter 는 base 통화 1단위당 상대 통화량을 주므로,
 * base=USD 로 한 번만 호출하고 KRW/해당통화 로 나눠 계산한다.
 */
export async function fetchFxToKrw(currencies: string[]): Promise<Record<string, number>> {
  const wanted = [...new Set(currencies)]
  const nonKrw = wanted.filter(c => c !== 'KRW')

  const result: Record<string, number> = {}
  if (wanted.includes('KRW')) result.KRW = 1
  if (nonKrw.length === 0) return result

  const symbols = [...new Set(['KRW', ...nonKrw])].join(',')
  const res = await fetch(`${BASE}?base=USD&symbols=${symbols}`)
  if (!res.ok) throw new Error(`frankfurter ${res.status}`)
  const json = (await res.json()) as { rates: Record<string, number> }

  const usdToKrw = json.rates.KRW
  if (!usdToKrw) throw new Error('frankfurter: KRW rate missing')

  for (const c of nonKrw) {
    if (c === 'USD') {
      result.USD = usdToKrw
      continue
    }
    const usdToC = json.rates[c]
    if (!usdToC) continue
    result[c] = usdToKrw / usdToC
  }
  return result
}
