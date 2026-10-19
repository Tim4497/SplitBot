# SplitBot design

Implements the supplied 2026-10-18 specification: permanent EUR ledgers for two Telegram users in existing private conversations, using inline queries and callbacks only. No normal messages are consumed.

## Trust boundary

Inline queries have no chat ID or peer identity. Require `chat_type=private`; reject missing type, groups, channels and sender chats. This is a filter, not proof of callback chat type. Every draft/status/setup gets an unguessable identifier. Only its creator can bind its first callback to `(chat_instance, inline_message_id)`. Both are immutable thereafter. Chosen-result feedback is optional and only pins message identity. Never infer chat IDs from opaque values.

Setup: creator binds the invitation; the first other Telegram user to tap **Beitreten** immediately creates the ledger. Telegram does not verify that this user is the intended peer or a member of a private 1:1 chat. The two participants are immutable. A zero balance never closes the ledger.

The creator's **Bestätigen** action binds and immediately finalizes an expense, settlement, or reversal in one transaction. Settlement creator is payer; the other member is recipient. Positive integer cents, payer absorbs odd cent. Confirmed history determines net balance. Partial settlement allowed; reject wrong payer and overpayment at final commit. Reversal remains auditable; no silent deletion.

Callbacks cannot prove private-chat membership or forwarding provenance. Return financial balance/history in caller-only callback alerts, not shared message edits. Original draft text is intentionally shared and may be forwarded by recipients. Never claim prevention of screenshots, forwards, malicious participant disclosure, or independently verified private-chat membership. Inline queries still reject non-private and unknown chat types.

## Architecture

`money.ts`: parsing, splits and integer formatting. `service.ts`: transactional authorization and state machine. `bot.ts`: Telegram adapter and German UI. `main.ts`: polling or authenticated webhook server. Prisma 7 with the PostgreSQL driver adapter stores users, ledgers, drafts, expenses, settlements and append-only events. Serializable transactions retry conflicts; unique source draft IDs prevent double booking. Read responses regenerated on retries, so failed Telegram delivery never rolls back a committed booking.

## Operations

Docker Compose with PostgreSQL, migration deployment, non-root app. HTTPS webhook termination external, secret-token validation and request size cap. BotFather inline mode; no DM onboarding. Secrets only in environment. Cleanup expires unbound drafts. Operator-assisted erasure removes affected shared ledgers transactionally after identity verification and notification outside this automated bot; explain impact on both participants. Backups have separately managed retention.
