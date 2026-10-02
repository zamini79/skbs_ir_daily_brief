import { describe, it, expect, vi } from 'vitest'
import type { NewsItem } from '@/providers/news/types'
import { INSTRUMENTS } from '../../prisma/instruments'
import { gatherInstrumentNews } from './instrumentNews'

/**
 * collect.ts 의 뉴스 루프가 부르는 판단 전부. collect.ts 는 Prisma 를 끌어와 테스트가
 * import 하지 못하므로, 배선이 지워지면 **여기서** 빨개져야 한다.
 */

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

function seed(name: string) {
  const s = INSTRUMENTS.find(i => i.name === name)!
  return { name: s.name, quoteSymbol: s.quoteSymbol, newsQuery: s.newsQuery, newsAliases: s.newsAliases ?? '' }
}

const NOW = new Date('2026-10-02T08:30:00+09:00')
const SP500 = seed('S&P500')
const NASDAQ = seed('Nasdaq')
const KOSPI = seed('KOSPI')
const CELLTRION = seed('셀트리온')

/** 실측(2026-10-02) 제목. 별칭(S&P500 …)이 없다 — 기본 검색 경로였다면 버려진다. */
const NYSE_WRAP = item('美국채 금리 따라 등락 반복한 뉴욕증시…강보합 마감(종합)', '2026-10-02T06:10:00')
const SP_A = item('S&P500 선물, 엔비디아 실적 호조에 상승', '2026-10-02T07:00:00', { url: 'https://a/1', publisher: 'a' })
const SP_B = item('S&P 500 편입 종목 교체 발표', '2026-10-02T07:20:00', { url: 'https://a/2', publisher: 'a' })
const SP_C = item('스탠더드앤드푸어스 신용등급 유지', '2026-10-02T07:30:00', { url: 'https://a/3', publisher: 'a' })

function searchBy(table: Record<string, NewsItem[] | Error>) {
  return vi.fn(async (query: string) => {
    const v = table[query]
    if (v instanceof Error) throw v
    return v ?? []
  })
}

describe('공유 행(Nasdaq)은 검색하지 않는다', () => {
  it('search 를 한 번도 부르지 않고 shared 를 준다', async () => {
    const search = searchBy({})
    const out = await gatherInstrumentNews(NASDAQ, 3, { search, now: NOW })
    expect(out).toEqual({ kind: 'shared' })
    expect(search).not.toHaveBeenCalled()
  })
})

describe('S&P500 — 우선 기사', () => {
  it('기본 검색 다음에 「뉴욕증시 종합」 을 같은 작업 안에서 이어 부른다', async () => {
    const search = searchBy({ 뉴욕증시: [SP_A], '뉴욕증시 종합': [NYSE_WRAP] })
    await gatherInstrumentNews(SP500, 3, { search, now: NOW })
    expect(search.mock.calls.map(c => c[0])).toEqual(['뉴욕증시', '뉴욕증시 종합'])
  })

  it('찾으면 별칭 필터를 우회해 rank 1 이고 나머지가 2..3 이다', async () => {
    const search = searchBy({ 뉴욕증시: [SP_A, SP_B, SP_C], '뉴욕증시 종합': [NYSE_WRAP] })
    const out = await gatherInstrumentNews(SP500, 3, { search, now: NOW })
    if (out.kind !== 'ok') throw new Error(out.kind)
    expect(out.priority).toEqual({ status: 'found', title: NYSE_WRAP.title })
    expect(out.clusters.map(c => c.representative)).toHaveLength(3)
    expect(out.clusters[0].representative).toBe(NYSE_WRAP)
  })

  it('기본 검색 결과에 같은 기사가 섞여 와도 두 번 싣지 않는다', async () => {
    const dupInMain = { ...NYSE_WRAP, title: `${NYSE_WRAP.title} S&P500` }
    const search = searchBy({ 뉴욕증시: [dupInMain, SP_A], '뉴욕증시 종합': [NYSE_WRAP] })
    const out = await gatherInstrumentNews(SP500, 3, { search, now: NOW })
    if (out.kind !== 'ok') throw new Error(out.kind)
    expect(out.clusters.filter(c => c.representative.url === NYSE_WRAP.url)).toHaveLength(1)
  })

  it('못 찾으면 not-found 이고 기존 순위 그대로다 — 정상 상태다', async () => {
    const search = searchBy({ 뉴욕증시: [SP_A, SP_B], '뉴욕증시 종합': [] })
    const out = await gatherInstrumentNews(SP500, 3, { search, now: NOW })
    if (out.kind !== 'ok') throw new Error(out.kind)
    expect(out.priority).toEqual({ status: 'not-found' })
    expect(out.clusters.map(c => c.representative.url).sort()).toEqual(['https://a/1', 'https://a/2'])
  })

  it('우선 검색이 실패하면 failed 로 갈라 주고, 행 뉴스는 기본 검색 결과로 남는다', async () => {
    const search = searchBy({ 뉴욕증시: [SP_A], '뉴욕증시 종합': new Error('naver news HTTP 429') })
    const out = await gatherInstrumentNews(SP500, 3, { search, now: NOW })
    if (out.kind !== 'ok') throw new Error(out.kind)
    expect(out.priority).toEqual({ status: 'failed', error: 'naver news HTTP 429' })
    expect(out.clusters.map(c => c.representative)).toEqual([SP_A])
  })

  it('기본 검색이 실패하면 우선 검색은 하지 않는다 — 행은 조회 실패로 남는다', async () => {
    const search = searchBy({ 뉴욕증시: new Error('naver news HTTP 429'), '뉴욕증시 종합': [NYSE_WRAP] })
    const out = await gatherInstrumentNews(SP500, 3, { search, now: NOW })
    expect(out).toEqual({ kind: 'failed', error: 'naver news HTTP 429' })
    expect(search).toHaveBeenCalledTimes(1)
  })
})

describe('KOSPI — 마켓뷰', () => {
  it('당일 [마켓뷰] 가 rank 1 이다', async () => {
    const mv = item("[마켓뷰] 마이크론 호실적에 반등한 코스피, '7천피' 탈환하나", '2026-10-02T08:02:00')
    const other = item('코스피, 외국인 매수에 상승 출발', '2026-10-02T09:01:00', { url: 'https://b/1', publisher: 'b' })
    const search = searchBy({ 코스피: [other], 마켓뷰: [mv] })
    const out = await gatherInstrumentNews(KOSPI, 3, { search, now: NOW })
    if (out.kind !== 'ok') throw new Error(out.kind)
    expect(out.clusters[0].representative).toBe(mv)
    expect(out.clusters[1].representative).toBe(other)
  })
})

describe('규칙이 없는 행', () => {
  it('검색을 한 번만 하고 priority 는 none 이다', async () => {
    const a = item('셀트리온, 신약 허가', '2026-10-02T07:00:00', { url: 'https://c/1', publisher: 'c' })
    const search = searchBy({ 셀트리온: [a] })
    const out = await gatherInstrumentNews(CELLTRION, 3, { search, now: NOW })
    expect(search).toHaveBeenCalledTimes(1)
    if (out.kind !== 'ok') throw new Error(out.kind)
    expect(out.priority).toEqual({ status: 'none' })
    expect(out.clusters.map(c => c.representative)).toEqual([a])
  })

  it('topN 을 넘기지 않는다', async () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      item(`셀트리온 소식 ${'가나다라마바'[i]}${i} 독립 제목 ${i}${i}`, '2026-10-02T07:00:00', {
        url: `https://c/${i}`,
        publisher: 'c',
      }),
    )
    const out = await gatherInstrumentNews(CELLTRION, 3, { search: searchBy({ 셀트리온: many }), now: NOW })
    if (out.kind !== 'ok') throw new Error(out.kind)
    expect(out.clusters.length).toBeLessThanOrEqual(3)
  })
})
