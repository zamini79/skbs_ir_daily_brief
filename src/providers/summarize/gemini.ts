import { charLength, truncateAtSentence } from '@/domain/text'
import { kstDateString } from '@/domain/date'
import { buildPrompt, MAX_SUMMARY_CHARS } from './prompt'

/**
 * gemini-2.5-flash 는 신규 사용자에게 404다.
 *
 * 무료 티어의 일일 쿼터는 "모델별로" 소진된다(실측: gemini-3.6-flash 가 429로
 * GenerateRequestsPerDayPerProjectPerModel-FreeTier 를 반환하는 순간에도
 * gemini-3.5-flash-lite 는 200을 돌려줬다). 그래서 단일 모델이 아니라 순서가
 * 있는 체인을 둔다 — 한 모델의 하루 치가 끝나면 다음 모델로 넘어간다.
 * gemini-3.6-flash 를 맨 앞에 둔 것은 품질을 실측으로 검증한 모델이기 때문이다.
 * 나머지는 측정된 품질(3안 모두 100자 이내인지, 관점이 실제로 갈리는지) 순으로
 * 배치했다(task-13-report.md "Fix round 2" 의 비교표 참고). 두 모델은 제외했다:
 * gemini-2.5-flash-lite 는 신규 사용자에게 404(영구 실패)를 반환한다 — 쿼터
 * 소진도, 일시적 장애도 아니라서 체인을 넘기는 조건에 해당하지 않는다. 어느
 * 자리에 두든 그 뒤 모델을 무력화하므로 제외했다. gemini-3.7-flash 는 실측
 * 시점에 매번 503(UNAVAILABLE)을 반환해 실제 응답 품질을 한 번도 측정하지
 * 못했다 — 품질을 추측해서 순서를 매기지 않고 제외해 둔다. 503 은 이제(fix
 * round 3) 체인을 넘기는 조건이라서 재측정만 하면 다시 넣을 수 있다.
 */
export const MODEL_CHAIN = [
  'gemini-3.6-flash',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
] as const

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
  implication: string
  /** 이 3안을 실제로 만들어낸 모델. 폴백 체인에서 몇 번째로 답한 모델인지
   * 나중에 추적할 수 있도록 남긴다 — 예: gemini-3.1-flash-lite 는 100자
   * 제한을 자주 넘겨서 truncateAtSentence 가 더 많이 개입한다. */
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
          implication: { type: 'STRING' },
        },
        required: ['numeric', 'context', 'implication'],
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
      const detail = await res.text()
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

    // Gemini 가 실제로 돌려주는 JSON 은 3안 필드뿐이다 — model 은 우리가 아는
    // 값(위 for 루프의 model 변수)이지 응답 안에 들어있는 값이 아니므로,
    // SummarySet(반환 타입)이 아니라 3안 필드만 있는 타입으로 파싱한다.
    let parsed: { numeric: string; context: string; implication: string }
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
      implication: enforceLimit(parsed.implication ?? ''),
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
