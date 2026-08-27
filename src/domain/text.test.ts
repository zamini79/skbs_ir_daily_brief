import { describe, it, expect } from 'vitest'
import { charLength, truncateAtSentence } from './text'

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
    const t = '첫 문장임. 두 번째 문장임. 세 번째 문장임.'
    expect(truncateAtSentence(t, 14)).toBe('첫 문장임.')
  })
  it('문장 경계가 없으면 한도에서 자른다', () => {
    expect(truncateAtSentence('가나다라마바사', 3)).toBe('가나다')
  })
})
