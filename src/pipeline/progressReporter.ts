import { formatProgress, type CollectionStep } from '@/domain/runProgress'

/** 진행 한 줄을 실제로 어딘가에 적는 함수. 파이프라인은 `BriefRun.progressDetail` 을 준다. */
export type ProgressWrite = (text: string) => Promise<void>

export type ProgressReporter = {
  /** 지금 어느 단계인지 알린다. **호출자를 기다리게 하지 않는다**(아래 주석 참고). */
  step(step: CollectionStep, counted?: { done: number; total: number }): void
  /** 밀린 쓰기를 끝까지 흘려보내고 더 이상 쓰지 않는다. 완료 상태를 기록하기 **전에** 부른다. */
  close(): Promise<void>
}

/**
 * 수집 진행을 한 줄씩 남기는 리포터.
 *
 * **왜 `step()` 이 Promise 를 돌려주지 않는가.** 진행 표시는 수집의 부산물이지
 * 수집의 일부가 아니다. 단계마다 DB 쓰기를 `await` 하면 실측 457.7초짜리 작업에
 * (2026-09-01, 감속 이전에는 202초였다)
 * 70여 번의 왕복이 직렬로 얹히고, 더 나쁘게는 **진행 표시가 느려지면 수집이
 * 느려진다.** 그래서 쓰기는 뒤에서 돌고 호출자는 즉시 진행한다.
 *
 * **왜 큐가 아니라 "마지막 값만"인가.** 요약 단계는 동시성 4로 돌아서 완료 순서가
 * 뒤섞인다. 들어온 순서대로 전부 쓰면 (31/47) 뒤에 (30/47) 이 도착해 화면의
 * 숫자가 뒷걸음질친다. 밀린 값은 어차피 다음 값이 덮으므로 **가장 최근 한 줄만**
 * 남기고 버린다 — 담당자가 보는 것은 "지금 어디쯤"이지 모든 중간값이 아니다.
 *
 * **쓰기 실패는 수집을 멈추지 않는다.** 진행 표시를 못 남긴 것 때문에 브리프
 * 자체를 날리는 것은 명백히 손해다. 다만 조용히 넘어가지는 않는다 — 로그에 남긴다.
 * (진행 표시가 통째로 죽어 있으면 화면은 단계 문구 없이 「수집 중」만 보이는데,
 * 그건 이 기능이 없던 때와 같은 상태이지 거짓말은 아니다.)
 */
export function createProgressReporter(write: ProgressWrite): ProgressReporter {
  /** 아직 쓰지 못한 마지막 값. null 이면 밀린 것이 없다. */
  let pending: string | null = null
  /** 마지막으로 실제 쓰기에 성공한 값. 같은 문구를 두 번 쓰지 않기 위한 것. */
  let lastWritten: string | null = null
  /** 지금 돌고 있는 배출 루프. 두 벌이 동시에 돌지 않게 한다. */
  let draining: Promise<void> | null = null
  let closed = false

  async function drain(): Promise<void> {
    while (pending !== null) {
      const text = pending
      pending = null
      try {
        await write(text)
        lastWritten = text
      } catch (e) {
        console.error(`[progress] 진행 표시 기록 실패: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    draining = null
  }

  return {
    step(step, counted) {
      // close() 이후의 호출은 버린다. 완료 상태를 적은 뒤에 진행 문구가 되살아나면
      // 끝난 실행이 다시 도는 것처럼 보인다.
      if (closed) return
      const text = formatProgress(step, counted)
      // 이미 그 문구가 화면에 있고 밀린 것도 없으면 쓸 이유가 없다.
      if (text === lastWritten && pending === null) return
      pending = text
      if (draining === null) draining = drain()
    },

    async close() {
      closed = true
      if (draining !== null) await draining
    },
  }
}
