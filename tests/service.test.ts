import { createDatabase } from "../src/database.js";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { LedgerService, DomainError } from "../src/service.js";
import { cleanup } from "../src/maintenance.js";
import { randomUUID } from "node:crypto";
const db = createDatabase();
const svc = new LedgerService(db);
const prefix = randomUUID();
const anna = { id: 101, first_name: "Anna" },
  max = { id: 102, first_name: "Max" },
  lisa = { id: 103, first_name: "Lisa" },
  stranger = { id: 104, first_name: "Stranger" };
let i = 0;
const query = () => prefix + String(++i);
async function setup(chat: string, peer = max) {
  const d = await svc.draft(anna, query(), {
    kind: "SETUP",
    description: "Einrichten",
  });
  const c = { chat, message: query() };
  await svc.act(anna, d.id, "bind", c);
  await svc.act(peer, d.id, "join", c);
  return db.ledger.findUniqueOrThrow({ where: { chatInstance: chat } });
}
async function book(
  chat: string,
  payer = anna,
  amount = 4000,
  kind: "EXPENSE" | "SETTLEMENT" = "EXPENSE",
) {
  const d = await svc.draft(payer, query(), {
    kind,
    amount,
    description: kind === "EXPENSE" ? "Essen" : "Ausgleich",
  });
  const c = { chat, message: query() };
  await svc.act(payer, d.id, "bind", c);
  return { d, c };
}
describe.skipIf(!process.env.DATABASE_URL)(
  "PostgreSQL ledger integration",
  () => {
    beforeAll(async () => {
      await db.$connect();
    });
    afterAll(async () => {
      await db.ledger.deleteMany({
        where: { chatInstance: { startsWith: prefix } },
      });
      await db.expenseDraft.deleteMany({
        where: { queryId: { startsWith: prefix } },
      });
      await db.$disconnect();
    });
    it("40 / 16 / 12 / later 10 stays on the same permanent ledger", async () => {
      const chat = query();
      const ledger = await setup(chat);
      await book(chat);
      expect(await svc.balance(anna, chat)).toBe(2000n);
      await book(chat, max, 1600);
      expect(await svc.balance(anna, chat)).toBe(1200n);
      await book(chat, max, 1200, "SETTLEMENT");
      expect(await svc.balance(anna, chat)).toBe(0n);
      await book(chat, anna, 1000);
      expect(await svc.balance(anna, chat)).toBe(500n);
      expect(
        (await db.ledger.findUniqueOrThrow({ where: { chatInstance: chat } }))
          .id,
      ).toBe(ledger.id);
    });
    it("isolates Anna-Max and Anna-Lisa, rejects outsiders", async () => {
      const c1 = query(),
        c2 = query();
      await setup(c1);
      await setup(c2, lisa);
      await book(c1);
      await book(c2, anna, 1000);
      expect(await svc.balance(anna, c1)).toBe(2000n);
      expect(await svc.balance(anna, c2)).toBe(500n);
      await expect(svc.balance(stranger, c1)).rejects.toBeInstanceOf(
        DomainError,
      );
      const d = await svc.draft(stranger, query(), {
        kind: "EXPENSE",
        amount: 1000,
        description: "No",
      });
      await expect(
        svc.act(stranger, d.id, "bind", { chat: c1, message: query() }),
      ).rejects.toBeInstanceOf(DomainError);
    });
    it("lets the creator finalize once; rejects replay across contexts", async () => {
      const chat = query();
      await setup(chat);
      const d = await svc.draft(anna, query(), {
          kind: "EXPENSE",
          amount: 1001,
          description: "Odd",
        }),
        c = { chat, message: query() };
      await expect(svc.act(max, d.id, "bind", c)).rejects.toBeInstanceOf(
        DomainError,
      );
      await svc.act(anna, d.id, "bind", c);
      expect(await svc.balance(anna, chat)).toBe(501n);
      await expect(
        svc.act(max, d.id, "bind", { ...c, message: "forward" }),
      ).rejects.toBeInstanceOf(DomainError);
      await expect(
        svc.act(max, d.id, "bind", { ...c, chat: "elsewhere" }),
      ).rejects.toBeInstanceOf(DomainError);
      await Promise.all(
        Array.from({ length: 5 }, () => svc.act(anna, d.id, "bind", c)),
      );
      expect(await db.expense.count({ where: { draftId: d.id } })).toBe(1);
      const e = await db.expense.findUniqueOrThrow({
        where: { draftId: d.id },
      });
      expect(e.shareA + e.shareB).toBe(1001);
      expect(e.shareA).toBe(501);
    });
    it("activates setup when the second person joins", async () => {
      const chat = query(),
        c = { chat, message: query() };
      const d = await svc.draft(anna, query(), {
        kind: "SETUP",
        description: "Setup",
      });
      await svc.act(anna, d.id, "bind", c);
      await expect(svc.act(anna, d.id, "join", c)).rejects.toBeInstanceOf(
        DomainError,
      );
      await svc.act(stranger, d.id, "join", c);
      expect(
        (await db.expenseDraft.findUniqueOrThrow({ where: { id: d.id } }))
          .status,
      ).toBe("CONFIRMED");
      await expect(svc.act(stranger, d.id, "join", c)).resolves.toMatchObject({
        status: "CONFIRMED",
      });
      expect(await svc.balance(anna, chat)).toBe(0n);
      await expect(svc.balance(stranger, chat)).resolves.toBe(0n);
    });
    it("rejects wrong-direction and excessive settlements; supports partial payments", async () => {
      const chat = query();
      await setup(chat);
      await book(chat);
      await expect(book(chat, anna, 100, "SETTLEMENT")).rejects.toBeInstanceOf(
        DomainError,
      );
      await expect(book(chat, max, 2001, "SETTLEMENT")).rejects.toBeInstanceOf(
        DomainError,
      );
      await book(chat, max, 500, "SETTLEMENT");
      expect(await svc.balance(max, chat)).toBe(1500n);
    });
    it("expires drafts and allows auditable creator reversal exactly once", async () => {
      const chat = query();
      await setup(chat);
      const { d } = await book(chat);
      const entry = await db.ledgerEvent.findUniqueOrThrow({
        where: { draftId: d.id },
      });
      const rev = await svc.reversal(anna, query(), entry.id, chat),
        c = { chat, message: query() };
      await svc.act(anna, rev.id, "bind", c);
      expect(await svc.balance(anna, chat)).toBe(0n);
      expect(await db.expense.count({ where: { draftId: d.id } })).toBe(1);
      expect(
        await db.ledgerEvent.count({ where: { reversesId: entry.id } }),
      ).toBe(1);
      const expired = await svc.draft(anna, query(), {
        kind: "EXPENSE",
        amount: 100,
        description: "Expired",
      });
      await db.expenseDraft.update({
        where: { id: expired.id },
        data: { expiresAt: new Date(0) },
      });
      await expect(svc.act(anna, expired.id, "bind", c)).rejects.toBeInstanceOf(
        DomainError,
      );
    });
    it("deduplicates repeated inline updates by query id", async () => {
      const id = query(),
        input = { kind: "EXPENSE" as const, amount: 100, description: "Same" };
      const [a, b] = await Promise.all([
        svc.draft(anna, id, input),
        svc.draft(anna, id, input),
      ]);
      expect(a.id).toBe(b.id);
    });
    it("retains a completed setup during cleanup", async () => {
      const peer = { id: 909001, first_name: "Fresh candidate" },
        chat = query(),
        c = { chat, message: query() };
      const d = await svc.draft(anna, query(), {
        kind: "SETUP",
        description: "Setup",
      });
      await svc.act(anna, d.id, "bind", c);
      await svc.act(peer, d.id, "join", c);
      await cleanup(db);
      expect(
        (await db.expenseDraft.findUniqueOrThrow({ where: { id: d.id } }))
          .status,
      ).toBe("CONFIRMED");
      expect(await svc.balance(peer, chat)).toBe(0n);
    });
  },
);
