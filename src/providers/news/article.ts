import { stripHtml } from './naver'
import type { NewsItem } from './types'

/** 이보다 짧으면 본문 추출에 실패한 것으로 본다. */
const MIN_BODY_CHARS = 50
/** 요약 입력으로 넘길 최대 길이. 토큰 낭비를 막는다. */
const MAX_BODY_CHARS = 3000

/** 네이버뉴스 본문 컨테이너. 구조가 바뀌면 여기만 고치면 된다. */
const BODY_SELECTORS = [/<div[^>]*id="dic_area"[^>]*>([\s\S]*?)<\/div>/i,
                        /<article[^>]*id="dic_area"[^>]*>([\s\S]*?)<\/article>/i,
                        /<div[^>]*id="newsct_article"[^>]*>([\s\S]*?)<\/div>/i]

export function extractNaverArticleBody(html: string): string {
  for (const re of BODY_SELECTORS) {
    const m = html.match(re)
    if (!m) continue
    // <script>/<style> 내용은 여기서 먼저 걷어낸다. stripHtml 이 태그만 지우고
    // 내용을 남기면 스크립트 안의 텍스트가 본문에 섞여 들어오기 때문이다.
    const withoutScriptsAndStyles = m[1]
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    // 나머지 태그 제거와 엔티티 디코딩은 naver.ts 의 단일 패스 디코더에 맡긴다.
    // 여기서 별도의 엔티티 치환 목록을 두면 그쪽이 고쳐져도 이쪽은 낡은 채로 남는다.
    const text = stripHtml(withoutScriptsAndStyles).replace(/\s+/g, ' ').trim()
    if (text) return text
  }
  return ''
}

/**
 * 요약 입력을 만든다. 어떤 경우에도 예외를 던지지 않는다.
 * 크롤링 실패는 정상 경로다 — 검색 API 스니펫으로 폴백한다.
 */
export async function fetchArticleBody(item: NewsItem): Promise<string> {
  if (!item.naverUrl) return item.description

  try {
    const res = await fetch(item.naverUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IRDailyBrief/1.0)' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return item.description
    const html = await res.text()
    const body = extractNaverArticleBody(html)
    if ([...body].length < MIN_BODY_CHARS) return item.description
    return [...body].slice(0, MAX_BODY_CHARS).join('')
  } catch {
    return item.description
  }
}
