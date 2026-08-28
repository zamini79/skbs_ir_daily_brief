import { describe, it, expect } from 'vitest'
import { isTransientNetworkError } from './transientNetwork'

describe('isTransientNetworkError', () => {
  function named(name: string, message = 'x') {
    const e = new Error(message)
    e.name = name
    return e
  }

  it('AbortSignal.timeout 이 끊은 경우', () => {
    expect(isTransientNetworkError(named('TimeoutError', 'The operation was aborted due to timeout'))).toBe(true)
  })

  it('호출부가 abort 한 경우', () => {
    expect(isTransientNetworkError(named('AbortError'))).toBe(true)
  })

  it('undici 의 fetch failed', () => {
    expect(isTransientNetworkError(new TypeError('fetch failed'))).toBe(true)
  })

  it('소켓/DNS 오류 코드', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'socket hang up']) {
      expect(isTransientNetworkError(new Error(`request to x failed, reason: ${code}`)), code).toBe(true)
    }
  })

  it('네트워크와 무관한 예외는 false — 던져야 진단이 가려지지 않는다', () => {
    expect(isTransientNetworkError(new TypeError('x is not a function'))).toBe(false)
    expect(isTransientNetworkError(new Error('GEMINI_API_KEY 없음'))).toBe(false)
    expect(isTransientNetworkError(new Error('gemini HTTP 401: API key not valid'))).toBe(false)
  })

  it('Error 가 아닌 값도 던지지 않고 판정한다', () => {
    expect(isTransientNetworkError('fetch failed')).toBe(true)
    expect(isTransientNetworkError(null)).toBe(false)
    expect(isTransientNetworkError(undefined)).toBe(false)
    expect(isTransientNetworkError({ weird: true })).toBe(false)
  })

  it('시세 경로의 분류가 이 판정을 그대로 쓴다 (기준이 한 벌이다)', async () => {
    const { classifyQuoteFailure } = await import('./quote/retry')
    expect(classifyQuoteFailure(named('TimeoutError'))).toBe('transient')
    expect(classifyQuoteFailure(new TypeError('fetch failed'))).toBe('transient')
    // 네트워크가 아닌 예외는 양쪽 모두 재시도/체인 진행 대상이 아니다.
    expect(isTransientNetworkError(new Error('CLSPRC_IDX 파싱 실패: -'))).toBe(false)
    expect(classifyQuoteFailure(new Error('CLSPRC_IDX 파싱 실패: -'))).toBe('permanent')
  })
})
