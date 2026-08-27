import { charLength, truncateAtSentence } from '@/domain/text'
import { buildPrompt, MAX_SUMMARY_CHARS } from './prompt'

/** gemini-2.5-flash 는 신규 사용자에게 404다. 3.6 으로 고정한다. */
const MODEL = 'gemini-3.6-flash'
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`

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

  const res = await fetch(`${ENDPOINT}?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(60_000),
  })
  if (!res.ok) {
    const detail = await res.text()
    throw new Error(`gemini HTTP ${res.status}: ${detail.slice(0, 200)}`)
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
