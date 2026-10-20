import { retryableTransactionError } from "./transaction-errors.js";
import {
  Prisma,
  PrismaClient,
  type DraftKind,
  type Ledger,
} from "./generated/prisma/client.js";
import { delta, split, MAX_CENTS } from "./money.js";
export class DomainError extends Error {}
export type Identity = { id: number; first_name: string; last_name?: string };
export type Binding = { chat: string; message: string };
type Tx = Prisma.TransactionClient;
export type DraftInput = {
  kind: Exclude<DraftKind, "REVERSAL">;
  amount?: number;
  description: string;
};
export const safeName = (name: string) =>
  name.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 40) || "Nutzer";
const fail = (text: string): never => {
  throw new DomainError(text);
};
export class LedgerService {
  constructor(readonly db: PrismaClient) {}
  private async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction(fn, {
          isolationLevel: "Serializable",
          timeout: 10000,
        });
      } catch (e) {
        if (retryableTransactionError(e) && attempt < 5) {
          await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
  }
  private user(tx: Tx, who: Identity) {
    if (!Number.isSafeInteger(who.id) || who.id <= 0)
      fail("Ungültige Identität.");
    return tx.user.upsert({
      where: { telegramId: BigInt(who.id) },
      create: {
        telegramId: BigInt(who.id),
        displayName: safeName(who.first_name),
      },
      update: { displayName: safeName(who.first_name) },
    });
  }
  private async member(tx: Tx, who: Identity, chat: string) {
    const ledger = await tx.ledger.findUnique({
      where: { chatInstance: chat },
      include: { a: true, b: true },
    });
    if (!ledger)
      return fail(
        "Zuerst mit „einrichten“ eine gemeinsame Abrechnung erstellen.",
      );
    const uid =
      ledger.a.telegramId === BigInt(who.id)
        ? ledger.a.id
        : ledger.b.telegramId === BigInt(who.id)
          ? ledger.b.id
          : null;
    if (!uid) return fail("Kein Zugriff auf diese Abrechnung.");
    return { ledger, uid };
  }
  private async sum(tx: Tx, ledgerId: string): Promise<bigint> {
    const sum = await tx.ledgerEvent.aggregate({
      where: { ledgerId },
      _sum: { deltaCents: true },
    });
    return sum._sum.deltaCents ?? 0n;
  }
  async draft(who: Identity, queryId: string, input: DraftInput) {
    if (
      ["EXPENSE", "SETTLEMENT"].includes(input.kind) &&
      (!Number.isSafeInteger(input.amount) ||
        input.amount! <= 0 ||
        input.amount! > MAX_CENTS)
    )
      fail("Ungültiger Betrag.");
    if (
      !input.description ||
      input.description.length > 120 ||
      /[\p{Cc}\p{Cf}]/u.test(input.description)
    )
      fail("Ungültige Beschreibung.");
    return this.tx(async (tx) => {
      const user = await this.user(tx, who);
      const prior = await tx.expenseDraft.findUnique({ where: { queryId } });
      if (prior) {
        if (prior.creatorId !== user.id) fail("Kein Zugriff.");
        return prior;
      }
      return tx.expenseDraft.create({
        data: {
          ...input,
          creatorId: user.id,
          queryId,
          expiresAt: new Date(Date.now() + 86400000),
        },
      });
    });
  }
  async chosen(who: Identity, id: string, message: string) {
    const d = await this.db.expenseDraft.findUnique({
      where: { id },
      include: { creator: true },
    });
    if (
      !d ||
      d.creator.telegramId !== BigInt(who.id) ||
      !["EXPENSE", "SETTLEMENT", "REVERSAL"].includes(d.kind) ||
      d.expiresAt < new Date()
    )
      return fail("Buchung nicht gespeichert. Bitte erneut eingeben.");
    if (d.status === "CONFIRMED") return;
    const user = await this.db.user.findUnique({
      where: { telegramId: BigInt(who.id) },
    });
    if (!user)
      return fail("Buchung nicht gespeichert. Bitte Abrechnung einrichten.");
    const ledgers = await this.db.ledger.findMany({
      where: {
        OR: [{ participantA: user.id }, { participantB: user.id }],
      },
      select: { chatInstance: true },
      take: 2,
    });
    if (ledgers.length !== 1)
      return fail(
        "Buchung nicht gespeichert. Es muss genau eine Abrechnung eingerichtet sein.",
      );
    await this.act(who, id, "bind", {
      chat: ledgers[0]!.chatInstance,
      message,
    });
  }
  async inlineLedgerStatus(
    who: Identity,
  ): Promise<"setup" | "multiple" | "ready"> {
    const user = await this.db.user.findUnique({
      where: { telegramId: BigInt(who.id) },
    });
    if (!user) return "setup";
    const ledgers = await this.db.ledger.findMany({
      where: {
        OR: [{ participantA: user.id }, { participantB: user.id }],
      },
      select: { id: true },
      take: 2,
    });
    if (ledgers.length === 0) return "setup";
    return ledgers.length === 1 ? "ready" : "multiple";
  }
  async act(who: Identity, id: string, action: string, c: Binding) {
    if (!c.chat || !c.message)
      fail("Nur Inline-Nachrichten werden unterstützt.");
    return this.tx(async (tx) => {
      let d = await tx.expenseDraft.findUnique({ where: { id } });
      if (!d) return fail("Nachricht nicht mehr verfügbar.");
      const u = await this.user(tx, who),
        owner = d.creatorId === u.id;
      if (
        (d.inlineMessageId && d.inlineMessageId !== c.message) ||
        (d.chatInstance && d.chatInstance !== c.chat)
      )
        fail("Nachricht gehört zu einem anderen Chat.");
      if (
        d.status !== "CONFIRMED" &&
        (d.status === "EXPIRED" || d.expiresAt < new Date())
      )
        fail("Entwurf abgelaufen. Bitte neu eingeben.");
      if (!d.chatInstance) {
        if (!owner || action !== "bind")
          fail("Zuerst muss die erstellende Person den Chat bestätigen.");
        let ledgerId = d.ledgerId;
        if (d.kind !== "SETUP") {
          const { ledger } = await this.member(tx, who, c.chat);
          if (d.ledgerId && d.ledgerId !== ledger.id)
            fail("Falsche Abrechnung.");
          ledgerId = ledger.id;
        } else {
          const exists = await tx.ledger.findUnique({
            where: { chatInstance: c.chat },
          });
          if (exists) {
            await this.member(tx, who, c.chat);
            fail("Abrechnung existiert bereits. „saldo“ verwenden.");
          }
        }
        d = await tx.expenseDraft.update({
          where: { id },
          data: {
            ledgerId,
            chatInstance: c.chat,
            inlineMessageId: c.message,
          },
        });
        if (d.kind === "SETUP" || d.kind === "STATUS") return d;
      }
      if (d.kind === "SETUP" && d.status !== "CONFIRMED") {
        if (action === "bind" && owner) return d;
        if (action === "join" && !owner) {
          if (d.creatorId === u.id)
            fail("Die erstellende Person kann nicht selbst beitreten.");
          const exists = await tx.ledger.findUnique({
            where: { chatInstance: c.chat },
          });
          if (exists) {
            await this.member(tx, who, c.chat);
            fail("Abrechnung existiert bereits. „saldo“ verwenden.");
          }
          const ledger = await tx.ledger.create({
            data: {
              chatInstance: c.chat,
              participantA: d.creatorId,
              participantB: u.id,
            },
          });
          await tx.ledgerEvent.create({
            data: {
              ledgerId: ledger.id,
              actorId: u.id,
              kind: "SETUP",
              draftId: d.id,
            },
          });
          return tx.expenseDraft.update({
            where: { id },
            data: {
              candidateId: null,
              ledgerId: ledger.id,
              status: "CONFIRMED",
            },
          });
        }
        return fail("Keine Berechtigung für diese Aktion.");
      }
      const { ledger, uid } = await this.member(tx, who, c.chat);
      if (d.ledgerId !== ledger.id) fail("Falsche Abrechnung.");
      if (d.status === "CONFIRMED") return d; // Membership and immutable binding checked BEFORE idempotent return.
      if (
        (action === "bind" && owner && d.kind === "STATUS") ||
        action === "view"
      )
        return d;
      if (action !== "bind" || !owner)
        fail("Nur die erstellende Person kann buchen.");
      if (![ledger.participantA, ledger.participantB].includes(d.creatorId))
        fail("Ungültiger Zahler.");
      const payerIsA = d.creatorId === ledger.participantA,
        peerId = payerIsA ? ledger.participantB : ledger.participantA;
      if (d.kind === "REVERSAL") {
        const target = await tx.ledgerEvent.findUnique({
          where: { id: d.targetEventId! },
          include: { reversedBy: true },
        });
        if (
          !target ||
          target.ledgerId !== ledger.id ||
          !["EXPENSE", "SETTLEMENT"].includes(target.kind) ||
          target.reversedBy
        )
          return fail("Buchung nicht stornierbar.");
        await tx.ledgerEvent.create({
          data: {
            ledgerId: ledger.id,
            actorId: uid,
            kind: "REVERSAL",
            deltaCents: -target.deltaCents,
            draftId: d.id,
            reversesId: target.id,
          },
        });
      } else {
        const kind: "EXPENSE" | "SETTLEMENT" =
          d.kind === "EXPENSE"
            ? d.kind
            : d.kind === "SETTLEMENT"
              ? d.kind
              : fail("Ungültige Aktion.");
        const amount = d.amount!;
        const change = delta(kind, amount, payerIsA);
        const event = {
          ledgerId: ledger.id,
          actorId: uid,
          kind,
          deltaCents: change,
          draftId: d.id,
        };
        if (kind === "EXPENSE") {
          const [shareA, shareB] = split(amount, payerIsA);
          const expense = await tx.expense.create({
            data: {
              ledgerId: ledger.id,
              payerId: d.creatorId,
              amount,
              shareA,
              shareB,
              description: d.description,
              draftId: d.id,
            },
          });
          await tx.ledgerEvent.create({
            data: { ...event, expenseId: expense.id },
          });
        } else {
          const bal = await this.sum(tx, ledger.id);
          const debt = payerIsA ? -bal : bal;
          if (debt <= 0n || BigInt(amount) > debt)
            fail(
              "Zahlung übersteigt die aktuelle Schuld oder hat die falsche Richtung.",
            );
          const settlement = await tx.settlement.create({
            data: {
              ledgerId: ledger.id,
              payerId: d.creatorId,
              recipientId: peerId,
              amount,
              draftId: d.id,
            },
          });
          await tx.ledgerEvent.create({
            data: { ...event, settlementId: settlement.id },
          });
        }
      }
      return tx.expenseDraft.update({
        where: { id },
        data: { status: "CONFIRMED" },
      });
    });
  }
  async snapshot(who: Identity, id: string, c: Binding) {
    return this.tx(async (tx) => {
      const d = await tx.expenseDraft.findUnique({
        where: { id },
        include: { creator: true },
      });
      if (!d || d.chatInstance !== c.chat || d.inlineMessageId !== c.message)
        return fail("Ungültige Nachricht.");
      if (d.kind === "SETUP" && d.status === "OPEN") {
        const candidate = d.candidateId
          ? await tx.user.findUnique({ where: { id: d.candidateId } })
          : null;
        if (
          d.creator.telegramId !== BigInt(who.id) &&
          candidate?.telegramId !== BigInt(who.id)
        )
          fail("Kein Zugriff.");
        return { draft: d, candidate, ledger: null, balance: 0n };
      }
      const { ledger } = await this.member(tx, who, c.chat);
      if (d.ledgerId !== ledger.id) fail("Kein Zugriff.");
      return {
        draft: d,
        candidate: null,
        ledger,
        balance: await this.sum(tx, ledger.id),
      };
    });
  }
  async balance(who: Identity, chat: string) {
    return this.tx(async (tx) => {
      const { ledger } = await this.member(tx, who, chat);
      return this.sum(tx, ledger.id);
    });
  }
  async history(who: Identity, id: string, c: Binding, page: number) {
    await this.snapshot(who, id, c);
    return this.tx(async (tx) => {
      const { ledger } = await this.member(tx, who, c.chat);
      const where = {
        ledgerId: ledger.id,
        kind: { notIn: ["SETUP" as DraftKind, "STATUS" as DraftKind] },
      };
      const count = await tx.expenseDraft.count({ where });
      const index = Math.min(Math.max(0, page), Math.max(0, count - 1));
      const rows = await tx.expenseDraft.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: index,
        take: 1,
        include: {
          creator: true,
          event: { include: { reversedBy: true } },
          expense: true,
        },
      });
      return { row: rows[0], count, page: index, ledger };
    });
  }
  async reversal(
    who: Identity,
    queryId: string,
    eventId: string,
    chat: string,
  ) {
    return this.tx(async (tx) => {
      const { ledger, uid } = await this.member(tx, who, chat);
      const target = await tx.ledgerEvent.findUnique({
        where: { id: eventId },
        include: { reversedBy: true, draft: true },
      });
      if (
        !target ||
        target.ledgerId !== ledger.id ||
        !["EXPENSE", "SETTLEMENT"].includes(target.kind) ||
        target.reversedBy
      )
        return fail("Buchung nicht stornierbar.");
      return tx.expenseDraft.upsert({
        where: { queryId },
        create: {
          queryId,
          creatorId: uid,
          kind: "REVERSAL",
          description: `Storno: ${target.draft.description}`.slice(0, 120),
          amount: target.draft.amount,
          targetEventId: eventId,
          ledgerId: ledger.id,
          expiresAt: new Date(Date.now() + 86400000),
        },
        update: {},
      });
    });
  }
  async reversalFromInline(who: Identity, queryId: string, eventId: string) {
    const e = await this.db.ledgerEvent.findUnique({
      where: { id: eventId },
      include: { ledger: true },
    });
    if (!e) return fail("Buchung nicht verfügbar.");
    return this.reversal(who, queryId, eventId, e.ledger.chatInstance);
  }
}
