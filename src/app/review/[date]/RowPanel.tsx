'use client'

import { useState, useTransition } from 'react'
import { charLength } from '@/domain/text'
import { sameEventBadgeLabel, summaryErrorShortLabel, type ClientRow } from '@/db/repo'
import { selectNews, omitNews, editSummary, saveManualQuote } from './actions'

const SUMMARY_LABEL: Record<number, string> = {
  1: '① 수치 중심',
  2: '② 배경·맥락 중심',
  3: '③ 시사점 중심',
}
const SUMMARY_MAX = 100

export function RowPanel({ runDate, row }: { runDate: string; row: ClientRow }) {
  const [, startTransition] = useTransition()
  const instrumentId = row.instrument.id
  const isManualSource = row.instrument.quoteSource === 'manual'

  const chosenCandidate = row.candidates.find(c => c.id === row.selection.chosenCandidateId) ?? null
  const chosenSummary = chosenCandidate?.summaries.find(s => s.id === row.selection.chosenSummaryId) ?? null

  const [draftText, setDraftText] = useState(row.selection.editedText ?? chosenSummary?.text ?? '')
  const [manualClose, setManualClose] = useState(row.selection.manualClose?.toString() ?? '')
  const [manualPrevClose, setManualPrevClose] = useState(row.selection.manualPrevClose?.toString() ?? '')

  function handlePickCandidate(candidateId: string) {
    const cand = row.candidates.find(c => c.id === candidateId)
    const firstSummaryId = cand?.summaries[0]?.id ?? null
    startTransition(async () => {
      await selectNews(runDate, instrumentId, candidateId, firstSummaryId)
    })
  }

  function handleOmit() {
    startTransition(async () => {
      await omitNews(runDate, instrumentId)
    })
  }

  function handlePickSummary(candidateId: string, summaryId: string) {
    startTransition(async () => {
      await selectNews(runDate, instrumentId, candidateId, summaryId)
    })
  }

  function handleTextBlur() {
    startTransition(async () => {
      await editSummary(runDate, instrumentId, draftText)
    })
  }

  function handleManualBlur() {
    const close = Number(manualClose)
    const prevClose = Number(manualPrevClose)
    if (!Number.isFinite(close) || !Number.isFinite(prevClose)) return
    startTransition(async () => {
      await saveManualQuote(runDate, instrumentId, close, prevClose)
    })
  }

  return (
    <div className="space-y-4 p-3">
      {isManualSource && (
        <div className="flex flex-wrap items-center gap-3 rounded border border-blue-200 bg-blue-50 p-2 text-sm">
          <span className="font-medium text-blue-800">
            수기 입력 (자동 소스 없음 — Naver 코드 없음, KRX 접근 차단, 공공데이터 API 지원 안 함)
          </span>
          <label className="flex items-center gap-1">
            종가
            <input
              type="number"
              step="0.01"
              value={manualClose}
              onChange={e => setManualClose(e.target.value)}
              onBlur={handleManualBlur}
              className="w-28 rounded border border-gray-300 px-1.5 py-0.5"
            />
          </label>
          <label className="flex items-center gap-1">
            전일종가
            <input
              type="number"
              step="0.01"
              value={manualPrevClose}
              onChange={e => setManualPrevClose(e.target.value)}
              onBlur={handleManualBlur}
              className="w-28 rounded border border-gray-300 px-1.5 py-0.5"
            />
          </label>
        </div>
      )}

      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-semibold text-gray-500">뉴스 후보</legend>
        {row.candidates.length === 0 && (
          <p className="text-sm text-gray-400">당일·D-1 기사가 없습니다.</p>
        )}
        {row.candidates.map(c => (
          <label
            key={c.id}
            className={`block cursor-pointer rounded border p-2 text-sm text-gray-900 ${
              row.selection.chosenCandidateId === c.id
                ? 'border-emerald-400 bg-emerald-50'
                : 'border-gray-200 bg-white'
            }`}
          >
            <div className="flex items-start gap-2">
              <input
                type="radio"
                name={`cand-${instrumentId}`}
                checked={row.selection.chosenCandidateId === c.id}
                onChange={() => handlePickCandidate(c.id)}
                className="mt-1"
              />
              <div className="flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={c.url}
                    target="_blank"
                    rel="noreferrer"
                    onClick={e => e.stopPropagation()}
                    className="font-medium text-blue-700 hover:underline"
                  >
                    {c.title}
                  </a>
                  {c.sameEventAsRank != null && (
                    <span className="rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-medium text-purple-700">
                      {sameEventBadgeLabel(c.sameEventAsRank)}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-xs text-gray-500">
                  {c.publisher} · {new Date(c.publishedAt).toLocaleString('ko-KR')} · {c.clusterSize}개 매체
                </div>
                {c.summaryError && (
                  // title에 원문을 그대로 남긴다 — 담당자에게는 모델명 나열이 의미
                  // 없지만(비개발자, 08:00 마감 전 급하게 훑는 화면), 운영자는 원문이
                  // 필요할 수 있으므로 지우지 않는다.
                  <p className="mt-1 text-xs text-red-600" title={c.summaryError}>
                    {summaryErrorShortLabel(c.summaryError)}
                    {c.summaries.some(s => s.isFallback) && ' — 아래는 본문 발췌로 대체됨'}
                  </p>
                )}
                {/*
                 * summaryError가 null인데 요약도 없는 경우 — 사유를 함부로 짐작해 말하지
                 * 않는다("본문 부족" 등). 이 화면은 실패 사유 추적(summaryError/failure
                 * counters)이 생기기 전에 수집된 실행에서만 나타나야 하는 레거시 경로다.
                 * 그 이후 실행은 실패든 건너뜀이든 항상 summaryError를 남기므로 위
                 * 분기로 간다.
                 */}
                {!c.summaryError && c.summaries.length === 0 && (
                  <p className="mt-1 text-xs text-gray-400">요약 없음 (사유 미기록)</p>
                )}
              </div>
            </div>
          </label>
        ))}
        <label
          className={`flex items-center gap-2 rounded border p-2 text-sm text-gray-900 ${
            row.selection.decision === 'OMITTED' ? 'border-gray-400 bg-gray-100' : 'border-gray-200 bg-white'
          }`}
        >
          <input
            type="radio"
            name={`cand-${instrumentId}`}
            checked={row.selection.decision === 'OMITTED'}
            onChange={handleOmit}
          />
          이 행에 뉴스 싣지 않음
        </label>
      </fieldset>

      {chosenCandidate && (
        <fieldset className="space-y-2 border-t border-gray-200 pt-3">
          <legend className="mb-1 text-xs font-semibold text-gray-500">요약 선택</legend>
          {/*
           * summaryError 가 있으면 모델 요약은 실패한 것이다 — summaries가 비어 있든
           * (모델 실패 + 발췌 대체도 못 만든 경우) 채워져 있든(발췌 대체로 채운 경우)
           * 항상 이 경고를 보여준다. summaries.length === 0 일 때만 보여주면, 발췌
           * 대체 요약이 채워진 순간 이 경고가 조용히 사라져 검수자가 기계 발췌문을
           * 모델 요약으로 착각하게 된다. 원인은 summaryError 문구를 그대로 보여줄 뿐
           * 짐작해서 이름 붙이지 않는다.
           */}
          {chosenCandidate.summaryError && (
            <p className="text-sm text-red-600" title={chosenCandidate.summaryError}>
              {summaryErrorShortLabel(chosenCandidate.summaryError)}
              {chosenCandidate.summaries.length > 0
                ? ' — 아래는 모델이 아니라 본문에서 기계적으로 뽑아낸 발췌입니다. 그대로 싣지 말고 반드시 손보세요.'
                : ' 제목만 보고 판단하세요.'}
            </p>
          )}
          {/* 위 후보 목록의 주석과 같은 이유로 사유를 짐작해 말하지 않는다 — 레거시 경로. */}
          {!chosenCandidate.summaryError && chosenCandidate.summaries.length === 0 && (
            <p className="text-sm text-gray-500">
              이 후보는 요약이 없고, 사유가 기록되어 있지 않습니다. 제목만 보고 판단하세요.
            </p>
          )}
          {chosenCandidate.summaries.map(s => (
            <label key={s.id} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name={`summary-${instrumentId}`}
                checked={row.selection.chosenSummaryId === s.id}
                onChange={() => handlePickSummary(chosenCandidate.id, s.id)}
                className="mt-1"
              />
              <span>
                {s.isFallback ? (
                  // variant 라벨("수치 중심" 등)은 기계 발췌에는 의미가 없다 — 있지도
                  // 않은 관점을 주장하는 라벨이 되므로 붙이지 않고, 대신 발췌라는
                  // 사실 자체를 먼저 보여준다. 정상 요약과 색을 다르게 해 한눈에
                  // 구분되게 한다.
                  <span className="mr-1 rounded bg-orange-100 px-1.5 py-0.5 text-[10px] font-medium text-orange-800">
                    본문 발췌 (모델 요약 실패)
                  </span>
                ) : (
                  <span className="mr-1 font-medium">{SUMMARY_LABEL[s.variant]}</span>
                )}
                {s.text}
              </span>
            </label>
          ))}
          <div>
            <textarea
              value={draftText}
              onChange={e => setDraftText(e.target.value)}
              onBlur={handleTextBlur}
              rows={2}
              className="w-full rounded border border-gray-300 p-1.5 text-sm"
            />
            <div
              className={`text-right text-xs ${
                charLength(draftText) > SUMMARY_MAX ? 'font-semibold text-red-600' : 'text-gray-400'
              }`}
            >
              {charLength(draftText)}/{SUMMARY_MAX}자
            </div>
          </div>
        </fieldset>
      )}
    </div>
  )
}
