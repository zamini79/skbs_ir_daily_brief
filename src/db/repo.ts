import { prisma } from './client'
import { changePct as calcChangePct } from '@/domain/calc'
import { monthRange } from '@/domain/calendar'
import { runProgressView } from '@/domain/runProgress'
import { ownsNews } from '@/domain/newsShare'
import type { Prisma } from '@prisma/client'

export type RowState =
  | 'NEWS_FAILED'
  | 'NO_NEWS'
  | 'OMITTED'
  | 'PENDING'
  | 'SELECTED'
  | 'STALE_SELECTION'
  | 'NEWS_SHARED'

/**
 * 시스템이 후보를 못 만든 것(NO_NEWS)과 담당자가 뺀 것(OMITTED)은 다르다.
 * 출력 표에서는 둘 다 공란이지만 검수 화면에서는 구분해 보여야 한다.
 *
 * NEWS_FAILED 는 NO_NEWS 와 반드시 갈라야 한다. 둘 다 후보 0건이지만 뜻이 정반대다 —
 * NO_NEWS 는 "찾아봤고 없었다"(사실)이고 NEWS_FAILED 는 "못 찾아봤다"(모름)이다.
 * 예전에는 네이버 429 로 검색이 실패한 행까지 「당일·D-1 기사 없음」이라고 단정해서,
 * 담당자가 "오늘 이 회사 뉴스가 없구나"로 읽었다. 실제로는 기사가 있었다.
 *
 * decision이 SELECTED인데 chosenCandidateId가 null이면, 담당자가 고른 뒤 재수집이
 * 일어나 그 후보가 삭제되고 FK(onDelete: SetNull)가 참조를 null로 되돌린 것이다.
 * decision 필드 자체는 저절로 되돌아가지 않으므로 여기서 잡아 SELECTED로 잘못
 * 표시되지 않게 한다.
 *
 * collectHelpers.needsPendingRevert()를 그대로 쓰지 않고 chosenCandidateId만 본다.
 * 그 함수는 chosenCandidateId나 chosenSummaryId 둘 중 하나만 null이어도 무효로
 * 보는데, "후보는 골랐지만 그 후보에 애초에 요약이 없어(summaryError 없이 빈
 * summaries) chosenSummaryId가 null인" 것은 무효화가 아니라 정상적으로 끝난
 * 선택이다 — 2026-08-27 실행 기준 후보 26건 중 20건이 이 경우였다. 그 조건을
 * 그대로 쓰면 그런 정상 선택 다수가 "선택 무효화됨"으로 잘못 표시된다. 재수집이
 * 후보 자체를 지우면 chosenCandidateId와 chosenSummaryId가 항상 함께 null이
 * 되므로(요약도 그 후보에 딸려 지워짐), chosenCandidateId 하나만 봐도 진짜
 * 무효화 신호를 놓치지 않는다.
 *
 * NEWS_SHARED 는 **자기 뉴스 칸이 없는 행**이다(domain/newsShare.ts — Nasdaq 은
 * S&P500 의 칸을 함께 쓴다). 맨 먼저 판정한다. 그 행은 뉴스를 검색하지 않으므로
 * NewsFetch 기록이 없고, 그대로 두면 NO_NEWS(「기사 없음」)로 **단정**된다 — 사실이
 * 아니다. 공유 이전 날짜에는 후보가 남아 있어 PENDING(「미검토」)이 되는데, 그러면
 * 담당자에게 할 일처럼 보인다. 검수는 소유 행에서만 한다.
 */
export function rowDisplayState(row: {
  /**
   * 뉴스 칸 공유 판정의 키(domain/newsShare.ts). **필수다** — 선택 인자로 두면 호출부에서
   * 이 줄이 지워져도 타입이 통과하고 Nasdaq 이 조용히 「미검토」·「기사 없음」으로 돌아간다.
   * getBriefRows 는 Prisma 를 써서 테스트가 부르지 못하는 자리라 타입이 유일한 방어선이다.
   */
  quoteSymbol: string
  candidateCount: number
  decision: string
  chosenCandidateId: string | null
  /** NewsFetch.status. 기록이 없으면 null (이 기록이 생기기 전에 수집된 실행). */
  newsFetchStatus?: string | null
}): RowState {
  if (!ownsNews(row.quoteSymbol)) return 'NEWS_SHARED'
  // 후보가 0건인 이유가 두 가지다. 검색이 실패했다면 "기사가 없다"고 말할 근거가
  // 없으므로 NO_NEWS 로 뭉뚱그리지 않는다 — 담당자가 직접 찾아봐야 하는 행이다.
  if (row.candidateCount === 0 && row.newsFetchStatus === 'FAILED') return 'NEWS_FAILED'
  if (row.candidateCount === 0) return 'NO_NEWS'
  if (row.decision === 'OMITTED') return 'OMITTED'
  if (row.decision === 'SELECTED') {
    return row.chosenCandidateId === null ? 'STALE_SELECTION' : 'SELECTED'
  }
  return 'PENDING'
}

const ROW_STATE_LABEL: Record<RowState, string> = {
  NEWS_FAILED: '뉴스 조회 실패 — 확인 필요',
  NO_NEWS: '당일·D-1 기사 없음',
  OMITTED: '싣지 않음 (담당자 결정)',
  PENDING: '미검토',
  SELECTED: '선택 완료',
  STALE_SELECTION: '선택 무효화됨 (재수집으로 초기화 — 다시 검토 필요)',
  NEWS_SHARED: '뉴스는 위 행과 한 칸 (검수는 그 행에서)',
}

export function rowStateLabel(state: RowState): string {
  return ROW_STATE_LABEL[state]
}

const RUN_STATUS_LABEL: Record<string, string> = {
  COLLECTING: '수집 중',
  READY: '준비 완료',
  PARTIAL: '부분 완료',
  FAILED: '실패',
}

/** 알려지지 않은 상태 문자열이 와도 화면이 깨지지 않도록 원문을 그대로 돌려준다. */
export function runStatusLabel(status: string): string {
  return RUN_STATUS_LABEL[status] ?? status
}

/** sameEventAsRank 배지 문구. rank 는 더 높은(작은 숫자) 후보의 순위다. */
export function sameEventBadgeLabel(rank: number): string {
  return `${rank}위와 같은 사건`
}

/**
 * summaryError 원문을 담당자용 짧은 문구로 줄인다. 원문 자체는 지우지 않는다 —
 * 호출자가 title 등으로 운영자에게 그대로 보여줄 수 있게 남겨 둔다.
 *
 * providers/summarize/gemini.ts 가 던지는 예외 메시지는 항상 "gemini:" 또는
 * "gemini HTTP"로 시작하고, 실패한 모델 식별자를 나열한다(예: "gemini: 모든 모델이
 * 실패했다 (쿼터 소진: gemini-3.5-flash-lite, ...)") — 담당자에게는 의미 없고 아침에
 * 급하게 훑는 화면만 어지럽힌다. 반대로 collect.ts 의 EMPTY_BODY_REASON/
 * QUOTA_EXHAUSTED_REASON 처럼 이미 사람이 읽으라고 쓴 짧은 한국어 문장은 그대로
 * 보여준다 — 전부 "모델 요약 실패"로 뭉뚱그리면 "본문이 짧아 애초에 시도하지 않은
 * 것"을 "모델이 시도했다가 실패한 것"이라고 잘못 말하게 된다.
 *
 * "gemini:"류 원문 안에서도 원인을 알아볼 수 있으면(할당량 소진) 그렇게 말하고,
 * 못 알아보면(세이프티 차단, JSON 파싱 실패 등) 원인을 지어내지 않고
 * "모델 요약 실패"까지만 말한다.
 */
export function summaryErrorShortLabel(raw: string): string {
  if (!/^gemini(:| HTTP)/i.test(raw)) return raw
  if (/소진|RESOURCE_EXHAUSTED|\b429\b/i.test(raw)) return '모델 요약 실패 — 할당량 소진'
  return '모델 요약 실패'
}

/**
 * 뉴스 칼럼에 무엇을 보여줄지 정한다. 이 칼럼이 이제 상태 배지를 대신하므로,
 * 상태 정보를 잃지 않으면서(NEWS_FAILED/STALE_SELECTION은 지금 라벨을 유지)
 * 기사 링크+요약(SELECTED/PENDING)을 함께 보여줘야 한다.
 *
 * PENDING의 'article'은 반드시 confirmed: false 로 표시된다 — 1순위 후보를
 * 미리보기로 보여주는 것이지 담당자가 확정한 것이 아니다. SELECTED와 같은 'article'
 * kind를 쓰되 confirmed 플래그로 구분해, 호출자가 시각적으로도(「미확정」 배지·행
 * 배경 등) 절대 같아 보이지 않게 렌더해야 한다 — 확정본과 구분되지 않으면 담당자가
 * 미확정 미리보기를 그대로 메일에 싣게 된다. 글자 서식(기울임·색)으로 가르지는
 * 않는다 — 담당자가 이 칸을 복사해 메일에 붙이므로 서식이 메일까지 따라간다
 * (2026-10-02 피드백, BriefTable 의 NewsCell 주석).
 *
 * OMITTED는 NO_NEWS와 똑같이 '텅 빈 칸'으로 보이면 안 된다 — 하나는 "기사가
 * 없었다"(NO_NEWS)이고 하나는 "담당자가 뺐다"(OMITTED)라서, 별도 kind로
 * 구조적으로 갈라 둔다. NEWS_FAILED("못 찾아봤다")도 이 둘과 절대 같은 문자열로
 * 수렴하면 안 된다 — 'label' kind로 완전히 다른 값을 돌려준다.
 *
 * 'article'의 isFallback은 표시 중인 summary가 모델 요약이 아니라 본문에서
 * 기계적으로 뽑아낸 대체 텍스트(NewsSummary.isFallback)라는 뜻이다. 이 칼럼이
 * 검수자가 표만 보고 메일 초안을 판단하는 화면이 됐으므로, 발췌본을 모델
 * 요약과 구분 없이 보여주면 검수자가 다듬지 않은 발췌를 그대로 실을 수 있다 —
 * RowPanel의 "본문 발췌 (모델 요약 실패)" 배지와 같은 사실을 표에서도 알려야 한다.
 */
export type NewsColumnContent =
  | { kind: 'article'; confirmed: boolean; title: string; url: string; summary: string | null; isFallback: boolean }
  | { kind: 'omitted' }
  | { kind: 'none' }
  | { kind: 'label'; text: string }
  /** 다른 행과 함께 쓰는 칸. 내용은 소유 행이 그린다(화면은 병합, 병합이 안 되면 참조 문구). */
  | { kind: 'shared' }

export function newsColumnContent(row: {
  state: RowState
  candidates: Array<Pick<ClientCandidate, 'id' | 'rank' | 'title' | 'url' | 'summaries'>>
  chosenCandidateId: string | null
  chosenSummaryId: string | null
  editedText: string | null
}): NewsColumnContent {
  switch (row.state) {
    case 'NEWS_SHARED':
      return { kind: 'shared' }
    case 'NEWS_FAILED':
    case 'STALE_SELECTION':
      return { kind: 'label', text: rowStateLabel(row.state) }
    case 'NO_NEWS':
      return { kind: 'none' }
    case 'OMITTED':
      return { kind: 'omitted' }
    case 'SELECTED': {
      const cand = row.candidates.find(c => c.id === row.chosenCandidateId)
      // rowDisplayState가 SELECTED를 주는 것은 chosenCandidateId가 유효한 후보를
      // 가리킬 때뿐이므로 정상 경로에서는 항상 찾는다. 그래도 못 찾으면(방어적으로)
      // STALE_SELECTION과 같은 라벨로 떨어뜨린다 — 존재하지 않는 후보를 가리키는
      // "확정본"을 보여주는 것보다 안전하다.
      if (!cand) return { kind: 'label', text: rowStateLabel('STALE_SELECTION') }
      const chosenSummary = cand.summaries.find(s => s.id === row.chosenSummaryId)
      // editedText가 있으면 그것이 최종 산출물이다 — 요약 원문이 남아 있어도 우선한다.
      // 빈 문자열은 편집분으로 치지 않는다. `?? ` 만 쓰면 ''(담당자가 텍스트를 지우고
      // blur 한 경우)가 값으로 취급돼 고른 요약이 영구히 가려진다 — 행은 여전히
      // 「선택 완료」라서 화면만 보고는 왜 비었는지 알 수 없다. 쓰기 쪽에서도
      // null 로 정규화하지만(actions.ts), 이미 ''로 저장된 행이 있으므로 여기서도 막는다.
      const edited = row.editedText !== null && row.editedText.trim() !== '' ? row.editedText : null
      const summary = edited ?? chosenSummary?.text ?? null
      // isFallback은 editedText 유무와 무관하게 chosenSummary 레코드 자체의 값이다.
      // editedText는 담당자가 손을 댔다는 뜻이지 발췌 출신이라는 사실을 지우지
      // 않는다 — draft가 원문 발췌를 그대로 두고 blur만 한 것일 수도 있으므로,
      // 표는 "손봤다고 주장"이 아니라 "원본이 발췌였다"는 사실을 계속 보여준다.
      return {
        kind: 'article',
        confirmed: true,
        title: cand.title,
        url: cand.url,
        summary,
        isFallback: chosenSummary?.isFallback ?? false,
      }
    }
    case 'PENDING': {
      // candidateCount === 0이면 rowDisplayState가 PENDING을 주지 않으므로
      // (NO_NEWS/NEWS_FAILED로 먼저 빠진다) 여기서는 후보가 항상 최소 1건 있다.
      const cand = row.candidates.find(c => c.rank === 1) ?? row.candidates[0]
      if (!cand) return { kind: 'none' }
      const previewSummary = cand.summaries.find(s => s.variant === 1)
      return {
        kind: 'article',
        confirmed: false,
        title: cand.title,
        url: cand.url,
        summary: previewSummary?.text ?? null,
        isFallback: previewSummary?.isFallback ?? false,
      }
    }
  }
}

export type CategoryGroup<T> = { category: string; rows: T[] }

/**
 * displayOrder 로 이미 정렬된 rows 를 구분(국내사/해외사/Index)별로 묶는다.
 * 인접한 같은 구분만 하나로 합친다 — 정렬이 깨졌을 때 조용히 잘못 묶지 않기 위함.
 */
export function groupByCategory<T extends { instrument: { category: string } }>(
  rows: T[],
): CategoryGroup<T>[] {
  const groups: CategoryGroup<T>[] = []
  for (const row of rows) {
    const last = groups[groups.length - 1]
    if (last && last.category === row.instrument.category) {
      last.rows.push(row)
    } else {
      groups.push({ category: row.instrument.category, rows: [row] })
    }
  }
  return groups
}

export type DisplayQuote = {
  close: number | null
  prevClose: number | null
  changePct: number | null
  /** 수기 입력값으로 대체된 것이면 true — 화면에 표시해 담당자가 알 수 있게 한다. */
  isManual: boolean
}

/**
 * 화면에 표시할 시세를 정한다.
 * 자동 소스가 온전한 값을 줬으면(close/prevClose 둘 다 있으면) 그걸 쓴다.
 * 아니면(코스피200 헬스케어처럼 소스가 아예 없거나, 있어도 이번에 실패했으면)
 * 담당자 수기 입력값(Selection.manualClose/manualPrevClose)을 쓴다.
 */
export function resolveDisplayQuote(args: {
  quoteClose: number | null
  quotePrevClose: number | null
  quoteChangePct: number | null
  manualClose: number | null
  manualPrevClose: number | null
}): DisplayQuote {
  if (args.quoteClose !== null && args.quotePrevClose !== null) {
    return {
      close: args.quoteClose,
      prevClose: args.quotePrevClose,
      changePct: args.quoteChangePct,
      isManual: false,
    }
  }
  if (args.manualClose !== null && args.manualPrevClose !== null) {
    return {
      close: args.manualClose,
      prevClose: args.manualPrevClose,
      changePct: calcChangePct(args.manualClose, args.manualPrevClose),
      isManual: true,
    }
  }
  return { close: null, prevClose: null, changePct: null, isManual: false }
}

/**
 * 시가총액이 비어 있는 이유 중 **환율 미확보로 단정할 수 있는 경우만** 골라낸다.
 * 알 수 없으면 null 을 주고, 화면은 아무 이유도 말하지 않는다 — 지어내지 않는다.
 *
 * 별도 저장이 필요 없다. QuoteSnapshot.fxRate 에 이미 종목별로 남아 있고
 * (resolveFxRate 가 통화를 못 찾으면 null), 그 값 하나로 판정이 끝난다.
 * 환율은 실행별·통화별 사실이지만 "이 행의 시총이 왜 비었나"는 행별 질문이라
 * 행에 이미 있는 값으로 답하는 게 맞다.
 *
 * **KRW 행은 통화만 보고 먼저 제외한다.** 국내 종목의 시총은 네이버가 직접 주므로
 * 보통은 값이 차 있어 2번 조건에서 걸러지지만, 그 논거는 quoteMarketCap 이 있을
 * 때만 성립한다 — 네이버 `/integration` 응답에 `marketValue` 가 빠지거나 파싱이
 * NaN 이면(naver.ts:45,52) resolveMarketCap 이 fxRate 검사까지 내려간다. 거기에
 * 환율 조회가 통째로 실패해 fx 가 빈 객체면 resolveFxRate('KRW', {}) 가 null 이라
 * 국내 행에 「환율 미확보」가 뜬다. KRW 는 환율이 필요 없는 통화다 — 화면이
 * 존재하지 않는 원인을 지어내게 된다.
 * (missingFxCurrencies 가 KRW 를 절대 담지 않는 것과 같은 이유다 —
 * collectHelpers.ts 의 그 독스트링을 그대로 참조한다.)
 */
export function marketCapBlankReason(row: {
  isIndex: boolean
  /** Instrument.currency. KRW 면 환율을 쓰지 않으므로 환율 탓을 할 수 없다. */
  currency: string
  marketCapKrwTrillion: number | null
  fxRate: number | null
  close: number | null
}): 'FX_UNAVAILABLE' | null {
  if (row.isIndex) return null // 지수는 시가총액 개념이 없다. 공란이 정상이다.
  if (row.currency === 'KRW') return null // 환율을 쓰지 않는 행. 환율 탓이라 말할 수 없다.
  if (row.marketCapKrwTrillion !== null) return null // 값이 있으니 설명할 게 없다.
  if (row.close === null) return null // 시세 자체가 실패한 행이다. 환율 탓이라 말할 수 없다.
  if (row.fxRate === null) return 'FX_UNAVAILABLE'
  return null // 환율은 있는데 시총이 없다(주식수 미등록 등). 원인을 단정하지 않는다.
}

/**
 * 시세 칸이 비어 있는 이유를 **수집 실패로 단정할 수 있는 경우에만** 원문 사유로 준다.
 * 규칙은 marketCapBlankReason 과 같다 — 모르면 null 이고, 그때 화면은 이유를 말하지 않는다.
 *
 * 이게 없으면 실패한 행이 주가·전일대비·%·연초대비 네 칸을 전부 `-` 로 보여주는데,
 * 그 `-` 는 "값이 없다"와 "받아오지 못했다"를 똑같이 뜻하게 된다. 사유는 이미
 * QuoteSnapshot.errorMessage 에 저장돼 클라이언트까지 실려 오지만 아무도 읽지 않았다.
 *
 * 두 경우는 실패가 아니므로 일부러 걸러낸다:
 *
 *  - **quoteSource 가 'manual'** — 수집을 시도조차 하지 않은 행이다. 파이프라인이
 *    '소스 없음(수기 입력 대상)' 을 errorMessage 에 남기지만 그건 기록이지 장애가 아니다.
 *    이걸 실패로 그리면 정상인 행에 매일 실패 딱지가 붙고, 진짜 실패와 구분이 사라진다.
 *  - **표시할 값이 있는 행** — 수기 입력값이 대신 채웠으면 담당자가 지금 할 일이 없다.
 *    그 행은 이미 '(수기)' 표시로 구분된다(resolveDisplayQuote).
 *
 * 사유는 지어내지 않는다. errorMessage 원문을 그대로 돌려주고, 원문이 없으면 null 이다.
 */
export function quoteFailureReason(row: {
  quoteSource: string
  displayClose: number | null
  errorMessage: string | null
}): string | null {
  if (row.quoteSource === 'manual') return null
  if (row.displayClose !== null) return null
  return row.errorMessage
}

/**
 * 이 행의 값이 **1차가 아닌 2차(폴백) 소스**에서 왔으면 그 소스 이름을 준다.
 * 아니면 null 이고, 그때 화면은 아무 표시도 하지 않는다.
 *
 * 왜 화면에 드러내야 하는가: 폴백은 값을 채우기 때문에 **실패처럼 보이지 않는다.**
 * 배너는 초록색이고 다섯 칸이 다 차 있다. 표시가 없으면 1차 소스가 몇 주째 죽어
 * 있어도 아무도 모르고, 그러면 이 장치는 "이중화"가 아니라 "장애 은폐"가 된다.
 *
 * 판정 근거는 **스냅샷에 수집 당시 저장한 `QuoteSnapshot.fallbackFrom`** 하나뿐이다.
 * 지금 시드(`Instrument.quoteSource`)는 보지 않는다.
 *
 * [폐기된 판정] 예전에는 `sourceName` 과 **지금** 시드의 `quoteSource` 의 차이로 판정했다
 * (「두 곳에 같은 사실을 적으면 언젠가 어긋난다」). 그런데 시드는 바뀐다 — Task 43 에서
 * 유럽 3종목의 1차를 FT 로 옮기자 과거 날짜의 평범한 행 52건에 거짓 「… 대체」가 붙고,
 * 진짜 폴백이었던 사노피 6건의 배지는 사라졌다. 「수집 당시 무엇이 1차였나」는 수집 때만
 * 알 수 있는 사실이라 그때 적어 둬야 한다. 같은 사실을 두 곳에 적는 게 아니다 — 시드는
 * 지금의 설정이고, 이 칸은 그날의 기록이다.
 *
 * 두 경우는 폴백이 아니므로 제외한다:
 *  - **표시할 값이 없는 행** — 폴백까지 실패했거나 통화 불일치로 값을 버린 행이다.
 *    그 행은 이미 「시세 실패」로 뜨고 사유에 두 소스가 모두 적혀 있다.
 *  - **수기 입력값으로 채워진 행** — 자동 수집의 산물이 아니다. '(수기)' 로 이미 구분된다.
 */
export function quoteFallbackSourceUsed(row: {
  /**
   * 그 행의 QuoteSnapshot **통째로**(없으면 null). `sourceName` 은 실제로 값을 가져온
   * 소스(배지 문구), `fallbackFrom` 은 수집 당시 실패한 1차(폴백이 아니었으면 null)다.
   *
   * 필드를 하나씩 받지 않는 이유: 호출부에서 `snapshotFallbackFrom: q?.sourceName` 처럼
   * 칸을 잘못 이으면 모든 행에 거짓 배지가 붙는데, 타입이 같아 아무것도 걸리지 않는다.
   * 스냅샷을 그대로 넘기면 잘못 이을 자리 자체가 없다.
   */
  snapshot: { sourceName: string; fallbackFrom: string | null } | null
  displayClose: number | null
  displayIsManual: boolean
}): string | null {
  if (row.snapshot === null) return null
  if (row.snapshot.fallbackFrom === null) return null
  if (row.displayClose === null) return null
  if (row.displayIsManual) return null
  return row.snapshot.sourceName
}

function toNum(v: Prisma.Decimal | number | null | undefined): number | null {
  if (v === null || v === undefined) return null
  return Number(v)
}

export type ClientSummary = {
  id: string
  variant: number
  text: string
  /** 모델이 만든 게 아니라 본문/스니펫에서 기계적으로 발췌한 대체 텍스트면 true. */
  isFallback: boolean
}

export type ClientCandidate = {
  id: string
  rank: number
  title: string
  url: string
  publisher: string
  publishedAt: string
  clusterSize: number
  sameEventAsRank: number | null
  summaryError: string | null
  summaries: ClientSummary[]
}

export type ClientSelection = {
  decision: string
  chosenCandidateId: string | null
  chosenSummaryId: string | null
  editedText: string | null
  manualClose: number | null
  manualPrevClose: number | null
}

export type ClientQuote = {
  close: number | null
  prevClose: number | null
  changePct: number | null
  ytdPct: number | null
  marketCapKrwTrillion: number | null
  asOf: string | null
  errorMessage: string | null
  /** 실제로 값을 가져온 소스(QuoteSnapshot.sourceName). 설정된 1차와 다를 수 있다. */
  sourceName: string
  /** 수집 당시 2차로 채웠으면 실패한 1차 소스(QuoteSnapshot.fallbackFrom), 아니면 null. */
  fallbackFrom: string | null
} | null

export type ClientInstrument = {
  id: string
  category: string
  displayOrder: number
  name: string
  currency: string
  isIndex: boolean
  quoteSource: string
  /** 뉴스 칸 공유 판정(domain/newsShare.ts)의 키. */
  quoteSymbol: string
}

export type ClientRow = {
  instrument: ClientInstrument
  quote: ClientQuote
  candidates: ClientCandidate[]
  selection: ClientSelection
  state: RowState
  display: DisplayQuote
  /** 뉴스 검색 실패 사유 원문. 성공했거나 기록이 없으면 null. 화면은 이 값만 근거로
   * 말하고 원인을 지어내지 않는다. */
  newsFetchError: string | null
  /** 시가총액이 비어 있는 이유를 환율 미확보로 단정할 수 있으면 'FX_UNAVAILABLE'.
   * 모르면 null 이고, 그때 화면은 이유를 말하지 않는다. */
  marketCapBlankReason: 'FX_UNAVAILABLE' | null
  /** 시세 칸이 비어 있는 이유를 수집 실패로 단정할 수 있으면 그 원문 사유. 아니면 null
   * (수기 입력 대상이거나, 표시할 값이 있거나, 사유가 기록되지 않았다). */
  quoteFailReason: string | null
  /** 1차가 실패해 2차 소스로 채운 행이면 그 소스 이름. 평소에는 null.
   * 실패는 아니지만 「평소 경로가 죽었다」는 사실이라 화면에 작게 드러낸다. */
  quoteFallbackSource: string | null
}

export type ClientRun = {
  id: string
  runDate: string
  tradeDate: string
  status: string
  /** 완료 사유. 진행 문구가 아니다 — 아래 progressDetail 과 칸이 나뉘어 있다. */
  statusDetail: string | null
  /** 수집이 도는 동안의 단계 문구. 끝난 실행에서는 null. */
  progressDetail: string | null
  /** 실행 시작 시각(ms). 화면이 「멈춘 것으로 보이는지」를 이 값으로 판정한다. */
  startedAtMs: number
}

/**
 * 검수 화면 한 페이지에 필요한 모든 데이터를 만든다.
 * DB 값(Decimal/Date)을 그대로 클라이언트 컴포넌트로 넘기면 RSC 직렬화 경계에서
 * 깨지므로, 여기서 전부 숫자/문자열로 변환해 돌려준다.
 */
export async function getBriefRows(runDate: string): Promise<{ run: ClientRun; rows: ClientRow[] } | null> {
  const run = await prisma.briefRun.findUnique({ where: { runDate } })
  if (!run) return null

  const instruments = await prisma.instrument.findMany({ orderBy: { displayOrder: 'asc' } })
  const quotes = await prisma.quoteSnapshot.findMany({ where: { runId: run.id } })
  const candidates = await prisma.newsCandidate.findMany({
    where: { runId: run.id },
    include: { summaries: { orderBy: { variant: 'asc' } } },
    orderBy: { rank: 'asc' },
  })
  const selections = await prisma.selection.findMany({ where: { runId: run.id } })
  const newsFetches = await prisma.newsFetch.findMany({ where: { runId: run.id } })

  const quoteBy = new Map(quotes.map(q => [q.instrumentId, q]))
  const selBy = new Map(selections.map(s => [s.instrumentId, s]))
  const fetchBy = new Map(newsFetches.map(f => [f.instrumentId, f]))

  const rows: ClientRow[] = instruments.map(inst => {
    const q = quoteBy.get(inst.id) ?? null
    const mine = candidates.filter(c => c.instrumentId === inst.id)
    const sel = selBy.get(inst.id) ?? null
    const fetched = fetchBy.get(inst.id) ?? null

    const quoteClose = toNum(q?.close)
    const quotePrevClose = toNum(q?.prevClose)
    const manualClose = toNum(sel?.manualClose)
    const manualPrevClose = toNum(sel?.manualPrevClose)

    const display = resolveDisplayQuote({
      quoteClose,
      quotePrevClose,
      quoteChangePct: q?.changePct ?? null,
      manualClose,
      manualPrevClose,
    })

    return {
      instrument: {
        id: inst.id,
        category: inst.category,
        displayOrder: inst.displayOrder,
        name: inst.name,
        currency: inst.currency,
        isIndex: inst.isIndex,
        quoteSource: inst.quoteSource,
        quoteSymbol: inst.quoteSymbol,
      },
      quote: q
        ? {
            close: quoteClose,
            prevClose: quotePrevClose,
            changePct: q.changePct,
            ytdPct: q.ytdPct,
            marketCapKrwTrillion: toNum(q.marketCapKrwTrillion),
            asOf: q.asOf,
            errorMessage: q.errorMessage,
            sourceName: q.sourceName,
            fallbackFrom: q.fallbackFrom,
          }
        : null,
      candidates: mine.map(c => ({
        id: c.id,
        rank: c.rank,
        title: c.title,
        url: c.url,
        publisher: c.publisher,
        publishedAt: c.publishedAt.toISOString(),
        clusterSize: c.clusterSize,
        sameEventAsRank: c.sameEventAsRank,
        summaryError: c.summaryError,
        summaries: c.summaries.map(s => ({ id: s.id, variant: s.variant, text: s.text, isFallback: s.isFallback })),
      })),
      selection: {
        decision: sel?.decision ?? 'PENDING',
        chosenCandidateId: sel?.chosenCandidateId ?? null,
        chosenSummaryId: sel?.chosenSummaryId ?? null,
        editedText: sel?.editedText ?? null,
        manualClose,
        manualPrevClose,
      },
      state: rowDisplayState({
        quoteSymbol: inst.quoteSymbol,
        candidateCount: mine.length,
        decision: sel?.decision ?? 'PENDING',
        chosenCandidateId: sel?.chosenCandidateId ?? null,
        newsFetchStatus: fetched?.status ?? null,
      }),
      display,
      newsFetchError: fetched?.error ?? null,
      marketCapBlankReason: marketCapBlankReason({
        isIndex: inst.isIndex,
        currency: inst.currency,
        marketCapKrwTrillion: toNum(q?.marketCapKrwTrillion),
        fxRate: q?.fxRate ?? null,
        close: quoteClose,
      }),
      quoteFailReason: quoteFailureReason({
        quoteSource: inst.quoteSource,
        displayClose: display.close,
        errorMessage: q?.errorMessage ?? null,
      }),
      quoteFallbackSource: quoteFallbackSourceUsed({
        snapshot: q ?? null,
        displayClose: display.close,
        displayIsManual: display.isManual,
      }),
    }
  })

  return {
    run: {
      id: run.id,
      runDate: run.runDate,
      tradeDate: run.tradeDate,
      status: run.status,
      statusDetail: run.statusDetail,
      progressDetail: run.progressDetail,
      startedAtMs: run.startedAt.getTime(),
    },
    rows,
  }
}

/* ------------------------------------------------------------------------ *
 * 달력·날짜 네비게이션
 *
 * 날짜 키는 **`runDate`** 다. `/review/[date]` 의 URL 키이고 `getBriefRows` 가
 * 찾는 값이며 `@@unique` 가 걸린 열이다. `tradeDate`(시세 기준일)는 실행에 따라
 * 다를 수 있으므로 달력이 그쪽을 쓰면 달력에서 누른 날짜와 열리는 화면의 날짜가
 * 어긋난다.
 *
 * 'YYYY-MM-DD' 문자열은 사전순 비교가 곧 날짜순 비교라, 문자열 열에 gte/lte 를
 * 걸어도 정확하다(자릿수가 항상 같다).
 * ------------------------------------------------------------------------ */

/**
 * 달력 한 칸이 말해야 하는 것. **`UNKNOWN` 이 있는 이유가 중요하다** — 모르는
 * 상태 문자열을 만났을 때 조용히 `DONE`(완료)으로 떨어뜨리면 달력이 "이 날은
 * 다 됐다"고 거짓으로 말하게 된다. 모르면 모른다고 표시한다.
 * `PARTIAL` 을 `DONE` 과 합치지 않는 것도 같은 이유다 — 부분 완료는 완료가 아니다.
 */
export type BriefDayMark = 'DONE' | 'PARTIAL' | 'RUNNING' | 'STALLED' | 'FAILED' | 'UNKNOWN'

const DAY_MARK: Record<string, BriefDayMark> = {
  READY: 'DONE',
  PARTIAL: 'PARTIAL',
  COLLECTING: 'RUNNING',
  FAILED: 'FAILED',
}

/**
 * 달력·사이드바 점 하나의 뜻.
 *
 * **`STALLED` 가 `RUNNING` 과 갈라져 있다.** `status` 문자열만 보면 둘 다
 * `COLLECTING` 이라, 몇 달 전에 죽은 실행이 오늘 07:40 에 막 시작한 실행과
 * 똑같은 파란 점으로 그려진다. 달력은 훑어보는 화면이라 그 거짓말이 특히 오래 산다 —
 * 담당자는 그 날짜를 열어 보지도 않는다. 판정 근거는 배너와 같은 함수다
 * (`domain/runProgress.ts` 의 `runProgressView`).
 */
export function briefDayMark(
  status: string,
  /** 시작 시각을 모르면 생략한다. 그때는 COLLECTING 이 그냥 RUNNING 이다 —
   * 멈췄는지 판단할 근거가 없으므로 멈췄다고 말하지 않는다. */
  timing?: { startedAtMs: number; nowMs: number },
): BriefDayMark {
  if (status === 'COLLECTING' && timing !== undefined) {
    const view = runProgressView({ status, ...timing, progressDetail: null })
    return view.kind === 'STALLED' ? 'STALLED' : 'RUNNING'
  }
  return DAY_MARK[status] ?? 'UNKNOWN'
}

const MARK_LABEL: Record<BriefDayMark, string> = {
  DONE: '준비 완료',
  PARTIAL: '부분 완료',
  RUNNING: '수집 중',
  STALLED: '수집 중 — 중단됐을 수 있음',
  FAILED: '실패',
  UNKNOWN: '',
}

/**
 * 점 옆에 적는 말. **`runStatusLabel(status)` 를 쓰면 안 된다** — 그쪽은 원본 상태
 * 문자열만 알아서 멈춘 실행에도 「수집 중」이라고 적는다. 점 색은 갈라 놓고 글자는
 * 같으면 구분이 반쪽만 산다.
 * `UNKNOWN` 은 우리가 모르는 상태 문자열이므로 **원문을 그대로** 보여준다.
 */
export function briefDayMarkLabel(mark: BriefDayMark, status: string): string {
  return MARK_LABEL[mark] || status
}

export type BriefDateEntry = {
  /** BriefRun.runDate — 검수 화면 URL 키. */
  date: string
  /** 원본 status 문자열. 모르는 상태를 그대로 보여줘야 할 때 쓴다. */
  status: string
  mark: BriefDayMark
  /** 화면에 적을 사람 말. mark 와 짝이다 — 색과 글자가 어긋나지 않게 여기서 함께 만든다. */
  label: string
}

function toDateEntry(
  r: { runDate: string; status: string; startedAt: Date },
  nowMs: number,
): BriefDateEntry {
  const mark = briefDayMark(r.status, { startedAtMs: r.startedAt.getTime(), nowMs })
  return { date: r.runDate, status: r.status, mark, label: briefDayMarkLabel(mark, r.status) }
}

/**
 * 그 달에 브리프가 있는 날짜들. 23행을 다 읽지 않고 `runDate`·`status` 두 열만 받는다 —
 * 달력이 알아야 하는 것은 "있나"와 "다 됐나" 둘뿐이다.
 */
export async function listBriefDates(yearMonth: string, now: Date = new Date()): Promise<BriefDateEntry[]> {
  const { first, last } = monthRange(yearMonth)
  const runs = await prisma.briefRun.findMany({
    where: { runDate: { gte: first, lte: last } },
    select: { runDate: true, status: true, startedAt: true },
    orderBy: { runDate: 'asc' },
  })
  const nowMs = now.getTime()
  return runs.map(r => toDateEntry(r, nowMs))
}

/** 사이드바 「최근 브리프」. 최신순. */
export async function listRecentBriefDates(limit: number, now: Date = new Date()): Promise<BriefDateEntry[]> {
  const runs = await prisma.briefRun.findMany({
    select: { runDate: true, status: true, startedAt: true },
    orderBy: { runDate: 'desc' },
    take: limit,
  })
  const nowMs = now.getTime()
  return runs.map(r => toDateEntry(r, nowMs))
}

/**
 * 「◀ 이전 / 다음 ▶」이 갈 곳. **하루씩 빼고 더하지 않는다** — 수집은 평일에만 돌아서
 * 하루씩 움직이면 주말·공휴일마다 「브리프 없음」 화면에 떨어진다. 실제로 데이터가
 * 있는 이웃 날짜로 건너뛰고, 없으면 null 이라 버튼이 비활성으로 보인다.
 * 기준 날짜 자체에 브리프가 없어도(없는 날짜를 URL 로 직접 열었을 때) 동작한다.
 */
export async function adjacentBriefDates(date: string): Promise<{ prev: string | null; next: string | null }> {
  const [prev, next] = await Promise.all([
    prisma.briefRun.findFirst({
      where: { runDate: { lt: date } },
      select: { runDate: true },
      orderBy: { runDate: 'desc' },
    }),
    prisma.briefRun.findFirst({
      where: { runDate: { gt: date } },
      select: { runDate: true },
      orderBy: { runDate: 'asc' },
    }),
  ])
  return { prev: prev?.runDate ?? null, next: next?.runDate ?? null }
}

/* ------------------------------------------------------------------------ *
 * 화면에서 수집을 직접 돌릴 때 버튼이 알아야 하는 것
 * ------------------------------------------------------------------------ */

/**
 * 「수집 실행」 버튼이 판단에 쓰는 사실들.
 *
 * **보고 있는 날짜가 아니라 수집이 실제로 만들 날짜(`runDate` = KST 오늘)의 사실이다.**
 * 담당자가 지난 날짜를 열어 둔 채 버튼을 눌러도 수집은 오늘 자로 돈다(시세 소스가
 * 주는 값이 "직전 영업일 종가"뿐이라 과거 날짜를 다시 만들 방법이 애초에 없다).
 * 경고 문구가 보고 있는 날짜의 선택 건수를 말하면, 실제로 덮어써질 날짜와 다른
 * 날짜에 대해 경고하게 된다.
 */
export type CollectTarget = {
  /** 수집이 만들/덮을 날짜. */
  runDate: string
  /** 그 날짜의 실행. 아직 한 번도 안 돌았으면 null. */
  run: { status: string; statusDetail: string | null; progressDetail: string | null; startedAtMs: number } | null
  /**
   * 그 날짜에서 담당자가 이미 판단을 끝낸 행 수(PENDING 이 아닌 Selection).
   * 재수집은 후보를 지우고 다시 만들므로 이 행들의 선택이 무효화된다
   * (`needsPendingRevert` 가 PENDING 으로 되돌린다 — 직접 고친 텍스트는 살아남는다).
   */
  decidedRows: number
}

export async function getCollectTarget(runDate: string): Promise<CollectTarget> {
  const [run, decidedRows] = await Promise.all([
    prisma.briefRun.findUnique({
      where: { runDate },
      select: { status: true, statusDetail: true, progressDetail: true, startedAt: true },
    }),
    prisma.selection.count({ where: { run: { runDate }, decision: { not: 'PENDING' } } }),
  ])

  return {
    runDate,
    run: run
      ? {
          status: run.status,
          statusDetail: run.statusDetail,
          progressDetail: run.progressDetail,
          startedAtMs: run.startedAt.getTime(),
        }
      : null,
    decidedRows,
  }
}
