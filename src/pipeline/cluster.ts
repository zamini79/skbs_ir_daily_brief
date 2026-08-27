import type { NewsItem } from '@/providers/news/types'

/** 같은 사건으로 볼 제목 유사도 임계값 */
const THRESHOLD = 0.5

export function normalizeTitle(title: string): string {
  return title
    .replace(/\[[^\]]*\]/g, ' ')       // [속보], [단독] 같은 말머리
    .replace(/[「」『』<>《》]/g, ' ')
    .replace(/["'"'`]/g, ' ')
    .replace(/[,.…·:;!?~\-–—()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokenize(title: string): string[] {
  return normalizeTitle(title)
    .split(' ')
    .filter(t => [...t].length >= 2)
}

export function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size === 0 && sb.size === 0) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  const union = sa.size + sb.size - inter
  return union === 0 ? 0 : inter / union
}

/** 네이버뉴스 링크가 있으면 우선, 그다음 최신순으로 대표 기사를 고른다. */
function pickRepresentative(members: NewsItem[]): NewsItem {
  return [...members].sort((a, b) => {
    const an = a.naverUrl ? 0 : 1
    const bn = b.naverUrl ? 0 : 1
    if (an !== bn) return an - bn
    return b.publishedAt.getTime() - a.publishedAt.getTime()
  })[0]
}

/** 인용부호류. 실제 낱말 경계가 아니라 인용구를 감싸는 장식일 뿐이므로,
 * hasGenuineMention 이 앞쪽 경계를 볼 때 이 문자들은 건너뛴다. */
const QUOTE_CHARS = new Set(['"', "'", '`'])

/**
 * 공백을 전부 제거하면서("삼성 바이오" ↔ "삼성바이오" 매칭을 위해), 지워진 자리마다
 * 원래 공백이 있었다는 사실을 boundary 배열에 남긴다. boundary[i] === true 는
 * stripped[i] 가 원본에서 문자열 시작이거나 공백 바로 다음이었다는 뜻이다 —
 * 즉 진짜 어절 경계였다는 뜻이고, 이 정보는 공백을 지우는 순간 사라진다.
 *
 * hasGenuineMention 이 이 정보 없이 지워진 문자열만 보고 앞쪽 경계를 판단하다가
 * 자기가 없앤 경계를 근거로 오판했던 것이 이번 수정의 계기다(아래 hasGenuineMention
 * 주석 참고).
 */
function stripWhitespaceWithBoundaries(s: string): { stripped: string; boundary: boolean[] } {
  let stripped = ''
  const boundary: boolean[] = []
  let atBoundary = true // 문자열 시작은 항상 경계다
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (/\s/.test(ch)) {
      atBoundary = true
      continue
    }
    stripped += ch
    boundary.push(atBoundary)
    atBoundary = false
  }
  return { stripped, boundary }
}

/**
 * needle 이 haystack 안에서 "진짜 낱말"로 등장하는 자리가 있는지 본다(부분문자열
 * 포함이 아니라). boundary 는 stripWhitespaceWithBoundaries 가 만든, haystack 과
 * 같은 길이의 배열이다 — boundary[i] 는 haystack[i] 자리가 원본에서 실제 공백
 * 뒤(또는 문자열 시작)였는지를 말해준다.
 *
 * 계기: Lonza 의 별칭 "론자" 가 "…없다'론자"(정청래는 '중도는 없다'론자 …) 같은
 * 정치 기사 제목에 걸렸다. "-론자"(-論者, "…라고 주장하는 사람")는 한국어 접미사로,
 * 절 종결어미 "다" 뒤에 (흔히 인용부호를 사이에 두고) 공백 없이 바로 붙는다.
 * 한국어는 형태소가 공백 없이 이어지므로 이런 충돌은 짧은 한글 별칭에서 구조적으로
 * 생긴다 — 단순 부분문자열 포함으로는 "다'론자"(주장하는 사람)와 "론자"(Lonza) 를
 * 구분할 수 없다.
 *
 * 검사(앞쪽 경계만): 먼저 boundary[idx] 를 본다. true 면(원본에 진짜 공백이 있던
 * 자리라면) 다른 검사 없이 바로 진짜 등장으로 인정한다 — 공백은 형태소가 아니라
 * 어절 자체의 경계이므로, 그 앞 어절이 "다"로 끝나든 말든(예: "…제쳤다 론자 1위
 * 탈환") 무관하다. **이 검사가 없으면 filterByTitleMention 이 공백을 지운 뒤에야
 * hasGenuineMention 을 부르므로, "제쳤다"와 "론자" 사이에 있던 진짜 공백이 이미
 * 사라진 상태로 넘어와 "다"+"론자" 접미사 패턴과 구분이 안 된다** — Lonza 전용이
 * 아니라 "다"로 끝나는 모든 짧은 별칭(화이자/셀트리온/모더나/녹십자 등)이 걸리는
 * 결함이었다.
 * boundary[idx] 가 false 면(원본에서도 공백 없이 바로 붙어 있던 자리라면) 기존
 * 규칙을 그대로 적용한다: 인용부호류(QUOTE_CHARS)를 건너뛰고 실제 문자를 본다.
 * 그 문자가 "다"이면 이 자리는 버리고 다음 등장 위치를 계속 찾는다.
 *
 * **뒤쪽(trailing)은 검사하지 않는다** — 한국어 조사(는/은/이/가/을/를/와/과 등)가
 * 공백 없이 바로 붙는 것은 정상이고 흔하다("론자는 …" 를 막아 버리면 진짜 기사까지
 * 떨어진다).
 *
 * 완벽한 형태소 분석이 아니라는 한계가 있다 — 의도적이다(형태소 분석기를 끌어오는
 * 건 이 문제에 과하다). "다" 가 아닌 다른 종결어미(-란, -라는, -자는 등) 뒤에 붙는
 * -론자 접미사는 잡지 못한다. 그런 조합은 흔치 않고, 형태소 분석 없이 안전하게
 * 구분할 수도 없다고 보고 포기했다 — 오탐(진짜 Lonza 기사를 버리는 것)의 대가가
 * 미탐(정치 기사를 하나 더 후보로 보여주는 것, 담당자가 "싣지 않음"으로 처리하면
 * 그만인)보다 크기 때문이다.
 */
function hasGenuineMention(haystack: string, needle: string, boundary: boolean[]): boolean {
  let from = 0
  while (true) {
    const idx = haystack.indexOf(needle, from)
    if (idx === -1) return false
    if (boundary[idx]) return true
    let before = idx - 1
    while (before >= 0 && QUOTE_CHARS.has(haystack[before])) before--
    if (before < 0 || haystack[before] !== '다') return true
    from = idx + 1
  }
}

/**
 * 제목에 별칭이 하나라도 등장하는 기사만 남긴다.
 * 공백은 양쪽 모두 제거하고("삼성 바이오" ↔ "삼성바이오"), 대소문자를 구분하지 않는다.
 * (GSK, Sanofi 같은 라틴 문자 별칭 대응). 클러스터링과는 별개의 전처리 단계로 분리해
 * 두 함수를 각각 독립적으로 테스트할 수 있게 한다.
 * aliases 가 비어 있으면 필터링하지 않고 원본을 그대로 반환한다 — 설정 누락으로
 * 화면이 조용히 비는 것을 막기 위함이다.
 *
 * 부분문자열 포함이 아니라 hasGenuineMention 으로 판정한다 — 그 이유는 위 주석 참고.
 * 제목의 공백은 stripWhitespaceWithBoundaries 로 지운다 — 그냥 replace(/\s+/g, '')
 * 로 지우면 hasGenuineMention 이 원본에 있던 진짜 어절 경계를 볼 방법이 없어진다.
 */
export function filterByTitleMention(items: NewsItem[], aliases: string[]): NewsItem[] {
  if (aliases.length === 0) return items
  const needles = aliases.map(a => a.replace(/\s+/g, '').toLowerCase())
  return items.filter(it => {
    const { stripped, boundary } = stripWhitespaceWithBoundaries(it.title)
    const haystack = stripped.toLowerCase()
    return needles.some(n => hasGenuineMention(haystack, n, boundary))
  })
}

/**
 * 제목 유사도로 묶은 뒤 묶음 크기(=보도 빈도) 상위 topN 개를 반환한다.
 * 탐욕적 클러스터링이다. 기사 100건 규모에서는 충분하고 결과가 안정적이다.
 *
 * 새 기사는 묶음의 창설 멤버가 아니라 "모든" 멤버와 비교한다. 창설 멤버하고만
 * 비교하면 A~B, B~C 는 임계값을 넘는데 A~C 는 못 넘는 전이적 유사도 상황에서
 * 도착 순서에 따라 같은 사건이 두 묶음으로 쪼개질 수 있다 — 묶음 크기(=보도
 * 빈도)가 실제보다 적게 표시되는 결과로 이어진다.
 */
export function topClusters(
  items: NewsItem[],
  topN: number,
): Array<{ representative: NewsItem; size: number }> {
  const clusters: Array<{ members: NewsItem[]; memberTokens: string[][] }> = []

  for (const it of items) {
    const tokens = tokenize(it.title)
    if (tokens.length === 0) continue
    const hit = clusters.find(c => c.memberTokens.some(t => jaccard(t, tokens) >= THRESHOLD))
    if (hit) {
      hit.members.push(it)
      hit.memberTokens.push(tokens)
    } else {
      clusters.push({ members: [it], memberTokens: [tokens] })
    }
  }

  return clusters
    .sort((a, b) => {
      if (b.members.length !== a.members.length) return b.members.length - a.members.length
      // 동점이면 최신 기사가 있는 묶음을 앞에 둔다
      const at = Math.max(...a.members.map(m => m.publishedAt.getTime()))
      const bt = Math.max(...b.members.map(m => m.publishedAt.getTime()))
      return bt - at
    })
    .slice(0, topN)
    .map(c => ({ representative: pickRepresentative(c.members), size: c.members.length }))
}
