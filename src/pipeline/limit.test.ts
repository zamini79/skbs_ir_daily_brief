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

  it('실패해도 큐가 막히지 않는다', async () => {
    const limit = pLimit(1)
    const results = await Promise.allSettled([
      limit(async () => { throw new Error('x') }),
      limit(async () => 'ok'),
    ])
    expect(results[0].status).toBe('rejected')
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: 'ok' })
  })
})
