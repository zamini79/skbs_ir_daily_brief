import { describe, it, expect } from 'vitest'
import { createPacer } from './pacer'

/**
 * 시간을 흉내내는 테스트용 시계. `sleep` 이 불리면 그만큼 시계를 앞으로 감는다 —
 * 실제 setTimeout 을 쓰면 테스트가 6초씩 실제로 기다린다.
 */
function fakeClock() {
  let t = 1_000_000
  const waits: number[] = []
  return {
    waits,
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms)
      t += ms
    },
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('createPacer', () => {
  it('첫 호출은 기다리지 않는다', async () => {
    const c = fakeClock()
    const pace = createPacer(6_000, c.sleep, c.now)

    await pace()

    expect(c.waits).toEqual([])
  })

  it('간격이 지나지 않았으면 남은 만큼만 기다린다', async () => {
    const c = fakeClock()
    const pace = createPacer(6_000, c.sleep, c.now)

    await pace()
    await pace()

    expect(c.waits).toEqual([6_000])
  })

  it('호출 자체가 간격보다 오래 걸렸으면 기다리지 않는다', async () => {
    // 고정 sleep 으로 만들면 느린 모델에 걸린 날 대기가 두 배로 붙는다.
    const c = fakeClock()
    const pace = createPacer(6_000, c.sleep, c.now)

    await pace()
    c.advance(9_000) // 요약 호출이 9초 걸렸다
    await pace()

    expect(c.waits).toEqual([])
  })

  it('일부만 지났으면 나머지만 기다린다', async () => {
    const c = fakeClock()
    const pace = createPacer(6_000, c.sleep, c.now)

    await pace()
    c.advance(2_000)
    await pace()

    expect(c.waits).toEqual([4_000])
  })

  it('연속 호출이 간격만큼씩 벌어진다 — 분당 호출 수가 실제로 제한된다', async () => {
    const c = fakeClock()
    const pace = createPacer(6_000, c.sleep, c.now)
    const startedAt: number[] = []

    for (let i = 0; i < 4; i++) {
      await pace()
      startedAt.push(c.now())
    }

    const gaps = startedAt.slice(1).map((t, i) => t - startedAt[i])
    expect(gaps).toEqual([6_000, 6_000, 6_000])
  })

  it('동시에 여러 호출이 들어와도 간격이 무너지지 않는다', async () => {
    // 예약을 await 뒤로 미룬 구현은 여기서 뒤의 둘이 같은 시각을 읽고 함께 나간다 —
    // 그러면 대기가 한 번뿐이고 마지막 호출이 6초 지점에 선다.
    const c = fakeClock()
    const start = c.now()
    const pace = createPacer(6_000, c.sleep, c.now)

    await Promise.all([pace(), pace(), pace()])

    expect(c.waits).toHaveLength(2)
    expect(c.now() - start).toBe(12_000)
  })

  it('간격이 0이면 아무도 기다리지 않는다 — 끄는 수단이 있다', async () => {
    const c = fakeClock()
    const pace = createPacer(0, c.sleep, c.now)

    await pace()
    await pace()

    expect(c.waits).toEqual([])
  })
})
