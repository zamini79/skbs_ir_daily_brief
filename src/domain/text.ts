/** 코드포인트 기준 길이. 한글·이모지 안전. String.length 를 쓰면 안 된다. */
export function charLength(text: string): number {
  return [...text].length
}

/**
 * 경계 절삭이 예산의 이만큼도 못 채우면 경계를 포기한다. 1/2 은 임의의 값이지만
 * 기준은 분명하다 — "문장으로 끝나지만 내용이 거의 없는 요약"보다 "말이 잘렸지만
 * 내용이 있는 요약"이 낫다는 판단이 뒤집히는 지점이다.
 */
const MIN_BOUNDARY_RATIO = 0.5

/**
 * max 를 넘으면 마지막 문장 경계에서 자른다. 경계가 없으면 max 에서 자른다.
 *
 * **경계가 너무 앞쪽이면 경계를 무시하고 max 에서 하드 컷한다.** 첫 문장 경계가
 * 앞쪽에 있으면(예: `"SK바이오. 2분기 매출 …"` — 마침표가 index 6) 100자 예산 중
 * 7자만 남기고 나머지를 통째로 버리는데, 그 결과는 화면에서 **정상적으로 짧은
 * 요약과 똑같이 보인다** — 담당자는 내용이 사라진 줄 모른다. 말이 중간에 잘린
 * 100자는 적어도 잘렸다는 사실이 보인다.
 */
export function truncateAtSentence(text: string, max: number): string {
  if (charLength(text) <= max) return text
  const chars = [...text]
  const head = chars.slice(0, max).join('')
  // Find sentence boundaries: . and 。, but only if the period is not flanked by digits
  const matches = Array.from(head.matchAll(/(?<![0-9])[.。](?![0-9])/g))
  const lastStop = matches.length > 0 ? matches[matches.length - 1].index! : -1
  // If boundary is at index 0, return full head rather than a lone "." (better UX)
  if (lastStop > 0) {
    const cut = head.slice(0, lastStop + 1)
    if (charLength(cut) >= max * MIN_BOUNDARY_RATIO) return cut
  }
  return head
}
