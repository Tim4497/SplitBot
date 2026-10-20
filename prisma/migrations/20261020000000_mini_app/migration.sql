ALTER TABLE "Expense" ADD COLUMN "splitPercentA" INTEGER;

ALTER TABLE "Expense" ADD CONSTRAINT "expense_split_percent"
CHECK ("splitPercentA" IS NULL OR "splitPercentA" BETWEEN 0 AND 100);

CREATE TABLE "MiniAppInvite" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "joinedById" TEXT,
    "ledgerId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MiniAppInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MiniAppInvite_code_key" ON "MiniAppInvite"("code");
CREATE INDEX "MiniAppInvite_creatorId_expiresAt_idx" ON "MiniAppInvite"("creatorId", "expiresAt");

ALTER TABLE "MiniAppInvite" ADD CONSTRAINT "MiniAppInvite_creatorId_fkey"
FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MiniAppInvite" ADD CONSTRAINT "MiniAppInvite_joinedById_fkey"
FOREIGN KEY ("joinedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MiniAppInvite" ADD CONSTRAINT "MiniAppInvite_ledgerId_fkey"
FOREIGN KEY ("ledgerId") REFERENCES "Ledger"("id") ON DELETE CASCADE ON UPDATE CASCADE;
