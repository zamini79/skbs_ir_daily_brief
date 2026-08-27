import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchLseQuote } from './lse'
import { classifyQuoteFailure } from './retry'
import { changePct } from '@/domain/calc'

// 실측(2026-08-27 / 2026-08-28 재확인)한 사실만 픽스처로 굳힌다:
//   - 값은 JSON 숫자다(문자열이 아니다).
//   - `currency` 가 **GBX**(펜스)다. GBP 가 아니다.
//   - `lastclose` 1852, `netchange` -47.5, `percentualchange` -2.500658067912609.
//   - `tradingdate` 는 null 이다. `previousclose`·`closeprice` 도 (오면) null 이다.
//   - `lastclosedate` 는 현지 시각 문자열 "2026-08-27T15:35:27.000".
//   - 없는 티커는 HTTP 404 `{"message":"Not found instrument with tidm: ..."}`.

/**
 * 실측 응답. **우리가 안 읽는 필드도 그대로 둔다** — 무시하는지 확인해야 하므로.
 * `previousclose`·`closeprice`·`tradingdate` 가 null 인 것이 이 픽스처의 핵심이다.
 */
function gskResponse(over: Record<string, unknown> = {}) {
  return {
    description: 'GSK PLC ORD 31 1/4P',
    tidm: 'GSK',
    currency: 'GBX',
    // 그럴듯한 이름인데 전부 null 이다. 이걸 쓰면 전일대비가 통째로 사라진다.
    previousclose: null,
    closeprice: null,
    tradingdate: null,
    bid: 1851.5,
    offer: 1852,
    high: 1902,
    low: 1852,
    midPrice: 1858.25,
    openingprice: 1.89e3,
    specialconditions: 'XD',
    previousreferenceprice: 1899.5,
    netchange: -47.5,
    percentualchange: -2.500658067912609,
    lastprice: 1852,
    lastpricedate: '2026-08-27T15:53:41.000',
    lastclose: 1852,
    lastclosedate: '2026-08-27T15:35:27.000',
    marketcapitalization: 76842586618,
    ...over,
  }
}

function stubLse(body: unknown, status = 200) {
  const spy = vi.fn(async (_url: string, _init?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchLseQuote', () => {
  it('종가·전일종가·통화·기준일을 실측 응답에서 뽑는다', async () => {
    stubLse(gskResponse())
    const q = await fetchLseQuote('GSK')
    expect(q.close).toBe(1852)
    expect(q.prevClose).toBe(1899.5) // 1852 − (−47.5)
    expect(q.currency).toBe('GBX')
    expect(q.asOf).toBe('2026-08-27')
  })

  it('전일 종가는 lastclose − netchange 다 — 응답의 percentualchange 로 검산된다', async () => {
    // 이 검산이 "뺄셈 방향"을 고정한다. 부호를 반대로 하면 1804.5 가 나오고
    // 등락률이 +2.63% 로 반대 방향이 된다.
    stubLse(gskResponse())
    const q = await fetchLseQuote('GSK')
    const pct = changePct(q.close, q.prevClose)!
    expect(pct * 100).toBeCloseTo(-2.500658067912609, 6)
  })

  it('null 인 previousclose·closeprice·tradingdate 를 쓰지 않는다', async () => {
    // 이 세 필드를 쓰면 전일대비와 기준일이 통째로 사라진다. null 인 채로도
    // 값이 정상으로 나오는 것이 곧 "안 쓴다"는 증거다.
    stubLse(gskResponse())
    const q = await fetchLseQuote('GSK')
    expect(q.prevClose).toBe(1899.5)
    expect(q.asOf).toBe('2026-08-27')
  })

  it('previousclose·closeprice 에 엉뚱한 값이 들어와도 무시한다', async () => {
    // 언젠가 null 대신 값이 채워질 수 있다. 그때 조용히 그쪽으로 갈아타면
    // 우리 검산(percentualchange)과 어긋나는 날 이 행만 틀린다.
    stubLse(gskResponse({ previousclose: 1234, closeprice: 5678, tradingdate: '1999-01-01T00:00:00.000' }))
    const q = await fetchLseQuote('GSK')
    expect(q.close).toBe(1852)
    expect(q.prevClose).toBe(1899.5)
    expect(q.asOf).toBe('2026-08-27')
  })

  it('previousreferenceprice 가 아니라 netchange 로 계산한다', async () => {
    // 오늘은 둘이 같았지만(1899.5) 배당락 조정 기준가라 어긋날 수 있다.
    // 어긋나게 만든 픽스처에서 어느 쪽을 쓰는지 드러난다.
    stubLse(gskResponse({ previousreferenceprice: 1800 }))
    const q = await fetchLseQuote('GSK')
    expect(q.prevClose).toBe(1899.5)
  })

  it('등락률은 응답에서 가져오지 않는다 — RawQuote 에 그 자리가 없다', async () => {
    // krx.ts 가 FLUC_RT 를 안 쓰는 것과 같은 이유: 반올림 규칙이 다르면 이 행만
    // 끝자리가 어긋난다. 등락률은 domain/calc.ts 가 전 종목 동일하게 계산한다.
    stubLse(gskResponse({ percentualchange: 99.9 }))
    const q = await fetchLseQuote('GSK')
    expect(Object.keys(q).sort()).toEqual(['asOf', 'close', 'currency', 'prevClose'])
    expect(changePct(q.close, q.prevClose)! * 100).toBeCloseTo(-2.5007, 3)
  })

  it('통화를 GBP 로 접지 않고 응답 그대로(GBX) 준다', async () => {
    // 접는 일은 collectHelpers.currencyMismatchReason 이 한다. 여기서 미리 접으면
    // 정말 다른 통화(예: USD ADR)로 바뀐 날에도 GBP 로 보여 검사가 무력해진다.
    stubLse(gskResponse())
    expect((await fetchLseQuote('GSK')).currency).toBe('GBX')
  })

  it('브라우저 User-Agent 로 부른다', async () => {
    const spy = stubLse(gskResponse())
    await fetchLseQuote('GSK')
    const init = spy.mock.calls[0][1] as RequestInit
    expect(String((init.headers as Record<string, string>)['User-Agent'])).toContain('Mozilla/5.0')
    expect(String(spy.mock.calls[0][0])).toContain('/instruments/alldata/GSK')
  })

  it('없는 티커(404)는 사유에 상태 코드와 본문 메시지를 함께 싣는다', async () => {
    stubLse({ message: 'Not found instrument with tidm: ZZZZNOPE' }, 404)
    await expect(fetchLseQuote('ZZZZNOPE')).rejects.toThrow(/HTTP 404/)
    await expect(fetchLseQuote('ZZZZNOPE')).rejects.toThrow(/Not found instrument/)
  })

  it('실패 메시지가 retry.ts 의 분류 규약을 따른다', async () => {
    // `... HTTP {status}` 형식이라야 classifyQuoteFailure 가 재시도 여부를 가른다.
    // 404 를 재시도하면 수집 창만 갉아먹고, 503 을 재시도 안 하면 하루치가 빈다.
    stubLse({ message: 'Not found' }, 404)
    const notFound = await fetchLseQuote('X').catch(e => e)
    expect(classifyQuoteFailure(notFound)).toBe('permanent')

    stubLse('', 503)
    const down = await fetchLseQuote('X').catch(e => e)
    expect(classifyQuoteFailure(down)).toBe('transient')

    stubLse('', 429)
    const limited = await fetchLseQuote('X').catch(e => e)
    expect(classifyQuoteFailure(limited)).toBe('rate-limit')
  })

  it('lastclose 가 없으면 실패한다 — 0 으로 둔갑하지 않는다', async () => {
    stubLse(gskResponse({ lastclose: null }))
    await expect(fetchLseQuote('GSK')).rejects.toThrow(/lastclose 파싱 실패/)
    stubLse(gskResponse({ lastclose: '' }))
    await expect(fetchLseQuote('GSK')).rejects.toThrow(/lastclose 파싱 실패/)
  })

  it('netchange 가 없으면 실패한다 — 전일 종가가 종가와 같아지지 않는다', async () => {
    // null 을 0 으로 읽으면 prevClose === close 가 되어 「보합」으로 그럴듯하게 찍힌다.
    stubLse(gskResponse({ netchange: null }))
    await expect(fetchLseQuote('GSK')).rejects.toThrow(/netchange 파싱 실패/)
  })

  it('lastclosedate 가 없거나 형식이 다르면 실패한다', async () => {
    stubLse(gskResponse({ lastclosedate: null }))
    await expect(fetchLseQuote('GSK')).rejects.toThrow(/lastclosedate 파싱 실패/)
    stubLse(gskResponse({ lastclosedate: '27/08/2026' }))
    await expect(fetchLseQuote('GSK')).rejects.toThrow(/lastclosedate 파싱 실패/)
  })

  it('통화가 없으면 실패한다', async () => {
    stubLse(gskResponse({ currency: null }))
    await expect(fetchLseQuote('GSK')).rejects.toThrow(/currency 없음/)
  })

  it('JSON 이 아닌 200 응답은 실패로 다룬다', async () => {
    stubLse('<html>maintenance</html>')
    await expect(fetchLseQuote('GSK')).rejects.toThrow(/JSON 이 아님/)
  })

  it('기준일은 문자열 앞 10자다 — Date 로 파싱해 KST 로 밀지 않는다', async () => {
    // 런던 15:35 를 Date 로 읽으면 KST 로는 다음 날 00:35 다. 그러면 거래일 라벨이
    // 하루 밀려 담당자가 "어제 값이 왜 오늘로 찍히지"를 보게 된다.
    stubLse(gskResponse({ lastclose: 100, netchange: 0.5, lastclosedate: '2026-12-31T16:30:00.000' }))
    expect((await fetchLseQuote('GSK')).asOf).toBe('2026-12-31')
  })
})
