-- AlterTable
ALTER TABLE "Instrument" ADD COLUMN     "newsAliases" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "NewsCandidate" ADD COLUMN     "sameEventAsRank" INTEGER;
