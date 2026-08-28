import { charLength, truncateAtSentence } from '@/domain/text'
import { kstDateString } from '@/domain/date'
import { buildPrompt, MAX_SUMMARY_CHARS } from './prompt'

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
  {
    model: 'gemma-4-31b-it',
    quality: 'last-resort',
    note:
      '2026-08-28 재측정해 추가. 성공하면 품질은 쓸 만하다 — 65~90자로 100자 이내, ' +
      '개조식 준수, 5~7초. (브리프가 남긴 "maxOutputTokens 3000 에서 잘린다"는 재현되지 ' +
      '않았다 — 출력이 65~193토큰이라 애초에 상한에 닿지 않는다.) ' +
      '**다만 약 4~5회에 1회는 JSON 파싱에 실패한다.** 총 26회 실측에서 20회 성공, ' +
      '4회는 responseMimeType 이 application/json 인데도 응답을 ```…``` 코드펜스로 감쌌고, ' +
      '1회는 그 밖의 파싱 실패, 1회는 타임아웃이었다. 실제 수집(2026-08-28)에서 발생한 ' +
      '발췌 폴백 5건이 **전부** 이 모델의 코드펜스였다 — 같은 기사를 앞의 gemini 7개에 ' +
      '태우면 7개 모두 정상 JSON 을 낸다. ' +
      '그래도 체인에 두는 이유: 이 실패는 **시끄럽다**. 던져서 발췌 폴백으로 떨어지므로, ' +
      '이 모델이 없었을 때와 결과가 같다(맨 뒤라 가려지는 모델도 없다). 대신 성공하는 ' +
      '나머지 약 77% 는 발췌가 아닌 진짜 요약이 된다. ' +
      '형제 모델 gemma-4-26b-a4b-it 을 배제한 것과 기준이 다르지 않다 — 그쪽은 실패가 ' +
      '**조용해서** 쓰레기가 정상 요약처럼 화면에 오른다(EXCLUDED_MODELS 참고). ' +
      '앞으로 옮기지 마라: 실패율이 이만큼인 모델이 앞에 오면 평상시 폴백이 늘어난다. ' +
      '알려진 개선 여지 — 파싱 전에 코드펜스를 벗겨내면 이 4회는 되살아난다. 다만 그건 ' +
      '체인 전체의 파싱 경로를 바꾸는 별도 결정이라 여기서 하지 않았다.',
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

type FailureClass = 'quota' | 'unavailable' | 'other'

/**
 * HTTP 실패를 분류한다. 상태 코드가 최우선(authoritative) 신호다 — 429/503/500
 * 은 그 자체로 확정적이라서 본문은 보지 않는다. 본문 문자열(RESOURCE_EXHAUSTED/
 * UNAVAILABLE)은 상태 코드가 이 셋 중 무엇도 아니어서 확정할 수 없을 때만
 * 보조로 쓴다. 상태를 먼저 확정 짓지 않고 문자열만으로 판단하면, 예를 들어
 * 503 응답 본문에 우연히 다른 문구가 섞여 들어와도 오분류할 위험이 있다.
 * 순서를 이렇게 두면 구글이 문구를 바꿔도 최악의 경우 "놓칠" 뿐, 상태 코드가
 * 이미 확정한 답을 문자열이 뒤집는 일은 없다.
 */
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

function classifyFailure(status: number, detail: string): FailureClass {
  if (status === 429) return 'quota'
  if (status === 503 || status === 500) return 'unavailable'
  if (detail.includes('RESOURCE_EXHAUSTED')) return 'quota'
  if (detail.includes('UNAVAILABLE')) return 'unavailable'
  return 'other'
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
  const skipped: Array<{ model: string; reason: 'quota' | 'unavailable' }> = []

  for (const model of candidates) {
    const res = await fetch(`${endpointFor(model)}?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(60_000),
    })

    if (!res.ok) {
      // 오류 본문에는 요청 URL 이 되비쳐 오는 경우가 있고, 그 URL 에는 `?key=` 가 붙어
      // 있다. 이 문자열은 summaryError 로 DB 에 저장되고 검수 화면의 title 속성에까지
      // 실리므로, 자르기 전에 키를 지운다. 자른 뒤에 지우면 잘린 조각이 남을 수 있다.
      const detail = redactKey(await res.text(), key)
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

    const payload = await res.json()
    const text = extractJsonText(payload)

    // Gemini 가 실제로 돌려주는 JSON 은 2안 필드뿐이다 — model 은 우리가 아는
    // 값(위 for 루프의 model 변수)이지 응답 안에 들어있는 값이 아니므로,
    // SummarySet(반환 타입)이 아니라 2안 필드만 있는 타입으로 파싱한다.
    let parsed: { numeric: string; context: string }
    try {
      parsed = JSON.parse(text)
    } catch {
      const finishReason = (payload as any)?.candidates?.[0]?.finishReason
      const finishNote = finishReason && finishReason !== 'STOP' ? ` finishReason=${finishReason}.` : ''
      throw new Error(
        `gemini: "${title}" 요약 응답이 JSON이 아니다.${finishNote} 원문: ${text.slice(0, 200)}`,
      )
    }

    return {
      numeric: enforceLimit(parsed.numeric ?? ''),
      context: enforceLimit(parsed.context ?? ''),
      model,
    }
  }

  const quotaExhausted = skipped.filter(s => s.reason === 'quota').map(s => s.model)
  const unavailable = skipped.filter(s => s.reason === 'unavailable').map(s => s.model)
  const detailParts: string[] = []
  if (quotaExhausted.length > 0) detailParts.push(`쿼터 소진: ${quotaExhausted.join(', ')}`)
  if (unavailable.length > 0) detailParts.push(`일시적 이용 불가: ${unavailable.join(', ')}`)
  throw new Error(`gemini: 모든 모델이 실패했다 (${detailParts.join(' / ')})`)
}
