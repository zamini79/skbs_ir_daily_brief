-- DropForeignKey
ALTER TABLE "YearOpenPrice" DROP CONSTRAINT "YearOpenPrice_instrumentId_fkey";

-- DropTable
DROP TABLE "YearOpenPrice";

-- CreateTable
CREATE TABLE "YtdBasePrice" (
    "id" TEXT NOT NULL,
    "instrumentId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "price" DECIMAL(65,30) NOT NULL,

    CONSTRAINT "YtdBasePrice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "YtdBasePrice_instrumentId_year_key" ON "YtdBasePrice"("instrumentId", "year");

-- AddForeignKey
ALTER TABLE "YtdBasePrice" ADD CONSTRAINT "YtdBasePrice_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

