-- CreateTable
CREATE TABLE "AgentMetadataField" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameToAgent" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentMetadataField_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentMetadataField_agentId_idx" ON "AgentMetadataField"("agentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentMetadataField_agentId_nameToAgent_key" ON "AgentMetadataField"("agentId", "nameToAgent");

-- AddForeignKey
ALTER TABLE "AgentMetadataField" ADD CONSTRAINT "AgentMetadataField_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
