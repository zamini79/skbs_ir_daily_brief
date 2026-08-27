import { createHash, timingSafeEqual } from 'node:crypto'
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

/**
 * 시크릿 비교. `!==` 는 첫 다른 바이트에서 즉시 끝나므로 원리상 응답 시간이
 * "몇 글자까지 맞았는지"를 흘린다. 지금은 인증 없는 1단계 설계에 수집만
 * 트리거하는 엔드포인트라 실질 위험이 낮지만, 사내 이관 후에는 이 시크릿이
 * 유일한 보호 장치가 된다(3부).
 *
 * 길이가 다르면 timingSafeEqual 이 던지므로, 먼저 길이를 비교하는 대신
 * **SHA-256 다이제스트(항상 32바이트)를 비교한다** — 길이 자체도 흘리지 않는다.
 */
function secretMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false
  const digest = (v: string): Buffer => createHash('sha256').update(v, 'utf8').digest()
  return timingSafeEqual(digest(provided), digest(expected))
}

/** `Authorization: Bearer <token>` 에서 토큰만 꺼낸다. 접두사 검사는 시크릿과
 * 무관하므로 타이밍에 영향을 주지 않는다. */
function bearerToken(header: string | null): string | null {
  if (header === null || !header.startsWith('Bearer ')) return null
  return header.slice('Bearer '.length)
}

export async function POST(request: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET
  if (!expected) {
    // 시크릿이 서버에 설정되지 않았다면 열어두지 않고 무조건 막는다(fail closed).
    return Response.json({ error: 'CRON_SECRET 미설정' }, { status: 500 })
  }
  if (!secretMatches(request.headers.get('x-cron-secret'), expected)) {
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
  if (!secretMatches(bearerToken(request.headers.get('authorization')), expected)) {
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
