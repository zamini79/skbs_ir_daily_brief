import { formatPrevDiff, formatPrice } from '@/domain/format'
import { newsColumnContent, type ClientRow, type RowState } from '@/db/repo'

/**
 * 검수 화면의 행을 **엑셀 셀 값**으로 바꾼다. 순수 함수만 있다 — exceljs 도
 * Prisma 도 부르지 않는다. "무엇을 어느 칸에 넣을지"는 전부 여기서 정하고,
 * 워크북 조립(`src/export/workbook.ts`)은 여기서 정한 값을 받아 적기만 한다.
 *
 * ─── 이 파일의 규칙 하나 ────────────────────────────────────────────────
 * **엑셀 칸은 화면 칸보다 더 확정된 것처럼 보여선 안 된다.**
 *
 * 엑셀은 메일에 붙어 전 임원에게 나가는 최종 산출물이다. 화면에서 「미확정」·
 * 「시세 실패」·「기준일 미상」으로 구분해 둔 것이 파일에서 평범한 값으로
 * 뭉개지면, 이 시스템이 막으려던 사고가 파일 안에서 그대로 일어난다.
 * 그래서:
 *
 *  - **미확정(PENDING·STALE_SELECTION) 뉴스는 내보내지 않는다.** 화면의
 *    「미확정 · 1순위 후보」 미리보기는 시스템 제안이지 담당자의 결정이 아니다.
 *    빈 칸으로 나간다.
 *  - **시세 조회 실패는 공란이 아니라 「시세 실패」라고 적는다.** 공란은
 *    "값이 없다"로 읽히는데 사실은 "받아오지 못했다"이다.
 *  - **기준일을 모르면 주가 칸에 그렇게 적는다.** 원본 엑셀에 기준일 칼럼이
 *    없으므로 칼럼을 늘리지 않고 값 옆에 경고로 붙인다. 기준일을 아는
 *    평상시에는 아무것도 붙이지 않는다(원본과 같은 모양).
 *  - **수기 입력값도 그렇게 적는다.** 자동 수집값과 같은 모양이면 안 된다.
 *
 * 반대로 **폴백 소스 표시(「ft 대체」)는 내보내지 않는다.** 그건 값의 신뢰도가
 * 아니라 1차 소스의 건강 상태에 대한 운영 신호이고(repo.ts 의
 * quoteFallbackSourceUsed 주석), 값 자체는 정상이라 담당자가 할 일도 없다.
 * 메일 받는 사람에게는 판단에 쓸 수 없는 정보다.
 */

/** 값이 없거나 담당자가 싣지 않기로 한 칸. */
export const DASH = '-'

/** 원본 브리프 엑셀의 머리글. 행4 는 시가총액 아래 단위 줄이다. */
export const SHEET_TITLE = '주가 현황 및 뉴스'
export const HEADERS = ['구분', '기업', '주가', '전일대비', '%', '연초대비', '시가총액', '뉴스'] as const
export const MARKET_CAP_UNIT = '(조원)'

export type ExcelValue = string | number

export type ExcelInstrumentRow = {
  category: string
  name: string
  /** 문자열이다. 통화 표기(KRW/USD/GBX…)가 칸마다 달라 숫자로 넣으면 통화가 사라진다. */
  price: ExcelValue
  prevDiff: ExcelValue
  /** 소수(0.0092). **문자열 "0.92%" 로 넣지 않는다** — 엑셀에서 계산이 안 된다. */
  changePct: ExcelValue
  /** 소수. changePct 와 같은 이유. */
  ytdPct: ExcelValue
  /** 숫자(조원). 서식이 소수 둘째 자리를 붙인다. */
  marketCap: ExcelValue
  /** 종목당 첫 행의 뉴스 칸. 미확정이면 빈 문자열이다. */
  newsTitle: string
  /** 종목당 둘째 행의 뉴스 칸. */
  newsSummary: string
}

/**
 * 이 행의 뉴스가 **담당자의 결정이 아닌** 상태인가.
 * PENDING(아직 안 봄)과 STALE_SELECTION(골랐지만 재수집으로 무효화됨)이 여기 든다.
 * 둘 다 "다시 봐야 하는 행"이고, 둘 다 엑셀에서는 빈 칸으로 나간다.
 */
export function isUnconfirmedForExport(state: RowState): boolean {
  return state === 'PENDING' || state === 'STALE_SELECTION'
}

type NewsCells = { title: string; summary: string }
const BLANK: NewsCells = { title: '', summary: '' }

/**
 * 뉴스 두 칸. 화면과 **같은 순수 함수**(newsColumnContent)로 무엇을 실을지 정한다 —
 * 엑셀 전용 조회나 전용 판정을 따로 두면 화면과 파일이 다른 내용을 보여주게 된다.
 *
 * **결과가 세 가지이고 서로 달라야 한다.** 서로 다른 사실이라, 파일에서 둘로
 * 합쳐지는 순간 그중 하나가 거짓이 된다:
 *
 *  - 빈 칸 `''` — 아직 정해지지 않았다 (미검토 · 선택 무효화됨)
 *  - `-` — 실을 것이 없다고 **정해졌다** (기사 없음 · 담당자가 뺌)
 *  - 「뉴스 조회 실패 — 확인 필요」 — 확인하지 **못했다** (기사가 있었을 수 있다)
 *
 * 화면은 다운로드 버튼 옆에 앞의 두 경우가 몇 건인지 미리 알려준다.
 */
export function excelNewsCells(row: {
  state: RowState
  candidates: ClientRow['candidates']
  selection: Pick<ClientRow['selection'], 'chosenCandidateId' | 'chosenSummaryId' | 'editedText'>
}): NewsCells {
  if (isUnconfirmedForExport(row.state)) return BLANK

  const content = newsColumnContent({
    state: row.state,
    candidates: row.candidates,
    chosenCandidateId: row.selection.chosenCandidateId,
    chosenSummaryId: row.selection.chosenSummaryId,
    editedText: row.selection.editedText,
  })

  if (content.kind === 'article') {
    // state 로 이미 걸렀지만 confirmed 를 한 번 더 본다. 이 두 겹 중 하나가
    // 리팩터링으로 사라져도 나머지 하나가 미확정 미리보기를 막는다.
    if (!content.confirmed) return BLANK
    return { title: content.title, summary: content.summary ?? '' }
  }

  // 조회 실패는 `-` 로 내보내면 안 된다. 이 파일은 전 임원에게 메일로 나가는 최종
  // 산출물이고, 거기서 `-` 는 **"오늘 이 회사 뉴스가 없었다"는 사실 주장**이다.
  // 실제로는 검색을 못 해서 모르는 것이다 — 담당자가 직접 찾아봐야 하는 행이,
  // 아무것도 할 일이 없는 행과 파일에서 똑같이 보이면 안 된다. 화면에서 없앤
  // 거짓말을 파일에서 되살리지 않는다(repo.ts 의 NEWS_FAILED 주석과 같은 이유).
  //
  // STALE_SELECTION 도 kind:'label' 이지만 그 **상태**로는 여기 오지 않는다 —
  // isUnconfirmedForExport 가 위에서 공란으로 걸러낸다(미확정이지 부재가 아니다).
  //
  // 다만 kind:'label' 로 오는 경로가 하나 더 있다: decision 이 SELECTED 인데 고른
  // 후보를 목록에서 찾지 못한 방어 경로다(repo.ts). 그때 text 는 STALE_SELECTION
  // 라벨이고, 그건 담당자에게 "다시 보라"는 말이지 메일 받는 사람에게 할 말이
  // 아니다. 그 행은 미확정이므로 공란으로 내보낸다 — state 만으로는 SELECTED 라
  // 위쪽 필터에 걸리지 않으니 여기서 잡는다.
  if (content.kind === 'label') {
    return row.state === 'NEWS_FAILED' ? { title: content.text, summary: '' } : BLANK
  }

  // kind: 'none'(기사 없음) | 'omitted'(담당자가 뺌). 둘 다 "실을 것이 없다"로
  // 결정된 상태라 원본 엑셀과 같이 `-` 다. 화면에서는 「싣지 않음」 태그로 갈리지만,
  // 최종 산출물에서는 결과가 같다 — 왜 비었는지는 메일 받는 사람의 관심사가 아니다.
  return { title: DASH, summary: '' }
}

/** 주가 칸. 값이 없으면 왜 없는지까지 말한다. */
export function excelPriceCell(row: Pick<ClientRow, 'instrument' | 'display' | 'quote' | 'quoteFailReason'>): string {
  if (row.display.close === null) {
    return row.quoteFailReason !== null ? '시세 실패' : DASH
  }
  const base = formatPrice(row.display.close, row.instrument.currency, row.instrument.isIndex)
  const notes: string[] = []
  if (row.display.isManual) notes.push('수기')
  // 기준일을 아는 평상시에는 아무것도 붙이지 않는다 — 원본 엑셀과 같은 모양이다.
  // 모를 때만 그 사실을 적는다. 해외 종목은 전영업일 종가일 수 있어서 담당자가
  // 지연을 판단할 근거가 필요하다(스펙 §3.2·§13.2).
  if (row.quote?.asOf == null) notes.push('기준일 미상')
  return notes.length > 0 ? `${base} (${notes.join(', ')})` : base
}

export function excelMarketCapCell(
  row: Pick<ClientRow, 'quote' | 'marketCapBlankReason'>,
): ExcelValue {
  if (row.marketCapBlankReason === 'FX_UNAVAILABLE') return '환율 미확보'
  return row.quote?.marketCapKrwTrillion ?? DASH
}

export function toExcelRows(rows: ClientRow[]): ExcelInstrumentRow[] {
  return rows.map(row => {
    const news = excelNewsCells(row)
    return {
      category: row.instrument.category,
      name: row.instrument.name,
      price: excelPriceCell(row),
      prevDiff: formatPrevDiff(row.display.close, row.display.prevClose),
      changePct: row.display.changePct ?? DASH,
      ytdPct: row.quote?.ytdPct ?? DASH,
      marketCap: excelMarketCapCell(row),
      newsTitle: news.title,
      newsSummary: news.summary,
    }
  })
}

/**
 * 뉴스 칸이 **빈 채로** 나가는 행 수. 다운로드 버튼 옆 경고에 쓴다.
 *
 * 상태를 따로 세지 않고 **실제로 만들어진 셀을 센다.** 상태로 세면 "무엇이 비는가"의
 * 판정이 두 곳이 되고, 언젠가 한쪽만 바뀌어 "몇 건이 빕니다"가 실제 파일과 어긋난다 —
 * 틀린 경고는 없느니만 못하다. 23행짜리 표라 한 번 더 만드는 비용은 없다.
 */
export function countBlankNewsCells(rows: ClientRow[]): number {
  return toExcelRows(rows).filter(r => r.newsTitle === '').length
}

/**
 * 뉴스 칸에 「뉴스 조회 실패 — 확인 필요」가 **적혀서** 나가는 행 수.
 *
 * 그 문구는 메일 받는 사람 눈에 그대로 보인다. 담당자가 누르기 전에 몇 건이 그렇게
 * 나가는지 알아야 파일을 붙이기 전에 처리할 수 있다.
 */
export function countNewsFailed(rows: Array<{ state: RowState }>): number {
  return rows.filter(r => r.state === 'NEWS_FAILED').length
}

export function excelFileName(date: string): string {
  return `IR_Daily_Brief_${date}.xlsx`
}
