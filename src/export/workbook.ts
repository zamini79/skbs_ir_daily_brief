import ExcelJS from 'exceljs'
import {
  HEADERS,
  MARKET_CAP_UNIT,
  SHEET_TITLE,
  type ExcelInstrumentRow,
} from '@/domain/excel'

/**
 * 엑셀 워크북 조립. **무엇을 넣을지는 정하지 않는다** — `domain/excel.ts` 의 순수
 * 함수가 정한 값을 받아 원본 브리프 엑셀과 같은 자리에 적기만 한다.
 *
 * 원본 구조:
 *
 *     행1  (비어 있음)
 *     행2  주가 현황 및 뉴스
 *     행3  구분 | 기업 | 주가 | 전일대비 | % | 연초대비 | 시가총액 | 뉴스
 *     행4                                              (조원)
 *     행5~ 종목당 2행 — 1행: 값 + 기사 제목 / 2행: 요약문
 *
 * 종목당 2행에서 구분~시가총액(A~G)은 세로 병합하고, 뉴스(H)만 두 행을 각각 쓴다.
 */

const COL = {
  CATEGORY: 1,
  NAME: 2,
  PRICE: 3,
  PREV_DIFF: 4,
  CHANGE_PCT: 5,
  YTD_PCT: 6,
  MARKET_CAP: 7,
  NEWS: 8,
} as const

const HEADER_ROW = 3
const UNIT_ROW = 4
const FIRST_DATA_ROW = 5

/** 백분율 칸은 **소수로 저장하고 서식으로 % 를 붙인다.** 문자열이면 계산이 안 된다. */
const PERCENT_FORMAT = '0.00%'
const MARKET_CAP_FORMAT = '0.00'

const INK = 'FF1F1B16'
const LINE = 'FFE5E0D8'
const THEAD = 'FFFAF8F5'

const THIN_BORDER = {
  top: { style: 'thin' as const, color: { argb: LINE } },
  left: { style: 'thin' as const, color: { argb: LINE } },
  bottom: { style: 'thin' as const, color: { argb: LINE } },
  right: { style: 'thin' as const, color: { argb: LINE } },
}

export async function buildBriefWorkbook(
  date: string,
  rows: ExcelInstrumentRow[],
): Promise<Uint8Array<ArrayBuffer>> {
  const wb = new ExcelJS.Workbook()
  wb.created = new Date()
  const ws = wb.addWorksheet(date)

  ws.columns = [
    { width: 10 },
    { width: 22 },
    { width: 18 },
    { width: 13 },
    { width: 10 },
    { width: 11 },
    { width: 13 },
    { width: 80 },
  ]

  // 행2 — 표 제목.
  ws.mergeCells(2, COL.CATEGORY, 2, COL.NEWS)
  const titleCell = ws.getCell(2, COL.CATEGORY)
  titleCell.value = SHEET_TITLE
  titleCell.font = { bold: true, size: 14, color: { argb: INK } }
  titleCell.alignment = { vertical: 'middle', horizontal: 'left' }
  ws.getRow(2).height = 24

  // 행3~4 — 머리글. 시가총액만 두 줄(제목 + 단위)이고 나머지는 세로 병합한다.
  HEADERS.forEach((label, i) => {
    const col = i + 1
    if (col !== COL.MARKET_CAP) ws.mergeCells(HEADER_ROW, col, UNIT_ROW, col)
    const cell = ws.getCell(HEADER_ROW, col)
    cell.value = label
    styleHeaderCell(cell)
  })
  const unitCell = ws.getCell(UNIT_ROW, COL.MARKET_CAP)
  unitCell.value = MARKET_CAP_UNIT
  styleHeaderCell(unitCell)

  // 행5~ — 종목당 2행.
  rows.forEach((row, i) => {
    const top = FIRST_DATA_ROW + i * 2
    const bottom = top + 1

    for (let col = COL.CATEGORY; col <= COL.MARKET_CAP; col++) {
      ws.mergeCells(top, col, bottom, col)
    }

    put(ws, top, COL.CATEGORY, row.category, 'center')
    put(ws, top, COL.NAME, row.name, 'center')
    put(ws, top, COL.PRICE, row.price, 'right')
    put(ws, top, COL.PREV_DIFF, row.prevDiff, 'right')
    put(ws, top, COL.CHANGE_PCT, row.changePct, 'right', PERCENT_FORMAT)
    put(ws, top, COL.YTD_PCT, row.ytdPct, 'right', PERCENT_FORMAT)
    put(ws, top, COL.MARKET_CAP, row.marketCap, 'right', MARKET_CAP_FORMAT)

    const titleCellNews = ws.getCell(top, COL.NEWS)
    titleCellNews.value = row.newsTitle
    titleCellNews.font = { color: { argb: INK } }
    titleCellNews.alignment = { vertical: 'top', horizontal: 'left', wrapText: true }
    titleCellNews.border = THIN_BORDER

    const summaryCell = ws.getCell(bottom, COL.NEWS)
    summaryCell.value = row.newsSummary
    summaryCell.font = { color: { argb: INK }, size: 10 }
    summaryCell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true }
    summaryCell.border = THIN_BORDER
  })

  ws.views = [{ state: 'frozen', ySplit: UNIT_ROW }]

  /*
   * exceljs 는 전역 `Buffer` 를 자기 식으로 다시 선언한다(`declare interface Buffer
   * extends ArrayBuffer {}`, exceljs/index.d.ts:1). 그래서 writeBuffer 의 반환 타입이
   * Node 의 Buffer 와 어긋나 그대로 들고 다니면 호출부마다 타입이 깨진다. 여기서
   * 한 번만 Uint8Array 로 정규화해 내보낸다 — Response 도 exceljs 의 load 도
   * 런타임에는 Uint8Array 를 그대로 받는다. 타입 인자를 `ArrayBuffer` 로 못 박는
   * 것은 `BodyInit` 이 `Uint8Array<ArrayBufferLike>`(SharedArrayBuffer 도 될 수
   * 있는 형태)를 받지 않기 때문이다.
   */
  const out: unknown = await wb.xlsx.writeBuffer()
  // 런타임에는 Node Buffer(= Uint8Array) 다. ArrayBuffer 가 와도 받아 준다.
  return out instanceof Uint8Array ? new Uint8Array(out) : new Uint8Array(out as ArrayBuffer)
}

function styleHeaderCell(cell: ExcelJS.Cell): void {
  cell.font = { bold: true, size: 11, color: { argb: INK } }
  cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: THEAD } }
  cell.border = THIN_BORDER
}

function put(
  ws: ExcelJS.Worksheet,
  rowNo: number,
  col: number,
  value: string | number,
  horizontal: 'left' | 'center' | 'right',
  numFmt?: string,
): void {
  const cell = ws.getCell(rowNo, col)
  cell.value = value
  cell.alignment = { vertical: 'middle', horizontal }
  cell.border = THIN_BORDER
  cell.font = { color: { argb: INK } }
  // 서식은 숫자에만 건다. '-' 같은 문자열에 백분율 서식을 걸면 엑셀이 그 칸을
  // 숫자로 취급하려다 표시가 깨진다.
  if (numFmt !== undefined && typeof value === 'number') cell.numFmt = numFmt
}
