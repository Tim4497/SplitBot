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
  it("does not offer auto-booking when the sender has no shared ledger", async () => {
    const result = (await inline("5 Lunch", lisa)).results[0];
    expect(result.title).toBe("Zuerst Abrechnung einrichten");
    expect(result.reply_markup).toBeUndefined();
  });
  it("handles inline setup, creator booking and private balance", async () => {
    const chat = prefix + "chat",
      message = prefix + "setup";
    const setupResult = (await inline("einrichten")).results[0],
      setup = setupResult.id;
    expect(JSON.stringify(setupResult)).not.toMatch(/datenschutz|privacy/i);
    await click(`bind:${setup}`, chat, message);
    await click(`join:${setup}`, chat, message, max);
    expect(
      (await db.expenseDraft.findUniqueOrThrow({ where: { id: setup } }))
        .status,
    ).toBe("CONFIRMED");
    const expense = (await inline("40 Abendessen")).results[0].id;
    const em = prefix + "expense";
    const expenseResult = sent
      .filter((x) => x.method === "answerInlineQuery")
      .at(-1)!.payload.results[0];
    expect(expenseResult.reply_markup).toBeUndefined();
    expect(expenseResult.input_message_content.message_text).toBe(
      'Anna added "40,00 € for Abendessen"',
    );
    await bot.handleUpdate({
      update_id: ++sequence,
      chosen_inline_result: {
        result_id: expense,
        from: anna,
        query: "40 Abendessen",
        inline_message_id: em,
      },
    });
    expect(
      (await db.expenseDraft.findUniqueOrThrow({ where: { id: expense } }))
        .status,
    ).toBe("CONFIRMED");
    expect(await db.expense.count({ where: { draftId: expense } })).toBe(1);
    const repayment = (await inline("ausgleich 5", max)).results[0].id;
    const repaymentResult = sent
      .filter((x) => x.method === "answerInlineQuery")
      .at(-1)!.payload.results[0];
    expect(repaymentResult.reply_markup).toBeUndefined();
    expect(repaymentResult.input_message_content.message_text).toBe(
      "Max recorded a repayment of 5,00 €",
    );
    await bot.handleUpdate({
      update_id: ++sequence,
      chosen_inline_result: {
        result_id: repayment,
        from: max,
        query: "ausgleich 5",
        inline_message_id: prefix + "repayment",
      },
    });
    const excessive = (await inline("ausgleich 30", max)).results[0].id;
    await bot.handleUpdate({
      update_id: ++sequence,
      chosen_inline_result: {
        result_id: excessive,
        from: max,
        query: "ausgleich 30",
        inline_message_id: prefix + "excessive",
      },
    });
    expect(
      sent.filter((x) => x.method === "editMessageTextInline").at(-1)!.payload
        .text,
    ).toContain("Not saved");
    expect(
      await db.expenseDraft.findUniqueOrThrow({ where: { id: excessive } }),
    ).toMatchObject({ status: "OPEN" });
    const status = (await inline("saldo")).results[0].id;
    await click(`bind:${status}`, chat, prefix + "status");
    const answer = await click(`saldo:${status}`, chat, prefix + "status", max);
    expect(answer.show_alert).toBe(true);
    expect(answer.text).toContain("Max schuldet Anna 15,00 €");
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
  it("books a chosen inline result immediately without a confirmation button", async () => {
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
      (await db.expenseDraft.findUniqueOrThrow({ where: { id } })).status,
    ).toBe("CONFIRMED");
    expect(
      (await db.expenseDraft.findUniqueOrThrow({ where: { id } }))
        .inlineMessageId,
    ).toBe(prefix + "chosen");
    expect(await db.expense.count({ where: { draftId: id } })).toBe(1);
  });
});
