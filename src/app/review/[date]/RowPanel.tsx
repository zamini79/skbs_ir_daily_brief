'use client'

import { useState, useTransition } from 'react'
import { charLength } from '@/domain/text'
import { sameEventBadgeLabel, type ClientRow } from '@/db/repo'
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
            className={`block cursor-pointer rounded border p-2 text-sm ${
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
                  <p className="mt-1 text-xs text-red-600">요약 실패: {c.summaryError}</p>
                )}
                {!c.summaryError && c.summaries.length === 0 && (
                  <p className="mt-1 text-xs text-gray-400">요약 없음 (본문 부족으로 건너뜀)</p>
                )}
              </div>
            </div>
          </label>
        ))}
        <label
          className={`flex items-center gap-2 rounded border p-2 text-sm ${
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
          {chosenCandidate.summaryError && chosenCandidate.summaries.length === 0 && (
            <p className="text-sm text-red-600">
              이 후보는 요약을 만들지 못했습니다 ({chosenCandidate.summaryError}). 제목만 보고 판단하세요.
            </p>
          )}
          {!chosenCandidate.summaryError && chosenCandidate.summaries.length === 0 && (
            <p className="text-sm text-gray-500">
              이 후보는 본문이 짧아 요약을 만들지 않았습니다. 제목만 보고 판단하세요.
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
                <span className="mr-1 font-medium">{SUMMARY_LABEL[s.variant]}</span>
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
