-- AlterTable
ALTER TABLE "QuoteSnapshot" ADD COLUMN     "fallbackFrom" TEXT;

-- Backfill (Task 43 후속, 2026-10-13).
--
-- 이 컬럼이 생기기 전의 스냅샷은 폴백 여부를 따로 적지 않았다. 다행히 규칙이 하나로
-- 정해진다: 2026-10-13 의 소스 전환(Task 43) 전까지 FT 는 **2차로만** 쓰였다
-- (2026-08-28 Task 32 도입). 그래서 sourceName 이 'ft' 이면 폴백이고, 아니면 폴백이
-- 아니다. 폴백일 때 실패한 1차는 그 시절 시드의 quoteSource 다:
--   displayOrder 16 GSK    → 'lse'
--   displayOrder 17 Sanofi → 'marketstack'
--   displayOrder 18 Lonza  → 'six'
--   displayOrder 19 Wuxi   → 'naver-world-stock'
-- 2026-08-28 이전에는 네 종목 모두 marketstack 1차였고 폴백 자체가 없었다(ft 행 없음).
--
-- **fetchedAt 상한을 둔다.** 전환 뒤에는 FT 가 유럽 3종목의 1차라 'ft' 가 폴백을 뜻하지
-- 않는다. 시드 전환은 2026-10-13 11:05 KST 경이었고, 그 전 마지막 스냅샷은 08:37 KST 였다.
-- 이 마이그레이션이 전환 뒤의 수집이 쌓인 DB 에 늦게 적용돼도 새 행을 잘못 칠하지 않도록
-- 11:00 KST(02:00 UTC)로 자른다. 새 행은 수집 코드가 직접 채운다.
--
-- 이식성: UPDATE ... FROM / JOIN 대신 상관 서브쿼리를 쓴다(Postgres·MariaDB 공통 문법).
UPDATE "QuoteSnapshot"
SET "fallbackFrom" = CASE (
    SELECT i."displayOrder" FROM "Instrument" i WHERE i."id" = "QuoteSnapshot"."instrumentId"
  )
  WHEN 16 THEN 'lse'
  WHEN 17 THEN 'marketstack'
  WHEN 18 THEN 'six'
  WHEN 19 THEN 'naver-world-stock'
END
WHERE "sourceName" = 'ft'
  AND "fetchedAt" < '2026-10-13 02:00:00';
