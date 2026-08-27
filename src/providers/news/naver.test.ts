import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { stripHtml, searchNaverNews } from './naver'

beforeEach(() => {
  process.env.NAVER_CLIENT_ID = 'test-id'
  process.env.NAVER_CLIENT_SECRET = 'test-secret'
})

afterEach(() => vi.unstubAllGlobals())

function stub(items: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items }), { status: 200 })))
}

describe('stripHtml', () => {
  it('b 태그를 없앤다', () => {
    expect(stripHtml('<b>셀트리온</b>, 매출 증가')).toBe('셀트리온, 매출 증가')
  })
  it('HTML 엔티티를 되돌린다', () => {
    expect(stripHtml('&quot;글로벌 톱3&quot; &amp; 성장')).toBe('"글로벌 톱3" & 성장')
  })
  it('작은따옴표 엔티티를 되돌린다', () => {
    expect(stripHtml('&#39;엑스코프리&#39;')).toBe("'엑스코프리'")
  })
  it('이중 인코딩된 입력이 살아있는 태그를 되살리지 않는다', () => {
    const out = stripHtml('&amp;lt;b&amp;gt; 태그')
    expect(out).toBe('&lt;b&gt; 태그')
    expect(out).not.toMatch(/[<>]/)
  })
  it('10진 숫자 엔티티를 디코딩한다', () => {
    expect(stripHtml('&#8220;큰따옴표&#8221; 인용')).toBe('“큰따옴표” 인용')
  })
  it('16진 숫자 엔티티를 디코딩한다', () => {
    expect(stripHtml('&#x27;작은따옴표&#x27;')).toBe("'작은따옴표'")
  })
  it('알 수 없는 이름 엔티티는 원문 그대로 남긴다', () => {
    expect(stripHtml('A &foobar; B')).toBe('A &foobar; B')
  })
  it('기존에 통하던 명명 엔티티 동작은 그대로 유지된다', () => {
    expect(stripHtml('&quot;글로벌 톱3&quot; &amp; 성장')).toBe('"글로벌 톱3" & 성장')
    expect(stripHtml('&#39;엑스코프리&#39;')).toBe("'엑스코프리'")
  })
  it('범위를 벗어난 숫자 코드포인트에서 예외를 던지지 않는다', () => {
    expect(() => stripHtml('&#99999999; 망가진 엔티티')).not.toThrow()
    const out = stripHtml('&#99999999; 망가진 엔티티')
    expect(out).toBe('&#99999999; 망가진 엔티티')
    expect([...out].length).toBe([...'&#99999999; 망가진 엔티티'].length)
  })
  it('한국어 기사에 흔한 명명 엔티티 8종을 디코딩한다', () => {
    expect(stripHtml('&lsquo;x&rsquo;')).toBe('‘x’')
    expect(stripHtml('&ldquo;x&rdquo;')).toBe('“x”')
    expect(stripHtml('A&middot;B')).toBe('A·B')
    expect(stripHtml('A&hellip;B')).toBe('A…B')
    expect(stripHtml('A&ndash;B')).toBe('A–B')
    expect(stripHtml('A&mdash;B')).toBe('A—B')
  })
  it('실제 기사 제목에 쓰이는 조합(작은따옴표+가운뎃점)을 정확히 디코딩한다', () => {
    expect(stripHtml('&lsquo;램시마SC&middot;짐펜트라&rsquo;')).toBe('‘램시마SC·짐펜트라’')
  })
  it('명명 엔티티 목록이 늘어나도 모르는 이름 엔티티는 여전히 원문 그대로 남긴다', () => {
    expect(stripHtml('A &foobar; B')).toBe('A &foobar; B')
  })
})

describe('searchNaverNews', () => {
  const now = new Date('2026-08-26T22:40:00Z') // KST 2026-08-27 07:40

  it('당일과 D-1 기사만 남긴다', async () => {
    stub([
      { title: '<b>당일</b>', originallink: 'https://a.com/1', link: 'https://n.news.naver.com/1', description: 'd1', pubDate: 'Thu, 27 Aug 2026 06:00:00 +0900' },
      { title: '전일', originallink: 'https://b.com/2', link: 'https://b.com/2', description: 'd2', pubDate: 'Wed, 26 Aug 2026 18:00:00 +0900' },
      { title: '이틀전', originallink: 'https://c.com/3', link: 'https://c.com/3', description: 'd3', pubDate: 'Tue, 25 Aug 2026 18:00:00 +0900' },
    ])
    const r = await searchNaverNews('셀트리온', now)
    expect(r.map(i => i.title)).toEqual(['당일', '전일'])
  })

  it('네이버뉴스 링크를 따로 담는다', async () => {
    stub([
      { title: 'a', originallink: 'https://a.com/1', link: 'https://n.news.naver.com/mnews/article/001/1', description: '', pubDate: 'Thu, 27 Aug 2026 06:00:00 +0900' },
      { title: 'b', originallink: 'https://b.com/2', link: 'https://b.com/2', description: '', pubDate: 'Thu, 27 Aug 2026 06:00:00 +0900' },
    ])
    const r = await searchNaverNews('x', now)
    expect(r[0].naverUrl).toContain('n.news.naver.com')
    expect(r[1].naverUrl).toBeNull()
  })

  it('언론사는 원문 도메인에서 뽑는다', async () => {
    stub([{ title: 'a', originallink: 'https://www.yna.co.kr/view/1', link: 'https://n.news.naver.com/1', description: '', pubDate: 'Thu, 27 Aug 2026 06:00:00 +0900' }])
    const r = await searchNaverNews('x', now)
    expect(r[0].publisher).toBe('yna.co.kr')
  })

  it('기사가 없으면 빈 배열을 준다', async () => {
    stub([])
    expect(await searchNaverNews('x', now)).toEqual([])
  })

  it('인증 정보가 없으면 어떤 변수가 빠졌는지 알 수 있는 메시지로 실패한다', async () => {
    const id = process.env.NAVER_CLIENT_ID
    const secret = process.env.NAVER_CLIENT_SECRET
    delete process.env.NAVER_CLIENT_ID
    delete process.env.NAVER_CLIENT_SECRET
    try {
      await expect(searchNaverNews('x', now)).rejects.toThrow(/NAVER_CLIENT_ID/)
    } finally {
      process.env.NAVER_CLIENT_ID = id
      process.env.NAVER_CLIENT_SECRET = secret
    }
  })
})

// ── 429 재시도. 동시성 1 로 낮춰도 직전 호출로 예산이 깎여 있으면 429 가 난다(실측). ──
describe('searchNaverNews — 429 재시도', () => {
  /** 테스트에서 2초를 실제로 기다리지 않도록 주입한다. 대기 인자도 함께 검사한다. */
  function fakeSleep() {
    const calls: number[] = []
    return { fn: async (ms: number) => { calls.push(ms) }, calls }
  }
  const ok = (items: unknown[] = []) => new Response(JSON.stringify({ items }), { status: 200 })
  const tooMany = () => new Response('', { status: 429 })

  it('429 면 2초 뒤 정확히 한 번 재시도하고, 성공하면 결과를 준다', async () => {
    const sleep = fakeSleep()
    const spy = vi.fn().mockResolvedValueOnce(tooMany()).mockResolvedValueOnce(ok([]))
    vi.stubGlobal('fetch', spy)

    const r = await searchNaverNews('코스피', new Date('2026-08-27T09:00:00+09:00'), { sleep: sleep.fn })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(sleep.calls).toEqual([2000])
    expect(r).toEqual([])
  })

  it('재시도도 429 면 던진다 — 무한 재시도 금지', async () => {
    const sleep = fakeSleep()
    const spy = vi.fn(async () => tooMany())
    vi.stubGlobal('fetch', spy)

    await expect(
      searchNaverNews('코스피', new Date('2026-08-27T09:00:00+09:00'), { sleep: sleep.fn }),
    ).rejects.toThrow('naver news HTTP 429')
    expect(spy).toHaveBeenCalledTimes(2) // 최초 1회 + 재시도 1회. 그 이상 없다.
    expect(sleep.calls).toHaveLength(1)
  })

  it('429 가 아닌 오류는 재시도하지 않는다', async () => {
    const sleep = fakeSleep()
    const spy = vi.fn(async () => new Response('', { status: 500 }))
    vi.stubGlobal('fetch', spy)

    await expect(
      searchNaverNews('코스피', new Date('2026-08-27T09:00:00+09:00'), { sleep: sleep.fn }),
    ).rejects.toThrow('naver news HTTP 500')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(sleep.calls).toEqual([])
  })

  it('처음부터 성공하면 기다리지 않는다', async () => {
    const sleep = fakeSleep()
    vi.stubGlobal('fetch', vi.fn(async () => ok([])))
    await searchNaverNews('코스피', new Date('2026-08-27T09:00:00+09:00'), { sleep: sleep.fn })
    expect(sleep.calls).toEqual([])
  })

  it('에러 메시지에 자격증명이 들어가지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })))
    await expect(
      searchNaverNews('코스피', new Date('2026-08-27T09:00:00+09:00'), { sleep: async () => {} }),
    ).rejects.toThrow(/^naver news HTTP 403$/)
  })
})
