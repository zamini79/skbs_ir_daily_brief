import { describe, it, expect } from 'vitest'
import {
  COLLECTION_STEPS,
  PROGRESS_POLL_MS,
  STALLED_AFTER_MS,
  formatElapsed,
  formatProgress,
  progressHeadline,
  runProgressView,
  shouldPollProgress,
  stalledNotice,
} from './runProgress'

describe('formatProgress', () => {
  it('셀 수 있는 단계는 건수를 붙인다', () => {
    expect(formatProgress('summary', { done: 31, total: 47 })).toBe('요약 생성 중 (31/47)')
    expect(formatProgress('quoteSave', { done: 12, total: 23 })).toBe('시세 저장 중 (12/23)')
  })

  it('셀 대상이 없는 단계는 이름만 적는다 — 숫자를 지어내지 않는다', () => {
    expect(formatProgress('fx')).toBe('환율 수집 중')
    expect(formatProgress('quote')).toBe('시세 수집 중')
    expect(formatProgress('finish')).toBe('마무리 중')
  })

  it('total 이 0이면 (0/0) 대신 단계 이름만 남긴다', () => {
    // 후보가 0건인 날 「요약 생성 중 (0/0)」은 멈춘 것처럼 읽힌다.
    expect(formatProgress('summary', { done: 0, total: 0 })).toBe('요약 생성 중')
  })

  it('모든 단계가 문구를 가진다', () => {
    for (const step of COLLECTION_STEPS) {
      expect(formatProgress(step)).not.toBe('')
    }
  })

  it('단계마다 서로 다른 문구다 — 두 단계가 같은 화면으로 수렴하면 진행이 멈춘 것처럼 보인다', () => {
    const labels = COLLECTION_STEPS.map(s => formatProgress(s))
    expect(new Set(labels).size).toBe(COLLECTION_STEPS.length)
  })
})

describe('runProgressView', () => {
  const base = { startedAtMs: 1_000_000, progressDetail: '요약 생성 중 (31/47)' }

  it('COLLECTING 이 아니면 진행에 대해 아무 말도 하지 않는다', () => {
    for (const status of ['READY', 'PARTIAL', 'FAILED', '알수없음']) {
      expect(runProgressView({ ...base, status, nowMs: base.startedAtMs })).toEqual({ kind: 'IDLE' })
    }
  })

  it('시작 직후는 도는 중이다', () => {
    const v = runProgressView({ ...base, status: 'COLLECTING', nowMs: base.startedAtMs + 1000 })
    expect(v).toEqual({ kind: 'RUNNING', detail: '요약 생성 중 (31/47)', elapsedMs: 1000 })
  })

  it('실측 202초 시점에도 여전히 도는 중이다', () => {
    const v = runProgressView({ ...base, status: 'COLLECTING', nowMs: base.startedAtMs + 202_000 })
    expect(v.kind).toBe('RUNNING')
  })

  it('임계 시간 직전은 RUNNING', () => {
    const v = runProgressView({ ...base, status: 'COLLECTING', nowMs: base.startedAtMs + STALLED_AFTER_MS - 1 })
    expect(v.kind).toBe('RUNNING')
  })

  it('임계 시간 정확히는 STALLED — 경계를 고정한다', () => {
    const v = runProgressView({ ...base, status: 'COLLECTING', nowMs: base.startedAtMs + STALLED_AFTER_MS })
    expect(v.kind).toBe('STALLED')
  })

  it('임계 시간을 넘기면 STALLED 이고 마지막 진행 문구를 그대로 들고 있다', () => {
    const v = runProgressView({ ...base, status: 'COLLECTING', nowMs: base.startedAtMs + STALLED_AFTER_MS * 10 })
    expect(v).toEqual({
      kind: 'STALLED',
      detail: '요약 생성 중 (31/47)',
      elapsedMs: STALLED_AFTER_MS * 10,
    })
  })

  it('진행 기록이 없는 옛 실행도 판정한다 — detail 은 null 로 남긴다', () => {
    const v = runProgressView({
      status: 'COLLECTING',
      startedAtMs: 0,
      nowMs: STALLED_AFTER_MS,
      progressDetail: null,
    })
    expect(v).toEqual({ kind: 'STALLED', detail: null, elapsedMs: STALLED_AFTER_MS })
  })

  it('시계가 어긋나 startedAt 이 미래여도 음수 경과를 만들지 않는다', () => {
    const v = runProgressView({ ...base, status: 'COLLECTING', nowMs: base.startedAtMs - 5000 })
    expect(v).toEqual({ kind: 'RUNNING', detail: base.progressDetail, elapsedMs: 0 })
  })
})

describe('shouldPollProgress', () => {
  it('도는 중일 때만 폴링한다', () => {
    expect(shouldPollProgress({ kind: 'RUNNING', detail: null, elapsedMs: 0 })).toBe(true)
  })

  it('COLLECTING 이 아니면 폴링하지 않는다', () => {
    expect(shouldPollProgress({ kind: 'IDLE' })).toBe(false)
  })

  it('멈춘 것으로 보이면 폴링하지 않는다 — 몇 초 뒤에도 같은 값이다', () => {
    expect(shouldPollProgress({ kind: 'STALLED', detail: null, elapsedMs: STALLED_AFTER_MS })).toBe(false)
  })

  it('폴링 간격은 3~5초 사이다', () => {
    expect(PROGRESS_POLL_MS).toBeGreaterThanOrEqual(3000)
    expect(PROGRESS_POLL_MS).toBeLessThanOrEqual(5000)
  })
})

describe('formatElapsed', () => {
  it('1분 미만은 숫자를 세지 않는다', () => {
    expect(formatElapsed(0)).toBe('1분 미만')
    expect(formatElapsed(59_999)).toBe('1분 미만')
  })

  it('한 시간 미만은 분', () => {
    expect(formatElapsed(60_000)).toBe('1분')
    expect(formatElapsed(202_000)).toBe('3분')
    expect(formatElapsed(59 * 60_000)).toBe('59분')
  })

  it('하루 미만은 시간(+분)', () => {
    expect(formatElapsed(60 * 60_000)).toBe('1시간')
    expect(formatElapsed(90 * 60_000)).toBe('1시간 30분')
  })

  it('하루 이상은 일(+시간)', () => {
    expect(formatElapsed(24 * 60 * 60_000)).toBe('1일')
    expect(formatElapsed(5 * 24 * 60 * 60_000 + 3 * 60 * 60_000)).toBe('5일 3시간')
  })

  it('음수는 0으로 본다', () => {
    expect(formatElapsed(-1000)).toBe('1분 미만')
  })
})

describe('stalledNotice', () => {
  it('단정하지 않고 근거를 준다', () => {
    const text = stalledNotice(5 * 24 * 60 * 60_000)
    expect(text).toBe('수집이 시작된 지 5일 지났습니다. 중단됐을 수 있습니다.')
    // "중단됐습니다"처럼 단정하지 않는다 — 우리는 프로세스가 죽었는지 모른다.
    expect(text).toContain('수 있습니다')
  })
})

describe('progressHeadline', () => {
  it('멈춘 것으로 보이는 실행이 도는 실행과 같은 말을 쓰지 않는다', () => {
    expect(progressHeadline('RUNNING')).not.toBe(progressHeadline('STALLED'))
  })

  it('도는 중은 「수집 중」', () => {
    expect(progressHeadline('RUNNING')).toBe('수집 중')
  })

  it('멈춘 것으로 보이면 머리말 자체가 다르다', () => {
    expect(progressHeadline('STALLED')).toContain('멈춰')
  })
})
