import "dotenv/config";
import { PrismaClient } from "@prisma/client";
// Operator-only workflow. Never expose this as an unauthenticated HTTP endpoint.
const telegramId = process.argv[2],
  confirmed = process.argv[3] === "--confirm-shared-ledger-deletion";
if (!telegramId || !/^\d+$/.test(telegramId))
  throw new Error(
    "Usage: npm run db:erase -- TELEGRAM_ID [--confirm-shared-ledger-deletion]",
  );
const db = new PrismaClient();
try {
  const result = await db.$transaction(
    async (tx) => {
      const user = await tx.user.findUnique({
        where: { telegramId: BigInt(telegramId) },
      });
      if (!user) return { affectedLedgers: 0, deleted: false };
      const where = {
        OR: [{ participantA: user.id }, { participantB: user.id }],
      };
      const count = await tx.ledger.count({ where });
      if (!confirmed) return { affectedLedgers: count, deleted: false };
      await tx.ledger.deleteMany({ where });
      await tx.expenseDraft.deleteMany({ where: { creatorId: user.id } });
      await tx.expenseDraft.updateMany({
        where: { candidateId: user.id },
        data: { candidateId: null },
      });
      await tx.user.delete({ where: { id: user.id } });
      return { affectedLedgers: count, deleted: true };
    },
    { isolationLevel: "Serializable" },
  );
  console.info(JSON.stringify(result));
} finally {
  await db.$disconnect();
}
