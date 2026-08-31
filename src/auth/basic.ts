import { secretMatches } from '@/auth/secret'

/**
 * HTTP Basic 인증 판정. 네트워크·프레임워크와 무관한 순수 함수라서 `src/proxy.ts`
 * 없이도 그대로 테스트된다.
 *
 * ## 왜 Basic 인증인가
 *
 * 설계 문서 §9 는 "인증 없음(1단계 결정)"이었고, 그 전제는 **사내망 배포**였다.
 * Render 같은 공개 URL 에 올리는 순간 전제가 깨진다 — 검수 화면의 서버 액션은
 * 누구나 담당자의 선택을 바꿀 수 있게 되고, 엑셀도 그냥 받아진다.
 *
 * 그래서 최소한의 문지기만 세운다. 로그인 화면·세션·사용자 테이블은 만들지
 * 않는다. 2단계에서 사내 인증으로 통째로 교체될 자리라 더 짓는 것이 낭비다.
 *
 * ## 세 가지 상태 (여기가 핵심이다)
 *
 * - **둘 다 없음 → `off`.** 로컬 개발과 사내망 배포는 지금처럼 인증 없이 돈다.
 *   개발 서버를 막지 않기 위한 설계다.
 * - **둘 다 있음 → 대조.** 맞으면 통과, 틀리면 `challenge`(401).
 * - **한쪽만 있음 → `misconfigured`. 전부 막는다.**
 *
 * 마지막 항이 이 파일의 존재 이유다. 오타로 한쪽만 넣었을 때 통과시키면
 * "보호했다고 믿는 무방비 상태"가 된다 — 화면은 멀쩡히 뜨고, 사용자는 인증이
 * 걸린 줄 안다. **실패가 정상처럼 보이는 쪽으로 절대 넘어지지 않는다.**
 * 열어두는 대신 닫고 로그를 남긴다(fail closed). `api/cron/collect` 가
 * `CRON_SECRET` 미설정을 500 으로 닫는 것과 같은 방향이다.
 */

/** 인증 판정 결과. */
export type BasicAuthDecision =
  /** 인증이 꺼져 있거나(둘 다 미설정) 자격증명이 맞다. 요청을 그대로 통과시킨다. */
  | { kind: 'pass' }
  /** 자격증명이 없거나 틀리다. 401 + `WWW-Authenticate` 로 다시 묻는다. */
  | { kind: 'challenge' }
  /** 환경변수가 한쪽만 설정됐다. 401 로 전부 막고 이유를 로그에 남긴다. */
  | { kind: 'misconfigured'; reason: string }

/** 판정에 필요한 환경변수만 추린 모양. `process.env` 를 그대로 받아도 맞는다. */
export interface BasicAuthEnv {
  BASIC_AUTH_USER?: string
  BASIC_AUTH_PASSWORD?: string
}

/**
 * 빈 문자열·공백만 있는 값은 **설정되지 않은 것으로 본다.**
 * 배포 대시보드에서 키만 만들고 값을 비워 두는 실수가 흔한데, 그걸 "설정됨"으로
 * 세면 빈 비밀번호로 통과하는 문이 열린다.
 */
function configured(v: string | undefined): string | null {
  if (v === undefined) return null
  return v.trim() === '' ? null : v
}

/**
 * `Authorization: Basic <base64>` 를 사용자/비밀번호로 쪼갠다.
 *
 * **어떤 입력에도 던지지 않는다.** 깨진 헤더로 500 이 나면 그건 "서버 오류"로
 * 보이지만 실제로는 인증 실패다 — 판별 불가능한 값은 전부 `null`(=실패)이다.
 * `Buffer.from(.., 'base64')` 는 잘못된 문자를 예외 없이 버리므로, 결과에
 * 콜론이 없는 경우만 걸러내면 된다.
 */
export function parseBasicCredentials(
  header: string | null | undefined,
): { user: string; password: string } | null {
  if (typeof header !== 'string') return null
  // 스킴 이름은 대소문자를 가리지 않는다(RFC 7235). 시크릿과 무관한 검사라
  // 타이밍에 영향을 주지 않는다.
  const prefix = 'basic '
  if (header.slice(0, prefix.length).toLowerCase() !== prefix) return null

  const encoded = header.slice(prefix.length).trim()
  if (encoded === '') return null

  const decoded = Buffer.from(encoded, 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  // 콜론이 없으면 자격증명이 아니다. 비밀번호에는 콜론이 들어갈 수 있으므로
  // **첫 번째** 콜론에서만 쪼갠다.
  if (separator === -1) return null

  return { user: decoded.slice(0, separator), password: decoded.slice(separator + 1) }
}

/** 환경변수와 `Authorization` 헤더로 통과 여부를 정한다. */
export function decideBasicAuth(
  env: BasicAuthEnv,
  authorizationHeader: string | null | undefined,
): BasicAuthDecision {
  const user = configured(env.BASIC_AUTH_USER)
  const password = configured(env.BASIC_AUTH_PASSWORD)

  if (user === null && password === null) return { kind: 'pass' }

  if (user === null || password === null) {
    const missing = user === null ? 'BASIC_AUTH_USER' : 'BASIC_AUTH_PASSWORD'
    const present = user === null ? 'BASIC_AUTH_PASSWORD' : 'BASIC_AUTH_USER'
    return {
      kind: 'misconfigured',
      reason:
        `${present} 만 설정돼 있고 ${missing} 가 비어 있다. 반쪽 설정은 인증이 걸린 것처럼 ` +
        `보이면서 실제로는 아무나 들어오는 상태라, 통과시키지 않고 모든 요청을 막는다. ` +
        `두 값을 모두 넣거나, 인증을 끄려면 두 값을 모두 지워라.`,
    }
  }

  const credentials = parseBasicCredentials(authorizationHeader)
  if (credentials === null) return { kind: 'challenge' }

  // **두 비교를 모두 수행한 뒤에 합친다.** `&&` 로 단축 평가하면 사용자명이
  // 틀렸을 때 비밀번호 비교를 건너뛰어, 응답 시간이 "사용자명은 맞았는지"를
  // 흘린다. 상수 시간 비교를 쓰는 의미가 없어진다.
  const userOk = secretMatches(credentials.user, user)
  const passwordOk = secretMatches(credentials.password, password)
  return userOk && passwordOk ? { kind: 'pass' } : { kind: 'challenge' }
}
