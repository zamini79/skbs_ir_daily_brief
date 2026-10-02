/**
 * ─── 뉴스 칸을 다른 행과 함께 쓰는 행 ──────────────────────────────────────
 *
 * 키 행은 **자기 뉴스를 갖지 않고** 값 행의 뉴스 칸을 함께 쓴다(quoteSymbol 기준).
 *
 * 2026-10-02 담당자 피드백: 「S&P500 과 Nasdaq 은 한 칸에 기사 하나로 취합」. 두 지수의
 * 뉴스는 같은 기사다 — 매일 아침 연합뉴스 「뉴욕증시 종합」 한 건이 세 지수(다우·S&P·
 * 나스닥)를 함께 다룬다. 행마다 따로 뽑으면 같은 사건이 두 칸에 두 번 실리거나, 한쪽에
 * 덜 중요한 기사가 들어간다.
 *
 * 그래서 이 표 하나가 세 곳을 함께 정한다. **셋이 다른 표를 보면 안 된다:**
 *  - 수집(pipeline/instrumentNews.ts) — 키 행은 뉴스 검색을 아예 하지 않는다.
 *  - 검수 화면(db/repo.ts 의 rowDisplayState, BriefTable) — 키 행은 `NEWS_SHARED` 이고
 *    뉴스 칸이 값 행의 칸과 병합된다(rowSpan). 「미검토」 수에 들어가지 않는다.
 *  - 엑셀(domain/excel.ts, export/workbook.ts) — 같은 규칙으로 mergeCells 하고,
 *    공란 경고 수에 들어가지 않는다.
 *
 * DB 컬럼이 아니라 코드 상수인 이유: 과거 날짜에도 같은 규칙으로 보여야 한다. 공유
 * 이전에 수집된 날은 Nasdaq 후보가 DB 에 남아 있지만, 화면은 그 후보를 보이지 않고
 * 똑같이 병합해 보여 준다 — 날짜마다 표 모양이 달라지면 담당자가 그 차이를 뜻으로 읽는다.
 *
 * 시세 칸은 이 표와 무관하다. 두 행 모두 자기 시세를 그대로 갖는다.
 */
export const NEWS_SHARED_WITH: Readonly<Record<string, string>> = {
  '.IXIC': '.INX', // Nasdaq → S&P500
}

/** 이 행의 뉴스 칸을 실제로 가진 행의 quoteSymbol. 공유하지 않으면 자기 자신이다. */
export function newsOwnerSymbol(quoteSymbol: string): string {
  return NEWS_SHARED_WITH[quoteSymbol] ?? quoteSymbol
}

/** 이 행이 자기 뉴스를 갖는가(= 뉴스를 검색하고 검수하는 행인가). */
export function ownsNews(quoteSymbol: string): boolean {
  return newsOwnerSymbol(quoteSymbol) === quoteSymbol
}

/**
 * 표에서 행마다 뉴스 칸이 몇 행을 덮는지 정한다. 화면(rowSpan)과 엑셀(mergeCells)이
 * **둘 다 이 함수 하나**를 쓴다.
 *
 *   1 이상 — 이 행이 뉴스 칸을 그리고, 그 칸이 자기 행부터 N행을 덮는다.
 *   0      — 이 행은 뉴스 칸을 그리지 않는다(바로 위 소유 행의 칸에 덮인다).
 *
 * **병합은 소유 행 바로 아래에 붙어 있을 때만 한다.** 정렬이 바뀌어 두 행이 떨어지면
 * 사이에 있는 남의 행까지 덮을 수 없으므로 병합하지 않고 1 을 준다 — 그때 그 행은
 * 자기 칸에 「…칸 참조」를 적는다(호출부). 조용히 다른 행의 칸에 섞이지 않는다.
 */
export function newsCellSpans(rows: Array<{ quoteSymbol: string }>): number[] {
  const spans = rows.map(() => 1)
  let start = -1
  rows.forEach((r, i) => {
    const owner = newsOwnerSymbol(r.quoteSymbol)
    if (owner !== r.quoteSymbol && start >= 0 && rows[start].quoteSymbol === owner) {
      spans[start]++
      spans[i] = 0
    } else {
      start = i
    }
  })
  return spans
}

/**
 * index 행이 속한 뉴스 묶음의 **마지막 행 번호**. 화면이 펼침 패널을 이 뒤에 그린다 —
 * 묶음 한가운데 패널 행을 끼우면 rowSpan 이 그 패널 행까지 덮어 표가 깨진다.
 */
export function newsGroupEnd(spans: number[], index: number): number {
  let start = index
  while (start > 0 && spans[start] === 0) start--
  return start + Math.max(spans[start], 1) - 1
}
