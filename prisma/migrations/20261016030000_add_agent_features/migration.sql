-- CreateEnum
CREATE TYPE "AgentFeatureType" AS ENUM ('CATALOG', 'PRODUCT_CAROUSEL', 'CTA_URL', 'LIST', 'REPLY_BUTTONS', 'MEDIA_CAROUSEL', 'LOCATION_REQUEST', 'CONTEXTUAL_REPLY', 'LINK_PREVIEW', 'PAYMENT');

-- CreateTable
CREATE TABLE "AgentFeature" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "type" "AgentFeatureType" NOT NULL,
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL DEFAULT '',
    "config" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentFeature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentFeature_agentId_idx" ON "AgentFeature"("agentId");

-- AddForeignKey
ALTER TABLE "AgentFeature" ADD CONSTRAINT "AgentFeature_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migra o catálogo único do agente (colunas catalog*) para uma funcionalidade CATALOG.
INSERT INTO "AgentFeature" ("id", "agentId", "type", "name", "prompt", "config", "updatedAt")
SELECT 'cmig' || substr(md5(random()::text || a."id"), 1, 21), a."id", 'CATALOG',
       COALESCE(NULLIF(a."catalogName", ''), 'Catálogo'), COALESCE(a."catalogPrompt", ''),
       jsonb_build_object('catalogId', a."catalogId", 'catalogName', COALESCE(a."catalogName", '')),
       CURRENT_TIMESTAMP
FROM "Agent" a
WHERE a."catalogEnabled" = true AND a."catalogId" IS NOT NULL;
