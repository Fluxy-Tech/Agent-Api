-- CreateTable
CREATE TABLE "SupportAgentSettings" (
    "userId" TEXT NOT NULL,
    "severities" "SupportSeverity"[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportAgentSettings_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "SupportAgentSettings" ADD CONSTRAINT "SupportAgentSettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
