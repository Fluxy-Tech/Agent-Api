-- CreateEnum
CREATE TYPE "TokenOrigin" AS ENUM ('OPENAI', 'ADK');

-- CreateTable
CREATE TABLE "Token" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "origin" "TokenOrigin" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Token_agentId_createdAt_idx" ON "Token"("agentId", "createdAt");

-- AddForeignKey
ALTER TABLE "Token" ADD CONSTRAINT "Token_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
