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
const privacy =
  "SplitBot speichert Telegram-ID, Anzeigename, eingegebene Ausgaben, Bestätigungen und Chat-Kennung. Keine normalen Chatnachrichten. Gemeinsame Historie bleibt bei 0 € erhalten. Löschung: Betreiber kontaktieren (siehe Bot-Profil).";
function menu(id: string) {
  return new InlineKeyboard()
    .text("Kontostand aktualisieren", `saldo:${id}`)
    .row()
    .switchInlineCurrent("Neue Ausgabe", "")
    .switchInlineCurrent("Zahlung erfassen", "ausgleich ")
    .row()
    .text("Verlauf anzeigen", `history:${id}:0`)
    .text("Datenschutz", `privacy:${id}`);
}
function preview(d: ExpenseDraft, name: string) {
  if (d.kind === "SETUP")
    return "SplitBot einrichten\nNur in einem privaten 1:1-Chat verwenden.\n1. Erstellende Person bestätigt diesen Chat.\n2. Zweite Person tritt bei.\n3. Erstellende Person prüft Name und Telegram-ID und bestätigt.\nMit Zustimmung werden die in „Datenschutz“ beschriebenen Daten gespeichert.";
  if (d.kind === "STATUS")
    return "SplitBot Kontostand\nErstellende Person: diesen Chat zuordnen. Saldo und Verlauf werden danach nur der klickenden Person angezeigt.";
  if (d.kind === "REVERSAL")
    return `${d.description}\nBetrag: ${euro(d.amount!)}\nBeide Personen müssen die Stornierung bestätigen.`;
  if (d.kind === "SETTLEMENT")
    return `Ausgleich: ${euro(d.amount!)}\nBezahlt von: ${name}\nKeine echte Überweisung. Nur bereits geleistete Zahlungen bestätigen.\nBeide Personen müssen bestätigen.`;
  const [payer, other] = split(d.amount!, true);
  return `Ausgabe: ${d.description}\nGesamtbetrag: ${euro(d.amount!)}\nBezahlt von: ${name}\nAufteilung: 50/50\nEigener Anteil: ${euro(payer)}\nAnteil der anderen Person: ${euro(other)}\nZuerst bestätigt die zahlende Person diesen Chat, dann die andere Person die Ausgabe.`;
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
      if (text.toLowerCase() === "datenschutz") {
        await ctx.answerInlineQuery(
          [
            {
              type: "article",
              id: "privacy",
              title: "Datenschutz",
              input_message_content: { message_text: privacy },
            },
          ],
          { cache_time: 0, is_personal: true },
        );
        return;
      }
      const kind = text.toLowerCase();
      const d = kind.startsWith("storno ")
        ? await service.reversalFromInline(q.from, q.id, text.slice(7).trim())
        : await service.draft(
            q.from,
            q.id,
            kind === "einrichten"
              ? { kind: "SETUP", description: "Einrichten" }
              : kind === "saldo" || kind === ""
                ? { kind: "STATUS", description: "Kontostand" }
                : parseQuery(text),
          );
      const kb = new InlineKeyboard()
        .text("Diesen Chat bestätigen", `bind:${d.id}`)
        .row()
        .text("Datenschutz", `privacy:${d.id}`);
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
          message_text: preview(d, safeName(q.from.first_name)),
        },
        reply_markup: kb,
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
                "SplitBot: @Botname einrichten · 12,50 Essen · saldo · ausgleich 12 · datenschutz",
            },
          },
        ],
        { cache_time: 0, is_personal: true },
      );
    }
  });
  bot.on("chosen_inline_result", async (ctx) => {
    const r = ctx.chosenInlineResult;
    if (r.inline_message_id)
      await service.chosen(r.from, r.result_id, r.inline_message_id);
  });
  bot.on("callback_query:data", async (ctx) => {
    const q = ctx.callbackQuery;
    const [action, id, arg] = q.data.split(":");
    if (action === "privacy") {
      await ctx.answerCallbackQuery({
        text: privacy.slice(0, 200),
        show_alert: true,
      });
      return;
    }
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
        await service.act(q.from, id, action!, c, arg);
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
          kb.text("Kontostand", `saldo:${id}`);
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
        if (s.candidate) {
          editedText = `Teilnahme angefragt: ${s.candidate.displayName}\nTelegram-ID: ${s.candidate.telegramId}\nNur bestätigen, wenn dies die gewünschte Person ist. Die Bot API verifiziert keine private Chat-Mitgliedschaft.`;
          kb = new InlineKeyboard()
            .text("Diese Person bestätigen", `approve:${id}:${s.candidate.id}`)
            .row()
            .text("Person ablehnen", `reject:${id}`);
        } else {
          editedText =
            "Chat zugeordnet. Die zweite Person muss jetzt beitreten. Nur für private 1:1-Chats. Mit Beitritt Zustimmung zur Speicherung der gemeinsamen Abrechnung.";
          kb = new InlineKeyboard()
            .text("Als zweite Person beitreten", `join:${id}`)
            .row()
            .text("Datenschutz", `privacy:${id}`);
        }
        answer = "Einrichtung aktualisiert.";
      } else if (s.draft.status === "CONFIRMED") {
        answer =
          s.draft.kind === "SETUP"
            ? "Dauerhafte Abrechnung eingerichtet."
            : "Bestätigt. Genau einmal verbucht.";
        kb = menu(id);
      } else {
        answer = "Chat zugeordnet. Jetzt muss die andere Person bestätigen.";
        kb = new InlineKeyboard()
          .text("Bestätigen (andere Person)", `confirm:${id}`)
          .row()
          .text("Kontostand", `saldo:${id}`);
      }
      if (
        kb &&
        s.draft.status === "OPEN" &&
        ["EXPENSE", "SETTLEMENT", "REVERSAL"].includes(s.draft.kind) &&
        s.draft.expiresAt > new Date()
      ) {
        kb.row().text("Bestätigen (andere Person)", `confirm:${id}`);
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
