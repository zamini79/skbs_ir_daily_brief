import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  extractJsonText,
  enforceLimit,
  summarize,
  MODEL_CHAIN,
  MODEL_CHAIN_ENTRIES,
  EXCLUDED_MODELS,
  stripCodeFence,
  classifyFailure,
  exhaustedModels,
  redactKey,
} from './gemini'

beforeEach(() => {
  process.env.GEMINI_API_KEY = 'test-key'
  exhaustedModels.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

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

describe('redactKey', () => {
  it('오류 본문에 되비친 요청 URL 의 키를 지운다', () => {
    const key = 'AIzaSyTESTKEY123'
    const body = `{"error":{"message":"API key not valid","url":"https://x/v1/models?key=${key}"}}`
    const out = redactKey(body, key)
    expect(out).not.toContain(key)
    expect(out).toContain('<redacted>')
  })

  it('URL 인코딩된 형태도 지운다', () => {
    const key = 'abc+def/ghi='
    const out = redactKey(`?key=${encodeURIComponent(key)}`, key)
    expect(out).not.toContain(encodeURIComponent(key))
  })

  it('키가 빈 문자열이면 본문을 건드리지 않는다 — replaceAll("") 은 문자열을 망가뜨린다', () => {
    expect(redactKey('quota exceeded', '')).toBe('quota exceeded')
  })

  it('키가 없는 본문은 그대로 둔다', () => {
    expect(redactKey('RESOURCE_EXHAUSTED', 'AIzaKEY')).toBe('RESOURCE_EXHAUSTED')
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
  it('문장 경계가 예산의 절반 이상을 채우면 거기서 자른다', () => {
    const s = '가'.repeat(60) + '.' + '나'.repeat(200)
    expect(enforceLimit(s)).toBe('가'.repeat(60) + '.')
  })
  it('문장 경계가 너무 앞쪽이면 경계를 버리고 100자를 채운다', () => {
    // 예전에는 여기서 6자짜리 "첫 문장임." 만 남았다. 그 6자는 화면에서 정상적으로
    // 짧은 요약과 구분되지 않아, 내용이 통째로 사라진 것을 아무도 알 수 없었다.
    const s = '첫 문장임.' + '가'.repeat(200)
    expect([...enforceLimit(s)].length).toBe(100)
  })
})

describe('summarize', () => {
  function stubOnce(obj: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(obj), thoughtSignature: 'x' }] } }],
    }), { status: 200 })))
  }

  it('2안을 돌려준다', async () => {
    stubOnce({ numeric: '수치임', context: '배경임' })
    const r = await summarize('제목', '본문')
    expect(r).toEqual({ numeric: '수치임', context: '배경임', model: MODEL_CHAIN[0] })
  })

  it('100자를 넘긴 응답을 잘라서 돌려준다', async () => {
    stubOnce({ numeric: '가'.repeat(180), context: '배경임' })
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

  it('요청 스키마에 implication 이 없다 — 모델에게 3안을 요구하지 않는다', async () => {
    let sentBody = ''
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      sentBody = String(init.body)
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: '{"numeric":"수치임","context":"배경임"}' }] } }],
      }), { status: 200 })
    }))

    await summarize('제목', '본문')

    const body = JSON.parse(sentBody)
    const schema = body.generationConfig.responseSchema
    expect(Object.keys(schema.properties)).toEqual(['numeric', 'context'])
    expect(schema.required).toEqual(['numeric', 'context'])
  })

  it('모델이 implication 을 끼워 보내도 그대로 흘려보내지 않는다', async () => {
    // 스키마에서 뺐어도 모델은 프롬프트를 따라 세 번째 필드를 낼 수 있다.
    // 그걸 SummarySet 에 실어 보내면 저장 단계의 SUMMARY_VARIANTS 매핑이
    // 조용히 무시하거나, 나중에 누가 되살릴 때 반쯤 살아 있는 경로가 된다.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{
        text: '{"numeric":"수치임","context":"배경임","implication":"모델이 지어낸 전망임"}',
      }] } }],
    }), { status: 200 })))

    const r = await summarize('제목', '본문')

    expect(r).toEqual({ numeric: '수치임', context: '배경임', model: MODEL_CHAIN[0] })
    expect(JSON.stringify(r)).not.toContain('전망')
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
  /**
   * **하루치 소진**의 실측 형태. quotaId 가 `...PerDay...` 다 — 기다려도 오늘은
   * 풀리지 않으므로 이것만 exhaustedModels 에 기록된다.
   */
  function dailyQuotaResponse() {
    return new Response(JSON.stringify({
      error: {
        status: 'RESOURCE_EXHAUSTED',
        details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
      },
    }), { status: 429 })
  }
  /**
   * **분당 한도**의 실측 형태(2026-09-01, 한 모델에 25건 동시 투입 시 받은 429 여덟 건이
   * 전부 이 quotaId 였다). 기다리면 풀린다.
   */
  function perMinuteResponse() {
    return new Response(JSON.stringify({
      error: {
        status: 'RESOURCE_EXHAUSTED',
        details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }],
      },
    }), { status: 429 })
  }
  /** quotaId 가 없어 **어느 쪽인지 판정할 수 없는** 429. */
  function indeterminateQuotaResponse() {
    return new Response(JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED' } }), { status: 429 })
  }
  /** 테스트가 실제로 20초를 기다리지 않도록 대기를 주입한다. */
  const noSleep = { sleep: async () => {} }
  function okResponse() {
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [
        { text: JSON.stringify({ numeric: '수치임', context: '배경임' }), thoughtSignature: 'x' },
      ] } }],
    }), { status: 200 })
  }

  it('첫 모델이 하루치 소진이면 다음 모델로 넘어가 정상 응답을 돌려준다', async () => {
    const calledUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calledUrls.push(url)
      return url.includes(MODEL_CHAIN[0]) ? dailyQuotaResponse() : okResponse()
    }))

    const r = await summarize('제목', '본문', noSleep)

    expect(r).toEqual({ numeric: '수치임', context: '배경임', model: MODEL_CHAIN[1] })
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

  it('모든 모델이 하루치 소진이면 체인 전체를 실제로 두드리고, 시도한 모델 이름을 모두 담아 던진다', async () => {
    const fetchMock = vi.fn(async () => dailyQuotaResponse())
    vi.stubGlobal('fetch', fetchMock)

    let error: unknown
    try {
      await summarize('제목', '본문', noSleep)
    } catch (e) {
      error = e
    }

    expect(error).toBeInstanceOf(Error)
    // 이름만 메시지에 담고 실제로는 앞의 몇 개만 호출하는 구현을 잡는다 —
    // 체인을 넓힌 목적(모델별 일일 한도를 합산한다)이 지켜지는지의 핵심이다.
    expect(fetchMock).toHaveBeenCalledTimes(MODEL_CHAIN.length)
    for (const model of MODEL_CHAIN) {
      expect((error as Error).message).toContain(model)
    }
  })

  it('이미 소진된 것으로 확인된 모델은 다음 호출에서 다시 두드리지 않는다', async () => {
    const calledUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calledUrls.push(url)
      return url.includes(MODEL_CHAIN[0]) ? dailyQuotaResponse() : okResponse()
    }))

    await summarize('제목1', '본문1', noSleep)
    const callsAfterFirst = calledUrls.length

    await summarize('제목2', '본문2', noSleep)

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

    expect(r).toEqual({ numeric: '수치임', context: '배경임', model: MODEL_CHAIN[0] })
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

    expect(r).toEqual({ numeric: '수치임', context: '배경임', model: MODEL_CHAIN[1] })
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

    expect(r).toEqual({ numeric: '수치임', context: '배경임', model: MODEL_CHAIN[1] })
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

  // ── 분당 한도: 버리지 않고 기다렸다 같은 모델을 다시 부른다 ──────────────
  //
  // 2026-09-01 이전에는 429 를 전부 하루치 소진으로 읽어 그 모델을 남은 하루 내내
  // 체인에서 뺐다. 실제로는 1분이면 풀릴 분당 한도였고, 체인 6~7개가 그렇게 통째로
  // 빠지면서 후보 42건 중 20건이 「본문 발췌」로 떨어졌다. 아래가 그 회귀 방지선이다.

  it('분당 한도면 같은 모델을 다시 부르고, 소진으로 기록하지 않는다', async () => {
    const calledUrls: string[] = []
    let hits = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calledUrls.push(url)
      return ++hits === 1 ? perMinuteResponse() : okResponse()
    }))

    const r = await summarize('제목', '본문', noSleep)

    // 다음 모델로 도망가지 않았다 — 두 번 다 1순위 모델이다.
    expect(calledUrls).toHaveLength(2)
    expect(calledUrls[0]).toContain(MODEL_CHAIN[0])
    expect(calledUrls[1]).toContain(MODEL_CHAIN[0])
    expect(r.model).toBe(MODEL_CHAIN[0])
    expect(exhaustedModels.has(MODEL_CHAIN[0])).toBe(false)
  })

  it('첫 시도가 분당 한도여도 발췌로 떨어지지 않고 정상 요약을 돌려준다', async () => {
    // 사용자에게 보인 결함 그대로의 모양: 첫 429 한 번에 요약을 포기했다.
    let hits = 0
    vi.stubGlobal('fetch', vi.fn(async () => (++hits === 1 ? perMinuteResponse() : okResponse())))

    const r = await summarize('제목', '본문', noSleep)

    expect(r).toEqual({ numeric: '수치임', context: '배경임', model: MODEL_CHAIN[0] })
  })

  it('재시도 대기가 주입한 sleep 으로만 일어난다 — 실제로 기다리지 않는다', async () => {
    const waits: number[] = []
    let hits = 0
    vi.stubGlobal('fetch', vi.fn(async () => (++hits <= 2 ? perMinuteResponse() : okResponse())))

    await summarize('제목', '본문', { sleep: async ms => { waits.push(ms) } })

    // 최초 1회 + 재시도 2회 = 대기는 두 번, 뒤로 갈수록 길어진다(분당 창이 지나야 한다).
    expect(waits).toEqual([20_000, 40_000])
  })

  it('분당 한도가 재시도를 다 써도 계속되면 다음 모델로 가되 소진 기록은 없다', async () => {
    const calledUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calledUrls.push(url)
      return url.includes(MODEL_CHAIN[0]) ? perMinuteResponse() : okResponse()
    }))

    const r = await summarize('제목', '본문', noSleep)

    // 1순위를 세 번 두드린 뒤에야 2순위로 넘어간다.
    expect(calledUrls.filter(u => u.includes(MODEL_CHAIN[0]))).toHaveLength(3)
    expect(r.model).toBe(MODEL_CHAIN[1])
    // **여기가 핵심이다.** 분당 한도는 그 모델을 하루 종일 잃을 이유가 되지 않는다.
    expect(exhaustedModels.has(MODEL_CHAIN[0])).toBe(false)
  })

  it('quotaId 가 없어 판정할 수 없는 429 도 소진으로 기록하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url.includes(MODEL_CHAIN[0]) ? indeterminateQuotaResponse() : okResponse()
    )))

    await summarize('제목', '본문', noSleep)

    expect(exhaustedModels.has(MODEL_CHAIN[0])).toBe(false)
  })

  it('하루치 소진은 예전처럼 기록하고 곧바로 다음 모델로 간다 (재시도하지 않는다)', async () => {
    const calledUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calledUrls.push(url)
      return url.includes(MODEL_CHAIN[0]) ? dailyQuotaResponse() : okResponse()
    }))

    await summarize('제목', '본문', noSleep)

    expect(calledUrls.filter(u => u.includes(MODEL_CHAIN[0]))).toHaveLength(1)
    expect(exhaustedModels.has(MODEL_CHAIN[0])).toBe(true)
  })

  it('발췌로 떨어지기 전에 체인 전원을 재시도까지 다 쓴다', async () => {
    // 요구사항의 핵심: 「본문 발췌」는 **마지막의 마지막**이어야 한다. 몇 번의
    // 429 로 조기에 떨어지면 안 된다.
    const fetchMock = vi.fn(async () => perMinuteResponse())
    vi.stubGlobal('fetch', fetchMock)

    let error: unknown
    try {
      await summarize('제목', '본문', noSleep)
    } catch (e) {
      error = e
    }

    // 모델마다 최초 1회 + 재시도 2회.
    expect(fetchMock).toHaveBeenCalledTimes(MODEL_CHAIN.length * 3)
    const message = (error as Error).message
    expect(message).toContain('분당 한도')
    expect(message).not.toContain('쿼터 소진')
    for (const model of MODEL_CHAIN) {
      expect(message).toContain(model)
    }
    // 체인 전체가 소진으로 오염되지 않는다 — 다음 후보는 1순위부터 다시 시도한다.
    expect(exhaustedModels.size).toBe(0)
  })

  it('하루치 소진과 503이 섞여 전부 실패하면 에러 메시지가 두 범주를 구분한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url.includes(MODEL_CHAIN[0]) ? dailyQuotaResponse() : unavailableResponse()
    )))

    let error: unknown
    try {
      await summarize('제목', '본문', noSleep)
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

describe('쿼터 소진 기록의 KST 날짜 경계', () => {
  /** 하루치 소진의 실측 형태. 소진 기록은 이 형태에서만 생긴다. */
  function dailyQuotaResponse() {
    return new Response(JSON.stringify({
      error: {
        status: 'RESOURCE_EXHAUSTED',
        details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
      },
    }), { status: 429 })
  }
  function okResponse() {
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [
        { text: JSON.stringify({ numeric: '수치임', context: '배경임' }), thoughtSignature: 'x' },
      ] } }],
    }), { status: 200 })
  }

  it('날짜가 바뀌면 소진 기록이 초기화돼 그 모델을 다시 시도한다', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T00:00:00+09:00'))

    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url.includes(MODEL_CHAIN[0]) ? dailyQuotaResponse() : okResponse()
    )))
    await summarize('제목1', '본문1')
    expect(exhaustedModels.has(MODEL_CHAIN[0])).toBe(true)

    // KST 자정을 넘어 다음 날로 — 실시간이 흐르길 기다리지 않고 시계를 직접 옮긴다.
    vi.setSystemTime(new Date('2026-08-28T00:00:00+09:00'))
    const day2Urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      day2Urls.push(url)
      return okResponse()
    }))
    await summarize('제목2', '본문2')

    expect(day2Urls[0]).toContain(MODEL_CHAIN[0])
    expect(exhaustedModels.has(MODEL_CHAIN[0])).toBe(false)
  })

  it('같은 KST 날짜 안에서는 소진 기록이 초기화되지 않는다 (너무 이르게 리셋되지 않는지 확인)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-27T00:30:00+09:00'))

    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      url.includes(MODEL_CHAIN[0]) ? dailyQuotaResponse() : okResponse()
    )))
    await summarize('제목1', '본문1')
    expect(exhaustedModels.has(MODEL_CHAIN[0])).toBe(true)

    // 같은 KST 날짜(2026-08-27) 안의 다른 시각.
    vi.setSystemTime(new Date('2026-08-27T23:30:00+09:00'))
    const calledUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calledUrls.push(url)
      return okResponse()
    }))
    await summarize('제목2', '본문2')

    expect(calledUrls).toHaveLength(1)
    expect(calledUrls[0]).toContain(MODEL_CHAIN[1])
    expect(exhaustedModels.has(MODEL_CHAIN[0])).toBe(true)
  })
})

describe('체인 순서 정책', () => {
  // 이 블록이 지키는 것은 "코드가 컴파일되는가"가 아니라 **순서의 근거**다.
  // 누가 이 배열을 정렬하거나 검증 안 된 모델을 앞에 끼워 넣으면, 평상시 담당자에게
  // 가는 요약이 조용히 그 모델의 것으로 바뀐다 — 화면에서는 구분되지 않는다.

  it('last-resort 모델이 verified 모델보다 앞에 오지 않는다', () => {
    // 2026-08-28 현재 체인은 전원 verified 라 이 단언은 공허하게 참이다. 그래도
    // 남긴다 — "빈칸보다는 낫다" 후보가 다시 생기는 순간 이 불변식이 필요해진다.
    const firstLastResort = MODEL_CHAIN_ENTRIES.findIndex(e => e.quality === 'last-resort')
    if (firstLastResort >= 0) {
      const lastVerified = MODEL_CHAIN_ENTRIES.map(e => e.quality).lastIndexOf('verified')
      expect(firstLastResort).toBeGreaterThan(lastVerified)
    }
  })

  it('체인은 전원 verified 다 — 검증 안 된 모델이 슬쩍 들어오지 않았는지', () => {
    // gemma-4-31b-it 을 뺀 뒤의 상태다(실제 본문에서 타임아웃 50%·정상 JSON 0%,
    // 60초 타임아웃이 07:40~08:00 수집 창을 갉아먹었다 — EXCLUDED_MODELS 참고).
    // 새 모델을 last-resort 로 넣으려면 이 테스트를 **의식적으로** 고쳐야 한다.
    expect(MODEL_CHAIN_ENTRIES.map(e => e.quality)).toEqual(MODEL_CHAIN_ENTRIES.map(() => 'verified'))
  })

  it('품질을 실측 검증한 gemini-3.6-flash 가 1순위다', () => {
    expect(MODEL_CHAIN_ENTRIES[0]).toMatchObject({ model: 'gemini-3.6-flash', quality: 'verified' })
  })

  it('gemma 계열은 체인에 없다 — 둘 다 실측으로 배제했다', () => {
    // 26b 는 조용히 무너지고(성공분의 40%), 31b 는 타임아웃 50% 에 정상 JSON 0% 였다.
    expect(MODEL_CHAIN.filter(m => m.startsWith('gemma-'))).toEqual([])
  })

  it('실측으로 배제한 모델은 체인에 없다', () => {
    for (const model of Object.keys(EXCLUDED_MODELS)) {
      expect(MODEL_CHAIN).not.toContain(model)
    }
  })

  it('배제 사유는 비어 있지 않다 — 사유 없는 배제는 다음 사람이 되돌린다', () => {
    for (const [model, reason] of Object.entries(EXCLUDED_MODELS)) {
      expect(reason.length, model).toBeGreaterThan(20)
    }
  })

  it('모든 항목에 순서의 근거(note)가 달려 있다', () => {
    for (const entry of MODEL_CHAIN_ENTRIES) {
      expect(entry.note.length, entry.model).toBeGreaterThan(20)
    }
  })

  it('중복 모델이 없다 — 같은 모델을 두 번 두드리면 쿼터만 빨리 마른다', () => {
    expect(new Set(MODEL_CHAIN).size).toBe(MODEL_CHAIN.length)
  })

  it('MODEL_CHAIN 은 MODEL_CHAIN_ENTRIES 에서 파생된다 (둘이 어긋나지 않는다)', () => {
    expect(MODEL_CHAIN).toEqual(MODEL_CHAIN_ENTRIES.map(e => e.model))
  })

  it('기존 5개 모델의 상대 순서가 유지된다 — 체인을 넓히면서 앞쪽을 흔들지 않았다', () => {
    const before = [
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-flash-lite-latest',
      'gemini-3.5-flash',
      'gemini-3.1-flash-lite',
    ]
    expect(MODEL_CHAIN.slice(0, before.length)).toEqual(before)
  })

  it('체인이 넓어졌다 — 확장 전 5개보다 많다', () => {
    // 파트 A 의 목적 자체(모델별 일일 한도를 합산해 발췌 폴백을 줄인다)를 지킨다.
    // gemma 둘을 배제하고도 gemini 7개가 남아 목적은 유지된다.
    expect(MODEL_CHAIN.length).toBeGreaterThan(5)
  })
})

describe('stripCodeFence', () => {
  const JSON_BODY = '{"numeric":"수치임","context":"배경임"}'

  it('실측 형태 — 여는 펜스 없이 닫는 펜스만 붙은 응답을 벗긴다', () => {
    // gemma-4-31b-it 이 실제로 이렇게 보냈다(2026-08-28, 표본 3개 모두 이 형태).
    const raw = ' {\n  "numeric": "수치임",\n  "context": "배경임"\n}\n```'
    const inner = stripCodeFence(raw)
    expect(inner).not.toBeNull()
    expect(JSON.parse(inner!)).toEqual({ numeric: '수치임', context: '배경임' })
  })

  it('여닫는 펜스가 모두 있는 형태도 벗긴다', () => {
    expect(JSON.parse(stripCodeFence('```\n' + JSON_BODY + '\n```')!)).toEqual({
      numeric: '수치임', context: '배경임',
    })
  })

  it('언어 태그가 붙은 펜스(```json)도 벗긴다', () => {
    expect(JSON.parse(stripCodeFence('```json\n' + JSON_BODY + '\n```')!)).toEqual({
      numeric: '수치임', context: '배경임',
    })
  })

  it('펜스가 없으면 null 이다 — 평상시 경로를 건드리지 않는다', () => {
    expect(stripCodeFence(JSON_BODY)).toBeNull()
    expect(stripCodeFence('죄송합니다, 요약할 수 없습니다')).toBeNull()
  })

  it('펜스만 있고 안이 비면 null 이다', () => {
    expect(stripCodeFence('```\n\n```')).toBeNull()
  })
})

describe('코드펜스 복구 (정상 파싱이 실패했을 때만)', () => {
  function respond(text: string) {
    return new Response(JSON.stringify({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }],
    }), { status: 200 })
  }

  it('펜스로 감싼 응답을 벗겨내고 요약을 돌려준다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      respond(' {\n  "numeric": "수치임",\n  "context": "배경임"\n}\n```')))

    const r = await summarize('제목', '본문')

    expect(r).toEqual({ numeric: '수치임', context: '배경임', model: MODEL_CHAIN[0] })
  })

  it('언어 태그가 붙은 펜스도 복구한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      respond('```json\n{"numeric":"수치임","context":"배경임"}\n```')))

    expect(await summarize('제목', '본문')).toEqual({
      numeric: '수치임', context: '배경임', model: MODEL_CHAIN[0],
    })
  })

  it('복구했으면 어느 모델이 규약을 어겼는지 경고 로그를 남긴다', async () => {
    // 조용히 고쳐주면 그 모델이 계속 그래도 아무도 모른다.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () =>
      respond('```json\n{"numeric":"수치임","context":"배경임"}\n```')))

    await summarize('제목', '본문')

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain(MODEL_CHAIN[0])
    warn.mockRestore()
  })

  it('펜스는 있는데 안쪽이 깨져 있으면 지금처럼 실패한다 — 무리해서 건져내지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      respond('```json\n{"numeric":"수치임", "context":\n```')))

    await expect(summarize('제목', '본문')).rejects.toThrow(/JSON이 아니다/)
  })

  it('펜스가 아닌 이유로 깨진 응답은 예전 그대로 실패한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond('죄송합니다, 요약할 수 없습니다')))

    await expect(summarize('제목', '본문')).rejects.toThrow(/JSON이 아니다/)
  })

  it('정상 JSON 은 복구 경로를 지나가지 않는다 (경고 로그 없음)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(async () => respond('{"numeric":"수치임","context":"배경임"}')))

    const r = await summarize('제목', '본문')

    expect(r).toEqual({ numeric: '수치임', context: '배경임', model: MODEL_CHAIN[0] })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('fetch 가 던졌을 때 (타임아웃·네트워크)', () => {
  function timeoutError() {
    const e = new Error('The operation was aborted due to timeout')
    e.name = 'TimeoutError'
    return e
  }
  function okResponse() {
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [
        { text: JSON.stringify({ numeric: '수치임', context: '배경임' }), thoughtSignature: 'x' },
      ] } }],
    }), { status: 200 })
  }

  it('첫 모델이 타임아웃이면 다음 모델로 넘어가 정상 응답을 돌려준다', async () => {
    // 예전에는 예외가 루프 밖으로 새어나가 체인 전체가 여기서 끝났다.
    const calledUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calledUrls.push(url)
      if (url.includes(MODEL_CHAIN[0])) throw timeoutError()
      return okResponse()
    }))

    const r = await summarize('제목', '본문')

    expect(r).toEqual({ numeric: '수치임', context: '배경임', model: MODEL_CHAIN[1] })
    expect(calledUrls).toHaveLength(2)
    expect(calledUrls[1]).toContain(MODEL_CHAIN[1])
  })

  it('네트워크 오류(fetch failed)도 다음 모델로 넘어간다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes(MODEL_CHAIN[0])) throw new TypeError('fetch failed')
      return okResponse()
    }))

    const r = await summarize('제목', '본문')

    expect(r.model).toBe(MODEL_CHAIN[1])
  })

  it('타임아웃은 소진으로 기록하지 않는다 — 다음 호출에서 맨 앞부터 다시 시도한다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes(MODEL_CHAIN[0])) throw timeoutError()
      return okResponse()
    })
    vi.stubGlobal('fetch', fetchMock)

    await summarize('제목1', '본문1')
    expect(exhaustedModels.has(MODEL_CHAIN[0])).toBe(false)

    fetchMock.mockClear()
    await summarize('제목2', '본문2')

    expect(fetchMock.mock.calls[0][0]).toContain(MODEL_CHAIN[0])
  })

  it('전부 타임아웃이면 체인 전체를 시도하고, 사유가 쿼터 소진과 구분된다', async () => {
    // 전부 타임아웃인 날에 "쿼터가 소진됐다"고 말하면 운영자가 엉뚱한 데를 본다.
    const fetchMock = vi.fn(async () => { throw timeoutError() })
    vi.stubGlobal('fetch', fetchMock)

    let error: unknown
    try {
      await summarize('제목', '본문')
    } catch (e) {
      error = e
    }

    expect(fetchMock).toHaveBeenCalledTimes(MODEL_CHAIN.length)
    const message = (error as Error).message
    expect(message).toContain('응답 없음')
    expect(message).not.toContain('쿼터 소진')
    for (const model of MODEL_CHAIN) expect(message).toContain(model)
  })

  it('타임아웃과 하루치 소진이 섞이면 두 범주를 갈라 적는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes(MODEL_CHAIN[0])) {
        return new Response(JSON.stringify({
          error: {
            status: 'RESOURCE_EXHAUSTED',
            details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
          },
        }), { status: 429 })
      }
      throw timeoutError()
    }))

    let error: unknown
    try {
      await summarize('제목', '본문')
    } catch (e) {
      error = e
    }

    const message = (error as Error).message
    expect(message).toContain('쿼터 소진')
    expect(message).toContain('응답 없음')
  })

  it('본문을 읽는 도중 끊기면 다음 모델로 넘어간다 (정상 응답 경로)', async () => {
    // fetch 는 헤더만 받고 반환한다. 바디가 흘러오다 끊기면 예외는 res.json() 에서
    // 난다 — fetch 를 감싼 try 로는 못 잡는다.
    const calledUrls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calledUrls.push(url)
      if (url.includes(MODEL_CHAIN[0])) {
        return { ok: true, status: 200, json: async () => { throw new TypeError('terminated') } } as unknown as Response
      }
      return okResponse()
    }))

    const r = await summarize('제목', '본문')

    expect(r.model).toBe(MODEL_CHAIN[1])
    expect(calledUrls).toHaveLength(2)
  })

  it('오류 본문을 읽는 도중 끊겨도 다음 모델로 넘어간다 (실패 응답 경로)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes(MODEL_CHAIN[0])) {
        return { ok: false, status: 500, text: async () => { throw new TypeError('terminated') } } as unknown as Response
      }
      return okResponse()
    }))

    expect((await summarize('제목', '본문')).model).toBe(MODEL_CHAIN[1])
  })

  it('본문 읽기 중 끊김은 소진으로 기록하지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes(MODEL_CHAIN[0])) {
        return { ok: true, status: 200, json: async () => { throw new TypeError('terminated') } } as unknown as Response
      }
      return okResponse()
    }))

    await summarize('제목', '본문')

    expect(exhaustedModels.has(MODEL_CHAIN[0])).toBe(false)
  })

  it('전부 본문 도중 끊기면 사유가 쿼터와 구분된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => (
      { ok: true, status: 200, json: async () => { throw new TypeError('terminated') } } as unknown as Response
    )))

    let error: unknown
    try {
      await summarize('제목', '본문')
    } catch (e) {
      error = e
    }

    const message = (error as Error).message
    expect(message).toContain('응답 없음')
    expect(message).not.toContain('쿼터 소진')
  })

  it('JSON 문법 오류는 다음 모델로 넘기지 않고 던진다 — 연결 문제가 아니다', async () => {
    // res.json() 의 SyntaxError 까지 "끊김"으로 삼키면, 응답이 이상한 모델이
    // 조용히 체인을 타고 넘어가 진단이 사라진다.
    const fetchMock = vi.fn(async () => (
      { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0') } } as unknown as Response
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(summarize('제목', '본문')).rejects.toThrow(/Unexpected token/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('네트워크 장애가 아닌 예외는 그대로 던진다 — 다음 모델로 가려지지 않는다', async () => {
    // 버그성 예외(예: 직렬화 실패)가 조용히 체인을 타고 넘어가면 진단이 사라진다.
    const fetchMock = vi.fn(async () => { throw new TypeError('x is not a function') })
    vi.stubGlobal('fetch', fetchMock)

    await expect(summarize('제목', '본문')).rejects.toThrow(/x is not a function/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('classifyFailure', () => {
  const dayDetail = '{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}'
  const minuteDetail = '{"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier"}'

  it('quotaId 는 상태 코드보다 우선한다 — 429 안에 두 실패가 들어 있다', () => {
    expect(classifyFailure(429, dayDetail)).toBe('quota')
    expect(classifyFailure(429, minuteDetail)).toBe('rate-limit')
  })

  it('quotaId 가 없는 429 는 하루 소진으로 단정하지 않는다 (재시도 가능한 쪽으로 둔다)', () => {
    expect(classifyFailure(429, 'RESOURCE_EXHAUSTED')).toBe('rate-limit')
    expect(classifyFailure(429, 'UNAVAILABLE')).toBe('rate-limit')
  })

  it('quotaId 가 없으면 상태 코드가 본문보다 우선한다 (기존 규칙 유지)', () => {
    expect(classifyFailure(503, 'RESOURCE_EXHAUSTED')).toBe('unavailable')
    expect(classifyFailure(500, 'RESOURCE_EXHAUSTED')).toBe('unavailable')
  })

  it('상태 코드로 확정할 수 없으면 본문을 본다', () => {
    expect(classifyFailure(400, 'RESOURCE_EXHAUSTED')).toBe('rate-limit')
    expect(classifyFailure(400, 'UNAVAILABLE')).toBe('unavailable')
  })

  it('그 밖은 other 다 — 체인을 넘기지 않고 던지는 쪽이 안전하다', () => {
    expect(classifyFailure(401, 'API key not valid')).toBe('other')
  })
})
