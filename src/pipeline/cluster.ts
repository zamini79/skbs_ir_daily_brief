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
 * ─── 뉴스 후보 감점 ────────────────────────────────────────────────────────
 *
 * **버리는 필터가 아니라 감점이다. 후보를 제거하지 않고 뒤로만 민다.**
 *
 * 이 코드베이스가 네 번 반복해서 맞은 결함은 "실패·누락을 정상적인 공란으로 렌더하는
 * 것"이었다. 하드 필터는 그 실패 모드를 그대로 되살린다 — 패턴이 과하게 걸려 후보가
 * 0건이 되면 화면은 「당일·D-1 기사 없음」이라고 **단정**한다(repo.ts 의 NO_NEWS).
 * 실제로는 기사가 있었는데 우리가 지운 것인데도 그렇다. 그 단정을 되돌릴 방법이
 * 화면에는 없다. 감점은 그 경로를 아예 만들지 않는다 — 후보 수는 감점 규칙과 무관하게
 * 늘 그대로이고, 규칙이 틀려도 최악의 결과는 "순서가 나쁘다"이지 "없다고 거짓말한다"가
 * 아니다. **여기를 필터로 바꾸지 마라.**
 *
 * 감점 대상은 전부 라이브 실측(2026-08-27)에서 실제로 상위를 차지한 제목에서 뽑았다.
 * 각 규칙 위 주석의 예가 그 제목이다.
 *
 * 제목만 보고 판정한다. 본문 크롤링은 이 단계보다 뒤(collect.ts step 6)에 있고
 * 비용도 크므로 순위 결정에 쓸 수 없다.
 */

/** 감점 단계. 클수록 뒤로 밀린다. 같은 단계 안에서는 기존 규칙(묶음 크기)이 그대로다. */
export const NEWS_PENALTY = {
  NONE: 0,
  /** 증시 시황 종합. 가장 약한 감점 — 그날 그 회사가 실제로 크게 움직였으면 시황
   *  기사에 그 사실이 들어 있을 수 있다. 진짜 기업 뉴스가 있으면 그 뒤로 밀리되,
   *  없으면 여전히 1순위가 될 수 있어야 한다. */
  MARKET_WRAP: 1,
  /** 구조적으로 IR 뉴스가 아닌 장르(브랜드평판 집계·광고 회고·수급표·종목추천·사진).
   *  그날 무슨 일이 있었든 이 장르는 IR 브리프에 실을 내용이 없다. */
  NON_NEWS: 2,
  /** 자동생성 주가 기사. 거의 항상 무가치하다 — 담고 있는 정보(종가·등락률)가
   *  같은 행의 시세 칸에 이미 숫자로 들어 있다. 그래서 가장 크게 감점한다. */
  AUTO_QUOTE: 3,
} as const

type PenaltyRule = {
  /** 어떤 규칙이 걸렸는지 테스트·디버깅에서 알아보기 위한 이름 */
  name: string
  penalty: number
  /**
   * true 면 **지수(Index) 행에서는 이 규칙을 적용하지 않는다.**
   * 시황과 수급은 개별 기업 행에서는 잡음이지만 지수 행에서는 바로 그 지수의 뉴스다.
   * KOSPI·S&P500·Nasdaq 행이 지금 잘 뽑고 있는 1순위가 전부 시황 기사이므로,
   * 이 구분을 빠뜨리면 잘 되던 3행을 한꺼번에 망가뜨리는 회귀가 된다.
   */
  indexExempt: boolean
  patterns: RegExp[]
}

/**
 * 담당자 인터뷰 후 조정될 값이라 한곳에 모아 둔다. 규칙을 늘리거나 무게를 바꿀 때
 * 이 배열만 고치면 되게 하는 것이 목적이다.
 */
const PENALTY_RULES: PenaltyRule[] = [
  {
    // 에이비엘바이오 주가, 8월 27일 장중 76,500원 2.55% 상승
    // 한미약품 주가, 8월 27일 504,000원 4.91% 하락 마감
    // 에이비엘바이오, 장초반 1%대 상승…최근 교차 흐름 속 7만5000원대
    //
    // 지수 행에서도 감점이다(지수의 자동생성 기사에도 값이 없다) — indexExempt: false.
    name: 'auto-quote',
    penalty: NEWS_PENALTY.AUTO_QUOTE,
    indexExempt: false,
    patterns: [
      /주가[,\s]+\d{1,2}\s*월\s*\d{1,2}\s*일/,          // "주가, 8월 27일"
      /[\d,]+\s*원\s*\d+(?:\.\d+)?\s*%/,                 // "76,500원 2.55%"
      /(?:장중|장초반|장중반|장후반|장마감|개장|시초가)[^%]{0,20}\d+(?:\.\d+)?\s*%대?\s*(?:상승|하락|강세|약세|보합)/,
      /\d+\s*만\s*[\d,]*\s*원대/,                        // "7만5000원대"
    ],
  },
  {
    // 생물공학 상장기업 브랜드평판 8월 빅데이터 분석결과…1위 알테오젠
    name: 'brand-ranking',
    penalty: NEWS_PENALTY.NON_NEWS,
    indexExempt: false,
    patterns: [/브랜드\s*평판/, /평판\s*지수/, /빅데이터\s*분석/],
  },
  {
    // [광고로 읽는 시대]한국화이자 '모리민'  ← 1974년 광고를 회고하는 연재 칼럼
    // 대괄호 말머리 안에 '광고'가 든 것만 본다. 본문 중의 '광고'(예: "…광고 규제 강화")는
    // 진짜 뉴스일 수 있으므로 건드리지 않는다.
    name: 'ad-column',
    penalty: NEWS_PENALTY.NON_NEWS,
    indexExempt: false,
    patterns: [/\[[^\]]*광고[^\]]*\]/],
  },
  {
    // [포토] 코스피, 삼성전자·SK하이닉스 상승에 6900선 회복
    name: 'photo',
    penalty: NEWS_PENALTY.NON_NEWS,
    indexExempt: false,
    patterns: [/\[\s*(?:포토|사진)[^\]]*\]/],
  },
  {
    // [헬로스톡] 8/27 주목할 종목 : 인바디·SK바이오팜·SK이노베이션
    // 종목 나열형 추천물. 지수 행에서도 개별 종목 나열일 뿐이라 예외를 두지 않는다.
    name: 'stock-pick',
    penalty: NEWS_PENALTY.NON_NEWS,
    indexExempt: false,
    patterns: [/주목할\s*종목/, /관심\s*종목/, /추천\s*종목/, /오늘의\s*종목/],
  },
  {
    // [코스닥 외국인] 대한광통신 에코프로 알테오젠 집중 매수
    //
    // 수급은 시황과 같은 성격이다 — 개별 기업 행에서는 "누가 샀나" 표에 이름이 한 번
    // 나온 것일 뿐이지만, 지수 행에서는 그 지수의 수급 자체가 뉴스다. 그래서 예외다.
    name: 'flow',
    penalty: NEWS_PENALTY.NON_NEWS,
    indexExempt: true,
    patterns: [/\[[^\]]*(?:외국인|기관|개인)[^\]]*\]/, /순매수/, /순매도/, /집중\s*매[수도]/],
  },
  {
    // 미국증시 다우 '연일 상승'..머크·엔비디아·GS '뛰고', 나이키 '뚝'
    // [美증시] 암 백신 모더나 14% 또 폭등…머크·화이자도 동반 상승
    //
    // 지수명이 제목에 있으면 시황으로 본다. "알테오젠, 코스피 이전상장" 같은 진짜
    // 뉴스가 걸리는 오탐이 있을 수 있으나, 감점은 한 단계 뒤로 미는 것뿐이고
    // 무감점 후보가 없으면 여전히 1순위로 남는다 — 버리는 필터였다면 못 할 타협이다.
    name: 'market-wrap',
    penalty: NEWS_PENALTY.MARKET_WRAP,
    indexExempt: true,
    patterns: [/증시/, /시황/, /코스피/, /코스닥/, /나스닥/, /다우지수/, /다우존스/, /항셍/, /닛케이/, /S&P\s*500/i],
  },
]

/**
 * 제목 하나의 감점을 매긴다. 순수 함수다 — 클러스터링과 섞지 않는 이유가 이것이다
 * (규칙 하나하나를 클러스터를 만들지 않고 직접 테스트할 수 있어야 한다).
 *
 * 여러 규칙에 걸리면 **합이 아니라 최댓값**을 쓴다. 감점 단계는 "이 제목이 어떤
 * 장르인가"를 뜻하는 것이지 누적 점수가 아니다. 합으로 하면 약한 규칙 두 개에 걸린
 * 제목이 자동생성 주가 기사와 같은 자리로 밀려나 단계의 뜻이 흐려진다.
 */
export function newsPenalty(title: string, opts: { isIndex: boolean }): number {
  let worst: number = NEWS_PENALTY.NONE
  for (const rule of PENALTY_RULES) {
    if (opts.isIndex && rule.indexExempt) continue
    if (rule.patterns.some(p => p.test(title))) {
      if (rule.penalty > worst) worst = rule.penalty
    }
  }
  return worst
}

/**
 * 제목 유사도로 묶은 뒤 묶음 크기(=보도 빈도) 상위 topN 개를 반환한다.
 * 탐욕적 클러스터링이다. 기사 100건 규모에서는 충분하고 결과가 안정적이다.
 *
 * 새 기사는 묶음의 창설 멤버가 아니라 "모든" 멤버와 비교한다. 창설 멤버하고만
 * 비교하면 A~B, B~C 는 임계값을 넘는데 A~C 는 못 넘는 전이적 유사도 상황에서
 * 도착 순서에 따라 같은 사건이 두 묶음으로 쪼개질 수 있다 — 묶음 크기(=보도
 * 빈도)가 실제보다 적게 표시되는 결과로 이어진다.
 *
 * 순위는 **감점 오름차순 → 묶음 크기 내림차순 → 최신순**이다. 묶음 크기 하나로만
 * 정렬하면 (a) 큰 뉴스가 없는 날은 전부 1개 매체라 순위가 사실상 무작위이고,
 * (b) 홍보성 보도자료가 여러 매체에 동시 배포되면 진짜 뉴스를 밀어낸다. 감점은
 * 후보를 **버리지 않고 뒤로만 민다** — 이유는 newsPenalty 주석 참고.
 *
 * opts.isIndex 를 그대로 newsPenalty 로 넘긴다. 이 값이 없으면 시황·수급 기사가
 * 지수 3행에서도 감점되어 지금 잘 뽑히는 1순위가 전부 엉뚱한 것으로 바뀐다.
 * 그래서 기본값을 두지 않고 호출부가 반드시 정하게 한다.
 */
export function topClusters(
  items: NewsItem[],
  topN: number,
  opts: { isIndex: boolean },
): Array<{ representative: NewsItem; size: number; penalty: number }> {
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

  // 감점은 **대표 기사의 제목**으로 매긴다 — 화면에 뜨는 것이 그 제목이기 때문이다.
  // 그래서 정렬보다 먼저 대표를 고른다(예전에는 slice 뒤에 골랐다).
  return clusters
    .map(c => {
      const representative = pickRepresentative(c.members)
      return {
        representative,
        size: c.members.length,
        penalty: newsPenalty(representative.title, opts),
        latest: Math.max(...c.members.map(m => m.publishedAt.getTime())),
      }
    })
    .sort((a, b) => {
      if (a.penalty !== b.penalty) return a.penalty - b.penalty
      if (b.size !== a.size) return b.size - a.size
      // 동점이면 최신 기사가 있는 묶음을 앞에 둔다
      return b.latest - a.latest
    })
    .slice(0, topN)
    .map(({ representative, size, penalty }) => ({ representative, size, penalty }))
}
