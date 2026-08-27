import { kstDateString, kstTodayAndYesterday } from '@/domain/date'
import type { NewsItem } from './types'

const NAMED_ENTITIES: Record<string, string> = {
  quot: '"',
  amp: '&',
  lt: '<',
  gt: '>',
  apos: "'",
  nbsp: ' ',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  hellip: '…',
  ndash: '–',
  mdash: '—',
}

const ENTITY_RE = /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g

/**
 * 네이버 검색 API 는 제목·본문에 <b> 태그와 HTML 엔티티(개체 참조)를 섞어 준다.
 * 태그 제거 뒤 엔티티를 단 한 번만 스캔해서 치환한다. 순차 치환(map 을 돌며
 * split/join)은 이중 인코딩된 입력(예: `&amp;lt;`)을 두 번 디코딩해 살아있는
 * `<b>` 태그를 되살릴 수 있으므로 쓰지 않는다. 알 수 없는 이름 엔티티나
 * 범위를 벗어난 숫자 코드포인트는 원문 그대로 남긴다(글자를 잃는 것보다 낫다).
 */
export function stripHtml(s: string): string {
  const noTags = s.replace(/<[^>]*>/g, '')
  const decoded = noTags.replace(ENTITY_RE, (match, body: string) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X'
      const codePoint = isHex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match
      try {
        return String.fromCodePoint(codePoint)
      } catch {
        return match
      }
    }
    const named = NAMED_ENTITIES[body]
    return named !== undefined ? named : match
  })
  return decoded.trim()
}

function publisherFrom(originallink: string): string {
  try {
    return new URL(originallink).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

type NaverNewsRaw = {
  title: string
  originallink: string
  link: string
  description: string
  pubDate: string
}

/** 07:40 무인 실행 시 진단 가능한 메시지로 즉시 실패하도록 변수명을 각각 확인한다. */
function credentials(): { id: string; secret: string } {
  const id = process.env.NAVER_CLIENT_ID
  const secret = process.env.NAVER_CLIENT_SECRET
  const missing: string[] = []
  if (!id) missing.push('NAVER_CLIENT_ID')
  if (!secret) missing.push('NAVER_CLIENT_SECRET')
  if (missing.length > 0) throw new Error(`${missing.join(', ')} 없음`)
  return { id: id!, secret: secret! }
}

/**
 * 당일·D-1(KST) 기사만 반환한다. 그 밖의 기사는 버린다.
 * 정렬은 date 로 받되 '빈도'는 여기서 계산하지 않는다(클러스터링 담당).
 */
export async function searchNaverNews(query: string, now: Date): Promise<NewsItem[]> {
  const { id, secret } = credentials()

  const url =
    `https://openapi.naver.com/v1/search/news.json` +
    `?query=${encodeURIComponent(query)}&display=100&sort=date`

  const res = await fetch(url, {
    headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret },
  })
  if (!res.ok) throw new Error(`naver news HTTP ${res.status}`)
  const json = (await res.json()) as { items?: NaverNewsRaw[] }

  const { today, yesterday } = kstTodayAndYesterday(now)
  const allowed = new Set([today, yesterday])

  const out: NewsItem[] = []
  for (const it of json.items ?? []) {
    const publishedAt = new Date(it.pubDate)
    if (Number.isNaN(publishedAt.getTime())) continue
    if (!allowed.has(kstDateString(publishedAt))) continue

    out.push({
      title: stripHtml(it.title),
      url: it.originallink || it.link,
      naverUrl: it.link?.includes('n.news.naver.com') ? it.link : null,
      publisher: publisherFrom(it.originallink || it.link),
      publishedAt,
      description: stripHtml(it.description ?? ''),
    })
  }
  return out
}
