import { describe, it, expect } from 'vitest'
import { formatSummary, finalizeSummary } from './summaryFormat'
import { charLength } from './text'

// 담당자가 준 예시(2026-10-02). 이 모양이 메일에 그대로 나간다.
const TARGET =
  '셀트리온이 1,000억원 규모(56만853주) 자사주 추가 매입 결정, 올해 누적 매입액은 총 4,000억원 달성…중장기적으로 당기순이익의 33%를 주주에게 환원할 방침'

describe('formatSummary — 담당자 예시', () => {
  it('마침표로 이은 모델 출력을 담당자 예시 모양으로 바꾼다', () => {
    const raw =
      '셀트리온이 1000억원 규모(56만853주) 자사주 추가 매입 결정. 올해 누적 매입액은 총 4000억원 달성...중장기적으로 당기순이익의 33%를 주주에게 환원할 방침.'
    expect(formatSummary(raw)).toBe(TARGET)
  })

  it('이미 예시 모양이면 그대로 둔다 (멱등)', () => {
    expect(formatSummary(TARGET)).toBe(TARGET)
    expect(formatSummary(formatSummary(TARGET))).toBe(TARGET)
  })
})

describe('formatSummary — 문장부호', () => {
  it('문장 사이 마침표는 `, ` 로, 끝 마침표는 지운다', () => {
    expect(formatSummary('계약 체결. 매출 확대.')).toBe('계약 체결, 매출 확대')
    expect(formatSummary('계약 체결。매출 확대。')).toBe('계약 체결, 매출 확대')
  })

  it('소수점은 건드리지 않는다', () => {
    expect(formatSummary('영업이익률 0.3%p 개선. 4.4조원 계약')).toBe('영업이익률 0.3%p 개선, 4.4조원 계약')
  })

  it('숫자로 끝난 문장의 마침표도 경계다 — 끝 마침표가 남지 않는다', () => {
    expect(formatSummary('목표 주가 25만원. 점유율 30%.')).toBe('목표 주가 25만원, 점유율 30%')
    expect(formatSummary('누적 4,000.')).toBe('누적 4,000')
  })

  it('`...` 과 `‥` 를 `…` 로 바꾸고 앞뒤 공백을 없앤다', () => {
    expect(formatSummary('계약 체결 ... 매출 확대')).toBe('계약 체결…매출 확대')
    expect(formatSummary('계약 체결‥매출 확대')).toBe('계약 체결…매출 확대')
  })

  it('`…` 은 첫 번째만 남기고 나머지는 `, ` 로 바꾼다', () => {
    expect(formatSummary('가 결정…나 달성…다 방침')).toBe('가 결정…나 달성, 다 방침')
    expect(formatSummary('가…나...다‥라')).toBe('가…나, 다, 라')
  })

  it('끝의 구분자를 지운다', () => {
    expect(formatSummary('계약 체결,')).toBe('계약 체결')
    expect(formatSummary('계약 체결…')).toBe('계약 체결')
    expect(formatSummary('계약 체결. ')).toBe('계약 체결')
    expect(formatSummary('계약 체결…, .')).toBe('계약 체결')
  })

  it('구분자 중복을 정리한다', () => {
    expect(formatSummary('가 결정, , 나 달성')).toBe('가 결정, 나 달성')
    expect(formatSummary('가 결정,. 나 달성')).toBe('가 결정, 나 달성')
    expect(formatSummary('가 결정. …나 달성')).toBe('가 결정…나 달성')
    expect(formatSummary('가 결정…, 나 달성')).toBe('가 결정…나 달성')
  })

  it('경계 콤마 뒤에 공백을 넣되 숫자 콤마는 건드리지 않는다', () => {
    expect(formatSummary('가 결정,나 달성')).toBe('가 결정, 나 달성')
    expect(formatSummary('매출 1,000억원')).toBe('매출 1,000억원')
  })

  it('줄바꿈은 문장 경계다', () => {
    expect(formatSummary('계약 체결\n매출 확대')).toBe('계약 체결, 매출 확대')
  })

  it('빈 문자열과 공백은 빈 문자열이다', () => {
    expect(formatSummary('')).toBe('')
    expect(formatSummary('   ')).toBe('')
    expect(formatSummary('.')).toBe('')
  })
})

describe('formatSummary — 금액 천 단위 콤마', () => {
  it.each([
    ['1000억원', '1,000억원'],
    ['4000억원', '4,000억원'],
    ['1조2000억원', '1조2,000억원'],
    ['1조 2000억원', '1조 2,000억원'],
    ['4000억 달러', '4,000억 달러'],
    ['12000억원', '12,000억원'],
    ['3000만원', '3,000만원'],
    ['1500원', '1,500원'],
    ['250만 유로', '250만 유로'],
    ['1200만 엔', '1,200만 엔'],
    ['3500억 위안', '3,500억 위안'],
  ])('%s → %s', (input, expected) => {
    expect(formatSummary(input)).toBe(expected)
  })

  it.each([
    ['2026년 실적', '연도'],
    ['임직원 1200명', '수량(명)'],
    ['56만853주 매입', '수량(주) — 만 단위 표기'],
    ['점유율 1234%', '퍼센트'],
    ['품목 코드 A1234원료', '코드'],
    ['이미 1,000억원', '이미 콤마'],
    ['0.12345억원', '소수의 일부'],
    ['2026년 1000대 판매', '수량(대)'],
  ])('건드리지 않는다: %s (%s)', input => {
    expect(formatSummary(input)).toBe(input)
  })
})

describe('formatSummary — `원` 보충', () => {
  it.each([
    ['4000억 규모', '4,000억원 규모'],
    ['4.4조 계약', '4.4조원 계약'],
    ['매출 2조 달성', '매출 2조원 달성'],
    ['1,000억 규모', '1,000억원 규모'],
    ['누적 4000억', '누적 4,000억원'],
    ['500억(전년 대비 20% 증가)', '500억원(전년 대비 20% 증가)'],
  ])('%s → %s', (input, expected) => {
    expect(formatSummary(input)).toBe(expected)
  })

  it.each([
    ['1조2,000억원', '뒤에 숫자 — 조 다음에 억이 이어진다'],
    ['1조 2,000억원', '공백 뒤 숫자'],
    ['1억5,000만원', '억 다음에 만이 이어진다'],
    ['4,000억 달러', '이미 통화'],
    ['4.4조원', '이미 원'],
    ['가입자 1억 명', '수량(명)'],
    ['발행 주식 3억 주', '수량(주)'],
    ['누적 1억 건', '수량(건)'],
    ['100억대 매출', '수량·범위(대)'],
    ['1억 USD', '영문 통화'],
    ['상법 제382조 위반', '조항 번호'],
    ['기억 속 추억', '앞이 숫자가 아님'],
    ['4조 3교대', '뒤에 숫자'],
  ])('붙이지 않는다: %s (%s)', input => {
    expect(formatSummary(input)).toBe(input)
  })
})

describe('finalizeSummary — 서식 → 절삭', () => {
  it('서식 후 100자를 넘으면 `, ` 경계에서 자르고 구분자로 끝나지 않는다', () => {
    const raw = '가'.repeat(60) + '. ' + '나'.repeat(60) + '.'
    const r = finalizeSummary(raw, 100)
    expect(r).toBe('가'.repeat(60))
  })

  it('`…` 도 경계다', () => {
    const raw = '가'.repeat(60) + '...' + '나'.repeat(60)
    expect(finalizeSummary(raw, 100)).toBe('가'.repeat(60))
  })

  it('금액 콤마가 늘린 글자 수까지 반영해 100자 이내로 만든다', () => {
    // 서식 전 99자, 서식 후 103자 — 절삭을 먼저 하면 그냥 통과한 뒤 콤마·원이 붙어 100자를 넘는다.
    const raw = '가'.repeat(45) + ', ' + '나'.repeat(40) + ' 1000억 1000억'
    expect(charLength(raw)).toBe(99)
    const r = finalizeSummary(raw, 100)
    expect(charLength(r)).toBeLessThanOrEqual(100)
    expect(r).not.toMatch(/[,….]$/)
  })

  it('결과에 끝 마침표가 없고 `…` 은 많아야 하나다', () => {
    const raw = '가 결정. 나 달성... 다 방침... 라 계획.'
    const r = finalizeSummary(raw, 100)
    expect(r).toBe('가 결정, 나 달성…다 방침, 라 계획')
    expect(r.split('…').length - 1).toBeLessThanOrEqual(1)
  })
})
