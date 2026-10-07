-- CreateTable
CREATE TABLE "SupportTicketReadState" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTicketReadState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupportTicketReadState_ticketId_userId_key" ON "SupportTicketReadState"("ticketId", "userId");

-- CreateIndex
CREATE INDEX "SupportTicketReadState_userId_idx" ON "SupportTicketReadState"("userId");

-- AddForeignKey
ALTER TABLE "SupportTicketReadState" ADD CONSTRAINT "SupportTicketReadState_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicketReadState" ADD CONSTRAINT "SupportTicketReadState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
