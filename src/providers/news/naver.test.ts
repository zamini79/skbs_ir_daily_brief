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
