import { charLength, truncateAtSentence } from '@/domain/text'
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
 * gemini-2.5-flash-lite 는 신규 사용자에게 404(영구 실패)를 반환하는데, 404는
 * 쿼터 소진이 아니라서 체인을 넘기지 않고 그 자리에서 요약 전체를 실패시킨다 —
 * 체인 어디에 두든 그 뒤 모델을 무력화한다. gemini-3.7-flash 는 실측 시점에
 * 503(UNAVAILABLE, "currently experiencing high demand")을 반환했다 — 503 도
 * 같은 이유로 체인을 넘기지 못하므로 제외했다. 안정화되면 재평가한다.
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
 * 프로세스 생애주기 동안 소진된 것으로 확인된 모델. 파이프라인 한 번 실행에서
 * 최대 69회를 호출하므로, 첫 모델이 죽으면 그 뒤로는 매 호출마다 죽은 모델을
 * 다시 두드리지 않고 바로 다음 모델부터 시작한다.
 */
export const exhaustedModels = new Set<string>()

/** 429, 또는 본문에 RESOURCE_EXHAUSTED 가 있으면 쿼터 소진으로 본다. 그 밖의
 * 실패(세이프티 차단, 5xx, 인증 오류 등)는 체인을 넘기지 않고 바로 던진다. */
function isQuotaExhausted(status: number, detail: string): boolean {
  return status === 429 || detail.includes('RESOURCE_EXHAUSTED')
}

export type SummarySet = { numeric: string; context: string; implication: string }

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

  const candidates = MODEL_CHAIN.filter(m => !exhaustedModels.has(m))
  if (candidates.length === 0) {
    throw new Error(`gemini: 모든 모델의 쿼터가 소진됐다 (시도: ${MODEL_CHAIN.join(', ')})`)
  }

  for (const model of candidates) {
    const res = await fetch(`${endpointFor(model)}?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(60_000),
    })

    if (!res.ok) {
      const detail = await res.text()
      // 쿼터 소진이 아닌 실패(세이프티 차단, 인증 오류, 5xx 등)는 다른 모델로
      // 재시도하지 않는다 — 다른 모델로 넘기면 fix round 1 에서 만든 진단
      // 가능한 에러가 가려진다.
      if (!isQuotaExhausted(res.status, detail)) {
        throw new Error(`gemini HTTP ${res.status}: ${detail.slice(0, 200)}`)
      }
      exhaustedModels.add(model)
      continue
    }

    const payload = await res.json()
    const text = extractJsonText(payload)

    let parsed: SummarySet
    try {
      parsed = JSON.parse(text) as SummarySet
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
    }
  }

  throw new Error(`gemini: 모든 모델의 쿼터가 소진됐다 (시도: ${MODEL_CHAIN.join(', ')})`)
}
