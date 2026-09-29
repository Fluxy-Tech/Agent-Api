-- AlterTable: o que fazer ao terminar a coleta/funções (true = atendimento humano, false = finalizar)
ALTER TABLE "Agent" ADD COLUMN "handoffAfterFunctions" BOOLEAN NOT NULL DEFAULT false;
