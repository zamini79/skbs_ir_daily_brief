import type { RunProgressView } from './runProgress'

/**
 * 「수집 실행」 버튼이 무엇을 보여주고 눌리는지의 판정. 순수 함수라 테스트가 고정한다.
 *
 * 버튼 컴포넌트에 인라인으로 두지 않는 이유는 이 판정이 **안전장치**이기 때문이다 —
 * 도는 중에 다시 누르면 같은 날짜에 두 수집이 겹쳐 서로의 결과를 덮어쓰고, 검토를
 * 마친 행이 있는데 경고 없이 눌리면 담당자의 선택이 말없이 무효화된다.
 */
export type CollectButtonWarning =
  /** 지금 도는 중이라 다시 시작할 수 없다. */
  | 'RUNNING'
  /** 보고 있는 날짜가 아니라 오늘 자로 돈다. */
  | 'OTHER_DATE'
  /** 이미 검토를 마친 행이 있어 재수집이 그 선택을 무효화한다. */
  | 'DECIDED_ROWS'

export type CollectButtonState = {
  disabled: boolean
  label: string
  /** 누르기 전에 보여줄 것들. 무게 순이다. */
  warnings: CollectButtonWarning[]
  /** 누를 때 확인 창을 띄울지. 되돌릴 수 없는 결과가 있을 때만 참이다. */
  confirmBeforeStart: boolean
}

/**
 * **`STALLED` 는 눌린다.** 막으면 프로세스가 죽은 날짜가 영원히 잠긴다 — 아무것도
 * 돌지 않는데 아무도 다시 돌릴 수 없는 상태가 된다. 서버도 같은 임계값으로 같은
 * 판단을 한다(`actions.ts` 의 `claimRun`); 둘이 어긋나면 눌리는데 거절당하거나,
 * 반대로 눌리지 않는데 서버는 받아 준다.
 *
 * 경고는 **막지 않는다.** 재수집할지는 담당자의 판단이고, 우리가 할 일은 누르기
 * 전에 결과를 말해 주는 것뿐이다.
 */
export function collectButtonState(args: {
  view: RunProgressView
  /** 액션이 아직 돌아오지 않았다. */
  pending: boolean
  /** 보고 있는 날짜가 수집 대상 날짜(오늘)와 같은가. */
  sameDay: boolean
  /** 수집 대상 날짜. 라벨에 적는다 — 어느 날짜를 건드리는지 누르기 전에 보여야 한다. */
  targetDate: string
  /** 수집 대상 날짜에서 이미 검토를 마친(PENDING 이 아닌) 행 수. */
  decidedRows: number
}): CollectButtonState {
  const running = args.view.kind === 'RUNNING'
  const stalled = args.view.kind === 'STALLED'

  const warnings: CollectButtonWarning[] = []
  if (running) warnings.push('RUNNING')
  if (!args.sameDay) warnings.push('OTHER_DATE')
  if (args.decidedRows > 0) warnings.push('DECIDED_ROWS')

  return {
    disabled: running || args.pending,
    label: buttonLabel({ ...args, running, stalled }),
    warnings,
    confirmBeforeStart: args.decidedRows > 0,
  }
}

function buttonLabel(args: {
  running: boolean
  stalled: boolean
  pending: boolean
  sameDay: boolean
  targetDate: string
}): string {
  if (args.pending) return '시작하는 중…'
  if (args.running) return '수집 중…'
  // 멈춘 것으로 보이는 실행 위에서는 「실행」이 아니라 「다시 실행」이다 —
  // 담당자가 무엇을 하는 것인지가 라벨에 드러나야 한다.
  if (args.stalled) return args.sameDay ? '수집 다시 실행' : `수집 다시 실행 (${args.targetDate})`
  return args.sameDay ? '수집 실행' : `수집 실행 (${args.targetDate})`
}
