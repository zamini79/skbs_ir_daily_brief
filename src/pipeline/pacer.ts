/**
 * 외부 API 호출 **사이의 최소 간격**을 지키는 게이트.
 *
 * `pLimit`(limit.ts)이 "동시에 몇 개"를 정한다면 이쪽은 "얼마나 자주"를 정한다.
 * 둘이 다른 축이라 하나로는 부족하다: 동시성을 1로 내려도 응답이 1.5초에 오는
 * 모델이면 초당 0.6회, 즉 **분당 40회**를 쏜다. Gemini 무료 티어의 분당 한도는
 * 모델당 대략 15~17회다(2026-09-01 실측: 한 모델에 25건 동시 투입 → 200 이 17건,
 * 429 가 8건, 8건 전부 `GenerateRequestsPerMinutePerProjectPerModel-FreeTier`).
 *
 * 지연은 **직전 호출 이후 흐른 시간을 빼고 남은 만큼만** 기다린다. 호출 자체가
 * 이미 간격보다 오래 걸렸으면 기다리지 않는다 — 고정 sleep 을 쓰면 느린 모델에
 * 걸린 날 대기가 두 배로 붙는다.
 *
 * `sleep` 과 `now` 를 주입받는 이유는 테스트가 실제로 6초를 기다리지 않게 하기
 * 위해서다(`quote/retry.ts` 의 `withQuoteRetry(…, sleep)` 과 같은 방식).
 */

const realSleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

export type Pacer = () => Promise<void>

export function createPacer(
  minIntervalMs: number,
  sleep: (ms: number) => Promise<void> = realSleep,
  now: () => number = Date.now,
): Pacer {
  /** 다음 호출이 나가도 되는 가장 이른 시각. 첫 호출은 기다리지 않는다. */
  let nextAllowedAt = 0

  return async function pace(): Promise<void> {
    const t = now()
    const startAt = Math.max(t, nextAllowedAt)
    // **await 앞에서 자리를 예약한다.** 나중에 동시성이 1보다 커지면, 예약을
    // 대기 뒤로 미룬 구현은 여러 호출자가 같은 시각을 읽고 한꺼번에 나가버린다 —
    // 간격 제한이 조용히 사라지는 형태의 결함이다.
    nextAllowedAt = startAt + minIntervalMs
    const wait = startAt - t
    if (wait > 0) await sleep(wait)
  }
}
