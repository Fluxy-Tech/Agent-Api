-- CreateTable
CREATE TABLE "CrmSettings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "calendarUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "calendarVisibleToAgent" BOOLEAN NOT NULL DEFAULT false,
    "kanbanUserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "kanbanMaxCardsPerUser" INTEGER,
    "kanbanVisibleToAgent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmSettings_organizationId_key" ON "CrmSettings"("organizationId");

-- AddForeignKey
ALTER TABLE "CrmSettings" ADD CONSTRAINT "CrmSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
