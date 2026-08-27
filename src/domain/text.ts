/** 코드포인트 기준 길이. 한글·이모지 안전. String.length 를 쓰면 안 된다. */
export function charLength(text: string): number {
  return [...text].length
}

/** max 를 넘으면 마지막 문장 경계에서 자른다. 경계가 없으면 max 에서 자른다. */
export function truncateAtSentence(text: string, max: number): string {
  if (charLength(text) <= max) return text
  const chars = [...text]
  const head = chars.slice(0, max).join('')
  const lastStop = Math.max(head.lastIndexOf('.'), head.lastIndexOf('。'))
  if (lastStop > 0) return head.slice(0, lastStop + 1)
  return head
}
