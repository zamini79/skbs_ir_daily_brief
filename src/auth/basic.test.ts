import { describe, it, expect } from 'vitest'
import { decideBasicAuth, parseBasicCredentials } from './basic'

const USER = 'ir'
const PASSWORD = 'brief-2026'
const BOTH = { BASIC_AUTH_USER: USER, BASIC_AUTH_PASSWORD: PASSWORD }

function basicHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`
}

describe('decideBasicAuth — 인증이 꺼진 상태', () => {
  it('둘 다 설정돼 있지 않으면 통과시킨다 (로컬 개발·사내망 배포)', () => {
    expect(decideBasicAuth({}, null)).toEqual({ kind: 'pass' })
  })

  it('빈 문자열은 설정으로 세지 않는다 — 둘 다 비어 있으면 통과다', () => {
    expect(decideBasicAuth({ BASIC_AUTH_USER: '', BASIC_AUTH_PASSWORD: '' }, null)).toEqual({
      kind: 'pass',
    })
    expect(decideBasicAuth({ BASIC_AUTH_USER: '  ', BASIC_AUTH_PASSWORD: '\t' }, null)).toEqual({
      kind: 'pass',
    })
  })

  it('인증이 꺼져 있으면 이상한 헤더가 와도 통과다', () => {
    expect(decideBasicAuth({}, 'Basic 완전히-깨진-값')).toEqual({ kind: 'pass' })
  })
})

describe('decideBasicAuth — 반쪽 설정은 전부 막는다 (fail closed)', () => {
  it('사용자만 설정되면 막는다 — 자격증명이 맞아도 통과하지 않는다', () => {
    const decision = decideBasicAuth(
      { BASIC_AUTH_USER: USER },
      basicHeader(USER, PASSWORD),
    )
    expect(decision.kind).toBe('misconfigured')
  })

  it('비밀번호만 설정되면 막는다', () => {
    const decision = decideBasicAuth({ BASIC_AUTH_PASSWORD: PASSWORD }, null)
    expect(decision.kind).toBe('misconfigured')
  })

  it('한쪽이 빈 문자열인 것도 반쪽 설정이다 — 빈 비밀번호로 열리면 안 된다', () => {
    expect(
      decideBasicAuth({ BASIC_AUTH_USER: USER, BASIC_AUTH_PASSWORD: '' }, basicHeader(USER, ''))
        .kind,
    ).toBe('misconfigured')
    expect(
      decideBasicAuth({ BASIC_AUTH_USER: '', BASIC_AUTH_PASSWORD: PASSWORD }, basicHeader('', PASSWORD))
        .kind,
    ).toBe('misconfigured')
  })

  it('막은 이유에 어느 쪽이 비었는지가 적힌다 — 로그만 보고 고칠 수 있어야 한다', () => {
    const decision = decideBasicAuth({ BASIC_AUTH_USER: USER }, null)
    if (decision.kind !== 'misconfigured') throw new Error('misconfigured 여야 한다')
    expect(decision.reason).toContain('BASIC_AUTH_PASSWORD')
    expect(decision.reason).toContain('BASIC_AUTH_USER')
  })

  it('막은 이유에 설정된 쪽의 값이 새지 않는다', () => {
    const decision = decideBasicAuth({ BASIC_AUTH_USER: USER }, null)
    if (decision.kind !== 'misconfigured') throw new Error('misconfigured 여야 한다')
    // 사용자명 'ir' 는 짧아 우연히 포함될 수 있으니 긴 값으로 다시 확인한다.
    const withLongUser = decideBasicAuth({ BASIC_AUTH_USER: 'super-secret-operator' }, null)
    if (withLongUser.kind !== 'misconfigured') throw new Error('misconfigured 여야 한다')
    expect(withLongUser.reason).not.toContain('super-secret-operator')
  })
})

describe('decideBasicAuth — 둘 다 설정된 정상 동작', () => {
  it('자격증명이 맞으면 통과다', () => {
    expect(decideBasicAuth(BOTH, basicHeader(USER, PASSWORD))).toEqual({ kind: 'pass' })
  })

  it('비밀번호가 틀리면 다시 묻는다', () => {
    expect(decideBasicAuth(BOTH, basicHeader(USER, 'wrong'))).toEqual({ kind: 'challenge' })
  })

  it('사용자명이 틀리면 다시 묻는다', () => {
    expect(decideBasicAuth(BOTH, basicHeader('wrong', PASSWORD))).toEqual({ kind: 'challenge' })
  })

  it('헤더가 아예 없으면 다시 묻는다', () => {
    expect(decideBasicAuth(BOTH, null)).toEqual({ kind: 'challenge' })
    expect(decideBasicAuth(BOTH, undefined)).toEqual({ kind: 'challenge' })
  })

  it('비밀번호에 콜론이 들어가도 첫 콜론에서만 쪼개 통과시킨다', () => {
    const env = { BASIC_AUTH_USER: USER, BASIC_AUTH_PASSWORD: 'a:b:c' }
    expect(decideBasicAuth(env, basicHeader(USER, 'a:b:c'))).toEqual({ kind: 'pass' })
  })

  it('한글 자격증명도 UTF-8 로 일관되게 통과한다', () => {
    const env = { BASIC_AUTH_USER: '담당자', BASIC_AUTH_PASSWORD: '비밀번호' }
    expect(decideBasicAuth(env, basicHeader('담당자', '비밀번호'))).toEqual({ kind: 'pass' })
  })
})

describe('decideBasicAuth — 깨진 헤더는 예외가 아니라 401 이다', () => {
  const broken = [
    'Basic',
    'Basic ',
    'Basic !!!not-base64!!!',
    'Bearer sometoken',
    'Basic ' + Buffer.from('콜론없음', 'utf8').toString('base64'),
    '',
    '   ',
    'Basic ' + 'A'.repeat(1001),
  ]

  for (const header of broken) {
    it(`깨진 헤더 ${JSON.stringify(header)} 에 던지지 않고 challenge 를 준다`, () => {
      expect(() => decideBasicAuth(BOTH, header)).not.toThrow()
      expect(decideBasicAuth(BOTH, header)).toEqual({ kind: 'challenge' })
    })
  }
})

describe('parseBasicCredentials', () => {
  it('스킴 이름의 대소문자를 가리지 않는다 (RFC 7235)', () => {
    expect(parseBasicCredentials(basicHeader('a', 'b').replace('Basic', 'basic'))).toEqual({
      user: 'a',
      password: 'b',
    })
    expect(parseBasicCredentials(basicHeader('a', 'b').replace('Basic', 'BASIC'))).toEqual({
      user: 'a',
      password: 'b',
    })
  })

  it('Basic 이 아닌 스킴은 null 이다', () => {
    expect(parseBasicCredentials('Bearer abc')).toBeNull()
    expect(parseBasicCredentials('Digest abc')).toBeNull()
  })

  it('빈 비밀번호도 형식상으로는 파싱된다 — 거부는 상위에서 한다', () => {
    expect(parseBasicCredentials(basicHeader('a', ''))).toEqual({ user: 'a', password: '' })
  })
})
