import { prisma } from './client'
import { changePct as calcChangePct } from '@/domain/calc'
import type { Prisma } from '@prisma/client'

export type RowState = 'NEWS_FAILED' | 'NO_NEWS' | 'OMITTED' | 'PENDING' | 'SELECTED' | 'STALE_SELECTION'

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
 */
export function rowDisplayState(row: {
  candidateCount: number
  decision: string
  chosenCandidateId: string | null
  /** NewsFetch.status. 기록이 없으면 null (이 기록이 생기기 전에 수집된 실행). */
  newsFetchStatus?: string | null
}): RowState {
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
 * kind를 쓰되 confirmed 플래그로 구분해, 호출자가 시각적으로도(진하기/기울임/
 * "미확정" 표시 등) 절대 같아 보이지 않게 렌더해야 한다 — 확정본과 구분되지
 * 않으면 담당자가 미확정 미리보기를 그대로 메일에 싣게 된다.
 *
 * OMITTED는 NO_NEWS와 똑같이 '텅 빈 칸'으로 보이면 안 된다 — 하나는 "기사가
 * 없었다"(NO_NEWS)이고 하나는 "담당자가 뺐다"(OMITTED)라서, 별도 kind로
 * 구조적으로 갈라 둔다. NEWS_FAILED("못 찾아봤다")도 이 둘과 절대 같은 문자열로
 * 수렴하면 안 된다 — 'label' kind로 완전히 다른 값을 돌려준다.
 */
export type NewsColumnContent =
  | { kind: 'article'; confirmed: boolean; title: string; url: string; summary: string | null }
  | { kind: 'omitted' }
  | { kind: 'none' }
  | { kind: 'label'; text: string }

export function newsColumnContent(row: {
  state: RowState
  candidates: Array<Pick<ClientCandidate, 'id' | 'rank' | 'title' | 'url' | 'summaries'>>
  chosenCandidateId: string | null
  chosenSummaryId: string | null
  editedText: string | null
}): NewsColumnContent {
  switch (row.state) {
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
      const summary = row.editedText ?? chosenSummary?.text ?? null
      return { kind: 'article', confirmed: true, title: cand.title, url: cand.url, summary }
    }
    case 'PENDING': {
      // candidateCount === 0이면 rowDisplayState가 PENDING을 주지 않으므로
      // (NO_NEWS/NEWS_FAILED로 먼저 빠진다) 여기서는 후보가 항상 최소 1건 있다.
      const cand = row.candidates.find(c => c.rank === 1) ?? row.candidates[0]
      if (!cand) return { kind: 'none' }
      const summary = cand.summaries.find(s => s.variant === 1)?.text ?? null
      return { kind: 'article', confirmed: false, title: cand.title, url: cand.url, summary }
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
} | null

export type ClientInstrument = {
  id: string
  category: string
  displayOrder: number
  name: string
  currency: string
  isIndex: boolean
  quoteSource: string
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
}

export type ClientRun = {
  id: string
  runDate: string
  tradeDate: string
  status: string
  statusDetail: string | null
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
        candidateCount: mine.length,
        decision: sel?.decision ?? 'PENDING',
        chosenCandidateId: sel?.chosenCandidateId ?? null,
        newsFetchStatus: fetched?.status ?? null,
      }),
      display,
      newsFetchError: fetched?.error ?? null,
    }
  })

  return {
    run: {
      id: run.id,
      runDate: run.runDate,
      tradeDate: run.tradeDate,
      status: run.status,
      statusDetail: run.statusDetail,
    },
    rows,
  }
}
