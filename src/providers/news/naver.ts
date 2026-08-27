import { kstDateString, kstTodayAndYesterday } from '@/domain/date'
import type { NewsItem } from './types'

const ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}

/** 네이버 검색 API 는 제목·본문에 <b> 태그와 HTML 엔티티를 섞어 준다. */
export function stripHtml(s: string): string {
  let out = s.replace(/<[^>]*>/g, '')
  for (const [k, v] of Object.entries(ENTITIES)) out = out.split(k).join(v)
  return out.trim()
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
