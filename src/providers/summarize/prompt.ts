/**
 * 담당자에게 제시할 요약 관점. **2안이다 (2026-08-28 확정, 3안에서 줄였다).**
 *
 * 뺀 것은 ③ 시사점 중심이다. 근거는 원본 샘플 엑셀 — 실제로 나가는 요약문은
 * 전부 사실·수치 중심이고 해석이 없다("IDT 바이오로지카 인수 통한 글로벌 공급망
 * 사업자 영역 확장 전략…지난해 연결 매출 6,513억원 달성, 전년 대비 두 배 넘는 성장").
 * 반면 모델이 만든 3안은 "기업 가치 재평가의 핵심 모멘텀이 될 것으로 기대됨" 같은
 * 문장이었다. **전 임원에게 나가는 문서에서 모델이 지어낸 전망이 가장 위험하다.**
 * 담당자가 걸러낼 수는 있지만 애초에 만들지 않는 편이 낫다.
 *
 * **이 판단은 되돌리기 쉽다.** 관점 정의와 프롬프트가 여기 상수로 모여 있으니,
 * 담당자 인터뷰 후 조정 가능하다(스펙 §8.2). 되돌린다면 함께 바뀌어야 하는 곳:
 * `gemini.ts` 의 `responseSchema`·`SummarySet`, 그리고 화면의 `SUMMARY_LABEL`.
 * 발췌 폴백(`buildFallbackSummaries`)은 이 배열의 길이를 따라가므로 손댈 필요 없다.
 */
export const SUMMARY_VARIANTS = [
  { key: 'numeric', variant: 1, label: '수치 중심' },
  { key: 'context', variant: 2, label: '배경·맥락 중심' },
] as const

/** 화면에서 관점 앞에 붙는 번호. 배열 순서가 곧 variant 1, 2, ... 다. */
const CIRCLED_NUMERAL = ['①', '②', '③', '④', '⑤'] as const

/**
 * 저장된 variant 번호를 화면 라벨로 바꾼다. `SUMMARY_VARIANTS` 에서 파생되므로
 * 관점을 늘리거나 줄일 때 라벨이 따로 놀지 않는다.
 *
 * **`SUMMARY_VARIANTS` 에 없는 variant 도 깨지지 않는다.** 이미 저장된 데이터에
 * `variant = 3` 행이 남아 있다 — 3안(시사점 중심)을 뺀 것은 앞으로 생성하지
 * 않는다는 뜻이지 지난 실행의 요약이 사라진다는 뜻이 아니다(재수집하면 사라지지만
 * 그 전에 화면을 열면 그대로 보인다). 라벨 맵을 그대로 인덱싱하면 `undefined` 가
 * 나와 라벨 자리가 **소리 없이 비고**, 담당자는 그 요약이 어느 관점인지도 왜 다른
 * 것과 달라 보이는지도 알 수 없다.
 *
 * 그렇다고 「③ 시사점 중심」으로 되살려 적지는 않는다 — 그 관점을 뺀 이유가
 * "모델이 지어낸 전망이 전 임원용 문서에서 가장 위험하다"이므로, 라벨로 되살리면
 * 없앤 것을 화면에서 정상 선택지처럼 복원하는 셈이다. 대신 **지금은 만들지 않는
 * 것**이라고 사실대로 말한다.
 */
export function summaryVariantLabel(variant: number): string {
  const found = SUMMARY_VARIANTS.find(v => v.variant === variant)
  if (!found) return `${variant}안 (지금은 만들지 않는 관점)`
  return `${CIRCLED_NUMERAL[variant - 1] ?? variant} ${found.label}`
}

export const MAX_SUMMARY_CHARS = 100

export function buildPrompt(title: string, body: string): string {
  return `다음 기사를 IR 데일리 브리프용으로 요약한다. 서로 다른 관점의 요약 2안을 작성하라.

1안(수치 중심): 기사의 핵심 수치를 중심으로
2안(배경·맥락 중심): 왜 이런 일이 일어났는지 배경을 중심으로

제약:
- 각 요약은 공백 포함 ${MAX_SUMMARY_CHARS}자 이내. 반드시 지킬 것.
- 개조식 문체(~함, ~임)로 간결하게. 기사 제목을 반복하지 말 것.

제목: ${title}

기사:
${body}`
}
