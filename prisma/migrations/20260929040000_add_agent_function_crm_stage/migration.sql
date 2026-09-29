-- AlterTable: estágio do Kanban em que a função KANBAN_CARD cria o card (null = estágio padrão)
ALTER TABLE "AgentFunction" ADD COLUMN "crmStageId" TEXT;

-- CreateIndex
CREATE INDEX "AgentFunction_crmStageId_idx" ON "AgentFunction"("crmStageId");

-- AddForeignKey
ALTER TABLE "AgentFunction" ADD CONSTRAINT "AgentFunction_crmStageId_fkey" FOREIGN KEY ("crmStageId") REFERENCES "StagesCrm"("id") ON DELETE SET NULL ON UPDATE CASCADE;
