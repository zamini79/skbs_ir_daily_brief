import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { proxy, config } from './proxy'

const USER = 'ir'
const PASSWORD = 'brief-2026'

function req(path: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, { headers })
}

function basicHeader(user: string, password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}` }
}

/** `NextResponse.next()` 는 통과 신호를 헤더로 표시한다. 상태 코드만으로는
 * 통과와 다른 200 응답을 구분할 수 없어서 그 헤더를 함께 본다. */
function isPass(res: Response): boolean {
  return res.status === 200 && res.headers.has('x-middleware-next')
}

const saved = { user: process.env.BASIC_AUTH_USER, password: process.env.BASIC_AUTH_PASSWORD }

beforeEach(() => {
  delete process.env.BASIC_AUTH_USER
  delete process.env.BASIC_AUTH_PASSWORD
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  if (saved.user === undefined) delete process.env.BASIC_AUTH_USER
  else process.env.BASIC_AUTH_USER = saved.user
  if (saved.password === undefined) delete process.env.BASIC_AUTH_PASSWORD
  else process.env.BASIC_AUTH_PASSWORD = saved.password
})

describe('proxy — 환경변수가 없으면 지금까지처럼 통과시킨다', () => {
  it('검수 화면을 그대로 통과시킨다 (로컬 개발 서버가 막히면 안 된다)', () => {
    expect(isPass(proxy(req('/review/2026-08-27')))).toBe(true)
  })

  it('엑셀 내려받기도 통과시킨다', () => {
    expect(isPass(proxy(req('/api/export/2026-08-27')))).toBe(true)
  })
})

describe('proxy — 둘 다 설정되면 인증을 건다', () => {
  beforeEach(() => {
    process.env.BASIC_AUTH_USER = USER
    process.env.BASIC_AUTH_PASSWORD = PASSWORD
  })

  it('자격증명이 맞으면 통과시킨다', () => {
    expect(isPass(proxy(req('/review/2026-08-27', basicHeader(USER, PASSWORD))))).toBe(true)
  })

  it('자격증명이 틀리면 401 과 인증 요구 헤더를 준다', () => {
    const res = proxy(req('/review/2026-08-27', basicHeader(USER, 'wrong')))
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toContain('Basic realm=')
  })

  it('헤더가 없으면 401 이다', () => {
    expect(proxy(req('/review/2026-08-27')).status).toBe(401)
  })

  it('엑셀 경로도 막힌다 — 파일이 그냥 받아지면 안 된다', () => {
    expect(proxy(req('/api/export/2026-08-27')).status).toBe(401)
  })

  it('401 본문에 설정된 비밀번호가 새지 않는다', async () => {
    const res = proxy(req('/review/2026-08-27'))
    const body = await res.text()
    expect(body).not.toContain(PASSWORD)
    expect(res.headers.get('www-authenticate')).not.toContain(PASSWORD)
  })

  it('깨진 형식의 헤더에도 500 이 아니라 401 이다', async () => {
    for (const authorization of ['Basic', 'Basic ', 'Basic !!!', 'Bearer x', 'nonsense']) {
      const res = proxy(req('/review/2026-08-27', { authorization }))
      expect(res.status, `헤더 ${JSON.stringify(authorization)}`).toBe(401)
    }
  })
})

describe('proxy — 반쪽 설정은 모든 요청을 막는다', () => {
  it('사용자만 설정되면 자격증명이 맞아도 401 이다', () => {
    process.env.BASIC_AUTH_USER = USER
    const res = proxy(req('/review/2026-08-27', basicHeader(USER, PASSWORD)))
    expect(res.status).toBe(401)
    expect(isPass(res)).toBe(false)
  })

  it('비밀번호만 설정되면 401 이다', () => {
    process.env.BASIC_AUTH_PASSWORD = PASSWORD
    expect(proxy(req('/review/2026-08-27')).status).toBe(401)
  })

  it('반쪽 설정에서는 인증 창을 띄우지 않는다 — 어떤 자격증명도 통과할 수 없으므로', () => {
    process.env.BASIC_AUTH_USER = USER
    const res = proxy(req('/review/2026-08-27'))
    expect(res.headers.get('www-authenticate')).toBeNull()
  })

  it('막은 이유를 서버 로그에 남긴다', () => {
    process.env.BASIC_AUTH_USER = USER
    proxy(req('/review/2026-08-27'))
    expect(console.error).toHaveBeenCalledOnce()
    expect(vi.mocked(console.error).mock.calls[0][0]).toContain('BASIC_AUTH_PASSWORD')
  })

  it('반쪽 설정 안내 본문에 설정된 값이 새지 않는다', async () => {
    process.env.BASIC_AUTH_USER = 'super-secret-operator'
    const body = await proxy(req('/review/2026-08-27')).text()
    expect(body).not.toContain('super-secret-operator')
  })
})

describe('proxy matcher — 무엇이 인증을 타고 무엇이 안 타는가', () => {
  // matcher 는 빌드 타임에 정적 분석되는 리터럴이라 런타임에 프록시를 호출해
  // 검증할 수 없다. 대신 그 리터럴 자체를 정규식으로 컴파일해 확인한다.
  // (지금 패턴은 통째로 정규식이라 path-to-regexp 해석과 결과가 같다.)
  const pattern = config.matcher[0]
  const matches = (path: string): boolean => new RegExp(`^${pattern}$`).test(path)

  it('크론 경로는 인증을 타지 않는다 — crontab 의 curl 한 줄이 깨지면 안 된다', () => {
    expect(matches('/api/cron/collect')).toBe(false)
  })

  it('정적 자산은 인증을 타지 않는다', () => {
    expect(matches('/_next/static/chunks/main.js')).toBe(false)
    expect(matches('/_next/image?url=%2Ffile.svg')).toBe(false)
    expect(matches('/favicon.ico')).toBe(false)
  })

  it('검수 화면과 서버 액션이 붙는 경로는 인증을 탄다', () => {
    expect(matches('/review/2026-08-27')).toBe(true)
    expect(matches('/')).toBe(true)
  })

  it('엑셀 내보내기는 인증을 탄다', () => {
    expect(matches('/api/export/2026-08-27')).toBe(true)
  })

  it('크론 제외는 경로 맨 앞에서만 적용된다 — 뒤에 끼워 넣어 우회할 수 없다', () => {
    expect(matches('/review/api/cron/collect')).toBe(true)
  })
})
