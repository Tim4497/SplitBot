# Verification record

## Environment

Development used Node 24.19.0, TypeScript 5.9.3 and Prisma 6.19.0. Production container targets Node 22 and PostgreSQL 16.

The local environment has no Docker/PostgreSQL service. Database/event integration runs use PGlite 0.5.10 (the PostgreSQL engine compiled to WASM) with pglite-socket 0.2.13, the committed migration SQL, and Prisma through the PostgreSQL wire protocol. The harness is external to the application. It uses a single connection and disables prepared-statement caching for PGlite's connection multiplexer. This verifies SQL, constraints, state transitions and event adapter behavior; it does **not** establish PostgreSQL 16 multi-connection serializable-conflict behavior. CI defines that environment and runs the full suite, including concurrent confirmations.

No live Telegram bot/token was available. Adapter tests dispatch real Telegram update shapes through grammY and intercept outbound API calls. BotFather configuration and a live two-account smoke test remain operator deployment steps. No Docker image was built in this environment.

## Result

31 tests passed across five test files, with no skips, using the local PostgreSQL-compatible harness. TypeScript build passed. PostgreSQL 16 CI, Docker build, and live Telegram operation were not run.

## Coverage

- All eight requested acceptance cases: 40 EUR, offsetting 16 EUR, 12 EUR settlement, later 10 EUR on same ledger, isolation, duplicate events, unauthorized access, odd cents.
- Creator-first binding and peer-only confirmation.
- Cross-message and cross-chat replay rejection; chosen results never book.
- Setup requires creator approval of the exact candidate ID.
- Wrong-direction/overpayment rejection, partial settlements and expiry.
- Retained original entries and exactly one inverse event on cancellation.
- Private callback balances and no shared-message balance edits.
- Group/unknown chat filtering, webhook configuration and secret validation.
- Regression tests for pending confirmation controls, rate-limit expiry at capacity, and cleanup preserving pending setup consent.

## Review

An independent static review found three issues listed above in regression coverage. They were reproduced with failing tests and fixed before delivery. No token or private environment file is committed.

GitHub publication and CI execution must be verified separately; a local test result is not a claim that remote CI or a production deployment ran.
