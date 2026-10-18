-- CreateEnum
CREATE TYPE "DraftKind" AS ENUM ('SETUP', 'EXPENSE', 'SETTLEMENT', 'STATUS', 'REVERSAL');

-- CreateEnum
CREATE TYPE "DraftStatus" AS ENUM ('OPEN', 'CONFIRMED', 'EXPIRED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "displayName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ledger" (
    "id" TEXT NOT NULL,
    "chatInstance" TEXT NOT NULL,
    "participantA" TEXT NOT NULL,
    "participantB" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseDraft" (
    "id" TEXT NOT NULL,
    "queryId" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "kind" "DraftKind" NOT NULL,
    "amount" INTEGER,
    "description" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inlineMessageId" TEXT,
    "chatInstance" TEXT,
    "ledgerId" TEXT,
    "candidateId" TEXT,
    "creatorApproved" BOOLEAN NOT NULL DEFAULT false,
    "status" "DraftStatus" NOT NULL DEFAULT 'OPEN',
    "targetEventId" TEXT,

    CONSTRAINT "ExpenseDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "payerId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "shareA" INTEGER NOT NULL,
    "shareB" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "draftId" TEXT NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "payerId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CONFIRMED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "draftId" TEXT NOT NULL,

    CONSTRAINT "Settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEvent" (
    "id" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "deltaCents" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "draftId" TEXT NOT NULL,
    "expenseId" TEXT,
    "settlementId" TEXT,
    "reversesId" TEXT,

    CONSTRAINT "LedgerEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "Ledger_chatInstance_key" ON "Ledger"("chatInstance");

-- CreateIndex
CREATE INDEX "Ledger_participantA_idx" ON "Ledger"("participantA");

-- CreateIndex
CREATE INDEX "Ledger_participantB_idx" ON "Ledger"("participantB");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseDraft_queryId_key" ON "ExpenseDraft"("queryId");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseDraft_inlineMessageId_key" ON "ExpenseDraft"("inlineMessageId");

-- CreateIndex
CREATE INDEX "ExpenseDraft_expiresAt_status_idx" ON "ExpenseDraft"("expiresAt", "status");

-- CreateIndex
CREATE INDEX "ExpenseDraft_ledgerId_createdAt_idx" ON "ExpenseDraft"("ledgerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_draftId_key" ON "Expense"("draftId");

-- CreateIndex
CREATE INDEX "Expense_ledgerId_createdAt_idx" ON "Expense"("ledgerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_draftId_key" ON "Settlement"("draftId");

-- CreateIndex
CREATE INDEX "Settlement_ledgerId_createdAt_idx" ON "Settlement"("ledgerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEvent_draftId_key" ON "LedgerEvent"("draftId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEvent_expenseId_key" ON "LedgerEvent"("expenseId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEvent_settlementId_key" ON "LedgerEvent"("settlementId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEvent_reversesId_key" ON "LedgerEvent"("reversesId");

-- CreateIndex
CREATE INDEX "LedgerEvent_ledgerId_createdAt_id_idx" ON "LedgerEvent"("ledgerId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "Ledger" ADD CONSTRAINT "Ledger_participantA_fkey" FOREIGN KEY ("participantA") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ledger" ADD CONSTRAINT "Ledger_participantB_fkey" FOREIGN KEY ("participantB") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseDraft" ADD CONSTRAINT "ExpenseDraft_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseDraft" ADD CONSTRAINT "ExpenseDraft_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "Ledger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "Ledger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ExpenseDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "Ledger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Settlement" ADD CONSTRAINT "Settlement_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ExpenseDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEvent" ADD CONSTRAINT "LedgerEvent_ledgerId_fkey" FOREIGN KEY ("ledgerId") REFERENCES "Ledger"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEvent" ADD CONSTRAINT "LedgerEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEvent" ADD CONSTRAINT "LedgerEvent_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "ExpenseDraft"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEvent" ADD CONSTRAINT "LedgerEvent_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEvent" ADD CONSTRAINT "LedgerEvent_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEvent" ADD CONSTRAINT "LedgerEvent_reversesId_fkey" FOREIGN KEY ("reversesId") REFERENCES "LedgerEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Financial and state invariants are enforced in PostgreSQL as well as the service.
ALTER TABLE "Ledger" ADD CONSTRAINT "ledger_two_people" CHECK ("participantA" <> "participantB"), ADD CONSTRAINT "ledger_eur" CHECK (currency = 'EUR'), ADD CONSTRAINT "ledger_active" CHECK (status = 'ACTIVE');
ALTER TABLE "Expense" ADD CONSTRAINT "expense_positive" CHECK (amount > 0 AND amount <= 1000000000), ADD CONSTRAINT "expense_split" CHECK ("shareA" >= 0 AND "shareB" >= 0 AND "shareA" + "shareB" = amount), ADD CONSTRAINT "expense_confirmed" CHECK (status = 'CONFIRMED');
ALTER TABLE "Settlement" ADD CONSTRAINT "settlement_positive" CHECK (amount > 0 AND amount <= 1000000000), ADD CONSTRAINT "settlement_two_people" CHECK ("payerId" <> "recipientId"), ADD CONSTRAINT "settlement_confirmed" CHECK (status = 'CONFIRMED');
ALTER TABLE "ExpenseDraft" ADD CONSTRAINT "draft_amount" CHECK ((kind IN ('EXPENSE','SETTLEMENT','REVERSAL') AND amount > 0 AND amount <= 1000000000) OR (kind IN ('SETUP','STATUS') AND amount IS NULL));
ALTER TABLE "ExpenseDraft" ADD CONSTRAINT "draft_bound_chat" CHECK ("chatInstance" IS NULL OR "inlineMessageId" IS NOT NULL);
ALTER TABLE "ExpenseDraft" ADD CONSTRAINT "draft_candidate_fk" FOREIGN KEY ("candidateId") REFERENCES "User"(id) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExpenseDraft" ADD CONSTRAINT "draft_target_fk" FOREIGN KEY ("targetEventId") REFERENCES "LedgerEvent"(id) ON DELETE CASCADE;
ALTER TABLE "LedgerEvent" ADD CONSTRAINT "event_shape" CHECK (
  (kind='SETUP' AND "expenseId" IS NULL AND "settlementId" IS NULL AND "reversesId" IS NULL AND "deltaCents"=0) OR
  (kind='EXPENSE' AND "expenseId" IS NOT NULL AND "settlementId" IS NULL AND "reversesId" IS NULL) OR
  (kind='SETTLEMENT' AND "settlementId" IS NOT NULL AND "expenseId" IS NULL AND "reversesId" IS NULL) OR
  (kind='REVERSAL' AND "reversesId" IS NOT NULL AND "expenseId" IS NULL AND "settlementId" IS NULL)
);
