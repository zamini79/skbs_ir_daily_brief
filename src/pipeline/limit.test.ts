import { describe, it, expect } from 'vitest'
import { pLimit } from './limit'

describe('pLimit', () => {
  it('동시 실행 수를 넘지 않는다', async () => {
    const limit = pLimit(2)
    let running = 0
    let peak = 0
    const task = () => limit(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise(r => setTimeout(r, 10))
      running--
      return 1
    })
    await Promise.all(Array.from({ length: 8 }, task))
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('모든 결과를 순서대로 돌려준다', async () => {
    const limit = pLimit(3)
    const r = await Promise.all([1, 2, 3, 4, 5].map(n => limit(async () => n * 2)))
    expect(r).toEqual([2, 4, 6, 8, 10])
  })

  // NEWS_CONCURRENCY = 1 이 실제로 직렬인지 고정한다. 이 값을 올리면 네이버가 429 를
  // 주고 브리프 뒤쪽 행이 매일 조용히 빈다(collect.ts 상수 주석의 실측 표 참조).
  it('n=1 이면 완전히 직렬로 돈다 — 겹치는 구간이 없다', async () => {
    const limit = pLimit(1)
    let running = 0
    let peak = 0
    const order: number[] = []
    await Promise.all([1, 2, 3, 4, 5].map(n => limit(async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise(r => setTimeout(r, 5))
      order.push(n)
      running--
    })))
    expect(peak).toBe(1)
    expect(order).toEqual([1, 2, 3, 4, 5])
  })

  it('실패해도 큐가 막히지 않는다', async () => {
    const limit = pLimit(1)
    const results = await Promise.allSettled([
      limit(async () => { throw new Error('x') }),
      limit(async () => 'ok'),
    ])
    expect(results[0].status).toBe('rejected')
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: 'ok' })
  })

  it('동기 예외를 던지는 fn 이 와도 슬롯을 반납한다 — 큐가 조용히 멈추지 않는다', async () => {
    // async 가 아닌 함수가 넘어오면 fn() 이 동기로 던진다. 슬롯을 되돌리지 않으면
    // n=1 에서 뒤따르는 작업이 영영 시작되지 않고, 예외도 로그도 남지 않는다.
    const limit = pLimit(1)
    const results = await Promise.allSettled([
      limit((() => { throw new Error('sync boom') }) as () => Promise<never>),
      limit(async () => 'ok'),
    ])
    expect(results[0]).toMatchObject({ status: 'rejected' })
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: 'ok' })
  })
})
