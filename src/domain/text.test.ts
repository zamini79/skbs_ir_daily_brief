import { describe, it, expect } from 'vitest'
import { charLength, truncateAtSentence, truncateAtClause } from './text'

describe('charLength', () => {
  it('한글을 코드포인트로 센다', () => {
    expect(charLength('셀트리온')).toBe(4)
  })
  it('공백을 포함해 센다', () => {
    expect(charLength('가 나')).toBe(3)
  })
  it('서로게이트 페어를 1자로 센다', () => {
    // String.length 는 2 를 반환한다. 이 테스트가 그 차이를 고정한다.
    expect(charLength('𝕏')).toBe(1)
    expect('𝕏'.length).toBe(2)
  })
})

describe('truncateAtSentence', () => {
  it('한도 이내면 그대로 둔다', () => {
    expect(truncateAtSentence('짧은 문장임', 100)).toBe('짧은 문장임')
  })
  it('한도를 넘으면 마지막 문장 경계에서 자른다', () => {
    // 경계가 예산의 절반 이상을 채우는 경우 — 경계 절삭이 그대로 유지된다.
    // (절반에 못 미치면 아래 "너무 앞쪽" 규칙이 우선한다.)
    const t = '첫 번째 문장임. 두 번째 문장임. 세 번째 문장임.'
    expect(truncateAtSentence(t, 14)).toBe('첫 번째 문장임.')
  })
  it('문장 경계가 너무 앞쪽이면 경계를 버리고 max 에서 자른다', () => {
    // "SK바이오." 뒤로 90자 넘는 내용이 있는데 경계만 보고 자르면 7자만 남는다.
    // 그 7자는 화면에서 **정상적으로 짧은 요약과 구분되지 않는다** — 담당자는
    // 내용이 사라진 줄 모른 채 그대로 메일에 싣게 된다.
    const t = 'SK바이오. ' + '가'.repeat(120)
    const result = truncateAtSentence(t, 100)
    expect(charLength(result)).toBe(100)
    expect(result).not.toBe('SK바이오.')
  })
  it('경계가 예산의 절반을 정확히 채우면 경계를 지킨다', () => {
    // 경계 절삭이 원칙이고 하드 컷은 예외다 — 경계가 이 이상이면 손대지 않는다.
    const t = '가나다라마바자차.' + '나'.repeat(50)
    expect(truncateAtSentence(t, 18)).toBe('가나다라마바자차.')
  })
  it('문장 경계가 없으면 한도에서 자른다', () => {
    expect(truncateAtSentence('가나다라마바사', 3)).toBe('가나다')
  })
  it('소수점은 문장 경계로 취급하지 않는다', () => {
    const t = '매출이 12.3% 증가했고 영업이익도 늘었음. 추가 문장임.'
    const result = truncateAtSentence(t, 18)
    // Should not end at "12." and should respect max length
    expect(result).not.toMatch(/12\.$/);
    expect(charLength(result)).toBeLessThanOrEqual(18)
  })
  it('한글 단어 뒤의 마침표는 문장 경계이다', () => {
    const t = '첫 문장임. 두 번째 문장임.'
    expect(truncateAtSentence(t, 10)).toBe('첫 문장임.')
  })
  it('천 단위 구분 숫자는 문장 경계로 취급하지 않는다', () => {
    const t = '매출 2조 5,387억원 달성함. 다음 문장임.'
    const result = truncateAtSentence(t, 20)
    // Should truncate at real sentence boundary, not inside the number
    expect(result).toBe('매출 2조 5,387억원 달성함.')
  })
  it('문장 경계가 없을 때 정확히 max 코드포인트를 반환한다', () => {
    const text = '가나다라마바사아자차카타파하'
    const result = truncateAtSentence(text, 5)
    expect(charLength(result)).toBe(5)
  })
})

describe('truncateAtClause — 서식 후 요약의 경계(`, ` 와 `…`)', () => {
  it('한도 이내면 그대로 둔다', () => {
    expect(truncateAtClause('가 결정, 나 달성', 100)).toBe('가 결정, 나 달성')
  })
  it('마지막 `, ` 앞에서 자르고, 구분자로 끝나지 않는다', () => {
    const t = '가'.repeat(60) + ', ' + '나'.repeat(60)
    expect(truncateAtClause(t, 100)).toBe('가'.repeat(60))
  })
  it('`…` 앞에서도 자른다', () => {
    const t = '가'.repeat(60) + '…' + '나'.repeat(60)
    expect(truncateAtClause(t, 100)).toBe('가'.repeat(60))
  })
  it('숫자 안의 콤마(`1,000`)는 경계가 아니다', () => {
    const t = '가'.repeat(55) + ' 1,000억원 ' + '나'.repeat(60)
    const r = truncateAtClause(t, 100)
    expect(charLength(r)).toBe(100)
    expect(r).toContain('1,000억원')
  })
  it('경계가 너무 앞이면 하드 컷한다 — truncateAtSentence 와 같은 판단', () => {
    // "SK바이오, " 에서 자르면 7자만 남고 화면에서 정상적으로 짧은 요약과 구분되지 않는다.
    const t = 'SK바이오, ' + '가'.repeat(120)
    const r = truncateAtClause(t, 100)
    expect(charLength(r)).toBe(100)
  })
  it('경계가 예산의 절반을 정확히 채우면 경계를 지킨다', () => {
    const t = '가'.repeat(9) + ', ' + '나'.repeat(50)
    expect(truncateAtClause(t, 18)).toBe('가'.repeat(9))
  })
  it('하드 컷이 구분자 직후에 떨어지면 구분자를 걷어낸다', () => {
    // 앞쪽 경계는 너무 앞이라 하드 컷 — 그 컷이 `, ` 의 콤마와 공백 사이에 떨어지면
    // head 안에는 `, ` 가 없어 경계로 잡히지 않고, 콤마만 끝에 남는다.
    const t = '가'.repeat(3) + ', ' + '나'.repeat(94) + ', ' + '다'.repeat(20)
    const r = truncateAtClause(t, 100)
    expect(r).toBe('가'.repeat(3) + ', ' + '나'.repeat(94))
  })
  it('하드 컷이 숫자 콤마 직후에 떨어지면 콤마를 남긴다 — `4` 로 보이면 잘린 줄 모른다', () => {
    const t = '가'.repeat(98) + '4,000억원'
    expect(truncateAtClause(t, 100)).toBe('가'.repeat(98) + '4,')
  })
})
