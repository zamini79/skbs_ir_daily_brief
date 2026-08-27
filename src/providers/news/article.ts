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
 * 요약 입력 텍스트와 **그 텍스트가 어디서 왔는지**.
 *
 * 스니펫 폴백은 스펙 §8 이 정한 정상 경로지만, 그 사실이 어디에도 남지 않으면
 * 100자 남짓한 도입부로 만든 요약과 전문으로 만든 요약이 완전히 같아 보인다.
 * 특히 네이버가 본문 컨테이너(`dic_area`)를 바꾸면 **모든** 기사가 조용히
 * 스니펫 요약으로 내려앉는데, summaryModel 은 채워지고 summaryError 는 null 이라
 * 모든 신호가 "정상"을 가리킨다.
 */
export type ArticleBody = {
  /** 요약 입력. 스니펫조차 없으면 빈 문자열일 수 있다. */
  text: string
  /** 'body' = 기사 본문 크롤링 성공. 'snippet' = 검색 API 스니펫(도입부). */
  source: 'body' | 'snippet'
  /**
   * 크롤링을 **시도했다가 실패**한 경우의 사유. 성공했거나 애초에 시도하지
   * 않았으면(네이버 링크 없음) null 이다.
   *
   * 둘을 같은 값으로 뭉개면 안 된다 — "링크가 없어 스니펫을 쓴 것"은 그 기사에
   * 대한 사실이고 매일 대다수 후보에서 일어나지만, "본문을 받으려다 실패한 것"은
   * 장애다. 뭉개면 실패율이 상수에 파묻혀 셀렉터가 깨진 날을 알아볼 수 없다.
   */
  crawlFailure: string | null
}

const fromSnippet = (item: NewsItem, crawlFailure: string | null): ArticleBody => ({
  text: item.description,
  source: 'snippet',
  crawlFailure,
})

/**
 * 요약 입력을 만든다. 어떤 경우에도 예외를 던지지 않는다.
 * 크롤링 실패는 정상 경로다 — 검색 API 스니펫으로 폴백하되, 폴백했다는 사실과
 * (시도했다 실패한 경우) 그 사유를 함께 돌려준다.
 */
export async function fetchArticleBody(item: NewsItem): Promise<ArticleBody> {
  // 네이버 기사 링크가 아예 없는 경우. 시도할 대상이 없으므로 실패가 아니다.
  if (!item.naverUrl) return fromSnippet(item, null)

  try {
    const res = await fetch(item.naverUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IRDailyBrief/1.0)' },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return fromSnippet(item, `본문 응답 HTTP ${res.status}`)
    const html = await res.text()
    const body = extractNaverArticleBody(html)
    if ([...body].length < MIN_BODY_CHARS) {
      // 셀렉터가 바뀌면 여기로 온다(추출 0자). 사유에 길이를 적어 두면 운영자가
      // "기사가 원래 짧았다"와 "추출에 실패했다"를 로그만 보고 가를 수 있다.
      return fromSnippet(item, `본문 추출 ${[...body].length}자 (최소 ${MIN_BODY_CHARS}자)`)
    }
    return { text: [...body].slice(0, MAX_BODY_CHARS).join(''), source: 'body', crawlFailure: null }
  } catch (e) {
    return fromSnippet(item, `본문 요청 실패: ${e instanceof Error ? e.message : String(e)}`)
  }
}
