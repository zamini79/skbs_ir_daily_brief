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
  it('&middot; 는 실제 가운뎃점 문자로 디코딩된다', () => {
    const html = `<div id="dic_area">램시마SC&middot;짐펜트라</div>`
    expect(extractNaverArticleBody(html)).toBe('램시마SC·짐펜트라')
  })
})

describe('fetchArticleBody', () => {
  it('네이버 링크가 없으면 바로 description 을 쓰고, 그것을 실패로 세지 않는다', async () => {
    const spy = vi.fn()
    vi.stubGlobal('fetch', spy)
    const r = await fetchArticleBody(base())
    expect(r.text).toBe('폴백 스니펫')
    expect(r.source).toBe('snippet')
    // 시도할 대상이 없었으므로 장애가 아니다. 여기에 사유를 채우면 매일 대다수
    // 후보가 "크롤링 실패"로 잡혀 진짜 실패(셀렉터 깨짐)를 알아볼 수 없다.
    expect(r.crawlFailure).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('네이버 본문을 받으면 그것을 쓴다', async () => {
    const realBody =
      '셀트리온은 26일 2분기 연결 기준 매출액이 전년 동기 대비 늘었다고 밝혔다. ' +
      '회사 측은 바이오시밀러 판매 호조와 신제품 출시가 실적을 견인했다고 설명했다.'
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(`<div id="dic_area">${realBody}</div>`, { status: 200 })))
    const r = await fetchArticleBody(base({ naverUrl: 'https://n.news.naver.com/1' }))
    expect(r.text).toBe(realBody)
    expect(r.source).toBe('body')
    expect(r.crawlFailure).toBeNull()
  })

  it('크롤링이 실패해도 던지지 않고 description 으로 넘어가되 사유를 남긴다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const r = await fetchArticleBody(base({ naverUrl: 'https://n.news.naver.com/1' }))
    expect(r.text).toBe('폴백 스니펫')
    expect(r.source).toBe('snippet')
    expect(r.crawlFailure).toContain('network down')
  })

  it('HTTP 오류는 상태 코드를 사유에 남긴다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })))
    const r = await fetchArticleBody(base({ naverUrl: 'https://n.news.naver.com/1' }))
    expect(r.text).toBe('폴백 스니펫')
    expect(r.crawlFailure).toContain('403')
  })

  it('본문이 너무 짧으면 description 을 쓰고 추출 길이를 사유에 남긴다', async () => {
    // 네이버가 dic_area 를 바꾸면 추출이 0자가 되고 **모든** 기사가 이 경로로 온다.
    // 사유에 길이가 있어야 "기사가 짧았다"와 "셀렉터가 깨졌다"를 로그로 가른다.
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('<div id="dic_area">짧음</div>', { status: 200 })))
    const r = await fetchArticleBody(base({ naverUrl: 'https://n.news.naver.com/1' }))
    expect(r.text).toBe('폴백 스니펫')
    expect(r.crawlFailure).toContain('2자')
  })

  it('스니펫 폴백 네 경로 중 시도한 셋만 실패로 구분된다', async () => {
    // 같은 폴백이라도 "시도하지 않음"과 "시도했다 실패"가 같은 값으로 수렴하면
    // 안 된다 — 실패율이 상수에 파묻힌다.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    const attempted = await fetchArticleBody(base({ naverUrl: 'https://n.news.naver.com/1' }))
    const notAttempted = await fetchArticleBody(base())
    expect(attempted.source).toBe(notAttempted.source)
    expect(attempted.crawlFailure).not.toBe(notAttempted.crawlFailure)
  })
})
