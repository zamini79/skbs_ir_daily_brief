-- CreateTable
CREATE TABLE "Instrument" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "displayOrder" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "quoteSource" TEXT NOT NULL,
    "quoteSymbol" TEXT NOT NULL,
    "newsQuery" TEXT NOT NULL,
    "isIndex" BOOLEAN NOT NULL DEFAULT false,
    "sharesOutstanding" BIGINT,
    "priceDivisorForMarketCap" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Instrument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YearOpenPrice" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "YearOpenPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BriefRun" (
    "id" TEXT NOT NULL,
    "tradeDate" TEXT NOT NULL,
    "runDate" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "BriefRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteSnapshot" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "close" DECIMAL(65,30),
    "prevClose" DECIMAL(65,30),
    "changePct" DOUBLE PRECISION,
    "ytdPct" DOUBLE PRECISION,
    "marketCapKrwTrillion" DECIMAL(65,30),
    "fxRate" DOUBLE PRECISION,
    "asOf" TEXT,
    "sourceName" TEXT NOT NULL,
    "errorMessage" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsCandidate" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "publisher" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "clusterSize" INTEGER NOT NULL,

    CONSTRAINT "NewsCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NewsSummary" (
    "id" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "variant" INTEGER NOT NULL,
    "text" TEXT NOT NULL,

    CONSTRAINT "NewsSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Selection" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "decision" TEXT NOT NULL DEFAULT 'PENDING',
    "chosenCandidateId" TEXT,
    "chosenSummaryId" TEXT,
    "editedText" TEXT,
    "manualClose" DECIMAL(65,30),
    "manualPrevClose" DECIMAL(65,30),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Selection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Instrument_displayOrder_key" ON "Instrument"("displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "YearOpenPrice_instrumentId_year_key" ON "YearOpenPrice"("instrumentId", "year");

-- CreateIndex
CREATE UNIQUE INDEX "BriefRun_runDate_key" ON "BriefRun"("runDate");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteSnapshot_runId_instrumentId_key" ON "QuoteSnapshot"("runId", "instrumentId");

-- CreateIndex
CREATE UNIQUE INDEX "NewsCandidate_runId_instrumentId_rank_key" ON "NewsCandidate"("runId", "instrumentId", "rank");

-- CreateIndex
CREATE UNIQUE INDEX "NewsSummary_candidateId_variant_key" ON "NewsSummary"("candidateId", "variant");

-- CreateIndex
CREATE UNIQUE INDEX "Selection_runId_instrumentId_key" ON "Selection"("runId", "instrumentId");

-- AddForeignKey
ALTER TABLE "YearOpenPrice" ADD CONSTRAINT "YearOpenPrice_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteSnapshot" ADD CONSTRAINT "QuoteSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BriefRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteSnapshot" ADD CONSTRAINT "QuoteSnapshot_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsCandidate" ADD CONSTRAINT "NewsCandidate_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BriefRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsCandidate" ADD CONSTRAINT "NewsCandidate_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsSummary" ADD CONSTRAINT "NewsSummary_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "NewsCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Selection" ADD CONSTRAINT "Selection_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BriefRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Selection" ADD CONSTRAINT "Selection_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
