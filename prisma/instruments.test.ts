import { describe, it, expect } from 'vitest'
import { INSTRUMENTS } from './instruments'
import { KRX_IDX_NM_KOSPI200_HEALTHCARE } from '@/providers/quote/krx'
import { MARKET_WRAP_ROWS } from '@/pipeline/collectHelpers'

describe('INSTRUMENTS', () => {
  it('23행이다', () => {
    expect(INSTRUMENTS).toHaveLength(23)
  })
  it('구분별 개수가 샘플과 같다', () => {
    const count = (c: string) => INSTRUMENTS.filter(i => i.category === c).length
    expect(count('국내사')).toBe(10)
    expect(count('해외사')).toBe(9)
    expect(count('Index')).toBe(4)
  })
  it('displayOrder 가 1..23 중복 없이 채워진다', () => {
    const orders = INSTRUMENTS.map(i => i.displayOrder).sort((a, b) => a - b)
    expect(orders).toEqual(Array.from({ length: 23 }, (_, i) => i + 1))
  })
  it('GSK 만 펜스 보정을 갖는다', () => {
    const divisors = INSTRUMENTS.filter(i => (i.priceDivisorForMarketCap ?? 1) !== 1)
    expect(divisors.map(i => i.name)).toEqual(['GSK'])
    expect(divisors[0].priceDivisorForMarketCap).toBe(100)
  })
  it('국내 종목코드는 6자리 숫자다', () => {
    for (const i of INSTRUMENTS.filter(i => i.quoteSource === 'naver-stock')) {
      expect(i.quoteSymbol).toMatch(/^\d{6}$/)
    }
  })
  it('코스피200 헬스케어는 KRX 자동 수집이고 quoteSymbol 이 KRX 표기와 정확히 같다', () => {
    // 표기가 두 가지다. 우리 name 은 원본 브리프 엑셀을 따른 '코스피200 헬스케어'(공백
    // 없음)이고, KRX 응답의 IDX_NM 은 '코스피 200 헬스케어'(공백 있음)다. quoteSymbol 은
    // **KRX 쪽 표기**여야 한다 — name 을 그대로 넣으면 51행 중 아무것도 안 걸린다.
    const hc = INSTRUMENTS.find(i => i.name === '코스피200 헬스케어')
    expect(hc).toBeDefined()
    expect(hc!.quoteSource).toBe('krx-index')
    expect(hc!.quoteSymbol).toBe(KRX_IDX_NM_KOSPI200_HEALTHCARE)
    expect(hc!.quoteSymbol).not.toBe(hc!.name)
    expect(hc!.isIndex).toBe(true)
  })

  it('수기 입력에 의존하는 종목은 더 이상 없다', () => {
    // 'manual' 경로 자체는 남겨 뒀지만(검수 화면의 수기 입력), 이제 쓰는 종목은 없다.
    expect(INSTRUMENTS.filter(i => i.quoteSource === 'manual')).toEqual([])
  })

  it('marketstack 에 남은 종목은 MIC 접미사를 쓰지 않는다', () => {
    // MIC 접미사(GSK.XLON)는 뉴욕 ADR 값이 온다. 거래소 약칭(SAN.PA)을 쓴다.
    const ms = INSTRUMENTS.filter(i => i.quoteSource === 'marketstack')
    expect(ms.map(i => i.name)).toEqual(['Sanofi']) // 나머지 셋은 Task 31 로 옮겼다
    for (const i of ms) {
      expect(i.quoteSymbol).not.toMatch(/\.X[A-Z]{3}$/)
    }
  })

  // ── Task 31: 비미국 4종목의 시세 소스가 넷으로 쪼개졌다 ──
  //
  // marketstack 무료 플랜이 호출 수가 아니라 **심볼 수**로 세는 탓에 월 88회가 나와
  // 한도 100 에 닿았다(2026-08-27 실제 소진). 매일 도는 시세만 옮겼고 연초 기준가는
  // 네 종목 모두 여전히 marketstack 이다. 「왜 이렇게 복잡하지」 하고 한 소스로
  // 되돌리면 한도가 곧바로 돌아온다 — 그래서 구성을 여기서 고정한다.

  it('비미국 4종목의 소스와 심볼이 소스별 표기와 맞는다', () => {
    const by = (name: string) => INSTRUMENTS.find(i => i.name === name)!
    expect([by('GSK').quoteSource, by('GSK').quoteSymbol]).toEqual(['lse', 'GSK'])
    expect([by('Lonza').quoteSource, by('Lonza').quoteSymbol]).toEqual(['six', 'LONN'])
    expect([by('Wuxi').quoteSource, by('Wuxi').quoteSymbol]).toEqual(['naver-world-stock', '2269.HK'])
    expect([by('Sanofi').quoteSource, by('Sanofi').quoteSymbol]).toEqual(['marketstack', 'SAN.PA'])
  })

  it('옮긴 세 종목은 marketstack 표기(접미사)를 그대로 쓰지 않는다', () => {
    // GSK.L / LONN.SW 를 LSE·SIX 에 그대로 넘기면 종목을 못 찾는다(HTTP 404 / totalRows 0).
    expect(INSTRUMENTS.find(i => i.name === 'GSK')!.quoteSymbol).not.toBe('GSK.L')
    expect(INSTRUMENTS.find(i => i.name === 'Lonza')!.quoteSymbol).not.toBe('LONN.SW')
  })

  it('사노피는 옮기지 않았다 — 유로넥스트에 쓸 만한 무료 소스가 없다', () => {
    // ajax 응답이 암호화된 블롭(`ct:`)이고 FT HTML 스크래핑은 깨지기 쉽다.
    // 한도 문제는 세 종목을 옮기는 것으로 이미 해결된다.
    expect(INSTRUMENTS.find(i => i.name === 'Sanofi')!.quoteSource).toBe('marketstack')
  })

  it('GSK 는 소스가 바뀌어도 펜스 보정(100)을 유지한다', () => {
    // LSE 는 통화를 GBX 로 알려 주지만 가격 단위는 marketstack 때와 같은 펜스다.
    // 이 값이 사라지면 시가총액이 100배가 된다(스펙 §3.2 주의 1, §13 리스크 3).
    const gsk = INSTRUMENTS.find(i => i.name === 'GSK')!
    expect(gsk.quoteSource).toBe('lse')
    expect(gsk.priceDivisorForMarketCap).toBe(100)
    expect(gsk.currency).toBe('GBP')
  })

  it('MARKET_WRAP_ROWS 는 실재하는 지수 행만 가리킨다', () => {
    // 이 목록은 이름 문자열로 시드와 맞춘다. 시드에서 name 을 바꾸거나 행을 지우면
    // 목록이 아무 행에도 걸리지 않게 되고, 그러면 그 행에서 시황이 조용히 감점되기
    // 시작한다 — 화면에는 "순위가 좀 이상하다"로만 보인다. 그래서 여기서 지킨다.
    for (const name of MARKET_WRAP_ROWS) {
      const row = INSTRUMENTS.find(i => i.name === name)
      expect(row, name).toBeDefined()
      expect(row!.isIndex, name).toBe(true)
    }
  })

  it('코스피200 헬스케어는 지수지만 MARKET_WRAP_ROWS 에 없다', () => {
    // 감점 예외의 기준이 `isIndex` 가 아니라는 것을 시드 쪽에서도 고정한다.
    // 이 행은 업종 검색어(`제약주`)를 쓰고 원하는 것이 시황이 아니라 업종 동향이다.
    // 「지수인데 왜 빠졌지」 하고 넣으면 미국 증시 시황이 업종 기사를 밀어낸다.
    const hc = INSTRUMENTS.find(i => i.name === '코스피200 헬스케어')!
    expect(hc.isIndex).toBe(true)
    expect(MARKET_WRAP_ROWS.has(hc.name)).toBe(false)
  })
})

describe('newsAliases 일관성', () => {
  // 지수는 종종 좁은 자기 이름으로는 기사가 거의 안 잡혀 넓은 시황 검색어로 기사 풀을
  // 넓힌 뒤 별칭으로 좁힌다. 실측(2026-08-27)으로 확인됨: '뉴욕증시' 검색 결과 100건을
  // S&P500 별칭으로 필터링하면 실제로 관련 기사가 남는다 — 별칭이 검색어 자체를
  // 포함하지 않아도 정상 동작이다.
  //
  // 코스피200 헬스케어도 같은 성격의 예외다. 검색어가 '제약주' 이고 별칭이 '제약' 인데,
  // '제약' 은 '제약주'·'제약株'(한자)·'제약사' 를 전부 포함하는 더 넓은 값이다.
  // '제약주' 를 별칭에 그대로 넣으면 실측에서 통과한 「…제약株 불붙었다」 를 놓친다.
  // 즉 별칭이 검색어 문자열을 담고 있지 않은 것이 의도된 결과다 — Vaxcyte류 오타가
  // 아니다. 이 행이 왜 업종 검색어를 쓰는지는 instruments.ts 의 해당 행 주석 참고.
  const DOCUMENTED_BROAD_QUERY_EXCEPTIONS = new Set(['S&P500', '코스피200 헬스케어'])

  it('모든 종목의 newsAliases는 비어있지 않다', () => {
    for (const i of INSTRUMENTS) {
      expect(i.newsAliases?.trim().length ?? 0, i.name).toBeGreaterThan(0)
    }
  })

  it('newsAliases는 newsQuery를 포함한다(문서화된 예외 제외) — Vaxcyte류 오타 재발을 막는다', () => {
    for (const i of INSTRUMENTS) {
      if (DOCUMENTED_BROAD_QUERY_EXCEPTIONS.has(i.name)) continue
      expect(i.newsAliases, i.name).toContain(i.newsQuery)
    }
  })

  it('예외로 등록된 행은 실재하는 행이다 — 이름이 바뀌면 예외가 조용히 무력화된다', () => {
    // 예외 집합은 이름 문자열로 맞춘다. 시드에서 name 을 바꾸면 예외가 아무 행에도
    // 걸리지 않게 되는데, 그러면 위 테스트가 갑자기 실패하거나(운이 좋으면) 다른 행의
    // 오타를 놓친다(운이 나쁘면). 그래서 예외가 실제 행을 가리키는지 함께 지킨다.
    for (const name of DOCUMENTED_BROAD_QUERY_EXCEPTIONS) {
      expect(INSTRUMENTS.some(i => i.name === name), name).toBe(true)
    }
  })

  it('코스피200 헬스케어는 업종 검색어를 쓴다 — 값을 바꾸려면 다시 실측해야 한다', () => {
    // 이 행만 자기 이름이 아니라 업종 단위로 찾는다(instruments.ts 주석 참고).
    // '코스피200 헬스케어' 는 실측 0건이었다. 아래 두 값은 2026-08-27 실측으로
    // 고른 것이고, 예외 등록 때문에 위의 포함 검사가 이 행을 건너뛰므로 여기서
    // 직접 고정한다 — 그러지 않으면 이 행의 오타를 아무도 잡지 못한다.
    const hc = INSTRUMENTS.find(i => i.name === '코스피200 헬스케어')!
    expect(hc.newsQuery).toBe('제약주')
    expect(hc.newsAliases).toBe('제약')
    // 별칭이 검색어의 접두사라는 것이 이 예외의 근거다 — '제약' 이 '제약주' 와
    // '제약株' 를 함께 잡는다. 관계가 끊기면(예: 별칭을 '바이오' 로 바꾸면)
    // 이 예외를 유지할 근거가 사라진다.
    expect(hc.newsQuery.startsWith(hc.newsAliases!)).toBe(true)
  })
})
