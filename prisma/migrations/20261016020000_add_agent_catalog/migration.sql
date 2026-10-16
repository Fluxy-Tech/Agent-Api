-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "catalogEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "catalogId" TEXT,
ADD COLUMN     "catalogName" TEXT,
ADD COLUMN     "catalogPrompt" TEXT;
