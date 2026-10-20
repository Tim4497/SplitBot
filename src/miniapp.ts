import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { euro, MAX_CENTS, splitByPercent } from "./money.js";
import { retryableTransactionError } from "./transaction-errors.js";
import { safeName } from "./service.js";

type TelegramIdentity = { id: number; first_name: string };
type Tx = Prisma.TransactionClient;

class AppError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function verifyTelegramInitData(
  value: string | undefined,
  token: string,
): TelegramIdentity {
  if (!value || value.length > 16_384)
    throw new AppError("Open this app in Telegram.", 401);
  const params = new URLSearchParams(value);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));
  if (
    !hash ||
    !/^[a-f0-9]{64}$/i.test(hash) ||
    !Number.isSafeInteger(authDate) ||
    authDate > Math.floor(Date.now() / 1000) + 60 ||
    Math.floor(Date.now() / 1000) - authDate > 86_400
  )
    throw new AppError("Telegram authorization expired. Reopen the app.", 401);
  const check = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, val]) => `${key}=${val}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  const provided = Buffer.from(hash, "hex");
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  )
    throw new AppError("Invalid Telegram authorization.", 401);
  try {
    const user = JSON.parse(
      params.get("user") ?? "",
    ) as Partial<TelegramIdentity>;
    if (
      !Number.isSafeInteger(user.id) ||
      Number(user.id) <= 0 ||
      typeof user.first_name !== "string"
    )
      throw new Error();
    return { id: Number(user.id), first_name: safeName(user.first_name) };
  } catch {
    throw new AppError("Invalid Telegram user.", 401);
  }
}

async function transaction<T>(
  db: PrismaClient,
  action: (tx: Tx) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(action, {
        isolationLevel: "Serializable",
        timeout: 10_000,
      });
    } catch (error) {
      if (retryableTransactionError(error) && attempt < 5) {
        await new Promise((resolveWait) =>
          setTimeout(resolveWait, 10 * (attempt + 1)),
        );
        continue;
      }
      throw error;
    }
  }
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new AppError("Expected JSON.", 415);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const part = Buffer.from(chunk);
    size += part.length;
    if (size > 16_384) throw new AppError("Request too large.", 413);
    chunks.push(part);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new AppError("Invalid JSON.");
  }
}

function amount(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) <= 0 ||
    Number(value) > MAX_CENTS
  )
    throw new AppError("Amount must be between 0.01 and 10,000,000.");
  return Number(value);
}

function description(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 120 ||
    /[\p{Cc}\p{Cf}]/u.test(value)
  )
    throw new AppError("Description is required (maximum 120 characters).");
  return value.trim();
}

async function authenticatedUser(tx: Tx, identity: TelegramIdentity) {
  return tx.user.upsert({
    where: { telegramId: BigInt(identity.id) },
    create: {
      telegramId: BigInt(identity.id),
      displayName: identity.first_name,
    },
    update: { displayName: identity.first_name },
  });
}

async function memberLedger(tx: Tx, userId: string, ledgerId: unknown) {
  if (typeof ledgerId !== "string" || !ledgerId)
    throw new AppError("Choose a ledger.");
  const ledger = await tx.ledger.findUnique({
    where: { id: ledgerId },
    include: { a: true, b: true },
  });
  if (!ledger || ![ledger.participantA, ledger.participantB].includes(userId))
    throw new AppError("Ledger not found.", 404);
  return ledger;
}

function payerId(
  ledger: {
    a: { id: string; telegramId: bigint };
    b: { id: string; telegramId: bigint };
  },
  value: unknown,
) {
  if (value === ledger.a.telegramId.toString()) return ledger.a.id;
  if (value === ledger.b.telegramId.toString()) return ledger.b.id;
  throw new AppError("Choose one of the two ledger participants.");
}

async function createEntry(
  tx: Tx,
  ledger: {
    id: string;
    chatInstance: string;
    participantA: string;
    participantB: string;
  },
  actorId: string,
  input: {
    kind: "EXPENSE" | "SETTLEMENT";
    amount: number;
    description: string;
    payerId: string;
    payerSharePercent?: number;
  },
) {
  const queryId = randomUUID();
  const draft = await tx.expenseDraft.create({
    data: {
      queryId,
      creatorId: actorId,
      kind: input.kind,
      amount: input.amount,
      description: input.description,
      expiresAt: new Date(Date.now() + 86_400_000),
      inlineMessageId: `miniapp:${randomUUID()}`,
      chatInstance: ledger.chatInstance,
      ledgerId: ledger.id,
      status: "CONFIRMED",
    },
  });
  if (input.kind === "EXPENSE") {
    const payerIsA = input.payerId === ledger.participantA;
    const [shareA, shareB] = splitByPercent(
      input.amount,
      payerIsA,
      input.payerSharePercent!,
    );
    const expense = await tx.expense.create({
      data: {
        ledgerId: ledger.id,
        payerId: input.payerId,
        amount: input.amount,
        shareA,
        shareB,
        splitPercentA: payerIsA
          ? input.payerSharePercent!
          : 100 - input.payerSharePercent!,
        description: input.description,
        draftId: draft.id,
      },
    });
    await tx.ledgerEvent.create({
      data: {
        ledgerId: ledger.id,
        actorId,
        kind: "EXPENSE",
        deltaCents: BigInt(payerIsA ? shareB : -shareA),
        draftId: draft.id,
        expenseId: expense.id,
      },
    });
  } else {
    const recipientId =
      input.payerId === ledger.participantA
        ? ledger.participantB
        : ledger.participantA;
    const current = await tx.ledgerEvent.aggregate({
      where: { ledgerId: ledger.id },
      _sum: { deltaCents: true },
    });
    const balance = current._sum.deltaCents ?? 0n;
    const debt = input.payerId === ledger.participantA ? -balance : balance;
    if (debt <= 0n || BigInt(input.amount) > debt)
      throw new AppError("Repayment does not match the current debt.");
    const settlement = await tx.settlement.create({
      data: {
        ledgerId: ledger.id,
        payerId: input.payerId,
        recipientId,
        amount: input.amount,
        draftId: draft.id,
      },
    });
    await tx.ledgerEvent.create({
      data: {
        ledgerId: ledger.id,
        actorId,
        kind: "SETTLEMENT",
        deltaCents: BigInt(
          input.payerId === ledger.participantA ? input.amount : -input.amount,
        ),
        draftId: draft.id,
        settlementId: settlement.id,
      },
    });
  }
}

async function state(tx: Tx, identity: TelegramIdentity, ledgerId?: string) {
  const user = await authenticatedUser(tx, identity);
  const ledgers = await tx.ledger.findMany({
    where: { OR: [{ participantA: user.id }, { participantB: user.id }] },
    include: { a: true, b: true },
    orderBy: { createdAt: "asc" },
  });
  const selected = ledgerId
    ? ledgers.find((ledger) => ledger.id === ledgerId)
    : ledgers[0];
  if (!selected)
    return { me: identity.id.toString(), ledgers: [], ledger: null };
  const [events, rows] = await Promise.all([
    tx.ledgerEvent.aggregate({
      where: { ledgerId: selected.id },
      _sum: { deltaCents: true },
    }),
    tx.expenseDraft.findMany({
      where: {
        ledgerId: selected.id,
        status: "CONFIRMED",
        kind: { in: ["EXPENSE", "SETTLEMENT"] },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: {
        creator: true,
        expense: true,
        settlement: true,
        event: { include: { reversedBy: true } },
      },
    }),
  ]);
  return {
    me: identity.id.toString(),
    ledgers: ledgers.map((ledger) => ({
      id: ledger.id,
      otherName:
        ledger.participantA === user.id
          ? ledger.b.displayName
          : ledger.a.displayName,
    })),
    ledger: {
      id: selected.id,
      me: identity.id.toString(),
      a: { id: selected.a.telegramId.toString(), name: selected.a.displayName },
      b: { id: selected.b.telegramId.toString(), name: selected.b.displayName },
      balance: euro(events._sum.deltaCents ?? 0n),
      balanceCents: (events._sum.deltaCents ?? 0n).toString(),
      entries: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        description: row.description,
        amount: row.amount,
        createdAt: row.createdAt.toISOString(),
        creator: row.creator.displayName,
        payerId:
          row.expense?.payerId === selected.a.id
            ? selected.a.telegramId.toString()
            : row.expense?.payerId === selected.b.id ||
                row.settlement?.payerId === selected.b.id
              ? selected.b.telegramId.toString()
              : selected.a.telegramId.toString(),
        shareA: row.expense?.shareA ?? null,
        shareB: row.expense?.shareB ?? null,
        splitPercentA: row.expense?.splitPercentA ?? null,
        reversed: Boolean(row.event?.reversedBy),
      })),
    },
  };
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  db: PrismaClient,
  token: string,
) {
  const identity = verifyTelegramInitData(
    typeof req.headers["x-telegram-init-data"] === "string"
      ? req.headers["x-telegram-init-data"]
      : undefined,
    token,
  );
  const route = url.pathname;
  if (req.method === "GET" && route === "/api/state") {
    const result = await transaction(db, (tx) =>
      state(tx, identity, url.searchParams.get("ledgerId") ?? undefined),
    );
    json(res, 200, result);
    return;
  }
  if (req.method === "POST" && route === "/api/invites") {
    const input = await body(req);
    const result = await transaction(db, async (tx) => {
      const user = await authenticatedUser(tx, identity);
      const ledger =
        input.ledgerId === undefined
          ? null
          : await memberLedger(tx, user.id, input.ledgerId);
      const invite = await tx.miniAppInvite.create({
        data: {
          code: randomBytes(8).toString("base64url"),
          creatorId: user.id,
          ledgerId: ledger?.id,
          expiresAt: new Date(Date.now() + 7 * 86_400_000),
        },
      });
      return { code: invite.code, expiresAt: invite.expiresAt.toISOString() };
    });
    json(res, 201, result);
    return;
  }
  if (req.method === "POST" && route === "/api/join") {
    const input = await body(req);
    if (
      typeof input.code !== "string" ||
      !/^[A-Za-z0-9_-]{8,32}$/.test(input.code)
    )
      throw new AppError("Enter a valid invite code.");
    const result = await transaction(db, async (tx) => {
      const user = await authenticatedUser(tx, identity);
      const invite = await tx.miniAppInvite.findUnique({
        where: { code: input.code as string },
        include: { creator: true, ledger: true },
      });
      if (!invite || invite.expiresAt < new Date())
        throw new AppError("Invite not found or expired.", 404);
      if (invite.creatorId === user.id)
        throw new AppError("You cannot join your own invite.");
      if (invite.joinedById && invite.joinedById !== user.id)
        throw new AppError("This invite has already been used.");
      if (invite.ledger) {
        const members = [
          invite.ledger.participantA,
          invite.ledger.participantB,
        ];
        if (!members.includes(user.id) || !members.includes(invite.creatorId))
          throw new AppError("Invite is not for this ledger.");
      } else {
        const ledger = await tx.ledger.create({
          data: {
            chatInstance: `miniapp:${randomUUID()}`,
            participantA: invite.creatorId,
            participantB: user.id,
          },
        });
        await tx.miniAppInvite.update({
          where: { id: invite.id },
          data: { ledgerId: ledger.id, joinedById: user.id },
        });
      }
      if (!invite.joinedById)
        await tx.miniAppInvite.update({
          where: { id: invite.id },
          data: { joinedById: user.id },
        });
      return { joined: true };
    });
    json(res, 200, result);
    return;
  }
  if (req.method === "POST" && route === "/api/entries") {
    const input = await body(req);
    const kind =
      input.kind === "EXPENSE"
        ? "EXPENSE"
        : input.kind === "SETTLEMENT"
          ? "SETTLEMENT"
          : (() => {
              throw new AppError("Choose an expense or repayment.");
            })();
    const cents = amount(input.amount);
    const result = await transaction(db, async (tx) => {
      const user = await authenticatedUser(tx, identity);
      const ledger = await memberLedger(tx, user.id, input.ledgerId);
      const payer = payerId(ledger, input.payerId);
      let pct: number | undefined;
      if (kind === "EXPENSE") {
        pct =
          input.payerSharePercent === undefined
            ? 50
            : Number(input.payerSharePercent);
        if (!Number.isSafeInteger(pct) || pct < 0 || pct > 100)
          throw new AppError("Split percentage must be from 0 to 100.");
      }
      await createEntry(tx, ledger, user.id, {
        kind,
        amount: cents,
        description:
          kind === "EXPENSE" ? description(input.description) : "Repayment",
        payerId: payer,
        payerSharePercent: pct,
      });
      return state(tx, identity, ledger.id);
    });
    json(res, 201, result);
    return;
  }
  const entryMatch = /^\/api\/entries\/([^/]+)$/.exec(route);
  if (entryMatch && (req.method === "PATCH" || req.method === "DELETE")) {
    const id = decodeURIComponent(entryMatch[1]!);
    const result = await transaction(db, async (tx) => {
      const input = req.method === "PATCH" ? await body(req) : {};
      const user = await authenticatedUser(tx, identity);
      const draft = await tx.expenseDraft.findUnique({
        where: { id },
        include: {
          expense: true,
          settlement: true,
          event: { include: { reversedBy: true } },
        },
      });
      if (
        !draft ||
        !draft.ledgerId ||
        !["EXPENSE", "SETTLEMENT"].includes(draft.kind) ||
        draft.status !== "CONFIRMED"
      )
        throw new AppError("Entry not found.", 404);
      const ledger = await memberLedger(tx, user.id, draft.ledgerId);
      if (req.method === "PATCH" && draft.event?.reversedBy)
        throw new AppError(
          "A reversed entry cannot be edited. Delete it instead.",
        );
      if (req.method === "DELETE") {
        if (draft.event?.reversedBy) {
          await tx.expenseDraft.delete({
            where: { id: draft.event.reversedBy.draftId },
          });
        }
        await tx.expenseDraft.delete({ where: { id } });
        return state(tx, identity, ledger.id);
      }
      const newAmount =
        input.amount === undefined ? draft.amount! : amount(input.amount);
      const newPayer =
        input.payerId === undefined
          ? (draft.expense?.payerId ?? draft.settlement!.payerId)
          : payerId(ledger, input.payerId);
      if (draft.kind === "EXPENSE" && draft.expense) {
        const pct =
          input.payerSharePercent === undefined
            ? draft.expense.splitPercentA === null
              ? 50
              : draft.expense.payerId === ledger.participantA
                ? draft.expense.splitPercentA
                : 100 - draft.expense.splitPercentA
            : Number(input.payerSharePercent);
        if (!Number.isSafeInteger(pct) || pct < 0 || pct > 100)
          throw new AppError("Split percentage must be from 0 to 100.");
        const label =
          input.description === undefined
            ? draft.description
            : description(input.description);
        const payerIsA = newPayer === ledger.participantA;
        const [shareA, shareB] = splitByPercent(newAmount, payerIsA, pct);
        await tx.expense.update({
          where: { draftId: id },
          data: {
            amount: newAmount,
            description: label,
            payerId: newPayer,
            shareA,
            shareB,
            splitPercentA: payerIsA ? pct : 100 - pct,
          },
        });
        await tx.ledgerEvent.update({
          where: { draftId: id },
          data: {
            deltaCents: BigInt(payerIsA ? shareB : -shareA),
            actorId: user.id,
          },
        });
        await tx.expenseDraft.update({
          where: { id },
          data: { amount: newAmount, description: label, creatorId: user.id },
        });
      } else if (draft.kind === "SETTLEMENT" && draft.settlement) {
        const current = await tx.ledgerEvent.aggregate({
          where: { ledgerId: ledger.id },
          _sum: { deltaCents: true },
        });
        const oldEvent = draft.event?.deltaCents ?? 0n;
        const balance = (current._sum.deltaCents ?? 0n) - oldEvent;
        const debt = newPayer === ledger.participantA ? -balance : balance;
        if (debt <= 0n || BigInt(newAmount) > debt)
          throw new AppError("Repayment does not match the current debt.");
        const recipientId =
          newPayer === ledger.participantA
            ? ledger.participantB
            : ledger.participantA;
        await tx.settlement.update({
          where: { draftId: id },
          data: { amount: newAmount, payerId: newPayer, recipientId },
        });
        await tx.ledgerEvent.update({
          where: { draftId: id },
          data: {
            deltaCents: BigInt(
              newPayer === ledger.participantA ? newAmount : -newAmount,
            ),
            actorId: user.id,
          },
        });
        await tx.expenseDraft.update({
          where: { id },
          data: { amount: newAmount, creatorId: user.id },
        });
      }
      return state(tx, identity, ledger.id);
    });
    json(res, 200, result);
    return;
  }
  json(res, 404, { error: "Not found." });
}

export function miniAppHandler(db: PrismaClient, token: string) {
  const root = resolve(import.meta.dirname, "../public");
  const assets: Record<string, { file: string; type: string }> = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname.startsWith("/api/")) {
      try {
        await handleApi(req, res, url, db, token);
      } catch (error) {
        if (error instanceof AppError)
          json(res, error.status, { error: error.message });
        else {
          console.error("miniapp_request_failed");
          json(res, 500, { error: "Something went wrong. Please try again." });
        }
      }
      return true;
    }
    const asset = assets[url.pathname];
    if (!asset || req.method !== "GET") return false;
    try {
      const content = await readFile(resolve(root, asset.file));
      res.writeHead(200, {
        "content-type": asset.type,
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors https://web.telegram.org https://*.telegram.org",
      });
      res.end(content);
    } catch {
      json(res, 503, { error: "App files unavailable." });
    }
    return true;
  };
}
