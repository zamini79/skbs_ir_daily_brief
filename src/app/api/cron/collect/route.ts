import { secretMatches } from '@/auth/secret'
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
 * **이 경로는 `src/proxy.ts` 의 Basic 인증 matcher에서 제외돼 있다.** 크론은
 * 자기 시크릿으로 인증하며, 여기에 Basic 인증까지 얹으면 crontab의 `curl` 한
 * 줄이 깨진다(설계 문서 §4.1-3). 제외는 의도된 것이니 되돌리지 마라 —
 * 시크릿 검사가 이 경로의 유일하고 충분한 보호 장치다.
 *
 * ## maxDuration 은 **수동 트리거 경로를 위한 것**이다
 *
 * **정기 실행을 Vercel 로 돌리는 것은 더 이상 지원 대상이 아니다.** 2026-09-01 실측:
 * 후보 37건 수집에 **457.7초**가 걸린다(요약 실패 0). 그 감속은 화면의 「본문 발췌」를
 * 없애기 위해 필요한 것이고(설계 §8.1.8), 감속을 걷어내도 순수 작업 시간이 약 236초라
 * 300초 상한에 여유가 없다. 여기에 요약 단계 마감 20분(`SUMMARY_DEADLINE_MS`)까지
 * 감안하면 Vercel 의 어떤 플랜으로도 상한이 맞지 않는다.
 *
 * 원래 설계가 스케줄러를 코드 밖에 둔 이유가 이것이다(§4.1-3) — **사내 crontab 이
 * 원래 목적지**이고 거기에는 이런 상한이 없다. Render 도 요청 상한이 100분이라 무관하다.
 *
 * 800은 Vercel 이 허용하는 최댓값이고, 손으로 이 엔드포인트를 부르는 경우를 위해 남긴다.
 * **Vercel Hobby(300초 상한)에서는 이 값이 빌드 오류이며, 애초에 이 작업이 돌지 않는다.**
 */
export const maxDuration = 800
export const dynamic = 'force-dynamic'

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
