import { describe, it, expect } from 'vitest'
import { createRateLimitBudget, RATE_LIMIT_WAIT_BUDGET_MS } from './rateLimitBudget'

describe('createRateLimitBudget', () => {
  it('예산 안에서는 그대로 허용하고 차감한다', () => {
    const b = createRateLimitBudget(100)

    expect(b.tryConsume(40)).toBe(true)
    expect(b.tryConsume(40)).toBe(true)
    expect(b.spentMs).toBe(80)
    expect(b.deniedCount).toBe(0)
  })

  it('남은 예산보다 크면 거절하고 **아무것도 쓰지 않는다**', () => {
    // 부분 차감을 하면 분당 창이 지나가지도 않는 어중간한 대기를 하게 된다.
    const b = createRateLimitBudget(100)
    b.tryConsume(80)

    expect(b.tryConsume(40)).toBe(false)
    expect(b.spentMs).toBe(80)
  })

  it('거절 횟수를 센다 — 0이 아니면 그날 무슨 일이 있었다는 뜻이다', () => {
    const b = createRateLimitBudget(10)

    b.tryConsume(20)
    b.tryConsume(20)

    expect(b.deniedCount).toBe(2)
  })

  it('한 번 거절돼도 더 작은 대기는 여전히 통과한다 — 영구히 잠기지 않는다', () => {
    const b = createRateLimitBudget(100)
    b.tryConsume(90)

    expect(b.tryConsume(40)).toBe(false)
    expect(b.tryConsume(10)).toBe(true)
  })

  it('정확히 남은 만큼은 쓸 수 있다 (경계)', () => {
    const b = createRateLimitBudget(100)

    expect(b.tryConsume(100)).toBe(true)
    expect(b.tryConsume(1)).toBe(false)
  })

  it('기본 예산은 10분이다 — 요약 마감(20분)보다 작아야 두 겹이 뜻을 갖는다', () => {
    expect(RATE_LIMIT_WAIT_BUDGET_MS).toBe(10 * 60 * 1000)
    expect(createRateLimitBudget().totalMs).toBe(RATE_LIMIT_WAIT_BUDGET_MS)
  })
})
