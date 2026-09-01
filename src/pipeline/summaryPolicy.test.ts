import { describe, it, expect, vi } from 'vitest'
import { SUMMARY_CONCURRENCY, SUMMARY_MIN_INTERVAL_MS, pacedSummarizer } from './summaryPolicy'

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

describe('pacedSummarizer', () => {
  it('간격 게이트를 **기다린 뒤에** 요약을 부른다', async () => {
    const order: string[] = []
    const pace = vi.fn(async () => {
      order.push('pace-start')
      await Promise.resolve()
      order.push('pace-end')
    })
    const summarizeFn = vi.fn(async () => {
      order.push('summarize')
      return 'ok'
    })

    await pacedSummarizer(pace, summarizeFn)('제목', '본문')

    // `await` 를 지우면 summarize 가 pace-end 앞으로 온다.
    expect(order).toEqual(['pace-start', 'pace-end', 'summarize'])
  })

  it('호출마다 게이트를 한 번씩 지난다', async () => {
    const pace = vi.fn(async () => {})
    const summarizeFn = vi.fn(async () => 'ok')
    const paced = pacedSummarizer(pace, summarizeFn)

    await paced('a', 'b')
    await paced('c', 'd')

    expect(pace).toHaveBeenCalledTimes(2)
    expect(summarizeFn).toHaveBeenCalledTimes(2)
  })

  it('제목과 본문을 그대로 넘기고 결과를 그대로 돌려준다', async () => {
    const summarizeFn = vi.fn(async () => 'result')

    const r = await pacedSummarizer(async () => {}, summarizeFn)('제목', '본문')

    expect(summarizeFn).toHaveBeenCalledWith('제목', '본문')
    expect(r).toBe('result')
  })

  it('요약이 던지면 그대로 전파한다 — 간격 게이트가 사유를 삼키지 않는다', async () => {
    const paced = pacedSummarizer(async () => {}, async () => {
      throw new Error('gemini: 모든 모델이 실패했다')
    })

    await expect(paced('제목', '본문')).rejects.toThrow(/모든 모델이 실패했다/)
  })
})
