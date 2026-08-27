import { redirect } from 'next/navigation'
import { kstDateString } from '@/domain/date'

/**
 * 루트는 오늘자 검수 화면으로 보낸다.
 *
 * `force-dynamic` 이 필요하다. 그러지 않으면 Next 가 이 리다이렉트를 **빌드 시각의
 * 날짜로 고정해** 정적 생성하고, 배포한 날 이후로는 매일 지난 날짜의 화면으로
 * 보낸다 — 담당자가 어제 브리프를 오늘 것으로 읽게 되는, 조용하고 위험한 오류다.
 *
 * 날짜는 KST 기준이다(수집·URL 키가 전부 KST 날짜다 — domain/date.ts).
 */
export const dynamic = 'force-dynamic'

export default function Home() {
  redirect(`/review/${kstDateString(new Date())}`)
}
