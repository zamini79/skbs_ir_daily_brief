/**
 * ─── 뉴스 칸 서식 (화면 + 엑셀) ────────────────────────────────────────────
 *
 * 2026-10-02 담당자 피드백: 담당자는 화면의 기사 제목·요약을 **복사해 임원 메일에
 * 붙인다.** 그래서 서식이 곧 메일의 서식이다:
 *
 *   기사 제목 — 파란색(#0563C1), 굵게, 밑줄, 맑은 고딕 10pt
 *   요약     — 검정(#000000), 굵게 아님, 맑은 고딕 10pt
 *   이탤릭   — 어디에도 쓰지 않는다(미확정 미리보기 포함)
 *
 * **화면은 인라인 style 로 건다.** 클래스(Tailwind)는 복사→Outlook 붙여넣기에서
 * 붙여넣기 대상에 따라 빠진다 — 계산된 스타일을 함께 실어 주는 브라우저도 있지만
 * 보장되지 않는다. 인라인 style 은 HTML 클립보드에 그대로 실린다.
 *
 * 밑줄은 **항상** 긋는다(hover 때만이 아니다). 메일에 붙은 제목은 hover 할 일이 없다.
 * #0563C1 은 Office 의 기본 하이퍼링크 색이다 — 엑셀 칸도 같은 색이고, 그 칸에는
 * 실제 하이퍼링크를 건다(파란 밑줄이 링크가 아니면 거짓 신호다. export/workbook.ts).
 *
 * 화면과 엑셀이 같은 값을 쓰도록 한곳에 둔다. 한쪽만 바뀌면 화면에서 복사한 메일과
 * 엑셀을 붙인 메일이 다른 모양이 된다.
 */

export const NEWS_FONT_FAMILY = "'Malgun Gothic', '맑은 고딕', sans-serif"
export const NEWS_TITLE_COLOR = '#0563C1'
export const NEWS_SUMMARY_COLOR = '#000000'

/** React `style` 로 바로 넘긴다. CSSProperties 의 부분집합이라 타입을 따로 끌어오지 않는다. */
export const NEWS_TITLE_STYLE = {
  color: NEWS_TITLE_COLOR,
  fontWeight: 700,
  fontStyle: 'normal',
  textDecoration: 'underline',
  fontFamily: NEWS_FONT_FAMILY,
  fontSize: '10pt',
} as const

export const NEWS_SUMMARY_STYLE = {
  color: NEWS_SUMMARY_COLOR,
  fontWeight: 400,
  fontStyle: 'normal',
  textDecoration: 'none',
  fontFamily: NEWS_FONT_FAMILY,
  fontSize: '10pt',
} as const

/** exceljs 의 Font. 엑셀은 글꼴 이름 하나만 받으므로 영문 이름을 쓴다(한글판 엑셀도 같은 글꼴로 연다). */
export const EXCEL_NEWS_TITLE_FONT = {
  name: 'Malgun Gothic',
  size: 10,
  bold: true,
  italic: false,
  underline: true,
  color: { argb: 'FF0563C1' },
} as const

export const EXCEL_NEWS_SUMMARY_FONT = {
  name: 'Malgun Gothic',
  size: 10,
  bold: false,
  italic: false,
  color: { argb: 'FF000000' },
} as const
