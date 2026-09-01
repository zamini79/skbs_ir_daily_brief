/**
 * **실행 하나가 분당 한도 재시도에 쓸 수 있는 대기 시간의 총량.**
 *
 * ## 왜 있는가 — `exhaustedModels` 가 차단기였다는 사실
 *
 * 2026-09-01 이전에는 quotaId 없는 429 도 `'quota'` 로 읽어 `exhaustedModels` 에
 * 넣었다. 그 판정 자체는 틀렸지만(1분이면 풀릴 것을 하루 종일 뺐다), **부작용으로
 * 차단기 역할을 하고 있었다**: 첫 후보에서 체인 7개가 전부 기록되면 둘째 후보부터는
 * `candidates.length === 0` 이 네트워크 호출 없이 즉시 던져, 실행 전체가 7회 호출로
 * 끝났다.
 *
 * 판정을 고치면서 그 차단기가 함께 꺼졌다. 고친 뒤의 산술(리뷰 실측 근거):
 *
 *     후보 1건당  7개 모델 × 3회 = 21회 호출,  7 × (20초+40초) = 420초 대기
 *     후보 42건   →  882회 호출,  약 4.9시간
 *
 * 「분당을 하루로 오판하는 쪽이 더 비싸다」는 비대칭 논거는 **모델 하나 기준으로만**
 * 맞았다. 후보 수의 곱셈이 빠져 있었다. 그래서 판정은 그대로 두고(그쪽이 옳다)
 * **곱셈만 끊는 상한**을 여기에 둔다.
 *
 * ## 무엇을 하지 않는가
 *
 * **예산이 끝나도 요약을 그만두지 않는다.** 끊는 것은 *재시도*뿐이고, 남은 후보도
 * 여전히 모델을 하나씩 최소 한 번은 두드린다. 예산 소진을 "이제 발췌로 간다"로
 * 만들면 이번 작업이 없애려던 결과가 그대로 돌아온다.
 *
 * **체인의 순서를 바꾸지 않는다.** 실행 중에 느린 모델을 뒤로 미루는 방식도 검토했지만,
 * 그 순서에는 품질 실측 근거가 붙어 있다(`MODEL_CHAIN_ENTRIES`). 대기 시간이 이
 * 문제의 지배적인 비용이므로 시간에만 상한을 두는 편이 단순하고, 품질 정책을
 * 런타임이 몰래 뒤집지 않는다.
 *
 * ## 상한이 두 겹인 이유
 *
 * 이 예산(10분)은 **요약 단계 마감 시한**(`SUMMARY_DEADLINE_MS`, 20분)보다 작다.
 * 안쪽 상한이 "재시도에 이 이상은 쓰지 않는다"를 막고, 바깥 상한이 그래도 늦어진
 * 실행을 **정상 종료 경로로** 끝낸다. 하나만 두면 각각 다른 실패를 놓친다 —
 * 예산만 있으면 후보가 아주 많은 날 마감 없이 늘어지고, 마감만 있으면 그 마감을
 * 재시도 대기가 통째로 먹는다.
 */

/** 한 실행이 분당 한도 재시도 대기에 쓸 수 있는 총 시간. */
export const RATE_LIMIT_WAIT_BUDGET_MS = 10 * 60 * 1000

export type RateLimitBudget = {
  /**
   * `ms` 만큼 기다려도 되는지 묻는다. 남아 있으면 **차감하고** `true`,
   * 모자라면 아무것도 쓰지 않고 `false`.
   *
   * 부분 차감을 하지 않는다 — 20초가 필요한데 5초만 남았다면 그 5초를 기다려도
   * 분당 창은 지나가지 않는다. 쓸모없는 대기를 하느니 재시도를 포기하는 편이 낫다.
   */
  tryConsume(ms: number): boolean
  /** 지금까지 실제로 쓴 대기 시간. */
  readonly spentMs: number
  /** 예산이 모자라 재시도를 거절한 횟수. **0이 아니면 그날 무슨 일이 있었다는 뜻이다.** */
  readonly deniedCount: number
  /** 이 예산의 총량. 로그·보고에 그대로 싣는다. */
  readonly totalMs: number
}

export function createRateLimitBudget(totalMs: number = RATE_LIMIT_WAIT_BUDGET_MS): RateLimitBudget {
  let spentMs = 0
  let deniedCount = 0

  return {
    tryConsume(ms: number): boolean {
      if (spentMs + ms > totalMs) {
        deniedCount++
        return false
      }
      spentMs += ms
      return true
    },
    get spentMs() {
      return spentMs
    },
    get deniedCount() {
      return deniedCount
    },
    get totalMs() {
      return totalMs
    },
  }
}
