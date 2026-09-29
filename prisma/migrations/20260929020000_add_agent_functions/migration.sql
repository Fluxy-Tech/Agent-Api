-- CreateEnum
CREATE TYPE "AgentFunctionType" AS ENUM ('CALENDAR_EVENT', 'KANBAN_CARD');

-- CreateTable
CREATE TABLE "AgentFunction" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "type" "AgentFunctionType" NOT NULL,
    "runAtStart" BOOLEAN NOT NULL DEFAULT false,
    "runAfterMetadata" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentFunction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentFunction_agentId_idx" ON "AgentFunction"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentFunction_agentId_type_key" ON "AgentFunction"("agentId", "type");

-- AddForeignKey
ALTER TABLE "AgentFunction" ADD CONSTRAINT "AgentFunction_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: evento passa a ter um usuário responsável (opcional)
ALTER TABLE "CalendarEvent" ADD COLUMN "userId" TEXT;

-- CreateIndex
CREATE INDEX "CalendarEvent_userId_idx" ON "CalendarEvent"("userId");

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: comentário sem usuário = comentário do agente de IA
ALTER TABLE "CardCrmComment" ALTER COLUMN "userId" DROP NOT NULL;
