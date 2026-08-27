# IR 데일리 브리프

IR팀의 아침 브리프 작성을 자동화한다. 매 평일 07:40(KST)에 국내사 10 · 해외사 9 ·
지수 4, 총 23행의 시세와 뉴스를 수집하고 기사별 요약 3안을 미리 만들어 둔다.
08:00에 담당자가 `/review/<YYYY-MM-DD>` 검수 화면에서 뉴스와 요약을 확정한다.

- 시세: 네이버(국내·지수) · Twelve Data(미국) · marketstack(비미국) · Frankfurter(환율)
- 뉴스: 네이버 검색 API → 제목 유사도 클러스터링 → 상위 3건
- 요약: Gemini (모델 폴백 체인, 실패 시 본문 발췌로 대체)
- 스택: Next.js 16 (App Router) · React 19 · Prisma 6 · PostgreSQL · Tailwind 4 · Vitest

## 시작하기

```bash
npm install
cp .env.example .env.local     # 값은 각자 채운다 (커밋 금지)
npx prisma migrate deploy
npx prisma db seed             # 23행 시드
npm run dev                    # http://localhost:3000
```

## 명령어

```bash
npm test           # vitest run
npx tsc --noEmit   # 타입 체크
npm run build      # 프로덕션 빌드 (배포 전 필수)
```

## 문서

- **[운영 문서 — `docs/운영.md`](docs/운영.md)**
  검수 담당자용 화면 사용법(1부), 개발·운영 함정과 한도(2부), 사내 이관 절차(3부).
  **화면을 매일 여는 담당자와 이 시스템을 넘겨받을 개발자 모두 여기부터 읽는다.**
- 설계 문서: [`docs/superpowers/specs/2026-08-27-ir-daily-brief-design.md`](docs/superpowers/specs/2026-08-27-ir-daily-brief-design.md)
- 구현 계획: [`docs/superpowers/plans/2026-08-27-ir-daily-brief.md`](docs/superpowers/plans/2026-08-27-ir-daily-brief.md)
