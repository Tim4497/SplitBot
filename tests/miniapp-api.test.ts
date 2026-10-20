import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "../src/database.js";
import { miniAppHandler } from "../src/miniapp.js";

const db = createDatabase();
const token = "123:mini-app-test";
const ids = [Date.now() * 100, Date.now() * 100 + 1];
const people = [
  { id: ids[0]!, first_name: "Anna" },
  { id: ids[1]!, first_name: "Max" },
];
const server = createServer(async (req, res) => {
  await handler(
    req,
    res,
    new URL(req.url ?? "/", `http://${req.headers.host}`),
  );
});
const handler = miniAppHandler(db, token);
let origin = "";
let ledgerId: string | undefined;

function signedInitData(person: (typeof people)[number]) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify(person),
  });
  const check = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

async function call(
  person: (typeof people)[number],
  path: string,
  method = "GET",
  body?: unknown,
) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      "x-telegram-init-data": signedInitData(person),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    body: (await response.json()) as any,
  };
}

describe.skipIf(!process.env.DATABASE_URL)("Mini App ledger API", () => {
  beforeAll(async () => {
    await db.$connect();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    const users = await db.user.findMany({
      where: { telegramId: { in: ids.map((id) => BigInt(id)) } },
      select: { id: true },
    });
    const userIds = users.map((user) => user.id);
    if (userIds.length) {
      await db.ledger.deleteMany({
        where: {
          OR: [
            { participantA: { in: userIds } },
            { participantB: { in: userIds } },
          ],
        },
      });
      await db.expenseDraft.deleteMany({
        where: { creatorId: { in: userIds } },
      });
    }
    await db.user.deleteMany({
      where: { telegramId: { in: ids.map((id) => BigInt(id)) } },
    });
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await db.$disconnect();
  });

  it("pairs two users and immediately creates, edits, repays, and deletes entries", async () => {
    const invite = await call(people[0]!, "/api/invites", "POST", {});
    expect(invite.status).toBe(201);
    expect(invite.body.code).toMatch(/^[A-Za-z0-9_-]{8,32}$/);

    expect(
      await call(people[1]!, "/api/join", "POST", {
        code: invite.body.code,
      }),
    ).toMatchObject({ status: 200, body: { joined: true } });

    let state = await call(people[0]!, "/api/state");
    ledgerId = state.body.ledger.id;
    expect(state.body.ledger.a.name).toBe("Anna");

    state = await call(people[0]!, "/api/entries", "POST", {
      ledgerId,
      kind: "EXPENSE",
      amount: 10_001,
      description: "Dinner",
      payerId: String(ids[0]),
      payerSharePercent: 70,
    });
    const expenseId = state.body.ledger.entries[0].id;
    expect(state.body.ledger.entries[0]).toMatchObject({
      shareA: 7_001,
      shareB: 3_000,
    });
    expect(state.body.ledger.balanceCents).toBe("3000");

    state = await call(people[1]!, "/api/entries", "POST", {
      ledgerId,
      kind: "SETTLEMENT",
      amount: 1_000,
      payerId: String(ids[1]),
    });
    const repaymentId = state.body.ledger.entries[0].id;
    expect(state.body.ledger.balanceCents).toBe("2000");

    state = await call(
      people[1]!,
      `/api/entries/${encodeURIComponent(expenseId)}`,
      "PATCH",
      {
        amount: 12_000,
        description: "Dinner updated",
        payerId: String(ids[0]),
        payerSharePercent: 60,
      },
    );
    expect(state.status).toBe(200);
    expect(state.body.ledger.balanceCents).toBe("3800");
    expect(
      state.body.ledger.entries.find(
        (entry: { id: string }) => entry.id === expenseId,
      ),
    ).toMatchObject({ shareA: 7_200, shareB: 4_800 });

    state = await call(
      people[1]!,
      `/api/entries/${encodeURIComponent(repaymentId)}`,
      "PATCH",
      { amount: 3_000 },
    );
    expect(state.body.ledger.balanceCents).toBe("1800");

    state = await call(
      people[0]!,
      `/api/entries/${encodeURIComponent(expenseId)}`,
      "DELETE",
    );
    expect(state.status).toBe(200);
    expect(state.body.ledger.balanceCents).toBe("-3000");

    state = await call(
      people[1]!,
      `/api/entries/${encodeURIComponent(repaymentId)}`,
      "DELETE",
    );
    expect(state.status).toBe(200);
    expect(state.body.ledger.balanceCents).toBe("0");
    expect(state.body.ledger.entries).toEqual([]);
  });
});
