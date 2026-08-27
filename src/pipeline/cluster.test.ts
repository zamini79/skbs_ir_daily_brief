import { describe, it, expect } from 'vitest'
import { normalizeTitle, jaccard, topClusters, filterByTitleMention } from './cluster'
import type { NewsItem } from '@/providers/news/types'

function item(title: string, opts: Partial<NewsItem> = {}): NewsItem {
  return {
    title,
    url: opts.url ?? `https://x.com/${encodeURIComponent(title)}`,
    naverUrl: opts.naverUrl ?? null,
    publisher: opts.publisher ?? 'x.com',
    publishedAt: opts.publishedAt ?? new Date('2026-08-27T06:00:00+09:00'),
    description: '',
  }
}

describe('normalizeTitle', () => {
  it('대괄호 말머리를 없앤다', () => {
    expect(normalizeTitle('[속보] 셀트리온 매출 증가')).toBe('셀트리온 매출 증가')
  })
  it('따옴표와 기호를 없앤다', () => {
    expect(normalizeTitle('셀트리온, "글로벌 톱3" 굳힌다…')).toBe('셀트리온 글로벌 톱3 굳힌다')
  })
  it('연속 공백을 하나로 줄인다', () => {
    expect(normalizeTitle('셀트리온   매출')).toBe('셀트리온 매출')
  })
})

describe('jaccard', () => {
  it('완전히 같으면 1이다', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1)
  })
  it('겹치지 않으면 0이다', () => {
    expect(jaccard(['a'], ['b'])).toBe(0)
  })
  it('절반 겹치면 1/3이다', () => {
    expect(jaccard(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3, 6)
  })
  it('둘 다 비면 0이다', () => {
    expect(jaccard([], [])).toBe(0)
  })
})

describe('topClusters', () => {
  it('많이 보도된 사건을 앞에 놓는다', () => {
    const items = [
      item('셀트리온 글로벌 톱3 굳힌다'),
      item('셀트리온, 글로벌 톱3 지위 굳힌다'),
      item('셀트리온 글로벌 톱3 굳힌다고 밝혀'),
      item('셀트리온 신규 공장 착공'),
    ]
    const r = topClusters(items, 3)
    expect(r[0].size).toBe(3)
    expect(r[1].size).toBe(1)
  })

  it('최대 topN 개만 준다', () => {
    const items = ['가나다 사건', '라마바 사건', '사아자 사건', '차카타 사건'].map(t => item(t))
    expect(topClusters(items, 3)).toHaveLength(3)
  })

  it('기사가 없으면 빈 배열을 준다', () => {
    expect(topClusters([], 3)).toEqual([])
  })

  it('대표 기사는 네이버뉴스 링크가 있는 쪽을 고른다', () => {
    const items = [
      item('셀트리온 글로벌 톱3 굳힌다'),
      item('셀트리온 글로벌 톱3 굳힌다 확정', { naverUrl: 'https://n.news.naver.com/1' }),
    ]
    const r = topClusters(items, 3)
    expect(r[0].representative.naverUrl).toContain('n.news.naver.com')
  })
})

describe('filterByTitleMention', () => {
  it('제목에 회사명이 있으면 남기고 없으면 뺀다', () => {
    const items = [
      item('삼성바이오로직스 파업 끝나나'),
      item('엔비디아 훈풍…코스피 7000선'),
    ]
    const r = filterByTitleMention(items, ['삼성바이오로직스'])
    expect(r).toHaveLength(1)
    expect(r[0].title).toBe('삼성바이오로직스 파업 끝나나')
  })

  it('공백 유무와 무관하게 매칭한다', () => {
    const items = [item('삼성 바이오 특허 등록')]
    const r = filterByTitleMention(items, ['삼성바이오'])
    expect(r).toHaveLength(1)
  })

  it('대소문자를 구분하지 않는다', () => {
    const items = [item('gsk 백신 부문 실적 발표')]
    const r = filterByTitleMention(items, ['GSK'])
    expect(r).toHaveLength(1)
  })

  it('여러 별칭 중 두번째만 맞아도 남긴다', () => {
    const items = [item('유바이오로직스 백신 임상 결과 발표')]
    const r = filterByTitleMention(items, ['잘못된별칭', '유바이오로직스'])
    expect(r).toHaveLength(1)
  })

  it('별칭이 비어 있으면 원본을 그대로 준다', () => {
    const items = [item('아무 상관 없는 기사')]
    expect(filterByTitleMention(items, [])).toEqual(items)
  })

  it('실제 실패 재현: 회사 기사 하나와 코스피 시황 기사들 중 회사 기사만 남는다', () => {
    const items = [
      item('삼성바이오로직스 파업 추석 전에 끝나나'),
      item('엔비디아 훈풍…코스피 7000선 돌파'),
      item('코스피, 금리 인상에 흔들렸지만 6900선대 강세'),
      item('엔비디아 효과…코스피 2%대 상승'),
    ]
    const r = filterByTitleMention(items, ['삼성바이오로직스'])
    expect(r).toHaveLength(1)
    expect(r[0].title).toBe('삼성바이오로직스 파업 추석 전에 끝나나')
  })

  it('인덱스 케이스: 별칭이 코스피면 코스피 시황 기사도 남는다', () => {
    const items = [
      item('코스피, 금리 인상에 흔들렸지만 6900선대 강세'),
      item('삼성바이오로직스 파업 추석 전에 끝나나'),
    ]
    const r = filterByTitleMention(items, ['코스피'])
    expect(r).toHaveLength(1)
    expect(r[0].title).toBe('코스피, 금리 인상에 흔들렸지만 6900선대 강세')
  })

  describe('Lonza(론자) — "-론자"(-論者) 접미사 오매칭', () => {
    const LONZA_ALIASES = ['론자', 'Lonza']

    // 실제 재현 사례(2026-08-27 실행). "…없다'론자"는 "'중도는 없다'는 주장을
    // 하는 사람"이라는 뜻의 정치 기사이지 Lonza 기사가 아니다.
    it('실패 재현 1: 절 종결어미(다) + 인용부호 + 론자는 매칭하지 않는다', () => {
      const items = [item('김민석 "鄭은 \'중도는 없다\'론자"…정청래 "무례하고 폭력적인 마이크"')]
      expect(filterByTitleMention(items, LONZA_ALIASES)).toHaveLength(0)
    })

    it('실패 재현 2: 같은 접미사 패턴의 다른 정치 기사도 매칭하지 않는다', () => {
      const items = [item('김민석 "정청래는 \'중도 없다\'론자 … 당원 선택은 민생·실용·확장"')]
      expect(filterByTitleMention(items, LONZA_ALIASES)).toHaveLength(0)
    })

    // 음성 케이스만으로는 "론자를 통째로 버린다"는 구현도 테스트를 통과한다 —
    // 그게 이 작업의 핵심 함정이므로 실제 Lonza 기사 제목을 양성 픽스처로 반드시 넣는다.
    // 아래 다섯 개는 네이버/경제지 실제 기사 제목이다.
    it.each([
      '론자 등 CDMO 고래들,세포유전자치료제 승부수...매출1조 넘은 SK팜테코 전략은',
      '세계 1위 CDMO 기업 론자, 대대적 시설투자 단행',
      '론자, 캡슐·건기식 원료 사업 3.2조원에 론스타 매각…\'순수 CDMO 기업\' 전환',
      '세계 1위 CDMO 론자, 美 바이오의약품 공장 12억 달러에 인수',
    ])('실제 Lonza 기사는 그대로 매칭한다: %s', title => {
      expect(filterByTitleMention([item(title)], LONZA_ALIASES)).toHaveLength(1)
    })

    // 뒤쪽(trailing)에 조사가 공백 없이 바로 붙는 정상적인 경우 — 이걸 막아 버리면
    // 진짜 Lonza 기사까지 함께 떨어진다. hasGenuineMention 이 뒤쪽은 보지 않는 이유.
    it('뒤에 조사(는)가 공백 없이 바로 붙어도 매칭한다', () => {
      const items = [item('다가온 CDMO 시대…론자는 어떻게 K-바이오의 \'워너비 기업\' 됐나[비즈니스 포커스]')]
      expect(filterByTitleMention(items, LONZA_ALIASES)).toHaveLength(1)
    })

    it('앞이 인용부호 없이 곧바로 "다"여도(중간에 따옴표가 없어도) 버린다', () => {
      // "있다론자" — 인용부호가 아예 없는 경우도 같은 규칙으로 잡혀야 한다.
      const items = [item('그는 여전히 냉전이 끝나지 않았다론자 취급을 받는다')]
      expect(filterByTitleMention(items, LONZA_ALIASES)).toHaveLength(0)
    })

    // H-2 회귀 재현: "다"로 끝나는 어절 뒤에 진짜 공백을 두고 별칭이 오는 정상
    // 제목. filterByTitleMention이 매칭 전에 공백을 전부 지워버리면, 이 진짜
    // 공백(어절 경계)이 "다"+"론자" 접미사 패턴과 구분되지 않아 통째로 걸러졌다.
    // Lonza 전용 결함이 아니었다는 것도 함께 검증한다 — 화이자/셀트리온/모더나/
    // 녹십자처럼 "다"로 끝나는 흔한 어절 뒤에 오는 다른 짧은 별칭도 실제로
    // 걸렸었다(2026-08-27 실행에서 실측).
    it('실제 Lonza 기사: "다" 로 끝나는 어절 뒤에 공백을 두고 와도 매칭한다', () => {
      const items = [item('삼성바이오로직스 제쳤다 론자 1위 탈환')]
      expect(filterByTitleMention(items, LONZA_ALIASES)).toHaveLength(1)
    })
    it('화이자: "다" 로 끝나는 어절 뒤에 공백을 두고 와도 매칭한다', () => {
      const items = [item('영업이익 늘었다 화이자 3분기')]
      expect(filterByTitleMention(items, ['화이자'])).toHaveLength(1)
    })
    it('셀트리온: "다" 로 끝나는 어절 뒤에 공백을 두고 와도 매칭한다', () => {
      const items = [item('CDMO 시장 커진다 셀트리온도 참전')]
      expect(filterByTitleMention(items, ['셀트리온'])).toHaveLength(1)
    })
    it('모더나: "다" 로 끝나는 어절 뒤에 공백을 두고 와도 매칭한다', () => {
      const items = [item('백신 공급 확대한다 모더나와 계약')]
      expect(filterByTitleMention(items, ['모더나'])).toHaveLength(1)
    })
    it('녹십자: "다" 로 끝나는 어절 뒤에 공백을 두고 와도 매칭한다', () => {
      const items = [item('실적 개선됐다 녹십자, 흑자 전환')]
      expect(filterByTitleMention(items, ['녹십자'])).toHaveLength(1)
    })
  })

  // 다른 짧은 한글 별칭(머크, 삼바, 녹십자)이 이번 변경으로 회귀하지 않는지 확인한다.
  // hasGenuineMention은 "바로 앞이 다인 경우"만 버리므로, 그 조건에 해당하지 않는
  // 정상적인 문맥에서는 여전히 부분문자열 포함과 동일하게 동작해야 한다.
  describe('짧은 별칭 회귀 방지', () => {
    it('머크: 정상 문맥에서 그대로 매칭한다', () => {
      expect(filterByTitleMention([item('머크, 항암제 임상 3상 성공')], ['머크'])).toHaveLength(1)
    })
    it('삼바: 정상 문맥에서 그대로 매칭한다', () => {
      expect(filterByTitleMention([item('삼바 4공장 가동률 상승')], ['삼바'])).toHaveLength(1)
    })
    it('녹십자: 정상 문맥에서 그대로 매칭한다', () => {
      expect(filterByTitleMention([item('녹십자, 독감 백신 출하 시작')], ['녹십자'])).toHaveLength(1)
    })
  })
})

describe('topClusters — 전이적 유사도 (모든 멤버와 비교)', () => {
  // 토큰 집합을 의도적으로 구성한다:
  //   A = {aa, bb, cc}
  //   B = {bb, cc, dd}
  //   C = {cc, dd, ee}
  // J(A,B) = |{bb,cc}| / |{aa,bb,cc,dd}|       = 2/4 = 0.5  (임계값 이상 → 유사)
  // J(B,C) = |{cc,dd}| / |{bb,cc,dd,ee}|       = 2/4 = 0.5  (임계값 이상 → 유사)
  // J(A,C) = |{cc}|     / |{aa,bb,cc,dd,ee}|   = 1/5 = 0.2  (임계값 미만 → 비유사)
  // 창설 멤버(A)하고만 비교하면 C 는 새 묶음이 되어 버린다. 모든 멤버와 비교해야
  // B 를 매개로 A-B-C 가 하나의 사건으로 묶인다.
  const A = 'aa bb cc'
  const B = 'bb cc dd'
  const C = 'cc dd ee'

  it('A, B, C 순서로 들어와도 하나의 묶음이 된다', () => {
    const items = [item(A), item(B), item(C)]
    const r = topClusters(items, 3)
    expect(r).toHaveLength(1)
    expect(r[0].size).toBe(3)
  })

  it('C, B, A 역순으로 들어와도 하나의 묶음이 된다 (순서에 무관하다)', () => {
    const items = [item(C), item(B), item(A)]
    const r = topClusters(items, 3)
    expect(r).toHaveLength(1)
    expect(r[0].size).toBe(3)
  })

  it('서로 무관한 두 제목은 여전히 별개의 묶음이 된다', () => {
    const items = [item('ff gg hh'), item('ii jj kk')]
    const r = topClusters(items, 3)
    expect(r).toHaveLength(2)
    expect(r[0].size).toBe(1)
    expect(r[1].size).toBe(1)
  })

  it('병합 후 묶음 크기는 실제 멤버 수와 같다 (검토자에게 보이는 숫자)', () => {
    const items = [item(A), item(B), item(C)]
    const r = topClusters(items, 3)
    expect(r[0].size).toBe(3)
  })
})
