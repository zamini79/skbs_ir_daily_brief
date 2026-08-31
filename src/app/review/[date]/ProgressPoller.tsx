'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * 수집이 도는 동안 화면을 주기적으로 다시 읽는다.
 *
 * **이 컴포넌트는 도는 중일 때만 마운트된다**(page.tsx 의 `shouldPollProgress`).
 * "폴링할지"를 여기서 판단하지 않는 것이 요점이다 — 조건을 안에 두면 끝난 화면에도
 * 타이머가 살아 있고, 끄는 조건을 한 번 빠뜨리면 완료된 화면을 영원히 두드린다.
 * 마운트 자체가 조건이면 조건이 거짓이 되는 순간 타이머도 함께 사라진다.
 *
 * **멈춘 것으로 보이는 실행도 폴링하지 않는다.** 그 화면은 4초 뒤에도 같은 값이다.
 *
 * `router.refresh()` 는 서버 컴포넌트만 다시 받아 온다 — 페이지가 `force-dynamic`
 * 이라 `BriefRun.progressDetail` 의 최신 값이 그대로 따라온다. 검수자가 열어 둔
 * 행 패널이나 입력 중인 텍스트는 클라이언트 상태라 날아가지 않는다.
 */
export function ProgressPoller({ intervalMs }: { intervalMs: number }) {
  const router = useRouter()

  useEffect(() => {
    const id = setInterval(() => router.refresh(), intervalMs)
    return () => clearInterval(id)
  }, [router, intervalMs])

  return null
}
