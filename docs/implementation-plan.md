# SplitBot Implementation Plan

Goal: executable Telegram inline shared-expense MVP.
Architecture: pure accounting plus PostgreSQL transaction service plus grammY adapter.
Tech Stack: Node 22+, TypeScript, grammY, Prisma 6, PostgreSQL 16, Vitest, Docker.
Spec: design.md and user attachment.

## Constraints

EUR only; integer cents; exactly two consenting identities per immutable chat binding; no private-message reading; financial data in callback alerts. No bot credentials embedded. New isolated repository.

## Review focus

Concurrent confirmation; forged callback IDs; reused drafts across chats; unknown chat types; expired/reversed drafts and pending settlement races.

## Tasks

- [x] Accounting: test German formats, invalid amounts, odd cents and reconstructed net positions; implement money.ts.
- [x] Persistence: Prisma schema with foreign keys, checks, unique chat/draft identifiers; migrate against real PostgreSQL.
- [x] Service: test full 40/16/12/10 flow, isolation, unauthorized access, concurrency, expiration and reversal; implement serializable state machine.
- [x] Adapter: simulate actual inline/chosen/callback updates through grammY, assert persistence and private responses; implement setup, draft confirmation, status and paginated history.
- [x] Operations: polling, authenticated webhook, Compose, migration, privacy cleanup and erasure; README and CI.
- [x] Verify build and complete suite; review authorization and arithmetic.
- [ ] Publish repository: blocked because the GitHub connector lacks repository creation; browser fallback awaits user approval.

Execution: inline. Direct user implementation request authorizes the work; no additional design approval round.
