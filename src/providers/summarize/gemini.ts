import { charLength, truncateAtSentence } from '@/domain/text'
import { buildPrompt, MAX_SUMMARY_CHARS } from './prompt'

/** gemini-2.5-flash 는 신규 사용자에게 404다. 3.6 으로 고정한다. */
const MODEL = 'gemini-3.6-flash'
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`

export type SummarySet = { numeric: string; context: string; implication: string }

/**
 * Gemini 3.x 는 파트에 thoughtSignature 를 함께 실어 보낸다.
 * parts[0].text 를 그대로 쓰면 빈 응답처럼 보인다.
 */
export function extractJsonText(payload: unknown): string {
  const parts = (payload as any)?.candidates?.[0]?.content?.parts ?? []
  for (const p of parts) {
    if (typeof p?.text === 'string' && !p.thought) return p.text
  }
  throw new Error('gemini: text 파트를 찾지 못했다')
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

  const parsed = JSON.parse(extractJsonText(await res.json())) as SummarySet
  return {
    numeric: enforceLimit(parsed.numeric ?? ''),
    context: enforceLimit(parsed.context ?? ''),
    implication: enforceLimit(parsed.implication ?? ''),
  }
}
