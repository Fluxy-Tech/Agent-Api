-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "batchIntervalMinutes" INTEGER,
ADD COLUMN     "batchSize" INTEGER,
ADD COLUMN     "nextBatchAt" TIMESTAMP(3),
ADD COLUMN     "scheduledAt" TIMESTAMP(3),
ADD COLUMN     "templateBodyText" TEXT,
ADD COLUMN     "templateHeaderText" TEXT;

-- CreateTable
CREATE TABLE "CampaignPendingContact" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "contact" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignPendingContact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CampaignPendingContact_campaignId_position_idx" ON "CampaignPendingContact"("campaignId", "position");

-- CreateIndex
CREATE INDEX "Campaign_status_active_nextBatchAt_idx" ON "Campaign"("status", "active", "nextBatchAt");

-- AddForeignKey
ALTER TABLE "CampaignPendingContact" ADD CONSTRAINT "CampaignPendingContact_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
