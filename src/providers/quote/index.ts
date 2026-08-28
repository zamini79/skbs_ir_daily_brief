import type { RawQuote } from '@/domain/types'
import {
  fetchNaverStock,
  fetchNaverDomesticIndex,
  fetchNaverWorldIndex,
  fetchNaverWorldStock,
} from './naver'
import { fetchTwelveDataQuotes } from './twelvedata'
import { fetchMarketstackQuotes } from './marketstack'
import { fetchKrxIndexQuote } from './krx'
import { fetchLseQuote } from './lse'
import { fetchSixQuote } from './six'
import { fetchFtQuote } from './ft'
import { withQuoteRetry } from './retry'

export type QuoteTarget = {
  id: string
  quoteSource: string
  quoteSymbol: string
  /**
   * 1차가 실패했을 때**만** 부르는 2차 소스. 없으면 폴백하지 않는다.
   * 지금은 `'ft'` 하나뿐이다(비미국 4종목). 시드에서 온다.
   */
  quoteFallbackSource?: string | null
  /** 2차 소스의 심볼 표기. 1차와 다르다(`SAN.PA` ↔ `SAN:PAR`). */
  quoteFallbackSymbol?: string | null
}

/**
 * 값을 얻은 결과. **어느 소스가 실제로 채웠는지를 함께 들고 다닌다.**
 *
 * 전에는 `collect.ts` 가 `QuoteSnapshot.sourceName` 에 항상 시드의 `quoteSource`
 * (설정값)를 넣었다. 폴백이 도는 순간 그 값은 **거짓말**이 된다 — 화면과 DB 는
 * marketstack 이 채웠다고 말하는데 실제로는 FT 가 채운 값이다. 나중에 "언제부터
 * 1차가 죽어 있었나"를 되짚을 근거가 통째로 사라진다.
 */
export type QuoteHit = RawQuote & {
  /** 실제로 값을 가져온 소스. 폴백이 돌았으면 2차 소스 이름이다. */
  sourceName: string
  /** 폴백으로 채웠으면 실패한 1차 소스 이름, 평소에는 null. */
  fallbackFrom: string | null
}

/** 폴백 단계가 아는 2차 소스. 여기 없는 이름은 조용히 건너뛰지 않고 실패로 남긴다. */
const FALLBACK_FETCHERS: Record<string, (symbol: string) => Promise<RawQuote>> = {
  ft: fetchFtQuote,
}

/**
 * 종목별 시세를 모은다. 실패는 그 종목의 값을 Error 로 남기고 전체는 계속 간다.
 * 배치 소스(twelvedata/marketstack)는 한 번에 묶어 호출해 무료 한도를 아낀다.
 *
 * 소스 호출은 전부 `withQuoteRetry` 로 감싼다. 수집은 하루 한 번(07:40)만 돌아서
 * 순간적인 5xx·429 한 번이 그 종목의 다섯 칸을 하루 종일 비워 놓고 담당자가 다시
 * 채울 방법이 없다 — 실측으로 twelvedata 522, marketstack 429 를 한 시간 안에
 * 두 번 봤고 둘 다 몇 분 뒤 정상이었다. 무엇을 얼마나 다시 부르는지는 retry.ts 참고.
 * `opts.sleep` 은 테스트가 실제로 기다리지 않게 하기 위한 것이다(ytdBase.fetchYtdBase,
 * news/naver.searchNaverNews 와 같은 방식).
 *
 * **1차가 끝난 뒤 폴백 단계가 따로 돈다**(아래 참고). 두 단계로 나눈 이유는 배치
 * 소스 때문이다 — 사노피의 1차는 marketstack 이고 그 실패는 배치 전체가 끝나야
 * 확정된다. 개별 호출 안에서 폴백하면 배치 실패는 폴백을 못 받는다.
 */
export async function fetchAllQuotes(
  instruments: QuoteTarget[],
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<Map<string, QuoteHit | Error>> {
  const retry = <T>(label: string, fn: () => Promise<T>): Promise<T> =>
    withQuoteRetry(label, fn, opts.sleep)
  const out = new Map<string, QuoteHit | Error>()

  /** 1차가 채운 값. 폴백은 아직 돌지 않았다. */
  const primaryHit = (source: string, q: RawQuote): QuoteHit => ({
    ...q,
    sourceName: source,
    fallbackFrom: null,
  })

  // lse·six·naver-world-stock 은 marketstack 에서 옮겨 온 세 종목이다(Task 31).
  // 전부 키가 없고 심볼당 한 번 부르므로 배치로 묶을 이유가 없다 — 개별 호출 쪽에 든다.
  const perItem = instruments.filter(i =>
    ['naver-stock', 'naver-index', 'naver-world-stock', 'krx-index', 'lse', 'six'].includes(
      i.quoteSource,
    ),
  )
  const td = instruments.filter(i => i.quoteSource === 'twelvedata')
  const ms = instruments.filter(i => i.quoteSource === 'marketstack')

  // manual 은 의도적으로 결과에서 제외한다. 그 외 알려지지 않은 quoteSource 는
  // 설정 오류이므로 manual 과 구분되도록 Error 로 남긴다(조용히 사라지면 안 됨).
  //
  // manual 은 지금 쓰는 종목이 없다(코스피200 헬스케어가 krx-index 로 옮겨갔다).
  // 그래도 경로는 남겨 둔다 — 다른 종목이 나중에 쓸 수 있고, 지우면 되돌리기가 번거롭다.
  const known = [
    'naver-stock', 'naver-index', 'naver-world-stock', 'krx-index',
    'lse', 'six', 'twelvedata', 'marketstack', 'manual',
  ]
  for (const i of instruments) {
    if (!known.includes(i.quoteSource)) {
      out.set(i.id, new Error(`알 수 없는 quoteSource: ${i.quoteSource}`))
    }
  }

  await Promise.all([
    // 개별 호출 소스
    ...perItem.map(async i => {
      try {
        const q = await retry(i.quoteSymbol, () => {
          if (i.quoteSource === 'krx-index') return fetchKrxIndexQuote(i.quoteSymbol)
          if (i.quoteSource === 'lse') return fetchLseQuote(i.quoteSymbol)
          if (i.quoteSource === 'six') return fetchSixQuote(i.quoteSymbol)
          if (i.quoteSource === 'naver-world-stock') return fetchNaverWorldStock(i.quoteSymbol)
          if (i.quoteSource === 'naver-stock') return fetchNaverStock(i.quoteSymbol)
          // 여기까지 오면 naver-index 다. 해외 지수만 심볼이 . 로 시작한다.
          if (i.quoteSymbol.startsWith('.')) return fetchNaverWorldIndex(i.quoteSymbol)
          return fetchNaverDomesticIndex(i.quoteSymbol)
        })
        out.set(i.id, primaryHit(i.quoteSource, q))
      } catch (e) {
        out.set(i.id, e instanceof Error ? e : new Error(String(e)))
      }
    }),

    // 배치 소스
    (async () => {
      if (td.length === 0) return
      try {
        const { quotes, failures } = await retry('twelvedata', () =>
          fetchTwelveDataQuotes(td.map(i => i.quoteSymbol)),
        )
        for (const i of td) {
          const q = quotes.get(i.quoteSymbol)
          if (q) {
            out.set(i.id, primaryHit(i.quoteSource, q))
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
        const m = await retry('marketstack', () => fetchMarketstackQuotes(ms.map(i => i.quoteSymbol)))
        for (const i of ms) {
          const q = m.get(i.quoteSymbol)
          out.set(
            i.id,
            q ? primaryHit(i.quoteSource, q) : new Error(`marketstack: ${i.quoteSymbol} 응답 없음`),
          )
        }
      } catch (e) {
        for (const i of ms) out.set(i.id, e instanceof Error ? e : new Error(String(e)))
      }
    })(),
  ])

  await runFallbacks(instruments, out, retry)
  return out
}

/**
 * 2차 소스 단계. **1차가 실패한 종목만** 부른다.
 *
 * 두 소스를 동시에 부르지 않는 것이 중요하다 — 평소(1차가 멀쩡한 날)에도 FT 를
 * 부르면 우리가 아무것도 얻지 못하면서 남의 부하만 두 배로 만든다. HTML 스크래핑
 * 의존을 2차에만 두기로 한 판단(ft.ts 주석)과도 어긋난다.
 *
 * **폴백이 실패하면 두 사유를 모두 남긴다.** 한쪽만 남기면 "1차가 왜 죽었는지"가
 * 사라져 원인 추적이 거기서 끊긴다 — 운영자가 보는 것은 이 문장 하나뿐이다.
 *
 * 폴백이 성공하면 **로그에 반드시 남긴다.** 값이 채워졌으니 화면은 평소와 같고
 * (행의 작은 배지 하나가 유일한 단서다), 로그마저 없으면 1차 소스가 몇 주째 죽어
 * 있어도 아무도 모른다. 이 줄이 매일 찍히면 1차를 고쳐야 한다는 뜻이다.
 */
async function runFallbacks(
  instruments: QuoteTarget[],
  out: Map<string, QuoteHit | Error>,
  retry: <T>(label: string, fn: () => Promise<T>) => Promise<T>,
): Promise<void> {
  const pending = instruments.filter(i => {
    const r = out.get(i.id)
    // manual 처럼 결과가 아예 없는 종목은 실패가 아니다 — 폴백 대상도 아니다.
    return r instanceof Error && !!i.quoteFallbackSource
  })

  await Promise.all(
    pending.map(async i => {
      const primaryError = out.get(i.id) as Error
      const source = i.quoteFallbackSource as string
      const symbol = (i.quoteFallbackSymbol ?? '').trim()
      try {
        const fetcher = FALLBACK_FETCHERS[source]
        // 설정 오류를 조용히 건너뛰지 않는다. 건너뛰면 "폴백이 있는데 왜 안 도나"를
        // 알아낼 방법이 없다 — 화면에는 1차 사유만 남아 폴백이 없는 종목과 똑같이 보인다.
        if (!fetcher) throw new Error(`알 수 없는 폴백 소스: ${source}`)
        if (symbol === '') throw new Error(`폴백 심볼이 비어 있음(${source})`)

        // 폴백도 재시도를 태운다. 1차가 이미 죽은 상태라 이 호출이 그 행의 마지막
        // 기회다 — 여기서 순간적인 5xx 한 번에 하루치를 버릴 이유가 없다.
        const q = await retry(`${symbol}(${source} 폴백)`, () => fetcher(symbol))
        out.set(i.id, { ...q, sourceName: source, fallbackFrom: i.quoteSource })
        console.error(
          `[quote] ${i.quoteSymbol}: 1차(${i.quoteSource}) 실패로 2차(${source})를 썼다` +
            ` — 1차 사유: ${primaryError.message}`,
        )
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e)
        // 두 사유를 한 줄에 모두 싣는다. 앞쪽이 1차, 뒤쪽이 2차다.
        out.set(i.id, new Error(`${primaryError.message} | 폴백(${source}) 실패: ${reason}`))
      }
    }),
  )
}
