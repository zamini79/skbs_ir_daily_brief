import { describe, it, expect, vi, afterEach } from 'vitest'
import { extractNaverArticleBody, fetchArticleBody } from './article'
import type { NewsItem } from './types'

afterEach(() => vi.unstubAllGlobals())

function base(overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    title: 't', url: 'https://a.com/1', naverUrl: null,
    publisher: 'a.com', publishedAt: new Date(), description: '폴백 스니펫',
    ...overrides,
  }
}

describe('extractNaverArticleBody', () => {
  it('dic_area 안의 본문을 뽑는다', () => {
    const html = `<html><body><div id="dic_area">셀트리온은 매출이 늘었다고 밝혔다.</div></body></html>`
    expect(extractNaverArticleBody(html)).toBe('셀트리온은 매출이 늘었다고 밝혔다.')
  })
  it('본문 안의 태그와 스크립트를 없앤다', () => {
    const html = `<div id="dic_area"><span class="x">앞</span><script>bad()</script> 뒤</div>`
    expect(extractNaverArticleBody(html)).toBe('앞 뒤')
  })
  it('본문 영역이 없으면 빈 문자열을 준다', () => {
    expect(extractNaverArticleBody('<html><body>없음</body></html>')).toBe('')
  })
  it('선행 0이 있는 10진 엔티티(&#039;)를 디코딩한다', () => {
    const html = `<div id="dic_area">치료제 &#039;램시마SC&#039;</div>`
    expect(extractNaverArticleBody(html)).toBe("치료제 '램시마SC'")
  })
  it('높은 10진 엔티티(&#8943;)를 디코딩한다', () => {
    const html = `<div id="dic_area">성장&#8943;확대</div>`
    expect(extractNaverArticleBody(html)).toBe('성장⋯확대')
  })
  it('script 안의 텍스트는 여전히 제거된다', () => {
    const html = `<div id="dic_area">앞<script>alert('스크립트 안의 한글 텍스트')</script>뒤</div>`
    const result = extractNaverArticleBody(html)
    expect(result).not.toContain('스크립트 안의 한글 텍스트')
    expect(result).toBe('앞 뒤')
  })
  it('&nbsp;, &quot;, &amp; 는 기존과 같이 디코딩된다', () => {
    const html = `<div id="dic_area">&quot;인용&quot;&nbsp;그리고&nbsp;A&amp;B</div>`
    expect(extractNaverArticleBody(html)).toBe('"인용" 그리고 A&B')
  })
})

describe('fetchArticleBody', () => {
  it('네이버 링크가 없으면 바로 description 을 쓴다', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    expect(await fetchArticleBody(base())).toBe('폴백 스니펫')
    expect(spy).not.toHaveBeenCalled()
  })

  it('네이버 본문을 받으면 그것을 쓴다', async () => {
    const realBody =
      '셀트리온은 26일 2분기 연결 기준 매출액이 전년 동기 대비 늘었다고 밝혔다. ' +
      '회사 측은 바이오시밀러 판매 호조와 신제품 출시가 실적을 견인했다고 설명했다.'
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(`<div id="dic_area">${realBody}</div>`, { status: 200 })))
    const r = await fetchArticleBody(base({ naverUrl: 'https://n.news.naver.com/1' }))
    expect(r).toBe(realBody)
  })

  it('크롤링이 실패해도 던지지 않고 description 으로 넘어간다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const r = await fetchArticleBody(base({ naverUrl: 'https://n.news.naver.com/1' }))
    expect(r).toBe('폴백 스니펫')
  })

  it('본문이 너무 짧으면 description 을 쓴다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<div id="dic_area">짧음</div>', { status: 200 })))
    const r = await fetchArticleBody(base({ naverUrl: 'https://n.news.naver.com/1' }))
    expect(r).toBe('폴백 스니펫')
  })
})
