import { charLength, truncateAtSentence } from '@/domain/text'
import { kstDateString } from '@/domain/date'
import { buildPrompt, MAX_SUMMARY_CHARS } from './prompt'
import { isTransientNetworkError } from '../transientNetwork'

/**
 * 요약 모델 폴백 체인.
 *
 * 무료 티어의 일일 쿼터는 "모델별로" 소진된다(실측: gemini-3.6-flash 가 429로
 * GenerateRequestsPerDayPerProjectPerModel-FreeTier 를 반환하는 순간에도
 * gemini-3.5-flash-lite 는 200을 돌려줬다). 그래서 단일 모델이 아니라 순서가
 * 있는 체인을 둔다 — 한 모델의 하루 치가 끝나면 다음 모델로 넘어간다.
 *
 * ## 순서는 곧 품질 정책이다 (지우지 마라)
 *
 * 체인이 길어질수록 **뒤쪽 모델의 품질 편차가 커진다.** 그런데 요약은 나쁘게
 * 나와도 "요약처럼" 생겼다 — 검수 화면에서 좋은 모델의 결과와 글자 하나
 * 다르지 않게 보인다. 그래서 **좋은 모델을 앞에 두는 것 자체가 안전장치**다:
 * 평상시(앞쪽 모델이 살아 있는 동안) 담당자에게 가는 것은 검증된 결과이고,
 * 뒤쪽 모델은 앞이 전부 소진된 날에만 "빈칸보다는 낫다"의 자리에서 일한다.
 *
 * **2026-08-28 현재 체인은 전원 `verified` 다**(gemini 7개). `last-resort` 자리에 있던
 * `gemma-4-31b-it` 은 실제 기사 본문 재측정 뒤 배제했다 — 타임아웃 60초가 수집 창을
 * 갉아먹는 비용이 그 자리에서 얻는 것보다 컸다(EXCLUDED_MODELS 참고). `last-resort`
 * 등급 자체는 남겨 둔다: 다음에 "빈칸보다는 낫다" 후보가 생기면 그 자리를 명시적으로
 * 표시할 수단이 있어야 하고, 순서 불변식을 테스트가 계속 지키고 있어야 하기 때문이다.
 *
 * 이 배열을 **모델 이름 문자열이 아니라 구조체로 두는 이유가 그것이다.**
 * 이름만 늘어놓으면 나중에 누가 알파벳순으로 정렬하거나 "최신 모델을 앞으로"
 * 옮기면서 이 정책을 흔적 없이 지운다. `quality` 는 그 정렬을 테스트가 막기
 * 위한 필드다(gemini.test.ts 의 "체인 순서 정책" 참고).
 *
 * 어느 모델이 실제로 답했는지는 `NewsCandidate.summaryModel` 에 남는다 —
 * 요약 품질이 이상한 날에는 그 컬럼부터 본다(docs/운영.md 2.8).
 */
export type ChainQuality =
  /**
   * 여러 기사로 JSON·문체(개조식)·길이를 실측 확인했다. 평상시 담당자에게
   * 가는 결과는 이 등급에서 나와야 한다.
   */
  | 'verified'
  /**
   * JSON 은 내지만 품질을 아직 신뢰할 수 없다. **앞의 모델이 전부 소진된
   * 날에만** 쓰이는 "빈칸보다는 낫다" 자리. verified 앞으로 옮기지 마라.
   */
  | 'last-resort'

export type ChainEntry = {
  model: string
  quality: ChainQuality
  /** 이 자리에 있는 근거. 실측 날짜와 관측값을 남긴다. */
  note: string
}

export const MODEL_CHAIN_ENTRIES: readonly ChainEntry[] = [
  {
    model: 'gemini-3.6-flash',
    quality: 'verified',
    note: '기준 모델. 품질을 실측으로 검증한 유일한 모델이라 맨 앞에 둔다(task-13-report.md).',
  },
  {
    model: 'gemini-3.5-flash-lite',
    quality: 'verified',
    note: '측정된 품질(2안이 100자 이내인지, 관점이 실제로 갈리는지) 순 배치. 응답 1~2초로 가장 빠르다.',
  },
  {
    model: 'gemini-flash-lite-latest',
    quality: 'verified',
    note: '위와 같은 근거로 배치. 2026-08-28 재확인: 200 OK, 1.5초.',
  },
  {
    model: 'gemini-3.5-flash',
    quality: 'verified',
    note: '위와 같은 근거로 배치. 사고 토큰이 많아 10초대.',
  },
  {
    model: 'gemini-3.1-flash-lite',
    quality: 'verified',
    note: '100자를 자주 넘겨 truncateAtSentence 개입이 잦다 — 그래서 검증군 중 마지막이다.',
  },
  {
    model: 'gemini-3-flash-preview',
    quality: 'verified',
    note:
      '2026-08-28 추가. 프로덕션과 같은 responseSchema 로 실측: JSON OK, 개조식 준수, ' +
      '93~107자(초과분은 절삭된다). 사고 토큰이 8,300여 개라 34초가 걸린다 — 60초 타임아웃 ' +
      '안이지만 여유가 크지 않으니, 이 모델까지 내려온 날은 수집이 느려진다.',
  },
  {
    model: 'gemini-3.1-flash-lite-preview',
    quality: 'verified',
    note:
      '2026-08-28 추가. JSON OK, 5초로 빠르다. 다만 실측 108~126자로 100자를 상시 초과해 ' +
      '절삭이 늘 개입한다 — 그래서 gemini-3-flash-preview 뒤다.',
  },
] as const

/**
 * 체인에 **넣지 않기로 실측을 근거로 결정한** 모델과 그 사유.
 *
 * 목록으로 남기는 이유: 사유 없이 빠져 있으면 다음 사람이 "왜 없지?" 하고 다시
 * 넣는다. 테스트가 이 목록의 모델이 체인에 없음을 강제한다.
 */
export const EXCLUDED_MODELS: Readonly<Record<string, string>> = {
  'gemini-2.5-flash': '신규 키에 404(NOT_FOUND, 영구 실패). 쿼터 소진도 일시적 장애도 아니라 체인을 넘기는 조건에 해당하지 않는다.',
  'gemini-2.5-flash-lite': '신규 키에 404(NOT_FOUND, 영구 실패). 어느 자리에 두든 체인을 넘기는 조건이 아니라서 그 뒤 모델을 통째로 무력화한다.',
  'gemini-2.5-pro': '신규 키에 404(NOT_FOUND, 영구 실패). gemini-2.5 계열은 신규 사용자에게 모두 폐지됐다.',
  'gemini-3.7-flash': '실측할 때마다 503(UNAVAILABLE)이라 응답 품질을 한 번도 측정하지 못했다. 2026-08-28 재확인에도 503. 품질을 추측해서 순서를 매기지 않는다 — 200 을 받는 날 재측정하면 넣을 수 있다.',
  'gemini-flash-latest': '2026-08-28 실측 503(UNAVAILABLE, high demand). gemini-3.7-flash 와 같은 이유로 품질을 측정하지 못했다.',
  'gemini-pro-latest': '실측 429(RESOURCE_EXHAUSTED). 무료 티어에서 쓸 수 있는 여유가 없다.',
  'gemini-3.1-pro-preview': '실측 429(RESOURCE_EXHAUSTED). pro 계열은 무료 티어 일일 한도가 사실상 없어 체인에 넣어도 매번 건너뛴다.',
  'gemini-omni-1.1-flash': '실측 429(RESOURCE_EXHAUSTED). 첫 호출부터 소진 상태라 이 키로는 쓸 수 없다.',
  'gemma-4-31b-it':
    '**실제 기사 본문에서는 쓸 수 없다.** 짧은 합성 기사로 잰 첫 표본(26회 중 20회 성공)이 ' +
    '전혀 대표적이지 않았다. 실제 크롤링 본문 24회 재측정: **타임아웃 12 / 코드펜스로 감싼 응답 12 / ' +
    '펜스 없는 정상 JSON 0.** 즉 실제 입력에서는 항상 규약을 어기고, 절반은 60초 안에 답하지 못한다. ' +
    '**배제의 결정적 근거는 타임아웃 비용이다.** 한 번이 60초이고 요약 동시성은 4다. 이 모델까지 ' +
    '내려간 날 후보 20건이 닿으면 20 × 60초 ÷ 4 = **5분**을 순수 대기로 쓴다 — 시세·뉴스·요약을 ' +
    '모두 처리해야 하는 07:40~08:00 창 20분의 4분의 1이다. 수율 50% 짜리 모델에 걸 수 없다. ' +
    '여기에 조용한 실패도 겹친다: 파싱된 12건 중 1건은 내용이 무너져 있었다("유럽으로의 시장으로의 ' +
    '확장 및 미국으로의 … same-day same-day own ow"). 아래 gemma-4-26b-a4b-it 과 성질이 같고 ' +
    '비율만 40% → 8% 로 낮다. 발췌 폴백은 배지가 붙고 본문에서 그대로 오려낸 문장이라 이미 정직하므로, ' +
    '이 모델을 두고 얻는 것("8순위까지 내려간 날에만, 절반의 확률로, 발췌 대신 요약")이 비용보다 작다. ' +
    '(브리프가 남긴 "maxOutputTokens 3000 에서 잘린다"는 재현되지 않았다 — 출력이 65~193토큰이라 ' +
    '애초에 상한에 닿지 않는다. 잘린 게 아니라 펜스였다.)',
  'gemma-4-26b-a4b-it':
    '**JSON 은 내지만 내용이 무너진다.** 2026-08-28 프로덕션과 같은 설정으로 10회 호출: ' +
    '5회 120초 초과(프로덕션 타임아웃 60초를 훨씬 넘는다), 1회만 정상, 4회는 finishReason=STOP ' +
    '인 채로 (a) 프롬프트의 자리표시자를 본문에 흘리고("1안(수치 중심): ..."), ' +
    '(b) 한국어가 깨지고("체결질적적 변화", "가동률 회솔복", "도약약속함"), ' +
    '(c) 한 번은 `<em>undercut</em>` 을 110회 반복한 2,081자를 냈다. ' +
    '이 출력은 enforceLimit 가 100자로 잘라 **정상 요약과 똑같이 「① 수치 중심」 라벨을 달고** ' +
    '화면에 오른다 — 이 저장소가 여섯 번 반복한 "부분 실패가 정상값과 똑같이 보이는" 결함 그 자체다. ' +
    '발췌 폴백은 최소한 「본문 발췌」 배지가 붙고 본문에서 그대로 오려낸 문장이다. ' +
    '따라서 이 모델은 "빈칸보다는 낫다"가 아니라 **발췌보다도 나쁘다.**',
}

/**
 * 체인의 모델 이름만 순서대로. `MODEL_CHAIN_ENTRIES` 가 유일한 출처다 —
 * 여기에 직접 이름을 추가하지 마라(순서의 근거가 사라진다).
 */
export const MODEL_CHAIN: readonly string[] = MODEL_CHAIN_ENTRIES.map(e => e.model)

function endpointFor(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
}

/**
 * 프로세스 생애주기 동안 "쿼터가 소진됐다"고 확인된 모델만 기록한다(영구적 —
 * 하루 치가 끝났다는 뜻). 파이프라인 한 번 실행에서 최대 69회를 호출하므로,
 * 첫 모델이 죽으면 그 뒤로는 매 호출마다 죽은 모델을 다시 두드리지 않고 바로
 * 다음 모델부터 시작한다.
 *
 * 일시적 장애(503/500)로 넘어간 모델은 여기 기록하지 않는다 — 순간적인 결함
 * 한 번으로 멀쩡한 모델을 남은 실행 내내 제외시키면 안 되기 때문이다. 다음
 * summarize() 호출은 다시 체인 맨 앞부터 그 모델을 시도한다.
 */
export const exhaustedModels = new Set<string>()

/**
 * exhaustedModels 가 마지막으로 리셋된 KST 날짜. summarize() 호출마다 오늘
 * 날짜와 비교해서 다르면 소진 기록을 비운다.
 *
 * 지금은 Vercel(인스턴스가 짧게 산다)에서 돌지만, 원래 설계는 크론을 crontab 에
 * 둔 상시 실행 서버로 옮기는 것이다(그래서 스케줄러가 코드가 아니라 crontab에
 * 있다) — 그러면 이 모듈이 프로세스 재시작 없이 며칠이고 살아있는다. 리셋이
 * 없으면 월요일 07:40 에 소진된 모델이 화요일에도, 수요일에도 계속 제외된 채로
 * 남는다. 구글의 무료 티어 쿼터는 조용히 매일 리셋되는데 우리 쪽은 절대
 * 리셋되지 않으면, 체인이 가장 약한 모델들로 조용히 저하된 채 영원히 머문다.
 *
 * 구글의 실제 리셋은 태평양 시간 자정 기준이지만, 여기서는 의도적으로 KST
 * 자정을 쓴다. 이 시스템은 크론이 07:40 KST 한 번만 도는 구조이므로, KST
 * 자정을 기준으로 하면 "리셋이 아직 유효한 소진 기록을 너무 이르게 지워버리는"
 * 창이 하루에 최대 한 번을 넘지 않는다는 게 보장된다. UTC나 태평양 시간으로
 * "고치면" 이 보장이 깨지니 바꾸지 말 것 — 절대 리셋하지 않는 것보다는
 * 이쪽이 훨씬 낫다.
 */
let exhaustedModelsResetDate: string | null = null

function resetExhaustedModelsIfNewDay(): void {
  const today = kstDateString(new Date())
  if (exhaustedModelsResetDate !== today) {
    exhaustedModels.clear()
    exhaustedModelsResetDate = today
  }
}

/**
 * 체인을 어떻게 다룰지 정하는 실패 분류.
 *
 *  - `quota`       그 모델의 하루치가 끝났다 → 소진 기록 + 다음 모델
 *  - `unavailable` 구글 쪽 일시적 장애(503/500) → 기록 없이 다음 모델
 *  - `no-response` **응답 자체가 없었다**(타임아웃·네트워크) → 기록 없이 다음 모델
 *  - `other`       세이프티 차단·인증 오류 등 → 던진다(다른 모델로 가려지면 안 된다)
 *
 * `unavailable` 과 `no-response` 는 체인에서 하는 일이 같지만 **구분해서 남긴다.**
 * 전부 실패했을 때 "구글이 503 을 줬다"와 "우리가 응답을 못 받았다"는 운영자가
 * 볼 곳이 다르다 — 전자는 기다리는 문제고 후자는 네트워크·타임아웃 설정 문제다.
 */
type FailureClass = 'quota' | 'unavailable' | 'no-response' | 'other'

/**
 * 외부 응답 문자열에서 API 키를 지운다. 키는 쿼리스트링(`?key=...`)으로 나가므로
 * 오류 본문이 요청 URL 을 되비추면 키가 그대로 딸려 온다. 이 문자열은
 * `NewsCandidate.summaryError` 로 **DB 에 저장되고 화면의 title 속성에도 실린다** —
 * 로그만 조심해서는 막을 수 없는 경로다.
 *
 * URL 인코딩된 형태도 함께 지운다. 빈 키는 무시한다 — `replaceAll('', ...)` 은
 * 모든 문자 사이에 치환문을 끼워 넣어 문자열을 망가뜨린다.
 */
export function redactKey(text: string, key: string): string {
  if (!key) return text
  const encoded = encodeURIComponent(key)
  let out = text.replaceAll(key, '<redacted>')
  if (encoded !== key) out = out.replaceAll(encoded, '<redacted>')
  return out
}

/**
 * **응답을 받았을 때**의 실패를 분류한다. 상태 코드가 최우선(authoritative)
 * 신호다 — 429/503/500 은 그 자체로 확정적이라서 본문은 보지 않는다. 본문
 * 문자열(RESOURCE_EXHAUSTED/UNAVAILABLE)은 상태 코드가 이 셋 중 무엇도 아니어서
 * 확정할 수 없을 때만 보조로 쓴다. 상태를 먼저 확정 짓지 않고 문자열만으로
 * 판단하면, 예를 들어 503 응답 본문에 우연히 다른 문구가 섞여 들어와도 오분류할
 * 위험이 있다. 순서를 이렇게 두면 구글이 문구를 바꿔도 최악의 경우 "놓칠" 뿐,
 * 상태 코드가 이미 확정한 답을 문자열이 뒤집는 일은 없다.
 */
export function classifyFailure(status: number, detail: string): FailureClass {
  if (status === 429) return 'quota'
  if (status === 503 || status === 500) return 'unavailable'
  if (detail.includes('RESOURCE_EXHAUSTED')) return 'quota'
  if (detail.includes('UNAVAILABLE')) return 'unavailable'
  return 'other'
}

/**
 * **`fetch` 가 던졌을 때**(응답 자체가 없을 때)의 실패를 분류한다.
 *
 * 예전에는 이 경로가 아예 없었다 — `fetch` 가 던지면 예외가 for 루프 밖으로
 * 그대로 새어나가 **체인 전체가 거기서 끝났다.** 3번 모델에서 타임아웃 한 번이
 * 나면 남은 5개를 시도조차 못 하고 그 후보가 발췌 폴백으로 떨어졌다. 체인이
 * 8개로 길어지면서 그 손실이 커졌다.
 *
 * 타임아웃은 기능적으로 503 과 같다(그 모델이 지금 응답을 못 준다). 그래서
 * 503 과 같은 규칙으로 다룬다 — **다음 모델로 넘어가되 소진으로 기록하지
 * 않는다.** 순간적인 결함 한 번으로 멀쩡한 모델을 남은 실행 내내 제외시키면
 * 안 되기 때문이다(exhaustedModels 주석과 같은 근거).
 *
 * 판정 기준은 시세 경로와 **한 벌을 공유한다**(`../transientNetwork`).
 * 일시적 네트워크 장애가 아닌 예외는 `other` 다 — 던져야 진단이 가려지지 않는다.
 */
function classifyThrownFailure(error: unknown): FailureClass {
  return isTransientNetworkError(error) ? 'no-response' : 'other'
}

/**
 * **응답 본문을 읽는 도중** 끊긴 것인지 판별한다.
 *
 * `fetch` 는 헤더를 받으면 반환하고, 본문은 `res.text()`/`res.json()` 에서 흘러온다.
 * 그 사이에 소켓이 끊기거나 60초 타임아웃이 걸리면 예외가 **본문 읽기 쪽에서** 난다 —
 * `fetch` 호출을 감싼 try 로는 못 잡는다. 기능적으로는 fetch 가 던진 것과 같다:
 * 이 모델은 답을 못 줬으니 다음 모델로 가야 한다.
 *
 * **공유 목록(`../transientNetwork`)을 넓히지 않고 여기서 끝낸다.** 그 목록은 시세
 * 경로(`classifyQuoteFailure`)와 함께 쓰므로, 거기에 `terminated` 같은 패턴을 넣으면
 * 시세 재시도 동작까지 바뀐다 — 요청받지 않은 변경이다. 본문 읽기 중 끊김은 이
 * 파일에서만 나는 문제이므로 판정도 이 파일에 둔다.
 *
 * undici 는 본문 도중 소켓이 끊기면 `TypeError: terminated` 를 던진다(원인은 `cause`).
 * 여기에 공유 판정(타임아웃·`fetch failed` 등)을 더한 것이 전부다.
 *
 * **JSON 문법 오류는 여기 해당하지 않는다.** `res.json()` 이 `SyntaxError` 를 던지면
 * 그건 연결 문제가 아니라 응답이 이상한 것이다 — 체인으로 넘기지 않고 던져야 진단이
 * 가려지지 않는다(`classifyFailure` 의 `other` 와 같은 취급).
 */
function isBodyReadFailure(error: unknown): boolean {
  if (isTransientNetworkError(error)) return true
  const message = error instanceof Error ? error.message : String(error)
  return /\bterminated\b|premature close|ERR_STREAM_PREMATURE_CLOSE/i.test(message)
}

/**
 * 모델이 JSON 을 ```` ```…``` ```` 코드펜스로 감싸 보냈으면 그 안쪽을 꺼낸다.
 * 감싸지 않았으면 `null`.
 *
 * **평상시 경로가 아니다.** 호출부는 정상 `JSON.parse` 를 먼저 시도하고, 그것이
 * 실패했을 때만 이 함수를 부른다. 그래서 규약을 지키는 모델(체인의 gemini 7개)은
 * 이 코드를 한 번도 지나가지 않는다 — 위험은 규약을 어기는 모델 자리에만 남는다.
 *
 * 실측(2026-08-28, `gemma-4-31b-it`): `responseMimeType` 이 `application/json`
 * 인데도 응답이 이렇게 왔다.
 *
 *     ' {\n  "numeric": "…",\n  "context": "…"\n}\n```'
 *
 * **여는 펜스 없이 닫는 펜스만 붙는다**(실측 표본 3개 모두). 여는 펜스가 함께
 * 오는 형태(```` ```json ```` 포함)도 같이 처리하지만, 실제로 본 것은 닫는 펜스뿐인
 * 쪽이다. 그래서 "여는 펜스가 있어야만 벗긴다"로 만들면 실제 실패를 못 잡는다.
 *
 * 벗겨낸 뒤에도 파싱에 실패하면 호출부가 **그대로 실패시킨다.** 무리해서 건져내지
 * 않는다 — 깨진 응답을 억지로 살리면 그게 정상 요약처럼 화면에 오른다.
 *
 * **현재 체인에 이 경로를 쓰는 모델은 없다.** 이 코드를 필요로 하던 `gemma-4-31b-it`
 * 은 2026-08-28 에 배제됐고, 남은 gemini 7개는 실측상 펜스를 붙인 적이 한 번도 없다.
 * **그래도 지우지 마라 — 죽은 코드가 아니다.** 정상 파싱이 실패했을 때만 도는 경로라
 * 비용이 0 이고, 복구하면 경고 로그가 남는다. 다음에 어떤 모델이 같은 짓을 하면
 * 그때 조용히 폴백으로 새지 않고 로그에 드러난다 — 그것이 이 코드의 값어치다.
 */
export function stripCodeFence(text: string): string | null {
  if (!text.includes('```')) return null
  const inner = text
    .replace(/^\s*```[A-Za-z0-9_+-]*[ \t]*\r?\n?/, '')
    .replace(/\r?\n?[ \t]*```[ \t]*$/, '')
    .trim()
  if (inner === '' || inner === text.trim()) return null
  return inner
}

export type SummarySet = {
  numeric: string
  context: string
  /** 이 2안을 실제로 만들어낸 모델. 폴백 체인에서 몇 번째로 답한 모델인지
   * 나중에 추적할 수 있도록 남긴다 — 예: gemini-3.1-flash-lite 는 100자
   * 제한을 자주 넘겨서 truncateAtSentence 가 더 많이 개입한다. 체인이 8개로
   * 늘어난 뒤로는 "오늘 요약이 왜 이상한가"의 답이 대개 이 값에 있다. */
  model: string
}

/**
 * Gemini 3.x 는 파트에 thoughtSignature 를 함께 실어 보낸다.
 * parts[0].text 를 그대로 쓰면 빈 응답처럼 보인다.
 *
 * 07:40 무인 크론에서 실패할 때 원인을 바로 알 수 있도록, "text 파트 없음"을
 * 뭉뚱그려 던지지 않고 페이로드가 실제로 어떤 모양인지에 따라 메시지를 구분한다:
 * 세이프티 차단 / candidates 없음 / 파트는 있는데 전부 thought 뿐인 경우.
 */
export function extractJsonText(payload: unknown): string {
  const p = payload as any

  const blockReason = p?.promptFeedback?.blockReason
  if (blockReason) {
    throw new Error(`gemini: 응답이 차단됐다 (blockReason=${blockReason})`)
  }

  const candidates = p?.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error('gemini: candidates 가 비어있다')
  }

  const parts = candidates[0]?.content?.parts ?? []
  for (const part of parts) {
    if (typeof part?.text === 'string' && !part.thought) return part.text
  }
  throw new Error('gemini: 모든 파트가 thought 뿐이거나 text 가 없다')
}

/**
 * 100자 제한을 강제한다. **초과해도 재생성하지 않는다** — 곧바로 절삭한다.
 *
 * 스펙 초안은 "초과 시 1회 재생성, 그래도 초과하면 절삭"이었고, 2026-08-27 에
 * 재생성을 빼기로 확정하면서 스펙 §8 에 그 근거를 적었다. 요약하면: 같은
 * 프롬프트로 다시 물어도 짧아질 이유가 없고(100자 초과는 그 모델의 계통적
 * 성향이다), 무료 티어의 일일 쿼터가 실질 제약이라 한 건의 절삭을 고치려고
 * 그날 남은 요약 전부의 품질을 걸게 되며, 호출 지연이 8초다.
 *
 * 절삭이 내용을 통째로 날리지 않도록 하는 것은 `truncateAtSentence` 쪽 책임이다
 * (경계가 예산의 절반에 못 미치면 하드 컷 — domain/text.ts).
 */
export function enforceLimit(s: string): string {
  const t = s.trim()
  if (charLength(t) <= MAX_SUMMARY_CHARS) return t
  return truncateAtSentence(t, MAX_SUMMARY_CHARS)
}

export async function summarize(title: string, body: string): Promise<SummarySet> {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY 없음')

  const req = {
    contents: [{ parts: [{ text: buildPrompt(title, body) }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          numeric: { type: 'STRING' },
          context: { type: 'STRING' },
        },
        required: ['numeric', 'context'],
      },
    },
  }

  resetExhaustedModelsIfNewDay()

  const candidates = MODEL_CHAIN.filter(m => !exhaustedModels.has(m))
  if (candidates.length === 0) {
    throw new Error(`gemini: 모든 모델의 쿼터가 소진됐다 (시도: ${MODEL_CHAIN.join(', ')})`)
  }

  // 이번 summarize() 호출 안에서 건너뛴 모델과 사유를 기록해 둔다. 전부
  // 실패하면 "무엇이 왜 실패했는지"를 07:40 무인 실행에서도 알 수 있어야 한다.
  const skipped: Array<{ model: string; reason: 'quota' | 'unavailable' | 'no-response' }> = []

  for (const model of candidates) {
    let res: Response
    try {
      res = await fetch(`${endpointFor(model)}?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal: AbortSignal.timeout(60_000),
      })
    } catch (e) {
      // 응답 자체가 없었다. 예전에는 이 예외가 루프 밖으로 새어나가 체인 전체를
      // 여기서 끝냈다 — 남은 모델을 시도조차 못 했다.
      if (classifyThrownFailure(e) !== 'no-response') throw e
      // 타임아웃·네트워크 오류는 503 과 같은 규칙이다: 기록하지 않고 다음 모델로.
      skipped.push({ model, reason: 'no-response' })
      continue
    }

    if (!res.ok) {
      // 오류 본문에는 요청 URL 이 되비쳐 오는 경우가 있고, 그 URL 에는 `?key=` 가 붙어
      // 있다. 이 문자열은 summaryError 로 DB 에 저장되고 검수 화면의 title 속성에까지
      // 실리므로, 자르기 전에 키를 지운다. 자른 뒤에 지우면 잘린 조각이 남을 수 있다.
      let rawDetail: string
      try {
        rawDetail = await res.text()
      } catch (e) {
        // 오류 본문을 읽다 끊겼다. 상태 코드는 봤지만 사유를 확정할 수 없으므로
        // 응답을 못 받은 것과 같이 다룬다 — 다음 모델로, 소진 기록은 안 한다.
        if (!isBodyReadFailure(e)) throw e
        skipped.push({ model, reason: 'no-response' })
        continue
      }
      const detail = redactKey(rawDetail, key)
      const failure = classifyFailure(res.status, detail)
      if (failure === 'quota') {
        // 오늘치가 끝났다 — 영구 기록해서 이후 호출은 이 모델을 건너뛴다.
        exhaustedModels.add(model)
        skipped.push({ model, reason: 'quota' })
        continue
      }
      if (failure === 'unavailable') {
        // 순간적인 과부하/서버 오류 — 이번만 다음 모델로 넘어간다. 기록하지
        // 않으므로 다음 summarize() 호출은 이 모델부터 다시 시도한다.
        skipped.push({ model, reason: 'unavailable' })
        continue
      }
      // 그 밖의 실패(세이프티 차단, 인증 오류, 잘못된 요청 등)는 다른 모델로
      // 재시도하지 않는다 — 다른 모델로 넘기면 fix round 1 에서 만든 진단
      // 가능한 에러가 가려진다.
      throw new Error(`gemini HTTP ${res.status}: ${detail.slice(0, 200)}`)
    }

    let payload: unknown
    try {
      payload = await res.json()
    } catch (e) {
      // 본문 도중 끊긴 경우만 다음 모델로 넘긴다. JSON 문법 오류(SyntaxError)는
      // 연결 문제가 아니라 응답이 이상한 것이므로 그대로 던진다.
      if (!isBodyReadFailure(e)) throw e
      skipped.push({ model, reason: 'no-response' })
      continue
    }
    const text = extractJsonText(payload)

    // Gemini 가 실제로 돌려주는 JSON 은 2안 필드뿐이다 — model 은 우리가 아는
    // 값(위 for 루프의 model 변수)이지 응답 안에 들어있는 값이 아니므로,
    // SummarySet(반환 타입)이 아니라 2안 필드만 있는 타입으로 파싱한다.
    let parsed: { numeric: string; context: string }
    try {
      parsed = JSON.parse(text)
    } catch {
      // 정상 파싱이 실패했을 때**만** 코드펜스를 의심한다. 규약을 지키는 모델은
      // 위에서 이미 끝났으므로 이 아래를 지나가지 않는다.
      const unfenced = stripCodeFence(text)
      let recovered: { numeric: string; context: string } | null = null
      if (unfenced !== null) {
        try {
          recovered = JSON.parse(unfenced)
        } catch {
          recovered = null // 벗겨도 안 되면 그대로 실패다. 무리해서 건져내지 않는다.
        }
      }
      if (recovered === null) {
        const finishReason = (payload as any)?.candidates?.[0]?.finishReason
        const finishNote = finishReason && finishReason !== 'STOP' ? ` finishReason=${finishReason}.` : ''
        throw new Error(
          `gemini: "${title}" 요약 응답이 JSON이 아니다.${finishNote} 원문: ${text.slice(0, 200)}`,
        )
      }
      // **조용히 고쳐주지 않는다.** 어느 모델이 규약을 어기는지가 로그에 남아야
      // 다음 사람이 안다 — 안 남기면 그 모델은 계속 그래도 아무도 모른다.
      // 기사 제목은 싣지 않는다(로그 규칙: providers 전반). 모델 이름이면 충분하다.
      console.warn(
        `[gemini] ${model}: responseMimeType 이 application/json 인데 응답을 코드펜스로 감쌌다. 벗겨내고 파싱했다.`,
      )
      parsed = recovered
    }

    return {
      numeric: enforceLimit(parsed.numeric ?? ''),
      context: enforceLimit(parsed.context ?? ''),
      model,
    }
  }

  // 사유를 범주별로 갈라 적는다. 07:40 무인 실행에서 운영자가 볼 곳이 서로 다르다:
  // 쿼터는 기다리는 문제, 503 은 구글 쪽 문제, 응답 없음은 우리 쪽 네트워크·타임아웃
  // 문제다. 전부 타임아웃인 날에 "쿼터가 소진됐다"고 말하면 엉뚱한 데를 보게 된다.
  const quotaExhausted = skipped.filter(s => s.reason === 'quota').map(s => s.model)
  const unavailable = skipped.filter(s => s.reason === 'unavailable').map(s => s.model)
  const noResponse = skipped.filter(s => s.reason === 'no-response').map(s => s.model)
  const detailParts: string[] = []
  if (quotaExhausted.length > 0) detailParts.push(`쿼터 소진: ${quotaExhausted.join(', ')}`)
  if (unavailable.length > 0) detailParts.push(`일시적 이용 불가: ${unavailable.join(', ')}`)
  if (noResponse.length > 0) detailParts.push(`응답 없음(타임아웃·네트워크): ${noResponse.join(', ')}`)
  throw new Error(`gemini: 모든 모델이 실패했다 (${detailParts.join(' / ')})`)
}
