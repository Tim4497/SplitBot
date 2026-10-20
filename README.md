# SplitBot

A simple Telegram ledger for two friends. The Mini App supports expenses with a percentage split, repayments, and immediate edit/delete. The existing inline bot is still available as an alternative. EUR only; no money is transferred.

## What works

- One permanent ledger per callback `chat_instance`, even at zero balance.
- One-time setup: creator links the chat, and the other person joins to activate it.
- Either participant can add an expense or repayment; only the person adding it taps to record it.
- Recorded entries become one short message, with the draft button removed.
- Mini App ledger: add expenses with a payer percentage, record repayments, edit or delete entries immediately.
- Telegram-signed Mini App authentication and one-time invite codes to pair two users.
- Partial/full settlements with commit-time debt validation.
- Private balance alerts, paginated history including pending/expired/confirmed/reversed entries.
- Creator-triggered cancellation using an inverse audit event; originals remain stored.
- Unique draft/query keys, immutable chat/message binding, serializable transactions with retries.
- Polling for development, authenticated webhooks for production, Docker, PostgreSQL migrations, Vitest and GitHub Actions.

## Telegram limits — read before deployment

An inline query gives the querying user and optionally a chat type, **not the peer or chat ID**. A callback provides the clicking user's ID, `chat_instance` and `inline_message_id`. These are the only identity/routing inputs used. Chosen-result feedback can pin the message, but never books anything.

The implementation rejects inline queries whose `chat_type` is not `private`. However, callbacks on inline messages do not independently prove that the destination is a private 1:1 chat, identify its other member, or reliably identify forwarding. The first person other than the creator to tap **Beitreten** activates the ledger; the bot cannot verify their relationship to the creator or independently verify private-chat membership. Shared messages can be distributed or forwarded.

Only the draft creator can first bind a draft. For a new expense or repayment, the person who added it taps **Bestätigen** once; the other participant does not confirm it. Telegram does not include the destination chat identity in an inline query or chosen-result update, so this callback is required to safely bind and save the entry to the correct chat ledger. Once recorded, the draft is replaced by a single short message (for example, `Tim added "10,00 € for Abendessen"`), and its button is removed. Every later operation must match **both** stored identifiers. Every financial read/write checks ledger membership.

To reduce forwarded-message disclosure, balances and history are shown in **private callback alerts** (Telegram's 200-character limit), not edited into shared messages. History is one entry per page; long descriptions/names are abbreviated for display but kept in the database. A and B in history correspond to the setup creator and joining participant. The initial expense preview is intentionally shared; recipients can forward it, copy it, or take screenshots. Existing Telegram messages and recipient copies cannot be recalled by database erasure.

Unknown chat types and secret chats are unsupported. Inline mode does not require a private conversation with the bot; the Mini App is opened from the bot's private-chat menu. The exact username `@SplitBot` may be unavailable: use the username BotFather assigns.

Official references checked 2026-10-18:

- [InlineQuery and inline mode](https://core.telegram.org/bots/api#inlinequery)
- [CallbackQuery](https://core.telegram.org/bots/api#callbackquery)
- [ChosenInlineResult](https://core.telegram.org/bots/api#choseninlineresult)
- [answerCallbackQuery](https://core.telegram.org/bots/api#answercallbackquery)
- [setWebhook](https://core.telegram.org/bots/api#setwebhook)

## 1. Create and configure the Telegram bot

1. Open the verified **@BotFather** account and run `/newbot`.
2. Choose a display name and an available username ending in `bot`. Copy its token into your local `.env` only.
3. Run `/setinline`, select the bot, and set a placeholder such as `12,50 Essen · saldo · einrichten`.
4. Run `/setinlinefeedback`, select the bot, and choose **100%**. Feedback is optional for correctness; callbacks also bind the message.
5. Run `/setjoingroups` and disable group joining. This does **not** disable inline use in groups by itself; application filtering still applies.
6. Keep privacy mode enabled. Configure the bot description/profile to identify the operator and a real privacy/deletion contact.
7. To enable the Mini App, configure an HTTPS domain with BotFather using `/setdomain`. Set `WEB_APP_URL` in `.env` to the public app URL on that domain. At startup, the bot installs a **Ledger** menu button in its private chat. Each person opens the bot chat and taps **Start** once to use that button.

## 2. Run with Docker Compose

Requirements: Docker Engine, a current Docker Compose release (v2 or newer), and the **Buildx plugin**. No Telegram token is bundled.

Check the installed command spelling first:

```sh
docker version
docker compose version
# If the command above is unavailable, check the standalone executable:
docker-compose version
docker buildx version
```

`docker compose` is the Docker CLI plugin form. Some installations expose modern Compose as `docker-compose`; use that spelling if it is the one installed on your server. A hyphen alone does not mean it is obsolete. The old Python Compose v1 is unsupported.

On Ubuntu using **Docker's official apt repository**, install the missing plugins:

```sh
sudo apt-get update
sudo apt-get install docker-buildx-plugin docker-compose-plugin
docker compose version
docker buildx version
```

If apt cannot find those packages, configure the [official Docker Ubuntu repository](https://docs.docker.com/engine/install/ubuntu/#install-using-the-apt-repository) first, or use the matching packages from your existing Docker distribution. Do not mix Docker CE and distribution packages blindly or remove an existing engine just to change the command spelling. [Compose installation reference](https://docs.docker.com/compose/install/linux/).

The warning `Docker Compose requires buildx plugin to be installed` refers to the **host's build tool**, not a missing package inside the bot container. The classic builder can still complete the build, as in your log, but installing Buildx resolves the prerequisite.

```sh
# First installation only: preserve an existing .env when updating.
cp -n .env.example .env
# Edit BOT_TOKEN and POSTGRES_PASSWORD in .env.
# Use a long URL-safe database password (hex is convenient).
docker compose up --build -d
docker compose logs --tail=30 bot
```

For a server where the installed command is `docker-compose`, the equivalent commands are:

```sh
docker-compose up --build -d
docker-compose ps
docker-compose logs --tail=30 bot
```

Use that spelling for **all** remaining Compose commands in this document when necessary.

To update an existing installation without resetting its database or replacing its secrets:

```sh
git pull --ff-only
docker-compose build --pull bot
docker-compose up -d
docker-compose ps
docker-compose logs --tail=30 bot
```

Use `docker compose` instead if you installed the CLI plugin. `build --pull` refreshes the base image; it does not change the PostgreSQL major version or remove its volume. A container reported as “Started” still needs its startup logs checked for successful migrations and `polling_ready`/`webhook_ready`.

The app runs as the non-root `node` user. Startup applies committed migrations before starting the bot. PostgreSQL data lives in the `postgres_data` volume. `docker compose down` preserves it; **do not use `down -v`** unless intentionally deleting the database. PostgreSQL and app ports bind only to loopback.

Compose overrides `DATABASE_URL` for its internal database hostname. The `.env.example` URL is for running Node directly on the host. Update that URL's password if you use local Node execution.

The same HTTPS reverse proxy should forward `/` and `/api/` to port 3000 for the Mini App, plus `/telegram` when using webhook mode. With `WEB_APP_URL` omitted, the Mini App is disabled and the inline bot continues to work.

## 3. Use the Mini App

1. Each person opens the bot's private chat and taps **Start**, then opens **Ledger** from the chat menu.
2. One person creates an invite code and shares it with the friend. The friend opens the app and enters that code once to join the same ledger.
3. Either person can add an expense, choose who paid and enter the payer's share percentage. It is saved immediately.
4. Record a repayment by choosing **Repayment** and entering who paid. Repayments must reduce the current debt.
5. Either person can edit or delete an existing entry. Changes update the balance immediately; there is no per-entry approval step.

The Mini App does not post into the existing 1:1 chat: Telegram does not give a bot access to send messages in a private conversation where it is not a participant. Both friends use the shared ledger inside the Mini App. For an existing inline ledger, either participant can create an invite from that ledger in the app so the other participant can access the same records there.

## 4. Use it in an existing private chat

Replace `@your_splitbot` with your own username.

1. Anna types `@your_splitbot einrichten` and inserts the result.
2. Anna taps **Bestätigen** to link the chat.
3. Max taps **Beitreten** once; the ledger is active immediately.
4. Anna types `@your_splitbot 40€ Abendessen`, inserts the result and taps **Bestätigen**. The other participant sees only `Anna added "40,00 € for Abendessen"` after it is recorded.
5. Use `@your_splitbot saldo`, insert the result, and tap **Saldo**. Each participant sees the balance privately.
6. Max records `@your_splitbot 16 Taxi` and taps **Bestätigen**. Balance: Max owes Anna EUR 12. Anna does not need to approve Max's entry.
7. After Max pays Anna, he records `@your_splitbot ausgleich 12` and taps **Bestätigen**. Balance: zero; the ledger remains active.
8. Weeks later Anna records `@your_splitbot 10 Kino`. Same ledger, Max owes EUR 5.

`12,50`, `12.50`, `12€`, and `12 EUR` are accepted. Thousands separators, negative/zero amounts, scientific notation, and more than two decimal places are rejected. Description required for expenses, maximum 120 characters. Limit: EUR 10,000,000 per entry. In a EUR 10.01 expense, the payer bears EUR 5.01 and the peer EUR 5.00; the extra cent always stays with the payer.

Only creator-confirmed entries affect balance. Setup activates when the second person taps **Beitreten**. A draft expires after 24 hours. Failed/double clicks cannot duplicate booking. A payment exceeding the current debt, or by the wrong debtor, is rejected. Re-enter a corrected draft if a payment is rejected after the balance changed.

For cancellation: open **Verlauf**, navigate to the entry, choose **Storno vorbereiten**, insert the resulting inline draft in the same chat, and tap **Bestätigen**. The original remains visible and the reversal cancels its signed contribution. Undoing an expense after a settlement can correctly create a debt in the opposite direction. Stale balances are snapshots; refresh to obtain the latest committed value.

## 5. Production webhooks

Use one deployment per bot token. Never run polling and webhook workers simultaneously. Configure an HTTPS reverse proxy with a valid public certificate, forwarding `/telegram` to `127.0.0.1:3000`. Set:

```dotenv
BOT_MODE=webhook
WEBHOOK_URL=https://your-real-domain.example/telegram
WEBHOOK_SECRET=your_own_random_url_safe_secret_at_least_32_characters
```

Generate the secret with `openssl rand -hex 32`. Redeploy with `docker compose up -d --build`. Startup registers `setWebhook` with the secret and only inline/chosen/callback updates. POST requests require the Telegram secret-token header, JSON, and a body of at most 1 MiB. `/healthz` checks database availability. Configure request throttling at the reverse proxy as well; the in-process per-user limiter is not distributed. Do not log request bodies, tokens, or full exception objects. Use TLS for remote database connections.

Returning to `BOT_MODE=polling` deletes the webhook without dropping pending updates. Production handles failed updates with HTTP 503 for retry; financial idempotency survives retries. Telegram UI edits are best-effort after commit: use a fresh `saldo` message if an edit fails. Expired callback IDs cannot be re-answered indefinitely.

## Local development and tests

Use Node.js 22.12 or newer and a **dedicated disposable test database**.

```sh
npm ci
npm run db:generate
docker compose up -d db
npm run db:migrate
npm run dev
```

For the full suite, set `DATABASE_URL` in the shell to a test database, apply migrations, then run:

```sh
npm run build
npm test
```

`npm test` does not load `.env`; it uses the shell's `DATABASE_URL`. Database tests are explicitly skipped when that variable is absent. `npm run test:unit` runs the pure accounting tests. GitHub Actions supplies PostgreSQL 16, applies migrations, runs all tests and builds the Docker image.

Tests exercise the accounting acceptance cases plus creator-only booking, direct setup activation by the second participant, forwarded identifiers, outsider rejection, duplicate query IDs, concurrent retries, overpayment, partial payment, expiration, reversal, actual grammY event dispatch, unknown/group queries and webhook authentication.

## Dependency and build warnings

Dependencies are pinned in `package-lock.json`. Prisma CLI, generated client and PostgreSQL adapter are upgraded together to the patched stable 7.x line; Prisma 8 release candidates are deliberately excluded. Prisma 7 uses `prisma.config.ts` for the CLI connection URL and a `pg` adapter at runtime. The existing SQL migration and data volume are unchanged; no reset is needed.

CI runs both `npm audit` and `npm audit --omit=dev`, plus the PostgreSQL integration suite and Docker build. Do not run `npm audit fix --force` on the production server: major updates require regenerating the client and testing. Install the committed lockfile with `npm ci`.

An npm “new major version available” notice is about the package-manager executable bundled with Node, not a failed application update. `debconf` messages about missing interactive frontends during an image build are also not failures. The Dockerfile uses noninteractive package configuration. Audit vulnerabilities, failed migrations and bot startup errors must still be addressed.

## Data handling and operations

Stored: Telegram ID, sanitized display name, opaque chat/message identifiers, draft data/expiry, participants, amounts/shares, entry states, creation timestamps and audit links. No usernames, contact lists, bank data, or normal private messages. Users choose what they put in expense descriptions. The database, backups and operator access must be protected separately; Telegram bots are not an end-to-end encrypted financial vault.

Run cleanup daily using your scheduler:

```sh
docker compose exec bot node dist/cleanup.js
```

Unbound expired drafts are deleted, bound financial drafts remain in history as expired, and truly orphaned users are removed. Confirmed history is retained until a verified erasure request; zero balance alone never triggers deletion. Configure and document backup retention with your hosting provider.

Erasure is operator-assisted because a shared ledger affects both users. Verify the requester's numeric Telegram identity through an authenticated interaction, explain the shared-history impact and notify the other participant through your established support process. Preview affected ledger count, then execute:

```sh
docker compose exec bot node dist/erase.js TELEGRAM_ID
docker compose exec bot node dist/erase.js TELEGRAM_ID --confirm-shared-ledger-deletion
```

This deletes the requester's user record and every affected shared ledger with its drafts, entries and events in one transaction; unrelated ledgers remain. It is deliberately not a public endpoint or a silent user-facing button. Remove affected backups according to your documented retention/erasure policy. The bot does not send support messages automatically.

## Layout

- `src/money.ts`: parsing, splitting and signed cents.
- `src/miniapp.ts`, `public/`: Telegram-authenticated Mini App and ledger API/UI.
- `src/service.ts`: authorization, transactions and ledger state transitions.
- `src/bot.ts`: German inline UI and callbacks.
- `src/main.ts`, `config.ts`, `webhook.ts`: transport and startup.
- `prisma/`: schema, foreign keys, checks and migration.
- `tests/`: unit, database and Telegram adapter tests.
- `docs/`: design, implementation plan and verification record.

No production token, domain, credentials, or running deployment is included. These must come from the operator.
