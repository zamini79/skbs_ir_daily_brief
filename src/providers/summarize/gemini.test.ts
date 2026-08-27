import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { extractJsonText, enforceLimit, summarize, MODEL_CHAIN, exhaustedModels } from './gemini'

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'test-key'
  exhaustedModels.clear()
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

describe('모델 폴백 체인', () => {
  function quotaResponse() {
    return new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }), { status: 429 })
  }
  function okResponse() {
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [
        { text: JSON.stringify({ numeric: '수치임', context: '배경임', implication: '시사점임' }), thoughtSignature: 'x' },
      ] } }],
    }), { status: 200 })
  }

  it('첫 모델이 429면 다음 모델로 넘어가 정상 응답을 돌려준다', async () => {
    const calledUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calledUrls.push(url)
      return url.includes(MODEL_CHAIN[0]) ? quotaResponse() : okResponse()
    }))

    const r = await summarize('제목', '본문')

    expect(r).toEqual({ numeric: '수치임', context: '배경임', implication: '시사점임' })
    expect(calledUrls).toHaveLength(2)
    expect(calledUrls[0]).toContain(MODEL_CHAIN[0])
    expect(calledUrls[1]).toContain(MODEL_CHAIN[1])
  })

  it('쿼터 소진이 아닌 실패(세이프티 차단)는 체인을 넘기지 않는다', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      promptFeedback: { blockReason: 'SAFETY' },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(summarize('제목', '본문')).rejects.toThrow(/SAFETY/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('모든 모델이 429면 시도한 모델 이름을 모두 담아 던진다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => quotaResponse()))

    let error: unknown
    try {
      await summarize('제목', '본문')
    } catch (e) {
      error = e
    }

    expect(error).toBeInstanceOf(Error)
    for (const model of MODEL_CHAIN) {
      expect((error as Error).message).toContain(model)
    }
  })

  it('이미 소진된 것으로 확인된 모델은 다음 호출에서 다시 두드리지 않는다', async () => {
    const calledUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calledUrls.push(url)
      return url.includes(MODEL_CHAIN[0]) ? quotaResponse() : okResponse()
    }))

    await summarize('제목1', '본문1')
    const callsAfterFirst = calledUrls.length

    await summarize('제목2', '본문2')

    const firstModelHits = calledUrls.filter(u => u.includes(MODEL_CHAIN[0])).length
    expect(firstModelHits).toBe(1)
    expect(calledUrls).toHaveLength(callsAfterFirst + 1)
    expect(calledUrls.at(-1)).toContain(MODEL_CHAIN[1])
  })

  it('첫 모델이 정상이면 체인을 건드리지 않는다 (회귀)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain(MODEL_CHAIN[0])
      return okResponse()
    })
    vi.stubGlobal('fetch', fetchMock)

    const r = await summarize('제목', '본문')

    expect(r).toEqual({ numeric: '수치임', context: '배경임', implication: '시사점임' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  function unavailableResponse() {
    return new Response(JSON.stringify({ error: { status: 'UNAVAILABLE' } }), { status: 503 })
  }
  function serverErrorResponse() {
    return new Response(JSON.stringify({ error: { message: 'internal' } }), { status: 500 })
  }

  it('첫 모델이 503이면 다음 모델로 넘어가 정상 응답을 돌려준다', async () => {
    const calledUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calledUrls.push(url)
      return url.includes(MODEL_CHAIN[0]) ? unavailableResponse() : okResponse()
    }))

    const r = await summarize('제목', '본문')

    expect(r).toEqual({ numeric: '수치임', context: '배경임', implication: '시사점임' })
    expect(calledUrls).toHaveLength(2)
    expect(calledUrls[1]).toContain(MODEL_CHAIN[1])
  })

  it('첫 모델이 500이면 다음 모델로 넘어간다', async () => {
    const calledUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calledUrls.push(url)
      return url.includes(MODEL_CHAIN[0]) ? serverErrorResponse() : okResponse()
    }))

    const r = await summarize('제목', '본문')

    expect(r).toEqual({ numeric: '수치임', context: '배경임', implication: '시사점임' })
    expect(calledUrls).toHaveLength(2)
  })

  it('503을 반환한 모델은 소진 기록되지 않는다 — 다음 호출에서 체인 맨 앞부터 다시 시도한다', async () => {
    const fetchMock = vi.fn(async (url: string) => (
      url.includes(MODEL_CHAIN[0]) ? unavailableResponse() : okResponse()
    ))
    vi.stubGlobal('fetch', fetchMock)

    await summarize('제목1', '본문1')
    expect(exhaustedModels.has(MODEL_CHAIN[0])).toBe(false)

    fetchMock.mockClear()
    await summarize('제목2', '본문2')

    // 두 번째 호출도 첫 모델부터 다시 시도했다 — 소진 기록이 없으므로 건너뛰지 않는다.
    expect(fetchMock.mock.calls[0][0]).toContain(MODEL_CHAIN[0])
  })

  it('세이프티 차단은 여전히 체인을 넘기지 않고 자기 메시지를 낸다', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      promptFeedback: { blockReason: 'SAFETY' },
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(summarize('제목', '본문')).rejects.toThrow(/SAFETY/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('429와 503이 섞여 전부 실패하면 에러 메시지가 두 범주를 구분한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url.includes(MODEL_CHAIN[0]) ? quotaResponse() : unavailableResponse()
    )))

    let error: unknown
    try {
      await summarize('제목', '본문')
    } catch (e) {
      error = e
    }

    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('쿼터 소진')
    expect(message).toContain(MODEL_CHAIN[0])
    expect(message).toContain('일시적 이용 불가')
    for (const model of MODEL_CHAIN.slice(1)) {
      expect(message).toContain(model)
    }
  })
})
