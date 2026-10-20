import { rateLimit } from "./rate-limit.js";
import { Bot, InlineKeyboard, GrammyError } from "grammy";
import type { UserFromGetMe, InlineQueryResultArticle } from "grammy/types";
import { PrismaClient, type ExpenseDraft } from "./generated/prisma/client.js";
import {
  DomainError,
  LedgerService,
  safeName,
  type Identity,
} from "./service.js";
import { parseQuery, euro, split } from "./money.js";
function menu(id: string) {
  return new InlineKeyboard()
    .text("Saldo", `saldo:${id}`)
    .row()
    .switchInlineCurrent("Ausgabe", "")
    .switchInlineCurrent("Zahlung", "ausgleich ")
    .row()
    .text("Verlauf", `history:${id}:0`);
}
function preview(d: ExpenseDraft, name: string) {
  if (d.kind === "SETUP")
    return "SplitBot einrichten\nEine zweite Person muss beitreten.";
  if (d.kind === "STATUS") return "SplitBot · Kontostand";
  if (d.kind === "REVERSAL") return `${d.description} · ${euro(d.amount!)}`;
  if (d.kind === "SETTLEMENT") return `Zahlung: ${euro(d.amount!)} · ${name}`;
  const [payer, other] = split(d.amount!, true);
  return `${d.description} · ${euro(d.amount!)} · ${name}\n50/50: ${euro(payer)} / ${euro(other)}`;
}
function recordedMessage(d: ExpenseDraft, name: string) {
  if (d.kind === "SETTLEMENT")
    return `${name} recorded a repayment of ${euro(d.amount!)}`;
  if (d.kind === "REVERSAL") return `${name} reversed "${d.description}"`;
  return `${name} added "${euro(d.amount!)} for ${d.description}"`;
}
export function createBot(
  token: string,
  db: PrismaClient,
  botInfo?: UserFromGetMe,
) {
  const bot = new Bot(token, botInfo ? { botInfo } : {}),
    service = new LedgerService(db),
    allowed = rateLimit();
  bot.on("inline_query", async (ctx) => {
    const q = ctx.inlineQuery;
    if (q.chat_type !== "private" || !allowed(q.from.id)) {
      await ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
      return;
    }
    const text = q.query.trim();
    try {
      const kind = text.toLowerCase();
      const setupQuery = kind === "einrichten";
      const statusQuery = kind === "saldo" || kind === "";
      if (!setupQuery && !statusQuery) {
        const ledgerStatus = await service.inlineLedgerStatus(q.from);
        if (ledgerStatus !== "ready") {
          const message =
            ledgerStatus === "setup"
              ? "Erstellt zuerst einmalig eine gemeinsame Abrechnung mit @Botname einrichten."
              : "Automatisches Buchen braucht genau eine gemeinsame Abrechnung pro Nutzer.";
          await ctx.answerInlineQuery(
            [
              {
                type: "article",
                id: "ledger-required",
                title:
                  ledgerStatus === "setup"
                    ? "Zuerst Abrechnung einrichten"
                    : "Mehrere Abrechnungen gefunden",
                input_message_content: { message_text: message },
              },
            ],
            { cache_time: 0, is_personal: true },
          );
          return;
        }
      }
      const d = kind.startsWith("storno ")
        ? await service.reversalFromInline(q.from, q.id, text.slice(7).trim())
        : await service.draft(
            q.from,
            q.id,
            setupQuery
              ? { kind: "SETUP", description: "Einrichten" }
              : statusQuery
                ? { kind: "STATUS", description: "Kontostand" }
                : parseQuery(text),
          );
      const needsCallback = d.kind === "SETUP" || d.kind === "STATUS";
      const result: InlineQueryResultArticle = {
        type: "article",
        id: d.id,
        title:
          d.kind === "SETUP"
            ? "Gemeinsame Abrechnung einrichten"
            : d.kind === "STATUS"
              ? "Kontostand abrufen"
              : `${d.description} – ${euro(d.amount!)}`,
        input_message_content: {
          message_text: needsCallback
            ? preview(d, safeName(q.from.first_name))
            : recordedMessage(d, safeName(q.from.first_name)),
        },
        ...(needsCallback
          ? {
              reply_markup: new InlineKeyboard().text(
                d.kind === "SETUP" ? "Einrichten" : "Anzeigen",
                `bind:${d.id}`,
              ),
            }
          : {}),
      };
      await ctx.answerInlineQuery([result], {
        cache_time: 0,
        is_personal: true,
      });
    } catch (e) {
      if (
        !(e instanceof DomainError) &&
        !(e instanceof Error && /Betrag|Beispiel|Beschreibung/.test(e.message))
      )
        throw e;
      await ctx.answerInlineQuery(
        [
          {
            type: "article",
            id: "help",
            title: "Eingabe prüfen",
            description: e.message,
            input_message_content: {
              message_text:
                "SplitBot: @Botname einrichten · 12,50 Essen · saldo · ausgleich 12",
            },
          },
        ],
        { cache_time: 0, is_personal: true },
      );
    }
  });
  bot.on("chosen_inline_result", async (ctx) => {
    const r = ctx.chosenInlineResult;
    if (!r.inline_message_id) return;
    try {
      await service.chosen(r.from, r.result_id, r.inline_message_id);
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      await ctx.api.editMessageTextInline(
        r.inline_message_id,
        "Not saved. Check the balance or ledger setup, then enter it again.",
      );
    }
  });
  bot.on("callback_query:data", async (ctx) => {
    const q = ctx.callbackQuery;
    const [action, id, arg] = q.data.split(":");
    if (!allowed(q.from.id)) {
      await ctx.answerCallbackQuery({
        text: "Zu viele Anfragen. Bitte kurz warten.",
        show_alert: true,
      });
      return;
    }
    if (!id || !q.inline_message_id || !q.chat_instance) {
      await ctx.answerCallbackQuery({
        text: "Nur Inline-Nachrichten verwenden.",
        show_alert: true,
      });
      return;
    }
    const c = { chat: q.chat_instance, message: q.inline_message_id };
    let answer = "";
    let kb: InlineKeyboard | undefined;
    let editedText: string | undefined;
    try {
      if (!["saldo", "history"].includes(action!))
        await service.act(q.from, id, action!, c);
      const s = await service.snapshot(q.from, id, c);
      if (action === "history") {
        const page = Number(arg);
        if (!Number.isSafeInteger(page) || page < 0 || page > 1000000)
          throw new DomainError("Ungültige Seite.");
        const h = await service.history(q.from, id, c, page),
          r = h.row;
        if (!r) answer = "Noch keine Buchungen.";
        else {
          const state = r.event?.reversedBy
            ? "STORNIERT"
            : r.status === "CONFIRMED"
              ? "BESTÄTIGT"
              : r.expiresAt < new Date()
                ? "ABGELAUFEN"
                : "AUSSTEHEND";
          const name = r.creator.displayName.slice(0, 16);
          const shares = r.expense
            ? `\nA: ${euro(r.expense.shareA)} / B: ${euro(r.expense.shareB)}`
            : "";
          answer = `${h.page + 1}/${h.count} · ${r.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC\n${state} · ${r.kind === "SETTLEMENT" ? "Zahlung" : r.kind === "REVERSAL" ? "Storno" : "Ausgabe"}\n${r.description.slice(0, 30)} · ${euro(r.amount!)}\nZahler: ${name}${shares}`;
          kb = new InlineKeyboard()
            .text("Neuer", `history:${id}:${Math.max(0, h.page - 1)}`)
            .text("Älter", `history:${id}:${Math.min(h.count - 1, h.page + 1)}`)
            .row();
          if (
            r.event &&
            !r.event.reversedBy &&
            ["EXPENSE", "SETTLEMENT"].includes(r.event.kind)
          )
            kb.switchInlineCurrent(
              "Storno vorbereiten",
              `storno ${r.event.id}`,
            ).row();
          kb.text("Saldo", `saldo:${id}`);
        }
      } else if (action === "saldo" || s.draft.kind === "STATUS") {
        if (!s.ledger)
          throw new DomainError("Einrichtung noch nicht abgeschlossen.");
        const { a, b } = s.ledger;
        answer =
          s.balance === 0n
            ? "Alles ausgeglichen! 0,00 €"
            : s.balance > 0n
              ? `${b.displayName} schuldet ${a.displayName} ${euro(s.balance)}`
              : `${a.displayName} schuldet ${b.displayName} ${euro(-s.balance)}`;
        kb = menu(id);
      } else if (s.draft.kind === "SETUP" && s.draft.status !== "CONFIRMED") {
        editedText = "Chat verknüpft. Zweite Person kann beitreten.";
        kb = new InlineKeyboard().text("Beitreten", `join:${id}`);
        answer = "Chat verknüpft.";
      } else if (s.draft.status === "CONFIRMED") {
        answer = s.draft.kind === "SETUP" ? "Eingerichtet." : "Verbucht.";
        if (["EXPENSE", "SETTLEMENT", "REVERSAL"].includes(s.draft.kind)) {
          editedText = recordedMessage(
            s.draft,
            safeName(s.draft.creator.displayName),
          );
          kb = new InlineKeyboard();
        } else {
          kb = menu(id);
        }
      } else {
        answer = "Chat verknüpft.";
        kb = menu(id);
      }
    } catch (e) {
      if (e instanceof DomainError) {
        await ctx.answerCallbackQuery({
          text: e.message.slice(0, 200),
          show_alert: true,
        });
        return;
      }
      throw e;
    }
    // Acknowledge promptly. UI edits are best-effort: retrying a callback is safe.
    await ctx.answerCallbackQuery({
      text: answer.slice(0, 200),
      show_alert: true,
    });
    try {
      if (editedText)
        await ctx.editMessageText(editedText, { reply_markup: kb });
      else if (kb) await ctx.editMessageReplyMarkup({ reply_markup: kb });
    } catch (e) {
      if (
        e instanceof GrammyError &&
        e.description.includes("message is not modified")
      )
        return;
      console.warn("telegram_ui_edit_failed"); // Never log updates, descriptions, financial data or tokens.
    }
  });
  return bot;
}
