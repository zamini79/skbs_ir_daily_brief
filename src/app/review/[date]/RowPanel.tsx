'use client'

import { useState, useTransition } from 'react'
import { charLength } from '@/domain/text'
import { summaryVariantLabel } from '@/providers/summarize/prompt'
import { sameEventBadgeLabel, summaryErrorShortLabel, type ClientRow } from '@/db/repo'
import { NEWS_SUMMARY_STYLE, NEWS_TITLE_STYLE } from '@/domain/newsStyle'
import { selectNews, omitNews, editSummary, saveManualQuote } from './actions'

const SUMMARY_MAX = 100

export function RowPanel({
  runDate,
  row,
  newsOwnerName = null,
}: {
  runDate: string
  row: ClientRow
  /** 이 행이 뉴스 칸을 다른 행과 함께 쓰면 그 행의 이름(domain/newsShare.ts). */
  newsOwnerName?: string | null
}) {
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
      {/*
        * quoteSource === 'manual' 인 종목의 수기 입력 칸. 지금은 해당 종목이 없어
        * 렌더되지 않지만(코스피200 헬스케어가 krx-index 로 옮겨갔다), 스펙 §11 이
        * KRX 이용약관에 걸리면 그 1행을 수기 입력으로 되돌리라고 안내하므로 경로는
        * 남겨 둔다(providers/quote/index.ts 의 manual 주석과 같은 이유다).
        *
        * 문구는 **왜** 자동 소스가 없는지 열거하지 않는다. 예전 문구는 "Naver 코드
        * 없음, KRX 접근 차단, 공공데이터 API 지원 안 함"이라고 단언했는데, 막혔던
        * 것은 KRX 웹사이트 내부 엔드포인트였고 KRX Open API 는 열려 있어서 지금
        * 실제로 그것으로 수집한다 — 화면이 사실이 아닌 것을 단언하고 있었다.
        * quoteSource 가 manual 이라는 사실 자체가 이미 조건을 다 말하므로, 어떤
        * 소스가 왜 막혔는지는 코드가 주장할 일이 아니다(그 경위는 스펙 §3.3 의
        * "폐기된 결론" 표에 기록으로 남아 있다).
        */}
      {isManualSource && (
        <div className="flex flex-wrap items-center gap-3 rounded border border-info-border bg-info p-2 text-[13px]">
          <span className="font-medium text-info-fg">
            수기 입력 (이 종목은 자동 시세 소스가 지정돼 있지 않습니다)
          </span>
          <label className="flex items-center gap-1">
            종가
            <input
              type="number"
              step="0.01"
              value={manualClose}
              onChange={e => setManualClose(e.target.value)}
              onBlur={handleManualBlur}
              className="w-28 rounded border border-btn-border px-1.5 py-0.5"
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
              className="w-28 rounded border border-btn-border px-1.5 py-0.5"
            />
          </label>
        </div>
      )}

      {/*
        * 시세 수집이 실패한 행. 뉴스 조회 실패 블록(아래 fieldset 안)과 **같은 구조**로
        * 말한다 — 무엇이 일어났는지 한 문장, 그다음 사유 원문 한 줄. 원문만 근거로
        * 삼고 원인을 지어내지 않는 것도 같다.
        *
        * 위치가 뉴스 쪽과 다른 것은 이 사실이 뉴스가 아니라 시세에 대한 것이기
        * 때문이다. 바로 아래 '환율 미확보' 블록과 나란히 두고 같은 박스 모양을 쓴다.
        * quoteFailReason 은 수기 입력 대상 행과 수기 값으로 채워진 행을 이미
        * 걸러내므로(repo.ts), 여기 뜨면 그건 진짜 실패다.
        */}
      {row.quoteFailReason !== null && (
        <p className="rounded border border-fail-border bg-fail-row p-2 text-[12px] text-fail-fg">
          시세를 받아오지 못했습니다 — 주가·전일대비·%·연초대비가 비어 있는 것은 값이
          없어서가 아니라 조회에 실패했기 때문입니다. 이 행의 숫자는 신뢰할 수 없습니다.
          <span className="mt-0.5 block text-fail-fg">사유: {row.quoteFailReason}</span>
        </p>
      )}

      {/* 시총이 왜 비었는지 아는 경우에만 말한다. 이유를 모르면 아무 말도 하지 않는다. */}
      {row.marketCapBlankReason === 'FX_UNAVAILABLE' && (
        <p className="rounded border border-fail-border bg-fail-row p-2 text-[12px] text-fail-fg">
          {row.instrument.currency} 환율을 받지 못해 시가총액을 계산하지 못했습니다.
          시세·전일대비·연초대비는 환율과 무관하므로 그대로 유효합니다.
        </p>
      )}

      {/*
        * 뉴스 칸을 다른 행과 함께 쓰는 행(Nasdaq → S&P500). 여기서는 뉴스를 고르지 않는다 —
        * 고를 수 있게 두면 화면에 보이지 않는 선택이 생긴다(병합된 칸은 소유 행의 선택만
        * 그린다). 공유 이전 날짜에 이 행 후보가 DB 에 남아 있어도 같은 규칙이다.
        */}
      {row.state === 'NEWS_SHARED' && (
        <p className="text-[13px] text-ink-muted">
          이 행의 뉴스는 {newsOwnerName !== null ? `${newsOwnerName} 행` : '위 행'}과 한 칸입니다. 기사·요약은
          그 행에서 고르세요.
        </p>
      )}

      {row.state !== 'NEWS_SHARED' && (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[12px] font-semibold text-ink-muted">뉴스 후보</legend>
          {/*
            * 후보 0건의 두 가지 뜻을 갈라서 말한다. 검색이 실패했으면 "기사가 없다"고
            * 말할 근거가 없다 — 담당자가 직접 찾아봐야 하는 행이다.
            * 사유는 error 원문만 근거로 삼고 원인을 지어내지 않는다. 원문이 없으면
            * (기록 이전 실행) 사유를 짐작하지 않고 미기록이라고만 말한다.
            */}
          {row.candidates.length === 0 && row.state === 'NEWS_FAILED' && (
            <p className="text-[13px] text-fail-fg" title={row.newsFetchError ?? undefined}>
              뉴스 조회에 실패했습니다 — 기사가 없는 것이 아니라 확인하지 못한 것입니다.
              직접 검색해 확인해 주세요.
              <span className="mt-0.5 block text-[12px] text-fail-fg">
                사유: {row.newsFetchError ?? '미기록'}
              </span>
            </p>
          )}
          {row.candidates.length === 0 && row.state !== 'NEWS_FAILED' && (
            <p className="text-[13px] text-ink-faint">당일·D-1 기사가 없습니다.</p>
          )}
          {row.candidates.map(c => (
            <label
              key={c.id}
              className={`block cursor-pointer rounded border p-2 text-[13px] text-ink ${
                row.selection.chosenCandidateId === c.id
                  ? 'border-ok-border bg-ok'
                  : 'border-line bg-page'
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
                    {/* 표의 뉴스 칸과 같은 인라인 서식 — 담당자가 여기서도 복사한다(domain/newsStyle.ts). */}
                    <a
                      href={c.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={e => e.stopPropagation()}
                      style={NEWS_TITLE_STYLE}
                    >
                      {c.title}
                    </a>
                    {c.sameEventAsRank != null && (
                      <span className="rounded bg-tag px-1.5 py-0.5 text-[10px] font-medium text-tag-fg">
                        {sameEventBadgeLabel(c.sameEventAsRank)}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-[12px] text-ink-muted">
                    {c.publisher} · {new Date(c.publishedAt).toLocaleString('ko-KR')} · {c.clusterSize}개 매체
                  </div>
                  {c.summaryError && (
                    // title에 원문을 그대로 남긴다 — 담당자에게는 모델명 나열이 의미
                    // 없지만(비개발자, 08:00 마감 전 급하게 훑는 화면), 운영자는 원문이
                    // 필요할 수 있으므로 지우지 않는다.
                    <p className="mt-1 text-[12px] text-accent" title={c.summaryError}>
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
                    <p className="mt-1 text-[12px] text-ink-faint">요약 없음 (사유 미기록)</p>
                  )}
                </div>
              </div>
            </label>
          ))}
          <label
            className={`flex items-center gap-2 rounded border p-2 text-[13px] text-ink ${
              row.selection.decision === 'OMITTED' ? 'border-badge-fg bg-omitted-row' : 'border-line bg-page'
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
      )}

      {row.state !== 'NEWS_SHARED' && chosenCandidate && (
        <fieldset className="space-y-2 border-t border-line pt-3">
          <legend className="mb-1 text-[12px] font-semibold text-ink-muted">요약 선택</legend>
          {/*
           * summaryError 가 있으면 모델 요약은 실패한 것이다 — summaries가 비어 있든
           * (모델 실패 + 발췌 대체도 못 만든 경우) 채워져 있든(발췌 대체로 채운 경우)
           * 항상 이 경고를 보여준다. summaries.length === 0 일 때만 보여주면, 발췌
           * 대체 요약이 채워진 순간 이 경고가 조용히 사라져 검수자가 기계 발췌문을
           * 모델 요약으로 착각하게 된다. 원인은 summaryError 문구를 그대로 보여줄 뿐
           * 짐작해서 이름 붙이지 않는다.
           */}
          {chosenCandidate.summaryError && (
            <p className="text-[13px] text-accent" title={chosenCandidate.summaryError}>
              {summaryErrorShortLabel(chosenCandidate.summaryError)}
              {chosenCandidate.summaries.length > 0
                ? ' — 아래는 모델이 아니라 본문에서 기계적으로 뽑아낸 발췌입니다. 그대로 싣지 말고 반드시 손보세요.'
                : ' 제목만 보고 판단하세요.'}
            </p>
          )}
          {/* 위 후보 목록의 주석과 같은 이유로 사유를 짐작해 말하지 않는다 — 레거시 경로. */}
          {!chosenCandidate.summaryError && chosenCandidate.summaries.length === 0 && (
            <p className="text-[13px] text-ink-muted">
              이 후보는 요약이 없고, 사유가 기록되어 있지 않습니다. 제목만 보고 판단하세요.
            </p>
          )}
          {chosenCandidate.summaries.map(s => (
            <label key={s.id} className="flex items-start gap-2 text-[13px]">
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
                  <span className="mr-1 rounded bg-excerpt px-1.5 py-0.5 text-[10px] font-medium text-excerpt-fg">
                    본문 발췌 (모델 요약 실패)
                  </span>
                ) : (
                  <span className="mr-1 font-medium">{summaryVariantLabel(s.variant)}</span>
                )}
                <span style={NEWS_SUMMARY_STYLE}>{s.text}</span>
              </span>
            </label>
          ))}
          <div>
            <textarea
              value={draftText}
              onChange={e => setDraftText(e.target.value)}
              onBlur={handleTextBlur}
              rows={2}
              className="w-full rounded border border-btn-border p-1.5 text-[13px]"
            />
            <div
              className={`text-right text-[12px] ${
                charLength(draftText) > SUMMARY_MAX ? 'font-semibold text-accent' : 'text-ink-faint'
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
