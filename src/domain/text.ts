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

/**
 * 서식을 거친 요약(`formatSummary`)을 max 이내로 자른다. 경계는 `, ` 와 `…` 다.
 *
 * **`truncateAtSentence` 를 쓰면 안 되는 이유:** 서식 후에는 문장 경계 마침표가
 * 하나도 없다(전부 `, ` 로 바뀌거나 지워졌다). 마침표를 찾으면 경계가 없다고 보고
 * 언제나 하드 컷을 하게 된다. 반대로 `truncateAtSentence` 의 경계를 바꾸지 않는
 * 이유도 있다 — 발췌 폴백이 **서식 전의 원문**을 마침표에서 잘라 "다음 구간"의 시작
 * 위치를 정한다(`buildFallbackSummaries`). 그 의미는 그대로 둔다.
 *
 * - 구분자 앞에서 자른다. 결과가 `,` 나 `…` 로 끝나면 메일에 붙였을 때 문장이
 *   끊긴 것처럼 보인다.
 * - `1,000` 의 콤마는 뒤에 공백이 없으므로 경계가 아니다.
 * - `MIN_BOUNDARY_RATIO` 규칙은 같다 — 경계가 너무 앞이면 하드 컷. 내용을 통째로
 *   버린 짧은 요약은 정상적으로 짧은 요약과 구분되지 않는다(위 주석).
 * - 하드 컷이 구분자 바로 뒤에 떨어지면 그 구분자는 걷어낸다. 단 **숫자 뒤의 콤마는
 *   남긴다** — `4,000억원` 이 `4,` 에서 잘렸을 때 콤마까지 지우면 `4` 라는 멀쩡해
 *   보이는 숫자가 되어, 잘렸다는 사실이 숨는다.
 */
export function truncateAtClause(text: string, max: number): string {
  if (charLength(text) <= max) return text
  const head = [...text].slice(0, max).join('')
  const matches = Array.from(head.matchAll(/, |…/g))
  const lastStop = matches.length > 0 ? matches[matches.length - 1].index! : -1
  if (lastStop > 0) {
    const cut = head.slice(0, lastStop).trimEnd()
    if (charLength(cut) >= max * MIN_BOUNDARY_RATIO) return cut
  }
  return head.replace(/(?:\s|…|(?<![0-9]),)+$/u, '')
}
