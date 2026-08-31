import { describe, it, expect } from 'vitest'
import { collectButtonState } from './collectButton'
import { STALLED_AFTER_MS, runProgressView, type RunProgressView } from './runProgress'

const IDLE: RunProgressView = { kind: 'IDLE' }
const RUNNING: RunProgressView = { kind: 'RUNNING', detail: '요약 생성 중 (31/47)', elapsedMs: 60_000 }
const STALLED: RunProgressView = { kind: 'STALLED', detail: null, elapsedMs: STALLED_AFTER_MS }

const base = { pending: false, sameDay: true, targetDate: '2026-08-31', decidedRows: 0 }

describe('collectButtonState — 눌리는가', () => {
  it('아무것도 안 돌고 있으면 눌린다', () => {
    expect(collectButtonState({ ...base, view: IDLE }).disabled).toBe(false)
  })

  it('도는 중이면 눌리지 않는다 — 겹치면 서로의 결과를 덮어쓴다', () => {
    expect(collectButtonState({ ...base, view: RUNNING }).disabled).toBe(true)
  })

  it('멈춘 것으로 보이면 다시 눌린다 — 아니면 그 날짜가 영원히 잠긴다', () => {
    expect(collectButtonState({ ...base, view: STALLED }).disabled).toBe(false)
  })

  it('액션이 도는 동안에는 눌리지 않는다 — 연타로 두 번 시작되지 않게', () => {
    expect(collectButtonState({ ...base, view: IDLE, pending: true }).disabled).toBe(true)
  })

  it('버튼이 눌리는 조건은 서버 판정과 같은 임계값을 쓴다', () => {
    // 서버(actions.ts 의 claimRun)는 `now - startedAt >= STALLED_AFTER_MS` 인 행을
    // 선점할 수 있게 둔다. 화면이 다른 값을 쓰면 눌리는데 거절당하거나 그 반대가 된다.
    const justBefore = runProgressView({
      status: 'COLLECTING',
      startedAtMs: 0,
      nowMs: STALLED_AFTER_MS - 1,
      progressDetail: null,
    })
    const exactly = runProgressView({
      status: 'COLLECTING',
      startedAtMs: 0,
      nowMs: STALLED_AFTER_MS,
      progressDetail: null,
    })
    expect(collectButtonState({ ...base, view: justBefore }).disabled).toBe(true)
    expect(collectButtonState({ ...base, view: exactly }).disabled).toBe(false)
  })
})

describe('collectButtonState — 라벨', () => {
  it('평소에는 「수집 실행」', () => {
    expect(collectButtonState({ ...base, view: IDLE }).label).toBe('수집 실행')
  })

  it('도는 중이면 도는 중이라고 적는다', () => {
    expect(collectButtonState({ ...base, view: RUNNING }).label).toBe('수집 중…')
  })

  it('멈춘 것으로 보이면 「다시 실행」이다 — 무엇을 하는 것인지 라벨에 드러난다', () => {
    expect(collectButtonState({ ...base, view: STALLED }).label).toBe('수집 다시 실행')
  })

  it('다른 날짜를 보고 있으면 어느 날짜를 건드리는지 라벨에 적는다', () => {
    const s = collectButtonState({ ...base, view: IDLE, sameDay: false })
    expect(s.label).toBe('수집 실행 (2026-08-31)')
  })

  it('액션이 도는 동안의 라벨은 도는 중과 다르다 — 눌린 게 먹혔는지 알아야 한다', () => {
    const pending = collectButtonState({ ...base, view: IDLE, pending: true }).label
    expect(pending).toBe('시작하는 중…')
    expect(pending).not.toBe(collectButtonState({ ...base, view: RUNNING }).label)
  })
})

describe('collectButtonState — 누르기 전에 알려야 하는 것', () => {
  it('평소에는 경고가 없다', () => {
    expect(collectButtonState({ ...base, view: IDLE }).warnings).toEqual([])
  })

  it('검토를 마친 행이 있으면 경고한다 — 재수집이 그 선택을 무효화한다', () => {
    const s = collectButtonState({ ...base, view: IDLE, decidedRows: 7 })
    expect(s.warnings).toContain('DECIDED_ROWS')
  })

  it('검토를 마친 행이 있으면 확인 창을 띄운다 — 다만 막지는 않는다', () => {
    const s = collectButtonState({ ...base, view: IDLE, decidedRows: 7 })
    expect(s.confirmBeforeStart).toBe(true)
    expect(s.disabled).toBe(false) // 담당자의 판단이다
  })

  it('검토를 마친 행이 없으면 확인 창을 띄우지 않는다 — 지어낸 경고는 무시하는 법을 가르친다', () => {
    expect(collectButtonState({ ...base, view: IDLE, decidedRows: 0 }).confirmBeforeStart).toBe(false)
  })

  it('다른 날짜를 보고 있으면 오늘 자로 돈다는 사실을 알린다', () => {
    const s = collectButtonState({ ...base, view: IDLE, sameDay: false })
    expect(s.warnings).toContain('OTHER_DATE')
  })

  it('도는 중이면 왜 눌리지 않는지 말한다', () => {
    expect(collectButtonState({ ...base, view: RUNNING }).warnings).toContain('RUNNING')
  })

  it('멈춘 것으로 보이는 실행에는 「도는 중」 경고를 붙이지 않는다', () => {
    // 그 문구는 눌리지 않는 이유인데, 이 상태에서는 눌린다.
    expect(collectButtonState({ ...base, view: STALLED }).warnings).not.toContain('RUNNING')
  })

  it('경고는 무게 순으로 쌓인다', () => {
    const s = collectButtonState({ ...base, view: RUNNING, sameDay: false, decidedRows: 3 })
    expect(s.warnings).toEqual(['RUNNING', 'OTHER_DATE', 'DECIDED_ROWS'])
  })
})
