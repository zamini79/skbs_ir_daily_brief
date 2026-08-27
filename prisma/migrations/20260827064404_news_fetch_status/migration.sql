-- CreateTable
CREATE TABLE "NewsFetch" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NewsFetch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NewsFetch_runId_instrumentId_key" ON "NewsFetch"("runId", "instrumentId");

-- AddForeignKey
ALTER TABLE "NewsFetch" ADD CONSTRAINT "NewsFetch_runId_fkey" FOREIGN KEY ("runId") REFERENCES "BriefRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NewsFetch" ADD CONSTRAINT "NewsFetch_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

