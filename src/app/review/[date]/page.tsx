import { getBriefRows, runStatusLabel } from '@/db/repo'
import { BriefTable } from './BriefTable'

const STATUS_BANNER_STYLE: Record<string, string> = {
  COLLECTING: 'border-blue-300 bg-blue-50 text-blue-800',
  READY: 'border-emerald-300 bg-emerald-50 text-emerald-800',
  PARTIAL: 'border-amber-400 bg-amber-50 text-amber-900',
  FAILED: 'border-red-400 bg-red-50 text-red-800',
}

export default async function ReviewPage({ params }: { params: Promise<{ date: string }> }) {
  const { date } = await params
  const data = await getBriefRows(date)

  if (!data) {
    return (
      <main className="min-h-screen bg-white p-8 text-gray-900 [color-scheme:light]">
        <h1 className="text-xl font-bold">{date} 브리프가 없습니다</h1>
        <p className="mt-2 text-sm text-gray-600">수집이 아직 돌지 않았습니다.</p>
      </main>
    )
  }

  const pending = data.rows.filter(r => r.state === 'PENDING').length
  const bannerStyle = STATUS_BANNER_STYLE[data.run.status] ?? 'border-gray-300 bg-gray-50 text-gray-700'

  return (
    /*
     * 이 화면은 하루 한 번, 마감 시간 압박 속에서 훑어보는 내부 도구다.
     * OS/브라우저의 다크 모드 설정을 그대로 물려받으면 행 배경(bg-amber-50 등)은
     * 옅은 색 그대로인데 글자색만 밝은 색으로 뒤집혀 사실상 안 보이게 된다
     * (특히 PENDING 행 — 검수가 가장 급한 행). 페이지 전체를 라이트 테마로
     * 명시적으로 고정해 OS 설정이 새어 들어오지 못하게 한다.
     */
    <main className="min-h-screen bg-white p-6 text-gray-900 [color-scheme:light]">
      <header className="mb-4 flex items-baseline gap-4">
        <h1 className="text-xl font-bold">주가 현황 및 뉴스 — {date}</h1>
        <span className="text-sm text-gray-600">
          미검토 {pending}건 / 전체 {data.rows.length}건
        </span>
      </header>

      <div className={`mb-4 rounded border px-3 py-2 text-sm ${bannerStyle}`}>
        <span className="font-semibold">실행 상태: {runStatusLabel(data.run.status)}</span>
        {data.run.status === 'PARTIAL' && data.run.statusDetail && (
          <span className="ml-2">— {data.run.statusDetail}</span>
        )}
      </div>

      <BriefTable runDate={date} rows={data.rows} />
    </main>
  )
}
