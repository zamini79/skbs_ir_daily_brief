/**
 * 시세 수집 경로의 재시도.
 *
 * 수집은 07:40 에 **하루 한 번** 돈다. 그래서 순간적인 장애 한 번이 그 종목의
 * 다섯 칸을 그날 하루 내내 비워 놓고, 담당자에게는 다시 채울 방법이 없다.
 * 실측(2026-08-27, 한 시간 안에 두 번):
 *
 *     twelvedata  HTTP 522   (Cloudflare 연결 타임아웃 — 미국 5행이 통째로 공란)
 *     marketstack HTTP 429   (비미국 4행이 통째로 공란)
 *
 * 둘 다 몇 분 뒤 손으로 다시 부르니 정상이었다. 그 한 번을 여기서 대신 부른다.
 *
 * 설계 규칙 세 가지:
 *
 *  1. **무엇을 재시도할지 가린다.** 401·404 처럼 다시 불러도 같은 답이 오는 실패는
 *     수집 창만 갉아먹는다. 5xx(Cloudflare 52x 포함)·네트워크 오류·429 만 다시 부른다.
 *  2. **한도 초과와 순간 장애는 기다리는 시간이 다르다.** ytdBase.ts 가 이미
 *     같은 구분을 하고 있고(분당 크레딧 리셋 = 61초), 그 값을 그대로 쓴다.
 *     5xx 는 분 단위로 기다릴 이유가 없으므로 짧게 두 번만 더 부른다.
 *  3. **영원히 재시도하지 않는다.** 최악의 경우(429 → 61초 → 5xx → 15초 → 실패)
 *     76초이고, 20분 수집 창에서 감당 가능한 상한이다. 여기서 실패하면 그대로
 *     던져 호출부가 사유와 함께 기록한다 — 재시도가 실패를 감추는 일은 없다.
 *
 * 재시도는 **로그에 남긴다**. 남기지 않으면 서서히 나빠지는 외부 API 가 "가끔
 * 느린 정상"으로 보인다 — 매일 3번씩 재시도로 겨우 붙는 상태를 운영자가 알아야 한다.
 */

/** 재시도 판단용 실패 분류. */
export type QuoteFailureKind = 'rate-limit' | 'transient' | 'permanent'

/** 한도 초과. Twelve Data 무료 티어는 분당 크레딧으로 리셋한다. 1분 + 여유 1초.
 * (ytdBase.ts 의 같은 이름 상수와 같은 값·같은 근거다.) */
const RATE_LIMIT_RETRY_DELAY_MS = 61_000

/** 순간 장애(5xx·네트워크)용 대기. 분 단위로 기다릴 이유가 없다. */
const TRANSIENT_DELAYS_MS = [3_000, 15_000]

/** 한 소스당 총 시도 횟수 상한(최초 1회 + 재시도 2회). */
const MAX_ATTEMPTS = 3

const realSleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/**
 * 실패를 분류한다.
 *
 * 상태 코드는 이 코드베이스의 모든 시세 provider 가 `... HTTP {status}` 형태로
 * 메시지에 싣는다(twelvedata·marketstack·naver·krx 모두, 각 파일의 테스트가
 * 그 형식을 고정한다). 그 숫자를 최우선 신호로 쓰고, 없을 때만 다른 단서를 본다.
 *
 * **모르면 'permanent' 이다** — 재시도하지 않는 쪽이 안전한 기본값이다.
 * 분류를 놓치면 예전과 같은 동작(재시도 없음)일 뿐, 20분 창을 모르는 실패에
 * 낭비하지는 않는다.
 */
export function classifyQuoteFailure(error: unknown): QuoteFailureKind {
  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''

  const http = /HTTP (\d{3})/.exec(message)
  if (http) {
    const status = Number(http[1])
    if (status === 429) return 'rate-limit'
    // 5xx 전부. Cloudflare 의 520~527(522=원본 연결 타임아웃)도 여기에 든다.
    if (status >= 500) return 'transient'
    return 'permanent' // 401·403·404 — 다시 불러도 같은 답이다.
  }

  // 상태 코드 없이 본문 오류 코드로만 오는 경우(marketstack 의 assertOk,
  // twelvedata 의 평면 오류 객체). `\b` 로 묶어 4290 같은 값이 429 로 읽히지 않게 한다.
  if (/\b429\b/.test(message)) return 'rate-limit'

  // fetch 자체가 던진 경우 — 응답이 없었으므로 상태 코드도 없다.
  if (name === 'TimeoutError' || name === 'AbortError') return 'transient'
  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(message)) return 'transient'

  return 'permanent'
}

/**
 * `fn` 을 부르고, 실패가 일시적이면 정해진 횟수만큼 다시 부른다.
 * 성공하면 그 값을, 끝내 실패하면 **마지막 예외를 그대로** 던진다(사유가 바뀌지 않는다).
 *
 * 재시도 전에 아무것도 기록하지 않는다는 것이 중요하다 — 이 함수는 수집 단계
 * 안에서만 돌고, 실패 기록(QuoteSnapshot.errorMessage·quoteFailed 카운터)은
 * 여기서 최종 결과가 나온 뒤에 만들어진다. 그래서 재시도가 이미 집계된 실패를
 * 되돌리는 일이 구조적으로 없다.
 */
export async function withQuoteRetry<T>(
  label: string,
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = realSleep,
): Promise<T> {
  let rateLimitRetried = false

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (e) {
      const kind = classifyQuoteFailure(e)
      const message = e instanceof Error ? e.message : String(e)
      if (kind === 'permanent' || attempt >= MAX_ATTEMPTS) throw e

      let delay: number
      if (kind === 'rate-limit') {
        // 61초를 두 번 기다리면 수집 창을 2분 넘게 쓴다. 한도 초과는 한 번만 봐준다.
        if (rateLimitRetried) throw e
        rateLimitRetried = true
        delay = RATE_LIMIT_RETRY_DELAY_MS
      } else {
        delay = TRANSIENT_DELAYS_MS[attempt - 1]
      }

      // 사유와 대기 시간을 남긴다. URL 은 싣지 않는다 — 키가 쿼리스트링에 있다.
      console.error(`[quote] ${label} ${kind} 재시도 ${attempt}/${MAX_ATTEMPTS - 1} (${delay}ms 후): ${message}`)
      await sleep(delay)
    }
  }
}
