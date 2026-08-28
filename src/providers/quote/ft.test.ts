import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchFtQuote } from './ft'
import { classifyQuoteFailure } from './retry'
import { changePct } from '@/domain/calc'

/**
 * 실측(2026-08-28, 컨트롤러 값 재측정)한 사실만 픽스처로 굳힌다:
 *
 *     GSK:LSE    Price (GBX) 1,852.00   Today's Change -47.50 / -2.50%
 *     SAN:PAR    Price (EUR) 77.28      Today's Change  -1.01 / -1.29%
 *     LONN:SWX   Price (CHF) 588.40     Today's Change  0.600 /  0.10%
 *     2269:HKG   Price (HKD) 50.80      Today's Change  0.300 /  0.59%
 *
 * - 값 span 안에 `<span class="mod-format--neg"><i/>…</span>` 이 한 겹 더 있다.
 * - 기준 시각은 `<div class="mod-disclaimer">…as of Aug 27 2026 16:39 BST.</div>` 이고
 *   같은 문구가 페이지에 두 번 나온다(값은 같다).
 * - 없는 심볼(`LONN:VTX`, `ZZZZNOPE:XXX`)은 404 가 아니라 302 다.
 */

/** 실측 HTML 의 라벨/값 한 줄. 태그 모양을 실물 그대로 둔다. */
function cell(label: string, valueInner: string): string {
  return (
    `<li><span class="mod-ui-data-list__label" data-toggle="tooltipster" data-placement="top"` +
    ` data-maxwidth="340" data-dismiss="true" title="설명 문구">${label}</span>` +
    `<span class="mod-ui-data-list__value">${valueInner}</span></li>`
  )
}

/** 변동 칸은 값 span 안에 부호 span 과 화살표 아이콘이 한 겹 더 있다(실측). */
function changeInner(text: string, sign: 'pos' | 'neg'): string {
  return (
    `<span class="mod-format--${sign}">` +
    `<i class="o-ft-icons-icon o-ft-icons-icon--arrow-${sign === 'neg' ? 'downwards' : 'upwards'}"></i>` +
    `${text}</span>`
  )
}

const DISCLAIMER = '<div class="mod-disclaimer">Data delayed at least 15 minutes, as of Aug 27 2026 16:39 BST.</div>'

/**
 * 실측 페이지 모양. `cells` 를 그대로 이어 붙이므로 **순서를 바꿔 넘길 수 있다** —
 * 위치가 아니라 라벨로 읽는지 확인하는 데 쓴다.
 */
function page(cells: string[], opts: { disclaimer?: string } = {}): string {
  return (
    `<html><body><div class="mod-module"><ul class="mod-ui-data-list">` +
    // 값이 딸리지 않은 라벨 세 개가 목록 앞에 있다(관심종목·포트폴리오·알림 버튼).
    `<li><span class="mod-ui-data-list__label" title="Add to watchlist"><div data-mod-action="add-to-watchlist">+</div></span></li>` +
    cells.join('') +
    `</ul>${opts.disclaimer ?? DISCLAIMER}</div></body></html>`
  )
}

const PRICE_GSK = cell('Price (GBX)', '1,852.00')
const CHANGE_GSK = cell("Today's Change", changeInner('-47.50 / -2.50%', 'neg'))
const VOLUME = cell('Shares traded', '3.59m')
const BETA = cell('Beta', '0.7699')

function stubFt(body: string, status = 200) {
  const spy = vi.fn(async (_url: string, _init?: RequestInit) =>
    status >= 300 && status < 400
      ? new Response('', { status, headers: { location: '/data/search?query=X' } })
      : new Response(body, { status, headers: { 'content-type': 'text/html' } }),
  )
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchFtQuote', () => {
  it('종가·전일종가·통화·기준일을 실측 페이지에서 뽑는다', async () => {
    stubFt(page([PRICE_GSK, CHANGE_GSK, VOLUME, BETA]))
    const q = await fetchFtQuote('GSK:LSE')
    expect(q.close).toBe(1852)
    expect(q.prevClose).toBe(1899.5) // 1852 − (−47.5)
    expect(q.currency).toBe('GBX')
    expect(q.asOf).toBe('2026-08-27')
  })

  it('**위치가 아니라 라벨로 읽는다** — 순서를 뒤바꾼 페이지에서도 같은 값이 나온다', async () => {
    // 이 테스트가 이 파서의 핵심 계약이다. 순서로 읽으면 FT 가 항목 하나를 옮긴 날
    // 종가 자리에 거래량이나 베타가 들어오고, 값이 그럴듯한 숫자라 아무도 못 알아본다.
    stubFt(page([BETA, CHANGE_GSK, VOLUME, PRICE_GSK]))
    const q = await fetchFtQuote('GSK:LSE')
    expect(q.close).toBe(1852)
    expect(q.prevClose).toBe(1899.5)
    expect(q.currency).toBe('GBX')
  })

  it('네 종목의 통화를 라벨 괄호에서 읽는다 (GBX/EUR/CHF/HKD)', async () => {
    const cases: Array<[string, string, string, 'pos' | 'neg', number, number]> = [
      ['GSK:LSE', 'GBX', '1,852.00', 'neg', 1852, 1899.5],
      ['SAN:PAR', 'EUR', '77.28', 'neg', 77.28, 78.29],
      ['LONN:SWX', 'CHF', '588.40', 'pos', 588.4, 587.8],
      ['2269:HKG', 'HKD', '50.80', 'pos', 50.8, 50.5],
    ]
    const changeText: Record<string, string> = {
      'GSK:LSE': '-47.50 / -2.50%',
      'SAN:PAR': '-1.01 / -1.29%',
      'LONN:SWX': '0.600 / 0.10%',
      '2269:HKG': '0.300 / 0.59%',
    }
    for (const [code, currency, price, sign, close, prevClose] of cases) {
      stubFt(page([cell(`Price (${currency})`, price), cell("Today's Change", changeInner(changeText[code], sign))]))
      const q = await fetchFtQuote(code)
      expect(q.currency, code).toBe(currency)
      expect(q.close, code).toBeCloseTo(close, 6)
      expect(q.prevClose, code).toBeCloseTo(prevClose, 6)
    }
  })

  it('전일 종가에 소스에 없던 자릿수를 만들지 않는다', async () => {
    // 77.28 − (−1.01) 은 이진 부동소수에서 78.29000000000001 이 된다. 그 뒤 12자리는
    // FT 가 준 적 없는 정밀도이고, 그대로 저장되면 DB 와 후속 산출물에 그대로 실린다.
    stubFt(page([cell('Price (EUR)', '77.28'), cell("Today's Change", changeInner('-1.01 / -1.29%', 'neg'))]))
    expect((await fetchFtQuote('SAN:PAR')).prevClose).toBe(78.29)
  })

  it('자릿수가 다른 두 값에서는 더 긴 쪽을 남긴다', async () => {
    // 588.40(2자리) − 0.600(3자리) → 3자리까지. 값을 뭉개지 않는다.
    stubFt(page([cell('Price (CHF)', '588.40'), cell("Today's Change", changeInner('0.600 / 0.10%', 'pos'))]))
    expect((await fetchFtQuote('LONN:SWX')).prevClose).toBe(587.8)
  })

  it('천 단위 콤마를 걷어낸다 — 1,852.00 이 1 이 되지 않는다', async () => {
    stubFt(page([cell('Price (GBX)', '1,852.00'), CHANGE_GSK]))
    expect((await fetchFtQuote('GSK:LSE')).close).toBe(1852)
  })

  it('양수 변동은 전일 종가가 오늘보다 낮다 — 부호 방향이 뒤집히지 않는다', async () => {
    stubFt(page([cell('Price (CHF)', '588.40'), cell("Today's Change", changeInner('0.600 / 0.10%', 'pos'))]))
    const q = await fetchFtQuote('LONN:SWX')
    expect(q.prevClose).toBeCloseTo(587.8, 6)
    expect(changePct(q.close, q.prevClose)! * 100).toBeCloseTo(0.102, 2)
  })

  it('등락률은 쓰지 않는다 — RawQuote 에 그 자리가 없고 `/` 뒤 값을 버린다', async () => {
    // 소스 등락률을 믿으면 이 행만 반올림 규칙이 달라 끝자리가 어긋난다.
    stubFt(page([PRICE_GSK, cell("Today's Change", changeInner('-47.50 / -99.99%', 'neg'))]))
    const q = await fetchFtQuote('GSK:LSE')
    expect(Object.keys(q).sort()).toEqual(['asOf', 'close', 'currency', 'prevClose'])
    expect(changePct(q.close, q.prevClose)! * 100).toBeCloseTo(-2.5007, 3)
  })

  // ── 여기서부터가 이 파일에서 가장 중요한 테스트다 ──
  // HTML 이 바뀌어 라벨을 못 찾았을 때 **0 이나 null 로 채우고 넘어가면 안 된다.**
  // 폴백 경로는 평소에 아무도 안 보므로, 조용히 0원이 찍히면 몇 주를 간다.

  it('Price 라벨이 없으면 실패한다 — 0 으로 채우지 않는다', async () => {
    stubFt(page([VOLUME, CHANGE_GSK, BETA]))
    await expect(fetchFtQuote('GSK:LSE')).rejects.toThrow(/Price 라벨을 찾지 못함/)
  })

  it("Today's Change 라벨이 없으면 실패한다 — 전일 종가가 종가와 같아지지 않는다", async () => {
    // 변동을 0 으로 읽으면 prevClose === close 가 되어 「보합」으로 그럴듯하게 찍힌다.
    stubFt(page([PRICE_GSK, VOLUME, BETA]))
    await expect(fetchFtQuote('GSK:LSE')).rejects.toThrow(/Today's Change 라벨을 찾지 못함/)
  })

  it('라벨이 하나도 없는 HTML(개편·오류 페이지)은 통째로 실패한다', async () => {
    stubFt('<html><body><h1>Sorry, page not found</h1></body></html>')
    await expect(fetchFtQuote('GSK:LSE')).rejects.toThrow(/Price 라벨을 찾지 못함/)
  })

  it('빈 응답도 실패한다', async () => {
    stubFt('')
    await expect(fetchFtQuote('GSK:LSE')).rejects.toThrow(/Price 라벨을 찾지 못함/)
  })

  it('값이 숫자가 아니면 실패한다 — 문자열에서 숫자 조각을 주워 담지 않는다', async () => {
    stubFt(page([cell('Price (GBX)', '--'), CHANGE_GSK]))
    await expect(fetchFtQuote('GSK:LSE')).rejects.toThrow(/Price 파싱 실패/)

    // 「3.59m」 같은 칸을 읽게 됐을 때 3.59 를 뽑아내면 그럴듯한 주가가 만들어진다.
    stubFt(page([cell('Price (GBX)', '3.59m'), CHANGE_GSK]))
    await expect(fetchFtQuote('GSK:LSE')).rejects.toThrow(/Price 파싱 실패/)
  })

  it('변동 칸이 숫자가 아니면 실패한다', async () => {
    stubFt(page([PRICE_GSK, cell("Today's Change", changeInner('-- / --', 'neg'))]))
    await expect(fetchFtQuote('GSK:LSE')).rejects.toThrow(/Today's Change 파싱 실패/)
  })

  it('라벨 문구가 바뀌면(예: Last Price) 실패한다 — 비슷한 칸으로 대체하지 않는다', async () => {
    stubFt(page([cell('Last Price (GBX)', '1,852.00'), CHANGE_GSK]))
    await expect(fetchFtQuote('GSK:LSE')).rejects.toThrow(/Price 라벨을 찾지 못함/)
  })

  // ── 기준일 ──

  it('기준일은 페이지의 데이터 기준 시각에서 읽는다', async () => {
    stubFt(page([PRICE_GSK, CHANGE_GSK]))
    expect((await fetchFtQuote('GSK:LSE')).asOf).toBe('2026-08-27')
  })

  it('기준 시각이 없으면 asOf 를 비워 둔다 — 오늘 날짜로 지어내지 않는다', async () => {
    // 빈 값은 normalizeAsOf 가 null 로 바꾸고 화면이 「기준일 미상」이라고 말한다.
    // 실패로 다루지는 않는다 — 기준일은 값이 아니다.
    stubFt(page([PRICE_GSK, CHANGE_GSK], { disclaimer: '' }))
    const q = await fetchFtQuote('GSK:LSE')
    expect(q.asOf).toBe('')
    expect(q.close).toBe(1852)
  })

  it('기준 시각이 서로 다르게 여러 개면 하나를 고르지 않고 비워 둔다', async () => {
    const two =
      '<div class="mod-disclaimer">Data delayed at least 15 minutes, as of Aug 27 2026 16:39 BST.</div>' +
      '<div class="mod-disclaimer">Data delayed at least 15 minutes, as of Aug 20 2026 16:39 BST.</div>'
    stubFt(page([PRICE_GSK, CHANGE_GSK], { disclaimer: two }))
    expect((await fetchFtQuote('GSK:LSE')).asOf).toBe('')
  })

  it('같은 기준 시각이 두 번 나오는 실측 구조에서는 그 값을 쓴다', async () => {
    stubFt(page([PRICE_GSK, CHANGE_GSK], { disclaimer: DISCLAIMER + DISCLAIMER }))
    expect((await fetchFtQuote('GSK:LSE')).asOf).toBe('2026-08-27')
  })

  // ── 요청과 실패 규약 ──

  it('브라우저 User-Agent 로 부르고 리다이렉트를 따라가지 않는다', async () => {
    const spy = stubFt(page([PRICE_GSK, CHANGE_GSK]))
    await fetchFtQuote('SAN:PAR')
    const url = String(spy.mock.calls[0][0])
    const init = spy.mock.calls[0][1] as RequestInit
    expect(url).toContain('tearsheet/summary?s=SAN%3APAR')
    expect(String((init.headers as Record<string, string>)['User-Agent'])).toContain('Mozilla/5.0')
    // 없는 심볼이 검색 페이지로 리다이렉트되므로 따라가면 다른 페이지의 숫자를 읽는다.
    expect(init.redirect).toBe('manual')
  })

  it('없는 심볼의 302 는 실패다 — 따라가서 엉뚱한 값을 읽지 않는다', async () => {
    stubFt('', 302)
    await expect(fetchFtQuote('LONN:VTX')).rejects.toThrow(/HTTP 302/)
    await expect(fetchFtQuote('LONN:VTX')).rejects.toThrow(/리다이렉트/)
  })

  it('실패 메시지가 retry.ts 의 분류 규약을 따른다', async () => {
    // `... HTTP {status}` 형식이라야 classifyQuoteFailure 가 재시도 여부를 가른다.
    stubFt('', 302)
    expect(classifyQuoteFailure(await fetchFtQuote('X:Y').catch(e => e))).toBe('permanent')

    stubFt('', 503)
    expect(classifyQuoteFailure(await fetchFtQuote('X:Y').catch(e => e))).toBe('transient')

    stubFt('', 429)
    expect(classifyQuoteFailure(await fetchFtQuote('X:Y').catch(e => e))).toBe('rate-limit')
  })

  it('사유에 심볼이 들어간다 — 어느 행이 왜 죽었는지 화면에서 짚을 수 있다', async () => {
    stubFt('', 503)
    await expect(fetchFtQuote('SAN:PAR')).rejects.toThrow(/\[SAN:PAR\]/)
  })
})
