import { describe, it, expect, vi } from 'vitest'
import { createProgressReporter } from './progressReporter'

/** 호출을 기록하면서, 각 쓰기를 테스트가 원하는 시점에 풀어 줄 수 있는 가짜 쓰기. */
function deferredWrite() {
  const calls: string[] = []
  const releases: Array<() => void> = []
  const write = (text: string): Promise<void> => {
    calls.push(text)
    return new Promise<void>(resolve => releases.push(resolve))
  }
  const releaseAll = async () => {
    while (releases.length > 0) {
      releases.shift()!()
      await Promise.resolve()
      await Promise.resolve()
    }
  }
  return { calls, write, releaseAll }
}

describe('createProgressReporter', () => {
  it('단계 문구를 그대로 적는다', async () => {
    const calls: string[] = []
    const r = createProgressReporter(async t => {
      calls.push(t)
    })
    r.step('fx')
    await r.close()
    expect(calls).toEqual(['환율 수집 중'])
  })

  it('건수를 실제 카운터에서 받아 적는다', async () => {
    const calls: string[] = []
    const r = createProgressReporter(async t => {
      calls.push(t)
    })
    r.step('summary', { done: 31, total: 47 })
    await r.close()
    expect(calls).toEqual(['요약 생성 중 (31/47)'])
  })

  it('호출자를 기다리게 하지 않는다 — 쓰기가 끝나지 않아도 step() 이 돌아온다', async () => {
    const { calls, write, releaseAll } = deferredWrite()
    const r = createProgressReporter(write)

    // 쓰기는 시작됐지만 아직 끝나지 않았다(deferredWrite 가 붙잡고 있다).
    r.step('fx')
    expect(calls).toEqual(['환율 수집 중'])

    // 그런데도 파이프라인은 이미 다음 단계로 넘어가 있다 — step() 이 Promise 를
    // 돌려주지 않으므로 호출부에 기다릴 방법 자체가 없다.
    r.step('quote')

    // 아직 안 끝났다는 근거: close() 가 여기서 걸린다.
    let closed = false
    const closing = r.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)

    await releaseAll()
    await closing
    expect(closed).toBe(true)
    expect(calls).toEqual(['환율 수집 중', '시세 수집 중'])
  })

  it('밀린 값은 마지막 것만 쓴다 — 중간값을 전부 쓰지 않는다', async () => {
    const { calls, write, releaseAll } = deferredWrite()
    const r = createProgressReporter(write)

    r.step('summary', { done: 1, total: 47 })
    await Promise.resolve() // 첫 쓰기 시작(아직 안 끝남)
    expect(calls).toEqual(['요약 생성 중 (1/47)'])

    // 첫 쓰기가 도는 동안 세 번 더 들어온다.
    r.step('summary', { done: 2, total: 47 })
    r.step('summary', { done: 3, total: 47 })
    r.step('summary', { done: 4, total: 47 })

    await releaseAll()
    await r.close()

    // 2와 3은 버려진다 — 어차피 4가 덮는다.
    expect(calls).toEqual(['요약 생성 중 (1/47)', '요약 생성 중 (4/47)'])
  })

  it('동시성으로 순서가 뒤섞여도 마지막에 쓴 값이 최신 값이다 — 숫자가 뒷걸음질치지 않는다', async () => {
    const { calls, write, releaseAll } = deferredWrite()
    const r = createProgressReporter(write)

    r.step('summary', { done: 1, total: 47 })
    await Promise.resolve()
    // 완료 순서가 뒤섞여 31 뒤에 30 이 도착한다.
    r.step('summary', { done: 31, total: 47 })
    r.step('summary', { done: 30, total: 47 })
    await releaseAll()
    await r.close()

    expect(calls.at(-1)).toBe('요약 생성 중 (30/47)')
    // 뒤섞임 자체는 리포터가 고칠 수 없다. 리포터가 보장하는 것은
    // "밀린 값들 중 마지막으로 들어온 것만 쓴다"이고, 호출부가 단조 카운터를 준다.
    expect(calls).toEqual(['요약 생성 중 (1/47)', '요약 생성 중 (30/47)'])
  })

  it('같은 문구를 두 번 쓰지 않는다', async () => {
    const calls: string[] = []
    const r = createProgressReporter(async t => {
      calls.push(t)
    })
    r.step('quote')
    await Promise.resolve()
    r.step('quote')
    await r.close()
    expect(calls).toEqual(['시세 수집 중'])
  })

  it('쓰기가 실패해도 던지지 않고 다음 단계를 계속 쓴다', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls: string[] = []
    const r = createProgressReporter(async t => {
      calls.push(t)
      if (t === '환율 수집 중') throw new Error('DB 연결 끊김')
    })

    r.step('fx')
    await Promise.resolve()
    r.step('quote')
    await r.close()

    expect(calls).toEqual(['환율 수집 중', '시세 수집 중'])
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('실패한 문구는 lastWritten 으로 남지 않아 다시 쓸 수 있다', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const calls: string[] = []
    let failOnce = true
    const r = createProgressReporter(async t => {
      calls.push(t)
      if (failOnce) {
        failOnce = false
        throw new Error('일시 장애')
      }
    })

    r.step('fx')
    await Promise.resolve()
    r.step('fx')
    await r.close()

    expect(calls).toEqual(['환율 수집 중', '환율 수집 중'])
    spy.mockRestore()
  })

  it('close() 는 밀린 쓰기를 끝까지 기다린다', async () => {
    const { calls, write, releaseAll } = deferredWrite()
    const r = createProgressReporter(write)

    r.step('news', { done: 5, total: 23 })
    await Promise.resolve()
    r.step('finish')

    let closed = false
    const closing = r.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)

    await releaseAll()
    await closing
    expect(closed).toBe(true)
    expect(calls).toEqual(['뉴스 수집 중 (5/23)', '마무리 중'])
  })

  it('close() 이후의 step() 은 아무것도 쓰지 않는다 — 끝난 실행이 다시 도는 것처럼 보이면 안 된다', async () => {
    const calls: string[] = []
    const r = createProgressReporter(async t => {
      calls.push(t)
    })
    await r.close()
    r.step('summary', { done: 1, total: 2 })
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual([])
  })
})
