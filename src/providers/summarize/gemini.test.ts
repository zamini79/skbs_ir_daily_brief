import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { extractJsonText, enforceLimit, summarize } from './gemini'

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'test-key'
})

afterEach(() => vi.unstubAllGlobals())

describe('extractJsonText', () => {
  it('thought 파트를 건너뛰고 text 를 고른다', () => {
    const payload = {
      candidates: [{ content: { parts: [
        { text: '생각중...', thought: true },
        { text: '{"numeric":"a"}' },
      ] } }],
    }
    expect(extractJsonText(payload)).toBe('{"numeric":"a"}')
  })
  it('thoughtSignature 가 붙은 text 파트도 읽는다', () => {
    const payload = {
      candidates: [{ content: { parts: [{ text: '{"numeric":"a"}', thoughtSignature: 'xx' }] } }],
    }
    expect(extractJsonText(payload)).toBe('{"numeric":"a"}')
  })
  it('text 파트가 없으면 던진다', () => {
    expect(() => extractJsonText({ candidates: [{ content: { parts: [] } }] })).toThrow()
  })
  it('promptFeedback.blockReason 이 있으면 차단 이유를 담아 던진다', () => {
    const payload = { promptFeedback: { blockReason: 'SAFETY' } }
    expect(() => extractJsonText(payload)).toThrow(/SAFETY/)
  })
  it('candidates 가 비어있으면 그 사실을 담아 던진다', () => {
    expect(() => extractJsonText({ candidates: [] })).toThrow(/candidates/)
  })
  it('파트가 모두 thought 뿐이면 그 사실을 담아 던진다 (blockReason/candidates 메시지와는 다르다)', () => {
    const payload = {
      candidates: [{ content: { parts: [{ text: '생각중...', thought: true }] } }],
    }
    expect(() => extractJsonText(payload)).toThrow(/thought/)
  })
})

describe('enforceLimit', () => {
  it('100자 이내는 그대로 둔다', () => {
    const s = '가'.repeat(100)
    expect(enforceLimit(s)).toBe(s)
  })
  it('100자를 넘으면 잘라 100자 이내로 만든다', () => {
    const s = '가'.repeat(150)
    expect([...enforceLimit(s)].length).toBeLessThanOrEqual(100)
  })
  it('문장 경계가 있으면 거기서 자른다', () => {
    const s = '첫 문장임.' + '가'.repeat(200)
    expect(enforceLimit(s)).toBe('첫 문장임.')
  })
})

describe('summarize', () => {
  function stubOnce(obj: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(obj), thoughtSignature: 'x' }] } }],
    }), { status: 200 })))
  }

  it('3안을 돌려준다', async () => {
    stubOnce({ numeric: '수치임', context: '배경임', implication: '시사점임' })
    const r = await summarize('제목', '본문')
    expect(r).toEqual({ numeric: '수치임', context: '배경임', implication: '시사점임' })
  })

  it('100자를 넘긴 응답을 잘라서 돌려준다', async () => {
    stubOnce({ numeric: '가'.repeat(180), context: '배경임', implication: '시사점임' })
    const r = await summarize('제목', '본문')
    expect([...r.numeric].length).toBeLessThanOrEqual(100)
  })

  it('JSON이 아닌 응답이면 기사 제목과 원문 일부를 담아 던진다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '죄송합니다, 요약할 수 없습니다', thoughtSignature: 'x' }] } }],
    }), { status: 200 })))
    let error: unknown
    try {
      await summarize('셀트리온 실적 발표', '본문')
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('셀트리온 실적 발표')
    expect((error as Error).message).toContain('죄송합니다')
  })

  it('finishReason 이 MAX_TOKENS 인 잘린 응답이면 에러 메시지에 남긴다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      candidates: [{
        finishReason: 'MAX_TOKENS',
        content: { parts: [{ text: '{"numeric":"수치임", "context":"배경', thoughtSignature: 'x' }] },
      }],
    }), { status: 200 })))
    let error: unknown
    try {
      await summarize('제목', '본문')
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('MAX_TOKENS')
  })

  it('키가 없으면 던진다', async () => {
    const saved = process.env.GEMINI_API_KEY
    delete process.env.GEMINI_API_KEY
    try {
      await expect(summarize('제목', '본문')).rejects.toThrow(/GEMINI_API_KEY/)
    } finally {
      process.env.GEMINI_API_KEY = saved
    }
  })
})
