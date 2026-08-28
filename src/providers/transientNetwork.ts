/**
 * **`fetch` 자체가 던진 예외**가 일시적 네트워크 장애인지 판별한다.
 *
 * 응답을 받았을 때(HTTP 5xx 등)의 판정과는 다른 문제다. 여기서는 응답 자체가
 * 없었으므로 상태 코드가 없고, `Error` 의 `name` 과 메시지만 남는다:
 *
 *  - `AbortSignal.timeout()` 이 끊으면 `TimeoutError`
 *  - 호출부가 직접 abort 하면 `AbortError`
 *  - undici 는 DNS·소켓 실패를 `TypeError: fetch failed` 로 감싼다
 *
 * **이 파일이 있는 이유는 판정 기준을 한 벌로 두기 위해서다.** 시세 경로
 * (`quote/retry.ts` 의 `classifyQuoteFailure`)와 요약 경로(`summarize/gemini.ts`)가
 * 둘 다 이 질문을 하는데, 목록을 각자 갖고 있으면 한쪽에만 패턴이 추가되어
 * "시세는 재시도하는데 요약은 안 하는" 식으로 조용히 갈라진다. 새 패턴은
 * **여기에만** 추가한다.
 *
 * 두 호출부가 이 결과로 하는 일은 서로 다르고, 그건 의도된 것이다:
 * 시세 경로는 같은 소스를 다시 부르고(`withQuoteRetry`), 요약 경로는 재시도
 * 없이 체인의 다음 모델로 넘어간다(하루 쿼터가 실질 제약이라 같은 모델을 다시
 * 두드릴 이유가 없다).
 *
 * **패턴 목록은 `classifyQuoteFailure` 가 원래 갖고 있던 것과 글자 그대로 같다.**
 * 여기로 옮기면서 늘리지 않았다 — 늘리면 요약 경로뿐 아니라 **시세 경로의 재시도
 * 대상도 함께 바뀐다.** 그건 별개의 판단이므로, 목록을 손댈 때는 두 경로에 미치는
 * 영향을 같이 보고 결정해라.
 */
export function isTransientNetworkError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : ''
  if (name === 'TimeoutError' || name === 'AbortError') return true

  const message = error instanceof Error ? error.message : String(error)
  return TRANSIENT_NETWORK_PATTERN.test(message)
}

/** `isTransientNetworkError` 전용. 목록을 늘릴 때는 위 주석의 경고를 먼저 읽어라. */
const TRANSIENT_NETWORK_PATTERN = /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i
