'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { collectButtonState, type CollectButtonWarning } from '@/domain/collectButton'
import type { RunProgressView } from '@/domain/runProgress'
import { startCollection } from './actions'

/**
 * 「수집 실행」 버튼.
 *
 * Render 무료 플랜에는 크론이 없어서 07:40 자동 수집이 임시 배포에서는 돌지 않는다.
 * 담당자가 화면에서 직접 돌릴 수 있어야 한다.
 *
 * **버튼은 항상 「오늘(KST)」 자로 수집한다.** 지난 날짜를 보고 있어도 마찬가지다 —
 * 시세 소스가 주는 값은 "직전 영업일 종가"뿐이라 지난 날짜의 브리프를 다시 만들
 * 방법이 애초에 없다. 오늘 자 데이터를 지난 날짜 행에 쓰면 그 화면은 날짜만 옛것인
 * 거짓말이 된다. 그래서 **보고 있는 날짜와 다르면 버튼이 그 사실을 먼저 말한다.**
 *
 * 되돌릴 수 없는 작업이라는 것을 두 겹으로 알린다: 버튼 아래 상시 문구(누르기 전에
 * 보인다)와 클릭 시 확인 창. **막지는 않는다** — 재수집할지는 담당자의 판단이다.
 *
 * 눌리는지·무엇이라고 적는지·무엇을 경고하는지의 판정은 전부
 * `domain/collectButton.ts` 에 있다(테스트가 고정한다). 여기는 그 판정을 화면으로
 * 옮기기만 한다.
 */
export function CollectButton({
  targetDate,
  viewingDate,
  view,
  decidedRows,
}: {
  /** 수집이 만들/덮을 날짜(KST 오늘). */
  targetDate: string
  /** 지금 보고 있는 날짜. */
  viewingDate: string
  /** 수집 대상 날짜(오늘)의 진행 상태. 보고 있는 날짜의 것이 아니다. */
  view: RunProgressView
  /** 대상 날짜에서 이미 검토를 마친(PENDING 이 아닌) 행 수. */
  decidedRows: number
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [rejected, setRejected] = useState<string | null>(null)

  const sameDay = targetDate === viewingDate
  const state = collectButtonState({ view, pending, sameDay, targetDate, decidedRows })

  function onClick() {
    setRejected(null)
    if (state.confirmBeforeStart && !window.confirm(confirmText(targetDate, decidedRows))) return

    startTransition(async () => {
      const result = await startCollection()
      if (!result.ok) {
        setRejected(result.reason)
        // 거절당했다는 것은 화면이 들고 있던 상태가 낡았다는 뜻이다 — 새로 읽어 온다.
        router.refresh()
        return
      }
      // 다른 날짜를 보고 있었다면 방금 시작한 날짜로 데려간다. 그러지 않으면
      // 진행 표시가 이 화면에 뜨지 않아 "눌렀는데 아무 일도 안 일어났다"로 보인다.
      if (result.runDate !== viewingDate) router.push(`/review/${result.runDate}`)
      else router.refresh()
    })
  }

  return (
    <div className="inline-block text-right">
      {/*
       * 스펙 §9.2 의 「기본 버튼 #2E2A24」. 화면에서 유일하게 무언가를 **시작하는**
       * 동작이라 「Excel 다운로드」(테두리만 있는 보조 버튼)와 무게를 다르게 둔다.
       */}
      <button
        type="button"
        onClick={onClick}
        disabled={state.disabled}
        className="inline-block rounded border border-btn bg-btn px-3.5 py-2 text-[13px] font-medium text-page disabled:cursor-not-allowed disabled:opacity-45"
      >
        {state.label}
      </button>

      <div className="mt-1.5 max-w-[22rem] space-y-1 text-[11px] leading-snug">
        {rejected !== null && <p className="text-fail-fg">{rejected}</p>}
        {state.warnings.map(w => (
          <Warning key={w} kind={w} targetDate={targetDate} sameDay={sameDay} decidedRows={decidedRows} />
        ))}
      </div>
    </div>
  )
}

function Warning({
  kind,
  targetDate,
  sameDay,
  decidedRows,
}: {
  kind: CollectButtonWarning
  targetDate: string
  sameDay: boolean
  decidedRows: number
}) {
  switch (kind) {
    case 'RUNNING':
      return (
        <p className="text-ink-muted">
          수집이 도는 동안에는 다시 시작할 수 없습니다 — 같은 날짜에 두 수집이 겹치면 서로의 결과를 덮어씁니다.
        </p>
      )
    case 'OTHER_DATE':
      return (
        <p className="text-ink-muted">
          수집은 <span className="tabular-nums">{targetDate}</span> (오늘) 자로 돕니다. 지난 날짜는 다시 수집할 수
          없습니다 — 시세 소스가 직전 영업일 종가만 주기 때문입니다.
        </p>
      )
    case 'DECIDED_ROWS':
      return (
        <p className="text-pending-fg">
          {sameDay ? '재수집' : `${targetDate} 재수집`}은 기존 뉴스 후보를 지우고 다시 만듭니다. 이미 검토를 마친{' '}
          <span className="tabular-nums">{decidedRows}</span>건의 선택이 무효화됩니다(직접 고친 텍스트는 남습니다).
        </p>
      )
  }
}

function confirmText(targetDate: string, decidedRows: number): string {
  return [
    `${targetDate} 수집을 다시 돌립니다.`,
    '',
    `기존 뉴스 후보를 지우고 다시 만들기 때문에, 이미 검토를 마친 ${decidedRows}건의 선택이 무효화됩니다.`,
    '(담당자가 직접 고친 요약 텍스트는 남습니다.)',
    '',
    '계속할까요?',
  ].join('\n')
}
