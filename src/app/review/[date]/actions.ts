'use server'

import { revalidatePath } from 'next/cache'
import { prisma } from '@/db/client'

async function updateSelection(
  runDate: string,
  instrumentId: string,
  data: Record<string, unknown>,
) {
  const run = await prisma.briefRun.findUniqueOrThrow({ where: { runDate } })
  await prisma.selection.upsert({
    where: { runId_instrumentId: { runId: run.id, instrumentId } },
    update: data,
    create: { runId: run.id, instrumentId, decision: 'PENDING', ...data },
  })
  revalidatePath(`/review/${runDate}`)
}

/**
 * 뉴스 후보를 고른다. summaryId 는 아직 요약을 고르지 않았으면 null 로 둘 수 있다
 * (예: summaryError 로 요약이 아예 없는 후보를 제목만 보고 고른 경우).
 * 후보를 다시 고르면 이전에 담당자가 직접 고친 텍스트(editedText)는 더 이상
 * 유효하지 않으므로 비운다.
 */
export async function selectNews(
  runDate: string,
  instrumentId: string,
  candidateId: string,
  summaryId: string | null,
) {
  await updateSelection(runDate, instrumentId, {
    decision: 'SELECTED',
    chosenCandidateId: candidateId,
    chosenSummaryId: summaryId,
    editedText: null,
  })
}

/** 후보가 있어도 담당자가 싣지 않기로 한 경우. NO_NEWS 와 구분된다. */
export async function omitNews(runDate: string, instrumentId: string) {
  await updateSelection(runDate, instrumentId, {
    decision: 'OMITTED',
    chosenCandidateId: null,
    chosenSummaryId: null,
  })
}

/**
 * 선택한 요약 텍스트를 담당자가 직접 고친 결과를 저장한다.
 *
 * **빈 문자열은 null 로 정규화한다.** 텍스트를 지우고 blur 하면 `editedText = ''` 가
 * 저장되는데, 표시 쪽 `row.editedText ?? chosenSummary?.text`(repo.ts) 는 `''` 를
 * nullish 로 보지 않으므로 담당자가 고른 요약이 화면에서 영구히 가려진다 —
 * 행은 여전히 「선택 완료」라서 비어 있는 이유를 알 방법이 없다. 지운 것은
 * "빈 요약을 쓰겠다"가 아니라 "고치기 전으로 되돌리겠다"는 뜻으로 본다.
 *
 * 100자 초과는 막지 않는다. 이 텍스트는 담당자가 직접 쓴 최종본이고, 편집칸 옆
 * 카운터가 이미 빨갛게 초과를 알린다(RowPanel). 서버가 조용히 버리면 담당자는
 * 저장된 줄 알고 08:00 에 없는 문장을 싣게 된다 — 길이 위반보다 나쁘다.
 */
export async function editSummary(runDate: string, instrumentId: string, text: string) {
  const trimmed = text.trim()
  await updateSelection(runDate, instrumentId, { editedText: trimmed === '' ? null : text })
}

/** 코스피200 헬스케어 전용 수기 입력. 자동 소스가 없는 종목의 종가/전일종가. */
export async function saveManualQuote(
  runDate: string,
  instrumentId: string,
  close: number,
  prevClose: number,
) {
  await updateSelection(runDate, instrumentId, { manualClose: close, manualPrevClose: prevClose })
}
