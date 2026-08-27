export const SUMMARY_VARIANTS = [
  { key: 'numeric', variant: 1, label: '수치 중심' },
  { key: 'context', variant: 2, label: '배경·맥락 중심' },
  { key: 'implication', variant: 3, label: '시사점 중심' },
] as const

export const MAX_SUMMARY_CHARS = 100

export function buildPrompt(title: string, body: string): string {
  return `다음 기사를 IR 데일리 브리프용으로 요약한다. 서로 다른 관점의 요약 3안을 작성하라.

1안(수치 중심): 기사의 핵심 수치를 중심으로
2안(배경·맥락 중심): 왜 이런 일이 일어났는지 배경을 중심으로
3안(시사점 중심): 회사·시장에 주는 함의를 중심으로

제약:
- 각 요약은 공백 포함 ${MAX_SUMMARY_CHARS}자 이내. 반드시 지킬 것.
- 개조식 문체(~함, ~임)로 간결하게. 기사 제목을 반복하지 말 것.

제목: ${title}

기사:
${body}`
}
