import { describe, it, expect } from 'vitest'
import type { NewsItem } from '@/providers/news/types'
import { topClusters } from './cluster'
import { buildStatusDetail, computeRunStatus } from './collectHelpers'
import {
  PRIORITY_NEWS_RULES,
  isYonhap,
  pickKospiMarketView,
  pickNyseWrap,
  priorityNewsRuleFor,
  selectRowClusters,
} from './priorityNews'

/** KST 시각 문자열로 기사를 만든다. publisher 기본값은 연합뉴스(yna.co.kr). */
function item(title: string, kst: string, opts: Partial<NewsItem> = {}): NewsItem {
  return {
    title,
    url: opts.url ?? `https://www.yna.co.kr/view/${encodeURIComponent(title)}`,
    naverUrl: opts.naverUrl ?? null,
    publisher: opts.publisher ?? 'yna.co.kr',
    publishedAt: new Date(`${kst}+09:00`),
    description: '',
  }
}

/*
 * 아래 제목·시각은 2026-10-02 11:32 KST 에 네이버 검색 API 로 직접 확인한 값이다
 * (task-41-brief.md 의 「실측」). 지어낸 제목이 아니다.
 */
const NYSE_WRAP = item('美국채 금리 따라 등락 반복한 뉴욕증시…강보합 마감(종합)', '2026-10-02T06:10:00')
const NYSE_FLASH = item('美국채 금리 따라 등락 반복한 뉴욕증시…강보합 마감', '2026-10-02T05:22:00')
const BOND_WRAP = item('美 10년물 5.34% 최고치 경신…글로벌 국채 투매 심화(종합)', '2026-10-02T08:02:00')

const MV_TODAY = item("[마켓뷰] 마이크론 호실적에 반등한 코스피, '7천피' 탈환하나", '2026-10-02T08:02:00')
const MV_D1 = item('[마켓뷰] 美금리 악재·마이크론 호실적…코스피 반등하나', '2026-10-01T08:01:00')
const MV_D2 = item('[마켓뷰] 美금리 악재 속 반도체주 상승…코스피 반등 시도하나', '2026-09-30T08:10:00')

/** 06:30 정기 수집, 08:30 담당자 재수집. */
const RUN_0630 = new Date('2026-10-02T06:30:00+09:00')
const RUN_0830 = new Date('2026-10-02T08:30:00+09:00')

describe('규칙 표', () => {
  it('S&P500(.INX) 과 KOSPI 에만 규칙이 있고, Nasdaq 에는 없다(뉴스를 공유한다)', () => {
    expect(Object.keys(PRIORITY_NEWS_RULES).sort()).toEqual(['.INX', 'KOSPI'])
    expect(priorityNewsRuleFor('.INX')?.query).toBe('뉴욕증시 종합')
    expect(priorityNewsRuleFor('KOSPI')?.query).toBe('마켓뷰')
    expect(priorityNewsRuleFor('.IXIC')).toBeNull()
    expect(priorityNewsRuleFor('302440')).toBeNull()
  })

  it('연합뉴스 판정은 originallink 호스트 기준이다', () => {
    expect(isYonhap({ publisher: 'yna.co.kr' })).toBe(true)
    expect(isYonhap({ publisher: 'm.yna.co.kr' })).toBe(true)
    expect(isYonhap({ publisher: 'news1.kr' })).toBe(false)
    // 접미사만 같은 다른 호스트를 연합뉴스로 보지 않는다.
    expect(isYonhap({ publisher: 'fakeyna.co.kr' })).toBe(false)
  })
})

describe('pickNyseWrap — 연합뉴스 「뉴욕증시 종합」', () => {
  it('실측 결과에서 당일 06:10 (종합) 을 고른다', () => {
    expect(pickNyseWrap([NYSE_FLASH, BOND_WRAP, NYSE_WRAP], RUN_0830)).toBe(NYSE_WRAP)
  })

  it('「마감」 이 없는 (종합) 제목도 고른다 — 브리프 예시 제목', () => {
    // 이 제목에는 「마감」이 없다. (종합) 우선 단계가 사라지면 마감 폴백이 이걸 고르지
    // 못해 null 이 된다. 위 실측 제목은 「마감」을 함께 담고 있어 그 회귀를 못 잡는다.
    const wrap = item('美국채 금리 고공행진에 뉴욕증시 약보합…다우 0.3%↓(종합)', '2026-10-02T06:10:00')
    expect(pickNyseWrap([wrap], RUN_0830)).toBe(wrap)
  })

  it('06:10 (종합) 과 그보다 늦은 「…마감」(비종합)이 함께 있으면 (종합) 을 고른다', () => {
    // 「최신」만 보면 06:40 마감판이 이긴다. (종합) 이 먼저라는 단계를 고정한다.
    const wrap = item('美국채 금리 고공행진에 뉴욕증시 약보합…다우 0.3%↓(종합)', '2026-10-02T06:10:00')
    const lateFlash = item('뉴욕증시, 국채금리 고공행진에 약보합 마감', '2026-10-02T06:40:00')
    expect(pickNyseWrap([lateFlash, wrap], RUN_0830)).toBe(wrap)
  })

  it('(종합) 이 아직 없으면 「마감」 속보판으로 폴백한다', () => {
    expect(pickNyseWrap([NYSE_FLASH, BOND_WRAP], RUN_0830)).toBe(NYSE_FLASH)
  })

  it('뉴욕증시 기사가 아닌 (종합) 은 제외한다', () => {
    expect(pickNyseWrap([BOND_WRAP], RUN_0830)).toBeNull()
  })

  it('타 언론사의 뉴욕증시 종합은 고르지 않는다', () => {
    const other = item('뉴욕증시, 국채금리 부담에도 강보합 마감(종합)', '2026-10-02T06:20:00', {
      publisher: 'news1.kr',
      url: 'https://www.news1.kr/x',
    })
    expect(pickNyseWrap([other], RUN_0830)).toBeNull()
    expect(pickNyseWrap([other, NYSE_WRAP], RUN_0830)).toBe(NYSE_WRAP)
  })

  it('전날 기사와 당일 04:00 이전 기사는 고르지 않는다', () => {
    const yesterday = item('뉴욕증시, 혼조 마감(종합)', '2026-10-01T06:10:00')
    const lateNight = item('뉴욕증시, 금리 주시 속 혼조 출발…장중 마감 앞두고(종합)', '2026-10-02T01:30:00')
    expect(pickNyseWrap([yesterday, lateNight], RUN_0830)).toBeNull()
  })

  it('「마감」 도 「(종합)」 도 없는 장중 시황은 고르지 않는다', () => {
    const intraday = item('뉴욕증시, 국채금리 급등에 하락 출발', '2026-10-02T04:40:00')
    expect(pickNyseWrap([intraday], RUN_0830)).toBeNull()
  })

  it('(종합) 이 여럿이면 최신 판을 고른다 — (종합2보) 도 종합이다', () => {
    const second = item('美국채 금리 따라 등락 반복한 뉴욕증시…강보합 마감(종합2보)', '2026-10-02T07:05:00')
    expect(pickNyseWrap([NYSE_WRAP, second, NYSE_FLASH], RUN_0830)).toBe(second)
  })
})

describe('pickKospiMarketView — 연합뉴스 「[마켓뷰]」', () => {
  it('실측 사흘치에서 당일 것을 고른다', () => {
    expect(pickKospiMarketView([MV_D2, MV_TODAY, MV_D1], RUN_0830)).toBe(MV_TODAY)
  })

  it('당일 마켓뷰가 아직 없으면 전날 것을 쓰지 않는다 (06:30 정기 수집)', () => {
    expect(pickKospiMarketView([MV_D1, MV_D2], RUN_0630)).toBeNull()
  })

  it('타 언론사의 [마켓뷰] 는 고르지 않는다', () => {
    const other = item('[마켓뷰] 코스피, 외국인 매수에 상승 출발', '2026-10-02T08:05:00', {
      publisher: 'edaily.co.kr',
      url: 'https://www.edaily.co.kr/x',
    })
    expect(pickKospiMarketView([other], RUN_0830)).toBeNull()
  })

  it('제목이 [마켓뷰] 로 시작해야 한다 — 본문 중에 언급된 것은 아니다', () => {
    const mention = item('증권가 "[마켓뷰] 전망 엇갈려"', '2026-10-02T08:05:00')
    expect(pickKospiMarketView([mention], RUN_0830)).toBeNull()
  })
})

describe('selectRowClusters — 우선 기사를 rank 1 로, 같은 사건은 빼고 2..N', () => {
  const MARKET = { wantsMarketWrap: true }

  it('우선 기사가 없으면 기존 순위 그대로다', () => {
    const ranked = topClusters(
      [item('S&P500 선물 상승', '2026-10-02T07:00:00'), item('S&P 500 사상 최고', '2026-10-02T07:10:00')],
      Infinity,
      MARKET,
    )
    expect(selectRowClusters(ranked, null, 3)).toEqual(ranked.slice(0, 3))
  })

  it('우선 기사가 rank 1 이고, 같은 URL·같은 사건 묶음은 2..N 에서 빠진다', () => {
    const sameUrl = { ...NYSE_WRAP, title: '美국채 금리 따라 등락 반복한 뉴욕증시…강보합 마감(종합) S&P500' }
    const sameEvent = item('국채 금리 따라 등락 반복한 뉴욕증시…강보합 마감', '2026-10-02T06:30:00', {
      publisher: 'news1.kr',
      url: 'https://news1.kr/same-event',
    })
    const other1 = item('S&P500 선물, 엔비디아 실적 호조에 상승', '2026-10-02T07:00:00', { url: 'https://a/1' })
    const other2 = item('S&P 500 편입 종목 교체 발표', '2026-10-02T07:20:00', { url: 'https://a/2' })
    const other3 = item('스탠더드앤드푸어스 신용등급 유지', '2026-10-02T07:30:00', { url: 'https://a/3' })
    const ranked = topClusters([sameUrl, sameEvent, other1, other2, other3], Infinity, MARKET)

    const out = selectRowClusters(ranked, NYSE_WRAP, 3)
    expect(out).toHaveLength(3)
    expect(out[0].representative).toBe(NYSE_WRAP)
    expect(out[0].penalty).toBe(0)
    const restUrls = out.slice(1).map(c => c.representative.url)
    expect(restUrls).not.toContain(NYSE_WRAP.url)
    expect(restUrls).not.toContain('https://news1.kr/same-event')
    // 빠진 같은 사건 기사는 우선 기사의 보도 수에 더한다(같은 URL 은 한 번만).
    expect(out[0].size).toBe(2)
  })

  it('URL 이 다르고 기존 묶음과도 따로인, 우선 기사와만 닮은 기사도 같은 사건으로 뺀다 (jaccard 경로)', () => {
    // 우선 기사와는 유사도 0.7(임계값 0.5 이상)이지만, 다른 후보들과는 겹치는 낱말이 없어
    // 자기 혼자 묶음이 된다. URL·네이버 링크도 다르다 — 빠진다면 순전히 제목 유사도 때문이다.
    const lookalike = item('국채 금리 따라 등락 반복한 뉴욕증시…강보합 마감', '2026-10-02T06:30:00', {
      publisher: 'news1.kr',
      url: 'https://news1.kr/lookalike',
      naverUrl: 'https://n.news.naver.com/article/421/1',
    })
    const other1 = item('S&P500 선물, 엔비디아 실적 호조에 상승', '2026-10-02T07:00:00', { url: 'https://a/1' })
    const other2 = item('S&P 500 편입 종목 교체 발표', '2026-10-02T07:20:00', { url: 'https://a/2' })
    const ranked = topClusters([lookalike, other1, other2], Infinity, MARKET)
    // 전제 확인: 닮은 기사는 자기 혼자 묶음이다(다른 후보에 흡수돼 빠지는 것이 아니다).
    const own = ranked.find(c => c.members.includes(lookalike))!
    expect(own.members).toEqual([lookalike])

    const out = selectRowClusters(ranked, NYSE_WRAP, 3)
    expect(out[0].representative).toBe(NYSE_WRAP)
    expect(out.slice(1).map(c => c.representative.url).sort()).toEqual(['https://a/1', 'https://a/2'])
    expect(out.map(c => c.representative)).not.toContain(lookalike)
    expect(out).toHaveLength(3)
    expect(out[0].size).toBe(2)
  })

  it('남은 묶음이 모자라면 그만큼만 준다', () => {
    expect(selectRowClusters([], NYSE_WRAP, 3).map(c => c.representative)).toEqual([NYSE_WRAP])
  })
})

describe('우선 검색 실패 — 문장은 남고 배너 색은 그대로', () => {
  const clean = {
    quoteFailed: 0,
    summariesFailed: 0,
    candidatesCreated: 40,
    ytdBaseFailed: 0,
    newsFailed: 0,
    missingCurrencies: [],
  }

  it('statusDetail 에 한 줄로 적힌다', () => {
    const d = buildStatusDetail({ ...clean, priorityNewsFailed: 2 })
    expect(d).toContain('우선 기사')
    expect(d).toContain('2종목')
  })

  it('0 이면 아무것도 적지 않는다', () => {
    expect(buildStatusDetail({ ...clean, priorityNewsFailed: 0 })).toBeNull()
  })

  it('computeRunStatus 는 이 카운터를 받지 않는다 — 다른 실패가 없으면 READY 다', () => {
    // 입력 타입(RunStatusCounts)에 이 카운터가 없다는 것 자체가 보장이다. 여기서는 그 결과를 고정한다.
    expect(
      computeRunStatus({
        summariesFailed: 0,
        ytdBaseFailed: 0,
        newsFailed: 0,
        fxFailed: 0,
        quoteFailed: 0,
        newsRecordFailed: 0,
        summariesSkippedDeadline: 0,
      }),
    ).toBe('READY')
  })
})
