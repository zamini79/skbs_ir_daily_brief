import { describe, it, expect } from 'vitest'
import { SUMMARY_VARIANTS, buildPrompt, summaryVariantLabel, MAX_SUMMARY_CHARS } from './prompt'

describe('SUMMARY_VARIANTS', () => {
  it('2안이다 — 시사점 중심(3안)은 빠졌다', () => {
    expect(SUMMARY_VARIANTS).toHaveLength(2)
    expect(SUMMARY_VARIANTS.map(v => v.variant)).toEqual([1, 2])
    expect(SUMMARY_VARIANTS.map(v => v.key)).toEqual(['numeric', 'context'])
  })

  it('시사점/함의 관점이 어디에도 남아 있지 않다', () => {
    // 되돌릴 때 한 곳만 고치고 나머지를 빠뜨리는 것을 잡는다.
    const blob = JSON.stringify(SUMMARY_VARIANTS)
    expect(blob).not.toContain('implication')
    expect(blob).not.toContain('시사점')
  })

  it('variant 번호는 1부터 연속이다 — 화면의 번호 라벨이 이 전제 위에 있다', () => {
    expect(SUMMARY_VARIANTS.map(v => v.variant)).toEqual(
      SUMMARY_VARIANTS.map((_, i) => i + 1),
    )
  })
})

describe('buildPrompt', () => {
  const prompt = buildPrompt('제목', '본문')

  it('2안을 요구한다', () => {
    expect(prompt).toContain('요약 2안을 작성하라')
    expect(prompt).not.toContain('요약 3안')
  })

  it('3안(시사점 중심) 설명 줄이 남아 있지 않다', () => {
    // 이 줄이 남으면 스키마에 없는 네 번째 요약을 모델이 만들려 하고, 그 내용이
    // 2안 안으로 섞여 들어온다.
    expect(prompt).not.toContain('3안')
    expect(prompt).not.toContain('시사점')
    expect(prompt).not.toContain('함의')
  })

  it('남은 두 관점의 설명은 그대로 있다', () => {
    expect(prompt).toContain('1안(수치 중심)')
    expect(prompt).toContain('2안(배경·맥락 중심)')
  })

  it('제목과 본문, 글자수 제약을 싣는다', () => {
    expect(buildPrompt('셀트리온 실적', '본문임')).toContain('셀트리온 실적')
    expect(buildPrompt('셀트리온 실적', '본문임')).toContain('본문임')
    expect(prompt).toContain(`${MAX_SUMMARY_CHARS}자 이내`)
  })
})

describe('summaryVariantLabel', () => {
  it('정의된 관점은 번호와 이름을 함께 준다', () => {
    expect(summaryVariantLabel(1)).toBe('① 수치 중심')
    expect(summaryVariantLabel(2)).toBe('② 배경·맥락 중심')
  })

  it('SUMMARY_VARIANTS 에서 라벨을 파생한다 — 둘이 따로 놀지 않는다', () => {
    for (const v of SUMMARY_VARIANTS) {
      expect(summaryVariantLabel(v.variant)).toContain(v.label)
    }
  })

  it('남아 있는 variant=3 행도 라벨이 비지 않는다 (기존 DB 데이터)', () => {
    // 라벨 맵을 그대로 인덱싱하던 시절에는 undefined 가 나와 라벨 자리가 소리 없이
    // 비었다. 빈 문자열도 실패로 본다 — "안 깨진다"의 기준은 예외가 안 나는 것이
    // 아니라 담당자가 읽을 것이 남는 것이다.
    const label = summaryVariantLabel(3)
    expect(label.length).toBeGreaterThan(0)
    expect(label).toContain('3')
  })

  it('없앤 관점을 라벨로 되살리지 않는다', () => {
    // 「③ 시사점 중심」으로 적으면 빼기로 한 관점이 화면에서 정상 선택지로 복원된다.
    expect(summaryVariantLabel(3)).not.toContain('시사점')
  })

  it('한 번도 쓴 적 없는 variant 에도 깨지지 않는다', () => {
    expect(() => summaryVariantLabel(99)).not.toThrow()
    expect(summaryVariantLabel(99).length).toBeGreaterThan(0)
    expect(summaryVariantLabel(0).length).toBeGreaterThan(0)
  })
})
