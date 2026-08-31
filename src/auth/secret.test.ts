import { describe, it, expect } from 'vitest'
import { secretMatches } from './secret'

describe('secretMatches', () => {
  it('같은 값이면 참이다', () => {
    expect(secretMatches('s3cr3t', 's3cr3t')).toBe(true)
  })

  it('다른 값이면 거짓이다', () => {
    expect(secretMatches('s3cr3t', 's3cr3T')).toBe(false)
  })

  it('길이가 달라도 던지지 않고 거짓을 준다', () => {
    // 다이제스트(32바이트 고정)를 비교하므로 timingSafeEqual 의 "길이가 같아야
    // 한다" 제약에 걸리지 않는다. 길이로 갈라 비교하면 길이 자체가 새어 나간다.
    for (const wrong of ['', 'x', 's3cr3t-and-more', 's3cr']) {
      expect(secretMatches(wrong, 's3cr3t')).toBe(false)
    }
  })

  it('제공된 값이 없으면(null·undefined) 거짓이다', () => {
    expect(secretMatches(null, 's3cr3t')).toBe(false)
    expect(secretMatches(undefined, 's3cr3t')).toBe(false)
  })

  it('빈 기대값에 빈 입력이 오면 참이다 — 빈 시크릿을 막는 것은 호출부의 책임이다', () => {
    // 이 함수는 "같은가"만 답한다. 빈 시크릿을 설정으로 인정하지 않는 판단은
    // decideBasicAuth 와 크론 라우트가 각자 앞에서 한다.
    expect(secretMatches('', '')).toBe(true)
  })

  it('유니코드를 바이트가 아니라 UTF-8 로 일관되게 비교한다', () => {
    expect(secretMatches('비밀번호', '비밀번호')).toBe(true)
    expect(secretMatches('비밀번호', '비밀번혼')).toBe(false)
  })
})
