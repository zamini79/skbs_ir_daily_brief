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

  it('월 한도 소진은 429 여도 재시도 대상이 아니다 (실측 2026-08-27)', () => {
    // marketstack 은 월 한도 소진을 분당 속도 제한과 **같은 429** 로 알린다.
    // 구분은 본문의 error.code 에만 있고, marketstack.ts 의 assertHttpOk 가 그걸
    // 메시지에 실어 준다. 상태 코드를 먼저 보면 이 구분이 사라진다.
    expect(classifyQuoteFailure(new Error(
      'marketstack HTTP 429 (usage_limit_reached: Your monthly usage limit has been reached.)',
    ))).toBe('permanent')
  })

  it('사람이 읽는 문구만 남아도 월 한도 소진으로 본다', () => {
    expect(classifyQuoteFailure(new Error('marketstack: Your monthly usage limit has been reached.')))
      .toBe('permanent')
  })

  it('twelvedata 의 크레딧 소진은 **분당** 이라 여전히 재시도 대상이다', () => {
    // 여기를 뭉뚱그리면 반대 방향으로 틀린다 — 61초 뒤 재시도 한 번이면 붙었을
    // 미국 5행이 매일 그냥 빈다.
    expect(classifyQuoteFailure(new Error(
      'twelvedata 오류 응답 (code 429): You have run out of API credits for the current minute.',
    ))).toBe('rate-limit')
  })

  it('본문 단서가 없는 429 는 예전대로 분당 한도로 본다', () => {
    expect(classifyQuoteFailure(new Error('marketstack HTTP 429'))).toBe('rate-limit')
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

  // ── 배선 확인 ─────────────────────────────────────────────────────────
  // 분류 함수만 검증하면 withQuoteRetry 가 그 분류를 실제로 쓰는지는 못 본다.
  // 아래 두 개는 **호출 횟수와 대기 시간을 직접 센다.**

  it('월 한도 소진은 한 번만 부르고 기다리지 않는다 (실측 사유 그대로)', async () => {
    const fn = vi.fn(async () => {
      throw new Error(
        'marketstack HTTP 429 (usage_limit_reached: Your monthly usage limit has been reached.)',
      )
    })
    const r = recorder()
    await expect(withQuoteRetry('marketstack', fn, r.sleep)).rejects.toThrow(/usage_limit_reached/)
    expect(fn).toHaveBeenCalledTimes(1)   // 재시도 0회
    expect(r.waits).toEqual([])           // 61초를 쓰지 않는다
  })

  it('같은 429 라도 분당 한도면 61초 뒤 한 번 더 부른다 — 둘이 갈리는지 본다', async () => {
    const fn = vi.fn(async () => {
      throw new Error('twelvedata 오류 응답 (code 429): You have run out of API credits')
    })
    const r = recorder()
    await expect(withQuoteRetry('twelvedata', fn, r.sleep)).rejects.toThrow(/API credits/)
    expect(fn).toHaveBeenCalledTimes(2)   // 재시도 1회
    expect(r.waits).toEqual([61_000])
  })

  it('소진 사유는 재시도 분류에 덮이지 않고 그대로 던져진다', async () => {
    // 담당자·운영자가 화면에서 봐야 하는 것은 "월 한도 소진"이라는 사실이다.
    const reason =
      'marketstack HTTP 429 (usage_limit_reached: Your monthly usage limit has been reached.)'
    const fn = vi.fn(async () => { throw new Error(reason) })
    await expect(withQuoteRetry('marketstack', fn, async () => {})).rejects.toThrow(reason)
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
