import { describe, it, expect, vi } from 'vitest'
import { classifyQuoteFailure, withQuoteRetry } from './retry'

/** 실제로 기다리지 않고, 무엇을 얼마나 기다렸는지만 기록한다. */
function recorder() {
  const waits: number[] = []
  return { waits, sleep: async (ms: number) => { waits.push(ms) } }
}

describe('classifyQuoteFailure', () => {
  it('429 는 한도 초과다', () => {
    expect(classifyQuoteFailure(new Error('marketstack HTTP 429'))).toBe('rate-limit')
  })

  it('본문 오류 코드로만 온 429 도 한도 초과다', () => {
    // twelvedata 의 평면 오류 객체, marketstack 의 assertOk 경로.
    expect(classifyQuoteFailure(new Error('twelvedata 오류 응답 (code 429): out of credits')))
      .toBe('rate-limit')
  })

  it('4290 을 429 로 읽지 않는다', () => {
    expect(classifyQuoteFailure(new Error('종가 4290 파싱 실패'))).toBe('permanent')
  })

  it('5xx 와 Cloudflare 52x 는 일시적 장애다', () => {
    // 522 가 실측으로 관측된 값이다(Cloudflare 원본 연결 타임아웃).
    expect(classifyQuoteFailure(new Error('twelvedata HTTP 522'))).toBe('transient')
    expect(classifyQuoteFailure(new Error('marketstack HTTP 503'))).toBe('transient')
    expect(classifyQuoteFailure(new Error('[.INX] HTTP 500'))).toBe('transient')
  })

  it('4xx 인증·미존재는 다시 불러도 같으므로 재시도 대상이 아니다', () => {
    expect(classifyQuoteFailure(new Error('KRX HTTP 401 (basDd=20260827)'))).toBe('permanent')
    expect(classifyQuoteFailure(new Error('[207940] HTTP 404'))).toBe('permanent')
  })

  it('응답을 못 받은 네트워크 오류는 일시적 장애다', () => {
    expect(classifyQuoteFailure(new TypeError('fetch failed'))).toBe('transient')
    const timeout = new Error('The operation was aborted due to timeout')
    timeout.name = 'TimeoutError'
    expect(classifyQuoteFailure(timeout)).toBe('transient')
  })

  it('설정 오류는 재시도하지 않는다', () => {
    expect(classifyQuoteFailure(new Error('TWELVEDATA_API_KEY 없음'))).toBe('permanent')
    expect(classifyQuoteFailure(new Error('CLSPRC_IDX 파싱 실패: -'))).toBe('permanent')
  })
})

describe('withQuoteRetry', () => {
  it('성공하면 다시 부르지 않는다', async () => {
    const fn = vi.fn(async () => 'ok')
    const { waits } = recorder()
    expect(await withQuoteRetry('t', fn, async () => {})).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(waits).toEqual([])
  })

  it('522 뒤 성공하면 값을 돌려준다 — 하루치 공란이 재시도 하나로 메워진다', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('twelvedata HTTP 522'))
      .mockResolvedValueOnce('ok')
    const r = recorder()
    expect(await withQuoteRetry('twelvedata', fn, r.sleep)).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(r.waits).toEqual([3_000])
  })

  it('한도 초과는 순간 장애보다 오래 기다린다', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('marketstack HTTP 429'))
      .mockResolvedValueOnce('ok')
    const r = recorder()
    await withQuoteRetry('marketstack', fn, r.sleep)
    expect(r.waits).toEqual([61_000])
  })

  it('영원히 재시도하지 않는다 — 세 번째 실패는 그대로 던진다', async () => {
    const fn = vi.fn(async () => { throw new Error('twelvedata HTTP 522') })
    const r = recorder()
    await expect(withQuoteRetry('twelvedata', fn, r.sleep)).rejects.toThrow('522')
    expect(fn).toHaveBeenCalledTimes(3)
    expect(r.waits).toEqual([3_000, 15_000])
  })

  it('한도 초과는 한 번만 기다린다 — 61초를 두 번 쓰면 수집 창을 넘본다', async () => {
    const fn = vi.fn(async () => { throw new Error('HTTP 429') })
    const r = recorder()
    await expect(withQuoteRetry('t', fn, r.sleep)).rejects.toThrow('429')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(r.waits).toEqual([61_000])
  })

  it('재시도해도 소용없는 실패는 즉시 던진다 — 20분 창을 낭비하지 않는다', async () => {
    const fn = vi.fn(async () => { throw new Error('KRX HTTP 401') })
    const r = recorder()
    await expect(withQuoteRetry('krx', fn, r.sleep)).rejects.toThrow('401')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(r.waits).toEqual([])
  })

  it('끝내 실패하면 마지막 사유를 그대로 던진다 — 재시도가 사유를 바꾸지 않는다', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('twelvedata HTTP 522'))
      .mockRejectedValueOnce(new Error('twelvedata HTTP 502'))
      .mockRejectedValueOnce(new Error('twelvedata 오류 응답 (code 429): out of credits'))
    const r = recorder()
    await expect(withQuoteRetry('twelvedata', fn, r.sleep)).rejects.toThrow('out of credits')
  })

  it('최악의 경로(429 → 5xx)도 상한 안에서 끝난다', async () => {
    const fn = vi.fn(async () => { throw new Error('HTTP 429') })
      .mockRejectedValueOnce(new Error('HTTP 429'))
      .mockRejectedValueOnce(new Error('HTTP 522'))
      .mockRejectedValueOnce(new Error('HTTP 522'))
    const r = recorder()
    await expect(withQuoteRetry('t', fn, r.sleep)).rejects.toThrow()
    // 61 + 15 = 76초. 20분 수집 창에서 감당 가능한 상한이다.
    expect(r.waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(76_000)
  })
})
