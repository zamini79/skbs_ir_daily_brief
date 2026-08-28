import { describe, it, expect, beforeAll } from 'vitest'
import ExcelJS from 'exceljs'
import type { ExcelInstrumentRow } from '@/domain/excel'
import { buildBriefWorkbook } from './workbook'

/**
 * 워크북을 실제로 만들고 **다시 열어서** 검사한다. 조립 코드를 눈으로 읽는 것과
 * 엑셀 파일이 실제로 그렇게 나오는 것은 다른 문제다(병합·서식이 특히 그렇다).
 */

const ROWS: ExcelInstrumentRow[] = [
  {
    category: '국내사',
    name: 'SK바이오사이언스',
    price: 'KRW 48,200',
    prevDiff: '▲ 500',
    changePct: 0.0105,
    ytdPct: -0.221,
    marketCap: 3.6841,
    newsTitle: '고른 기사 제목',
    newsSummary: '고른 요약문',
  },
  {
    category: '해외사',
    name: 'Pfizer',
    price: 'USD 24.5',
    prevDiff: '-',
    changePct: '-',
    ytdPct: '-',
    marketCap: '-',
    // 미확정 행 — 빈 칸으로 나가야 한다.
    newsTitle: '',
    newsSummary: '',
  },
]

let ws: ExcelJS.Worksheet

beforeAll(async () => {
  const bytes = await buildBriefWorkbook('2026-08-28', ROWS)
  const wb = new ExcelJS.Workbook()
  // exceljs 의 load 는 자기가 다시 선언한 전역 `Buffer` 타입을 요구하지만
  // (index.d.ts:1) 런타임에는 Uint8Array 를 그대로 읽는다.
  await wb.xlsx.load(bytes as unknown as Parameters<typeof wb.xlsx.load>[0])
  ws = wb.worksheets[0]
})

describe('원본 브리프 엑셀과 같은 머리 구조', () => {
  it('행1 은 비어 있고 행2 가 표 제목이다', () => {
    expect(ws.getCell('A1').value).toBeNull()
    expect(ws.getCell('A2').value).toBe('주가 현황 및 뉴스')
  })

  it('행3 이 머리글이고 행4 가 시가총액 단위 줄이다', () => {
    const header = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map(c => ws.getCell(`${c}3`).value)
    expect(header).toEqual(['구분', '기업', '주가', '전일대비', '%', '연초대비', '시가총액', '뉴스'])
    expect(ws.getCell('G4').value).toBe('(조원)')
  })

  it('시가총액을 뺀 머리글은 행3~4 로 세로 병합돼 있다', () => {
    expect(ws.getCell('A4').isMerged).toBe(true)
    expect(ws.getCell('A4').master.address).toBe('A3')
    // 시가총액만 병합하지 않는다 — 아래 칸이 단위 줄이라서다.
    expect(ws.getCell('G4').isMerged).toBe(false)
  })
})

describe('종목당 2행 구조와 병합', () => {
  it('첫 종목은 행5~6, 둘째 종목은 행7~8 이다', () => {
    expect(ws.getCell('B5').value).toBe('SK바이오사이언스')
    expect(ws.getCell('B7').value).toBe('Pfizer')
  })

  it('구분~시가총액(A~G)은 두 행이 병합돼 있다', () => {
    for (const col of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      expect(ws.getCell(`${col}6`).isMerged, `${col}6`).toBe(true)
      expect(ws.getCell(`${col}6`).master.address, `${col}6`).toBe(`${col}5`)
    }
  })

  it('뉴스 칸(H)만 병합하지 않고 제목/요약을 각 행에 나눠 쓴다', () => {
    expect(ws.getCell('H5').isMerged).toBe(false)
    expect(ws.getCell('H6').isMerged).toBe(false)
    expect(ws.getCell('H5').value).toBe('고른 기사 제목')
    expect(ws.getCell('H6').value).toBe('고른 요약문')
  })

  it('미확정 행의 뉴스 두 칸은 비어 있다', () => {
    expect(ws.getCell('H7').value ?? '').toBe('')
    expect(ws.getCell('H8').value ?? '').toBe('')
  })
})

describe('숫자 서식', () => {
  it('% 와 연초대비는 소수로 저장되고 셀 서식이 백분율이다', () => {
    expect(ws.getCell('E5').value).toBe(0.0105)
    expect(ws.getCell('F5').value).toBe(-0.221)
    expect(typeof ws.getCell('E5').value).toBe('number')
    expect(ws.getCell('E5').numFmt).toBe('0.00%')
    expect(ws.getCell('F5').numFmt).toBe('0.00%')
  })

  it('시가총액은 숫자에 소수 둘째 자리 서식이다', () => {
    expect(ws.getCell('G5').value).toBe(3.6841)
    expect(ws.getCell('G5').numFmt).toBe('0.00')
  })

  it('값이 없어 「-」 인 칸에는 숫자 서식을 걸지 않는다', () => {
    expect(ws.getCell('E7').value).toBe('-')
    expect(ws.getCell('E7').numFmt).toBeUndefined()
  })

  it('주가는 통화 표기를 잃지 않도록 문자열이다', () => {
    expect(ws.getCell('C5').value).toBe('KRW 48,200')
    expect(ws.getCell('C7').value).toBe('USD 24.5')
  })
})

describe('파일 자체', () => {
  it('행 수가 머리 4행 + 종목당 2행이다', () => {
    expect(ws.rowCount).toBe(4 + ROWS.length * 2)
  })

  it('시트 이름이 날짜다', () => {
    expect(ws.name).toBe('2026-08-28')
  })
})
