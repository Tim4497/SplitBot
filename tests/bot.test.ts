import { createDatabase } from "../src/database.js";
import { describe, it, expect, afterAll } from "vitest";
import { createBot } from "../src/bot.js";
import { randomUUID } from "node:crypto";
const db = createDatabase();
const prefix = randomUUID();
let sequence = 1000;
const anna = { id: 201, first_name: "Anna", is_bot: false },
  max = { id: 202, first_name: "Max", is_bot: false };
const info = {
  id: 999,
  is_bot: true as const,
  first_name: "SplitBot",
  username: "splitbot_test_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: true,
};
const bot = createBot("999:test", db, info);
const sent: { method: string; payload: any }[] = [];
bot.api.config.use(async (_prev, method, payload) => {
  sent.push({ method, payload });
  return { ok: true, result: true } as any;
});
async function inline(text: string, user = anna, chat_type: any = "private") {
  const id = prefix + ++sequence;
  await bot.handleUpdate({
    update_id: sequence,
    inline_query: { id, from: user, query: text, offset: "", chat_type },
  });
  return sent.filter((x) => x.method === "answerInlineQuery").at(-1)!.payload;
}
async function click(data: string, chat: string, message: string, user = anna) {
  await bot.handleUpdate({
    update_id: ++sequence,
    callback_query: {
      id: String(sequence),
      from: user,
      chat_instance: chat,
      inline_message_id: message,
      data,
    },
  });
  return sent.filter((x) => x.method === "answerCallbackQuery").at(-1)!.payload;
}
describe.skipIf(!process.env.DATABASE_URL)("Telegram event integration", () => {
  afterAll(async () => {
    await db.ledger.deleteMany({
      where: { chatInstance: { startsWith: prefix } },
    });
    await db.expenseDraft.deleteMany({
      where: { queryId: { startsWith: prefix } },
    });
    await db.$disconnect();
  });
  it("rejects group and unknown chat types before persisting drafts", async () => {
    expect((await inline("40 Essen", anna, "group")).results).toEqual([]);
    expect((await inline("40 Essen", anna, null)).results).toEqual([]);
    expect(
      await db.expenseDraft.count({
        where: { queryId: { startsWith: prefix } },
      }),
    ).toBe(0);
  });
  it("handles inline setup, mutual approval, expense confirmation and private balance", async () => {
    const chat = prefix + "chat",
      message = prefix + "setup";
    const setup = (await inline("einrichten")).results[0].id;
    await click(`bind:${setup}`, chat, message);
    await click(`join:${setup}`, chat, message, max);
    const candidate = (
      await db.expenseDraft.findUniqueOrThrow({ where: { id: setup } })
    ).candidateId!;
    await click(`approve:${setup}:${candidate}`, chat, message);
    const expense = (await inline("40 Abendessen")).results[0].id;
    const em = prefix + "expense";
    await click(`bind:${expense}`, chat, em);
    await click(`saldo:${expense}`, chat, em, max);
    expect(
      sent
        .filter((x) => x.method === "editMessageReplyMarkup")
        .at(-1)!
        .payload.reply_markup.inline_keyboard.flat()
        .some((b: any) => b.callback_data === `confirm:${expense}`),
    ).toBe(true);
    await click(`confirm:${expense}`, chat, em, max);
    await click(`confirm:${expense}`, chat, em, max);
    expect(await db.expense.count({ where: { draftId: expense } })).toBe(1);
    const status = (await inline("saldo")).results[0].id;
    await click(`bind:${status}`, chat, prefix + "status");
    const answer = await click(`saldo:${status}`, chat, prefix + "status", max);
    expect(answer.show_alert).toBe(true);
    expect(answer.text).toContain("Max schuldet Anna 20,00 €");
    const outsider = await click(`saldo:${status}`, chat, prefix + "status", {
      ...max,
      id: 203,
    });
    expect(outsider.text).toContain("Kein Zugriff");
    const forwarded = await click(
      `saldo:${status}`,
      "other",
      prefix + "status",
    );
    expect(forwarded.text).toContain("Ungültige");
    expect(
      sent
        .filter((x) => x.method === "editMessageText")
        .some((x) => /schuldet|20,00/.test(x.payload.text)),
    ).toBe(false);
  });
  it("chosen results pin identity but never book an expense", async () => {
    const id = (await inline("10 Kino")).results[0].id;
    await bot.handleUpdate({
      update_id: ++sequence,
      chosen_inline_result: {
        result_id: id,
        from: anna,
        query: "10 Kino",
        inline_message_id: prefix + "chosen",
      },
    });
    expect(
      (await db.expenseDraft.findUniqueOrThrow({ where: { id } }))
        .inlineMessageId,
    ).toBe(prefix + "chosen");
    expect(await db.expense.count({ where: { draftId: id } })).toBe(0);
  });
});
