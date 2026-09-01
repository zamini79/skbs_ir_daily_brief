import { describe, it, expect, vi } from 'vitest'
import { SUMMARY_CONCURRENCY, SUMMARY_MIN_INTERVAL_MS, createSummaryCaller } from './summaryPolicy'
import { createRateLimitBudget } from '@/providers/summarize/rateLimitBudget'

/**
 * 이 블록이 지키는 것은 "코드가 컴파일되는가"가 아니라 **실측으로 산 값**이다.
 * 리뷰에서 확인된 사실: 이 테스트가 없던 동안 `await summaryPace()` 를 통째로
 * 지워도 테스트 900개가 전부 통과했다. 주석의 "되돌리지 마라"는 아무것도 막지 못한다.
 * (같은 처방을 이 저장소는 `MODEL_CHAIN_ENTRIES` 에서 이미 쓰고 있다.)
 */
describe('요약 감속 정책', () => {
  it('동시성은 1이다 — 올리면 순간 속도가 분당 한도를 넘고 「본문 발췌」가 돌아온다', () => {
    expect(SUMMARY_CONCURRENCY).toBe(1)
  })

  it('호출 간격은 6초다 — 분당 10회, 실측 상한 15~17에 여유를 둔 값', () => {
    expect(SUMMARY_MIN_INTERVAL_MS).toBe(6_000)
  })

  it('동시성과 간격은 한 벌이다 — 간격이 0이면 동시성 1도 분당 40회가 된다', () => {
    // 한쪽만 되돌리는 것을 막는다. 둘 다 살아 있어야 감속이 뜻을 갖는다.
    expect(SUMMARY_CONCURRENCY).toBeGreaterThan(0)
    expect(SUMMARY_MIN_INTERVAL_MS).toBeGreaterThan(0)
  })
})

describe('createSummaryCaller', () => {
  const budget = () => createRateLimitBudget(1000)

  it('간격 게이트를 **기다린 뒤에** 요약을 부른다', async () => {
    const order: string[] = []
    const pace = vi.fn(async () => {
      order.push('pace-start')
      await Promise.resolve()
      order.push('pace-end')
    })
    const summarize = vi.fn(async () => {
      order.push('summarize')
      return 'ok'
    })

    await createSummaryCaller({ pace, budget: budget(), summarize })('제목', '본문')

    // `await` 를 지우면 summarize 가 pace-end 앞으로 온다.
    expect(order).toEqual(['pace-start', 'pace-end', 'summarize'])
  })

  it('**실행 예산을 요약에 넘긴다** — 이 배선이 blocker 1 의 유일한 방어선이다', async () => {
    const b = budget()
    const summarize = vi.fn(async () => 'ok')

    await createSummaryCaller({ pace: async () => {}, budget: b, summarize })('제목', '본문')

    expect(summarize).toHaveBeenCalledWith('제목', '본문', { budget: b })
  })

  it('**모든 호출이 같은 예산 객체를 받는다** — 후보마다 새로 만들면 곱셈이 안 끊긴다', async () => {
    // 예산을 인자로 닫아 넣기 때문에 "호출마다 새 예산"이라는 형태가 애초에 만들어지지
    // 않는다. gemini.ts 의 `opts.budget ?? createRateLimitBudget()` 기본값에 기대면
    // 배선을 지워도 타입·런타임이 조용하고 예산이 한 번도 걸리지 않는다.
    const b = budget()
    const seen: unknown[] = []
    const summarize = vi.fn(async (_t: string, _b: string, opts: { budget: unknown }) => {
      seen.push(opts.budget)
      return 'ok'
    })
    const call = createSummaryCaller({ pace: async () => {}, budget: b, summarize })

    await call('a', 'b')
    await call('c', 'd')
    await call('e', 'f')

    expect(seen).toEqual([b, b, b])
  })

  it('호출마다 게이트를 한 번씩 지난다', async () => {
    const pace = vi.fn(async () => {})
    const summarize = vi.fn(async () => 'ok')
    const call = createSummaryCaller({ pace, budget: budget(), summarize })

    await call('a', 'b')
    await call('c', 'd')

    expect(pace).toHaveBeenCalledTimes(2)
    expect(summarize).toHaveBeenCalledTimes(2)
  })

  it('결과를 그대로 돌려준다', async () => {
    const r = await createSummaryCaller({
      pace: async () => {},
      budget: budget(),
      summarize: async () => 'result',
    })('제목', '본문')

    expect(r).toBe('result')
  })

  it('요약이 던지면 그대로 전파한다 — 간격 게이트가 사유를 삼키지 않는다', async () => {
    const call = createSummaryCaller({
      pace: async () => {},
      budget: budget(),
      summarize: async () => {
        throw new Error('gemini: 모든 모델이 실패했다')
      },
    })

    await expect(call('제목', '본문')).rejects.toThrow(/모든 모델이 실패했다/)
  })
})
