import type { RateLimitBudget } from '@/providers/summarize/rateLimitBudget'

/**
 * **요약 호출을 얼마나 빨리 쏠 것인가.** 이 파일의 값은 전부 실측으로 정해졌고,
 * 되돌리면 화면에 「본문 발췌」가 돌아온다.
 *
 * ## 왜 별도 파일인가
 *
 * 원래 이 값들은 `collect.ts` 안의 모듈 상수였다. 그런데 `collect.ts` 는 최상단에서
 * Prisma 를 끌어오므로 테스트가 가볍게 import 할 수 없고, **그래서 아무 테스트도
 * 이 값들을 지키지 않았다.** 리뷰에서 확인된 사실: `await summaryPace()` 를 지워도
 * 테스트 900개가 전부 통과했다. 주석으로 "되돌리지 마라"라고 쓰는 것만으로는
 * 막히지 않는다 — 이 저장소는 같은 위험을 `MODEL_CHAIN_ENTRIES` 에서 이미
 * 테스트로 막았다(「체인 순서 정책」). 같은 처방을 여기에 둔다.
 *
 * ## 두 값을 같이 읽어라 — 하나만 되돌리면 나머지가 뜻을 잃는다
 *
 * 2026-09-01 이전에는 동시성 4, 간격 없음이었다. 응답이 오는 즉시 다음을 쏘므로
 * 순간 속도가 분당 한도를 넘었고, 그날 재수집에서 **후보 42건 중 요약 20건이
 * 실패해 화면 8행에 「본문 발췌」가 나갔다.** 같은 날 후보 29건짜리 첫 실행은
 * 실패 0이었다 — 부하에 따라 터지는 결함이다.
 *
 * 실측 기준선(2026-09-01): 한 모델에 25건을 동시에 던지니 200 이 17건, 429 가 8건
 * 이었고 8건 전부 `GenerateRequestsPerMinutePerProjectPerModel-FreeTier` 였다.
 * 즉 한 모델의 분당 상한은 대략 15~17이다. 여유를 크게 두어 **분당 10회**를 목표로 한다.
 *
 * 바꾼 뒤 실측(2026-09-01): 후보 37건 · 요약 37건 · **실패 0** · 457.7초.
 * 본문 발췌가 실제로 사라졌다. 그 457.7초가 이 감속의 대가이고,
 * **새벽 무인 배치이므로 그것은 비용이 아니다**(2026-09-01 사용자 결정, 설계 §8.1.8).
 * 반대로 「본문 발췌」는 담당자가 화면에서 바로 보는 비용이다.
 *
 * `NEWS_CONCURRENCY`(collect.ts)와 혼동하지 마라 — 그쪽은 속도가 아니라 **실패 분포**
 * 때문에 정해진 값이고 근거가 다르다.
 */

/** 요약 동시 호출 수. 동시성만으로는 순간 속도를 못 잡으므로 아래 간격과 한 벌이다. */
export const SUMMARY_CONCURRENCY = 1

/** 분당 10회 = 호출 간 6초. 위 실측이 근거다. */
export const SUMMARY_MIN_INTERVAL_MS = 6_000

/**
 * 요약 호출 하나를 만든다 — **간격 게이트와 실행 단위 예산을 둘 다 물려서.**
 *
 * `attemptSummary` 에 넘길 함수를 만든다. 여기서 만드는 이유는 두 가지다:
 *
 *  - 본문이 짧아 호출 자체를 건너뛰는 후보에 6초를 물리지 않으면서, 그 판정
 *    (`MIN_BODY_CHARS_FOR_SUMMARY`)을 두 곳에 복제하지 않는다.
 *  - **배선이 테스트되는 자리에 있게 한다.** 이 합성이 `collect.ts` 안에 있던 동안
 *    `{ budget }` 을 지워도 933개가 전부 통과했다(리뷰에서 변이로 확인). `collect.ts`
 *    는 최상단에서 Prisma 를 끌어와 테스트가 가볍게 import 할 수 없기 때문이다.
 *
 * ## 예산을 **인자로 받고, 한 번만 받는다**
 *
 * `budget` 은 선택 항목이 아니다. 빼면 **컴파일이 안 된다** — `summarize()` 쪽 기본값
 * (`opts.budget ?? createRateLimitBudget()`)에 기대면 배선을 지워도 타입도 런타임도
 * 조용하고, 호출마다 새 예산이 생겨 한 번도 걸리지 않는다(체인 7개 × 60초 < 기본 600초).
 * 그러면 blocker 1 이 소리 없이 부활한다.
 *
 * 여기서 **하나의 예산을 닫아 넣는다.** 실행 전체가 한 예산을 공유해야 후보 수만큼의
 * 곱셈이 끊기기 때문이다(rateLimitBudget.ts).
 *
 * **다만 이 구조가 보장하는 것은 「빠뜨릴 수 없다」이지 「잘못된 범위를 표현할 수
 * 없다」가 아니다.** 리뷰에서 우회 두 가지가 실제로 통과하는 것을 확인했다: 이 합성
 * 호출을 후보 루프 **안**으로 옮기고 `createRateLimitBudget()` 을 새로 부르는 것,
 * 그리고 `attemptSummary` 에 `{ exceeded: () => false }` 를 인라인으로 넣는 것.
 * 둘 다 tsc 도 943개 테스트도 통과한다.
 *
 * 그래도 이 구조에 값어치가 있는 이유는 **위험의 종류가 다르기 때문**이다. 막으려는
 * 것은 리팩터링 중 `{ budget }` **한 토큰이 사라지는** 사고이고, 그건 실제로 일어났다.
 * 위 우회들은 합성 호출을 옮기고 생성자를 새로 쓰는 **재작성**이라 사고로는 안 난다.
 * 근본 원인은 `collect.ts` 가 Prisma 때문에 테스트 불가라 **거기서만 표현되는 것은
 * 여전히 무방비**라는 것이고, 그건 이 파일이 고칠 수 있는 범위 밖이다.
 *
 * **`pace()` 를 반드시 `await` 한 뒤에 부른다.** 그 순서와 예산 전달, 두 가지를
 * 테스트가 지킨다(summaryPolicy.test.ts).
 */
export function createSummaryCaller<T>(deps: {
  pace: () => Promise<void>
  budget: RateLimitBudget
  summarize: (title: string, body: string, opts: { budget: RateLimitBudget }) => Promise<T>
}): (title: string, body: string) => Promise<T> {
  return async (title, body) => {
    await deps.pace()
    return deps.summarize(title, body, { budget: deps.budget })
  }
}
