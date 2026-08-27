import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchSixQuote } from './six'
import { classifyQuoteFailure } from './retry'

// 실측(2026-08-27 / 2026-08-28 재확인)한 사실만 픽스처로 굳힌다:
//   - `rowData` 는 **값만 담은 배열**이고 이름은 `colNames` 에 따로 온다.
//   - LONN: [588.4, 587.8, 20260827] (ClosingPrice, PreviousClosingPrice, MarketDate).
//     교차 검증: SIX 588.4 = FT 588.40.
//   - `Currency` 는 유효한 select 이름이고 "CHF" 를 준다(재실측으로 확인).
//   - 없는 심볼은 오류가 아니라 `totalRows: 0` + 빈 `rowData` 다.
//   - 없는 select 이름은 **HTML 오류 본문**이다(`Invalid name '...' in select parameter`).
//     실측 상태 코드는 400 이었다.

/** colNames/rowData 를 원하는 순서로 만든다. 순서를 바꿔도 결과가 같아야 한다. */
function fqs(cols: Array<[string, unknown]>, over: Record<string, unknown> = {}) {
  return {
    protocolVersion: 'fqs.json#17x',
    pageNumber: 1,
    pageSize: 50,
    totalRows: 1,
    delayMinutes: 15,
    copyRight: '(c) Copyright by SIX Group Ltd 2026. All rights reserved.',
    colNames: cols.map(c => c[0]),
    rowData: [cols.map(c => c[1])],
    elapsed: 0,
    ...over,
  }
}

const LONN: Array<[string, unknown]> = [
  ['ClosingPrice', 588.4],
  ['PreviousClosingPrice', 587.8],
  ['MarketDate', 20260827],
  ['Currency', 'CHF'],
]

const HTML_ERROR =
  "<html>\n<body>\n  <tt>Bad request ERR-1787848983970</tt>\n  <br/>\n" +
  "  <tt>Invalid name 'ClosingDate' in select parameter</tt>\n</body>\n</html>\n"

function stubSix(body: unknown, status = 200) {
  const spy = vi.fn(async (_url: string) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchSixQuote', () => {
  it('종가·전일종가·통화·기준일을 실측 응답에서 뽑는다', async () => {
    stubSix(fqs(LONN))
    const q = await fetchSixQuote('LONN')
    expect(q.close).toBe(588.4)
    expect(q.prevClose).toBe(587.8)
    expect(q.currency).toBe('CHF')
    expect(q.asOf).toBe('2026-08-27')
  })

  it('위치가 아니라 colNames 의 이름으로 읽는다 — 순서를 뒤집어도 값이 안 바뀐다', async () => {
    // 위치로 읽으면 종가 자리에 전일 종가가 들어오고, 둘 다 그럴듯한 숫자라
    // 아무도 눈치채지 못한다. select 순서를 바꾸는 것만으로 조용히 뒤바뀌면 안 된다.
    stubSix(fqs([...LONN].reverse()))
    const q = await fetchSixQuote('LONN')
    expect(q.close).toBe(588.4)
    expect(q.prevClose).toBe(587.8)
    expect(q.currency).toBe('CHF')
    expect(q.asOf).toBe('2026-08-27')
  })

  it('모르는 컬럼이 끼어들어도 이름으로 찾는다', async () => {
    stubSix(
      fqs([
        ['ISIN', 'CH0013841017'],
        ['ClosingPrice', 588.4],
        ['ValorSymbol', 'LONN'],
        ['MarketDate', 20260827],
        ['PreviousClosingPrice', 587.8],
        ['Currency', 'CHF'],
      ]),
    )
    const q = await fetchSixQuote('LONN')
    expect(q.close).toBe(588.4)
    expect(q.prevClose).toBe(587.8)
  })

  it('MarketDate(YYYYMMDD 숫자)를 YYYY-MM-DD 로 바꾼다', async () => {
    stubSix(fqs([...LONN.slice(0, 2), ['MarketDate', 20260102], LONN[3]]))
    expect((await fetchSixQuote('LONN')).asOf).toBe('2026-01-02')
  })

  it('심볼이 안 맞으면(totalRows 0) 실패로 남긴다 — 빈 값이 아니다', async () => {
    stubSix(fqs(LONN, { totalRows: 0, rowData: [] }))
    await expect(fetchSixQuote('NOPE')).rejects.toThrow(/totalRows 가 1이 아님: 0/)
  })

  it('여러 상장이 걸리면(totalRows 2) 아무거나 고르지 않고 실패한다', async () => {
    stubSix({
      totalRows: 2,
      colNames: ['ClosingPrice', 'PreviousClosingPrice', 'MarketDate', 'Currency'],
      rowData: [
        [588.4, 587.8, 20260827, 'CHF'],
        [640.0, 639.0, 20260827, 'EUR'],
      ],
    })
    await expect(fetchSixQuote('LONN')).rejects.toThrow(/totalRows 가 1이 아님: 2/)
  })

  it('HTML 오류 본문(없는 select 이름)을 실패로 다루고 사유를 사람이 읽게 남긴다', async () => {
    stubSix(HTML_ERROR, 400)
    const e = (await fetchSixQuote('LONN').catch(err => err)) as Error
    expect(e.message).toMatch(/SIX HTTP 400/)
    expect(e.message).toMatch(/Invalid name 'ClosingDate' in select parameter/)
    expect(e.message).not.toContain('<tt>') // 태그는 걷어낸다
  })

  it('HTTP 200 인데 JSON 이 아니면 실패로 다룬다', async () => {
    // 브리프 실측은 같은 오류를 200 으로 봤다. 상태 코드에만 기대지 않는다.
    stubSix(HTML_ERROR, 200)
    const e = (await fetchSixQuote('LONN').catch(err => err)) as Error
    expect(e.message).toMatch(/JSON 이 아님/)
    expect(e.message).toMatch(/Invalid name/)
  })

  it('실패 메시지가 retry.ts 의 분류 규약을 따른다', async () => {
    stubSix(HTML_ERROR, 400)
    expect(classifyQuoteFailure(await fetchSixQuote('LONN').catch(e => e))).toBe('permanent')
    stubSix('', 502)
    expect(classifyQuoteFailure(await fetchSixQuote('LONN').catch(e => e))).toBe('transient')
  })

  it('ClosingPrice 가 null 이면 실패한다 — 0 으로 둔갑하지 않는다', async () => {
    stubSix(fqs([['ClosingPrice', null], ...LONN.slice(1)]))
    await expect(fetchSixQuote('LONN')).rejects.toThrow(/ClosingPrice 파싱 실패/)
  })

  it('PreviousClosingPrice 가 없으면 실패한다 — 전일대비가 조용히 사라지지 않는다', async () => {
    stubSix(fqs([LONN[0], ['PreviousClosingPrice', ''], LONN[2], LONN[3]]))
    await expect(fetchSixQuote('LONN')).rejects.toThrow(/PreviousClosingPrice 파싱 실패/)
  })

  it('MarketDate 형식이 다르면 실패한다', async () => {
    stubSix(fqs([...LONN.slice(0, 2), ['MarketDate', '2026-08-27'], LONN[3]]))
    await expect(fetchSixQuote('LONN')).rejects.toThrow(/MarketDate 파싱 실패/)
  })

  it('Currency 컬럼이 사라지면 실패한다 — 시드 통화로 슬쩍 채우지 않는다', async () => {
    // 통화를 provider 안에 하드코딩하면 currencyMismatchReason 이 자기 자신을
    // 검사하게 되어, 다른 상장으로 바뀐 날을 못 잡는다.
    stubSix(fqs(LONN.slice(0, 3)))
    await expect(fetchSixQuote('LONN')).rejects.toThrow(/Currency 없음/)
  })

  it('요청 URL 에 심볼과 필요한 select 이름이 전부 들어간다', async () => {
    const spy = stubSix(fqs(LONN))
    await fetchSixQuote('LONN')
    const url = String(spy.mock.calls[0][0])
    expect(url).toContain('where=ValorSymbol=LONN')
    for (const name of ['ClosingPrice', 'PreviousClosingPrice', 'MarketDate', 'Currency']) {
      expect(url).toContain(name)
    }
    // 실측으로 "없는 이름"임이 확인된 것들. 넣으면 HTML 오류가 온다.
    expect(url).not.toContain('ClosingDate')
    expect(url).not.toContain('LastTradedDateTime')
  })
})
