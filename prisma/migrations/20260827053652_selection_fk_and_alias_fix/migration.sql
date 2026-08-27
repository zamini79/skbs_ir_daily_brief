-- AddForeignKey
ALTER TABLE "Selection" ADD CONSTRAINT "Selection_chosenCandidateId_fkey" FOREIGN KEY ("chosenCandidateId") REFERENCES "NewsCandidate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Selection" ADD CONSTRAINT "Selection_chosenSummaryId_fkey" FOREIGN KEY ("chosenSummaryId") REFERENCES "NewsSummary"("id") ON DELETE SET NULL ON UPDATE CASCADE;
