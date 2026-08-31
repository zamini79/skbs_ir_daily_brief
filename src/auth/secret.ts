import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * 공유 시크릿 비교. **이 저장소에서 시크릿을 대조하는 유일한 함수다.**
 *
 * `!==` 는 첫 다른 바이트에서 즉시 끝나므로 원리상 응답 시간이 "몇 글자까지
 * 맞았는지"를 흘린다. 그래서 상수 시간 비교를 쓴다.
 *
 * 길이가 다르면 `timingSafeEqual` 이 던지므로, 먼저 길이를 비교하는 대신
 * **SHA-256 다이제스트(항상 32바이트)를 비교한다** — 길이 자체도 흘리지 않고,
 * 길이가 다른 입력에도 예외 대신 `false` 를 돌려준다.
 *
 * 원래 `api/cron/collect/route.ts` 안에 있던 것을 꺼냈다. 검수 화면의 Basic
 * 인증(`src/proxy.ts`)도 같은 판정이 필요한데, **같은 보안 판정을 두 벌 두면
 * 그중 한 쪽이 틀리는 것이 이 종류 결함의 전형적인 모습이다.** 한 곳만 둔다.
 */
export function secretMatches(provided: string | null | undefined, expected: string): boolean {
  if (provided === null || provided === undefined) return false
  const digest = (v: string): Buffer => createHash('sha256').update(v, 'utf8').digest()
  return timingSafeEqual(digest(provided), digest(expected))
}
