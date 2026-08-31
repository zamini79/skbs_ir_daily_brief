import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { decideBasicAuth } from '@/auth/basic'

/**
 * 공개 URL 앞에 세우는 최소 문지기(HTTP Basic 인증).
 *
 * 판정은 전부 `src/auth/basic.ts` 에 있다 — 여기는 판정 결과를 HTTP 응답으로
 * 옮기기만 한다. 인증을 켜고 끄는 규칙과 반쪽 설정을 막는 이유는 그 파일의
 * 주석을 읽어라.
 *
 * **Next.js 16 에서 `middleware.ts` 는 `proxy.ts` 로 이름이 바뀌었다**
 * (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/middleware.md`).
 * 옛 이름은 아직 동작하지만 deprecated 다. 그리고 16 부터 Proxy 는 **Node.js
 * 런타임이 기본**이라 `node:crypto` 의 `timingSafeEqual` 을 그대로 쓸 수 있다
 * (Edge 런타임이던 시절에는 못 썼다). `runtime` 설정을 여기에 쓰면 에러가 난다.
 */

/** 브라우저 인증 창에 뜨는 이름. */
const REALM = 'IR Daily Brief'

/**
 * 인증을 거는 경로.
 *
 * 제외 대상과 이유:
 * - `api/cron/collect` — 크론은 `CRON_SECRET` 으로 스스로 인증한다. 여기에
 *   Basic 인증까지 요구하면 설계 문서 §4.1-3 의 "crontab 의 `curl` 한 줄"이
 *   깨진다. **의도된 제외다. 되돌리지 마라.**
 * - `_next/static`, `_next/image` — 매 요청 인증할 이유가 없는 정적 자산이다.
 * - `favicon.ico` — 같은 이유.
 *
 * 나머지는 전부 인증을 탄다. 특히 `/review/[date]`(검수 화면과 그 서버 액션)와
 * `/api/export/[date]`(엑셀)는 반드시 포함돼야 한다 — 이 둘이 이번에 막으려는
 * 대상이다. 서버 액션은 별도 경로가 아니라 **자기가 쓰인 페이지 경로로 가는
 * POST** 이므로, `/review/...` 가 matcher 에 들어 있으면 함께 보호된다.
 *
 * matcher 값은 빌드 타임에 정적 분석되므로 **반드시 리터럴이어야 한다.**
 * 변수로 빼면 Next 가 무시한다(문서 "Good to know").
 */
export const config = {
  matcher: ['/((?!api/cron/collect|_next/static|_next/image|favicon\\.ico).*)'],
}

function challenge(): NextResponse {
  return new NextResponse('인증이 필요합니다.\n', {
    status: 401,
    headers: {
      // charset 을 붙여야 한글이 섞인 자격증명이 UTF-8 로 인코딩된다(RFC 7617).
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'content-type': 'text/plain; charset=utf-8',
    },
  })
}

/**
 * 반쪽 설정일 때의 응답.
 *
 * **`WWW-Authenticate` 를 일부러 붙이지 않는다.** 이 상태에서는 어떤 자격증명도
 * 통과할 수 없으므로 인증 창을 띄우면 사용자가 영원히 같은 창을 다시 보게 되고,
 * 진짜 원인(환경변수 반쪽 설정)은 끝내 화면에 나오지 않는다. 상태 코드는 401
 * 그대로 두되, 이유는 본문과 서버 로그에 적는다.
 */
function misconfigured(reason: string): NextResponse {
  console.error(`[basic-auth] 설정 오류로 모든 요청을 차단한다: ${reason}`)
  return new NextResponse(
    `서버 설정 오류: BASIC_AUTH_USER 와 BASIC_AUTH_PASSWORD 중 한쪽만 설정돼 있습니다.\n` +
      `안전한 쪽으로 모든 요청을 차단합니다. 배포 환경변수를 확인하세요.\n`,
    { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8' } },
  )
}

export function proxy(request: NextRequest): NextResponse {
  // 인덱스 접근(`process.env['X']`)으로 읽는다. Next 는 `process.env.X` 형태를
  // 빌드 타임에 값으로 치환할 수 있는데, 그러면 배포 후 대시보드에서 값을
  // 고쳐도 재배포 전까지 반영되지 않는다. 인증 스위치가 그런 식으로 굳으면
  // "껐는데 켜져 있거나, 켰는데 꺼져 있는" 상태를 만든다.
  const decision = decideBasicAuth(
    {
      BASIC_AUTH_USER: process.env['BASIC_AUTH_USER'],
      BASIC_AUTH_PASSWORD: process.env['BASIC_AUTH_PASSWORD'],
    },
    request.headers.get('authorization'),
  )

  switch (decision.kind) {
    case 'pass':
      return NextResponse.next()
    case 'misconfigured':
      return misconfigured(decision.reason)
    case 'challenge':
      return challenge()
  }
}
