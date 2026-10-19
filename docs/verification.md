# Verification record

## Environment

Development used Node 24.19.0, TypeScript 5.9.3 and Prisma 6.19.0. Production container targets Node 22 and PostgreSQL 16.

The local environment has no Docker/PostgreSQL service. Database/event integration can use an external PGlite 0.5.10 harness (PostgreSQL compiled to WASM), with pglite-socket 0.2.13, the committed migration SQL, and Prisma through the PostgreSQL wire protocol. It uses a single connection and disables prepared-statement caching for PGlite's connection multiplexer. That harness was not configured for this verification run, so the database integration tests were skipped. Even when run, it does **not** establish PostgreSQL 16 multi-connection serializable-conflict behavior. CI defines a PostgreSQL environment and runs the full suite, including concurrent booking retries.

No live Telegram bot/token was available. Adapter tests dispatch real Telegram update shapes through grammY and intercept outbound API calls. BotFather configuration and a live two-account smoke test remain operator deployment steps. No Docker image was built locally; the GitHub Actions Docker build subsequently passed.

## Result

TypeScript build passed. `npm test` passed 20 tests across the available unit files; 11 database integration tests were skipped because `DATABASE_URL` is not configured in this environment. GitHub Actions subsequently passed the PostgreSQL 16 migrations, full test suite, TypeScript build and Docker image build. Live Telegram operation remains untested.

## Coverage

- All eight requested acceptance cases: 40 EUR, offsetting 16 EUR, 12 EUR settlement, later 10 EUR on same ledger, isolation, duplicate events, unauthorized access, odd cents.
- Creator-first binding and direct creator booking, including concurrent idempotent retries.
- Cross-message and cross-chat replay rejection; chosen results never book.
- Setup activates immediately when a second user joins; no creator approval round trip.
- Wrong-direction/overpayment rejection, partial settlements and expiry.
- Retained original entries and exactly one inverse event on creator-triggered cancellation.
- Private callback balances and no shared-message balance edits.
- Group/unknown chat filtering, webhook configuration and secret validation.
- Regression tests for confirmation-free financial controls and privacy-free inline UI, rate-limit expiry at capacity, and cleanup preserving completed setup.

## Review

An independent static review found three issues listed above in regression coverage. They were reproduced with failing tests and fixed before delivery. No token or private environment file is committed.

Published to the private repository [Tim4497/SplitBot](https://github.com/Tim4497/SplitBot). [GitHub Actions run 39153005308](https://github.com/Tim4497/SplitBot/actions/runs/39153005308) verified the implementation commit `1d3795f2d5faf996e0b127d67fed579184d6387a` against PostgreSQL 16 and built the Docker image. This is a build verification, not a production deployment.

## 2026-10-19 dependency and deployment update

The initial dependency lockfile produced seven npm audit findings. The update moves Prisma CLI/client/adapter to stable 7.10.1 and Vitest to patched 4.1.12, refreshes the other runtime/tooling packages, and keeps TypeScript 5.9 as recommended by the Prisma 7 migration guide. Prisma 8 is a release candidate and is not selected.

No SQL migration or PostgreSQL major-version change is required. The new generated client uses the PostgreSQL adapter and explicit pool timeouts. The Docker image includes the CLI configuration for runtime migrations. CI now runs on native AMD64 and ARM64, audits both dependency sets, builds the image and verifies database access and migrations inside it. Docker Compose configuration is also checked. Run-specific results are available in GitHub Actions.
