import { runCollection } from '@/pipeline/collect'

/**
 * 수집 트리거 엔드포인트.
 *
 * 스케줄러를 앱 코드에 넣지 않는 것이 이관 전략의 핵심이다: Vercel Cron이
 * 오늘 이 엔드포인트를 부르고, 온프레미스 이관 후에는 사내 crontab의 curl이
 * 같은 엔드포인트를 부른다. 앱 코드는 바뀌지 않는다.
 *
 * - POST + `x-cron-secret` 헤더: 사내 crontab이 보낼 방식.
 * - GET + `Authorization: Bearer <secret>` 헤더: Vercel Cron이 보내는 방식.
 *   GET은 POST 로직에 위임한다(중복 구현 금지).
 *
 * 실제 수집이 56초 걸린 것을 측정했으므로 넉넉한 maxDuration을 둔다.
 */
export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    // 시크릿이 서버에 설정되지 않았다면 열어두지 않고 무조건 막는다(fail closed).
    return Response.json({ error: 'CRON_SECRET 미설정' }, { status: 500 })
  }
  if (request.headers.get('x-cron-secret') !== expected) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    const result = await runCollection(new Date())
    return Response.json(result)
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ error: message }, { status: 500 })
  }
}

/**
 * Vercel Cron 스케줄은 `40 22 * * 0-4`(UTC, 일~목)로 등록되어 있다.
 * 이는 KST 평일(월~금) 07:40이다 — UTC 표기만 보고 로컬 시간으로 착각해
 * "고치지" 말 것.
 */
export async function GET(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    return Response.json({ error: 'CRON_SECRET 미설정' }, { status: 500 })
  }
  if (request.headers.get('authorization') !== `Bearer ${expected}`) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Vercel Cron 경로: 헤더 이름만 다르고 하는 일은 POST와 완전히 같다.
  return POST(
    new Request(request.url, {
      method: 'POST',
      headers: { 'x-cron-secret': expected },
    }),
  )
}
