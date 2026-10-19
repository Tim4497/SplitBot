import { PrismaClient } from "./generated/prisma/client.js";
export async function cleanup(db: PrismaClient) {
  await db.$transaction(
    async (tx) => {
      // Bound financial drafts stay in history, explicitly marked expired.
      await tx.expenseDraft.updateMany({
        where: {
          status: "OPEN",
          expiresAt: { lt: new Date() },
          ledgerId: { not: null },
        },
        data: { status: "EXPIRED" },
      });
      await tx.expenseDraft.deleteMany({
        where: {
          status: { not: "CONFIRMED" },
          ledgerId: null,
          expiresAt: { lt: new Date() },
        },
      });
      await tx.user.deleteMany({
        where: {
          ledgersA: { none: {} },
          ledgersB: { none: {} },
          drafts: { none: {} },
          expenses: { none: {} },
          payments: { none: {} },
          receipts: { none: {} },
          events: { none: {} },
          candidates: { none: {} },
        },
      });
    },
    { isolationLevel: "Serializable" },
  );
}
