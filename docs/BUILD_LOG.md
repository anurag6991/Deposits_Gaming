# Build Log

A chronological record of what was built, why, and what changed. Newest entries at
the top. Read this before resuming work — it captures the reasoning that the code
itself does not show, especially decisions that were later reversed.

Format for each entry: what changed, why, and anything a future session must not undo.

---

## 2026-08-15 — Phase 3 started: backend foundation

**Commit:** see `git log` for `feat(api)` commits after `ac73f31`

Built the layers everything else sits on, in dependency order.

| Area | Files | Notes |
|---|---|---|
| Config | `src/config/env.ts` | Zod-validated environment. Fails fast at boot with a readable message rather than surfacing `undefined` deep in a request. |
| Errors | `src/lib/errors.ts` | `AppError` carrying a shared `ErrorCode`. The error middleware is the only place a response is shaped. |
| Logging | `src/lib/logger.ts` | Pino with a redaction list. Passwords, tokens, cookies, and proxy secrets can never be logged even if someone passes the whole object. |
| Crypto | `src/lib/crypto.ts` | AES-256-GCM for proxy and test-account secrets; Argon2id for passwords; sha256 for refresh-token storage. |
| Money | `src/lib/money.ts` | Decimal helpers. Guards against the float trap and against negative results. |
| Database | `src/db/prisma.ts` | Client singleton plus `withTransaction` and the `lockOfferPublisher` helper that every timer/target path uses. |
| Scoping | `src/db/scope.ts` | `scopeFilter()` — the one place role becomes a WHERE clause. |
| Middleware | `src/middleware/*` | requestId, authenticate, authorize, validate, rateLimit, error handler. |
| Audit | `src/modules/audit/audit.service.ts` | `writeAudit()` takes the transaction client so the log and the change commit together or not at all. |
| Auth | `src/modules/auth/*` | Login, refresh rotation, logout, lockout, forced password change. |

**Decisions made while building:**

- Refresh tokens are stored as sha256 hashes, never raw, and rotate on every use. A
  replayed old token revokes the whole session family — standard reuse detection.
- `authenticate` rejects a user whose `status` became `DISABLED` after their token was
  issued. Checking the JWT alone would let a disabled user keep working for up to 15
  minutes.
- Audit writes take the transaction client rather than the global one. Passing the
  global client would let the audit entry survive a rolled-back change, producing a log
  of things that never happened.

---

## 2026-08-15 — Phase 2 complete: schema, migrations, shared package

**Commit:** `ac73f31`

Monorepo scaffold (npm workspaces), the full PostgreSQL schema as Prisma models, two
migrations, and the shared package used by both API and frontend.

**Migration 001** (`20260815120000_initial`) is Prisma-generated DDL: 20 tables, 14
enums, all foreign keys and standard indexes.

**Migration 002** (`20260815120100_constraints_and_guards`) is hand-written and holds
the invariants Prisma cannot express. These matter more than the tables:

- Hierarchy: CHECK that `(role = 'PUBLISHER') = (manager_id IS NOT NULL)`, a trigger
  asserting `manager_id` points at an actual MANAGER, and a trigger refusing to demote
  a manager who still has publishers.
- Import dedupe: partial unique indexes on `(owner, country, lower(email))` and
  `(owner, country, phone)`. Scoped per owner so two managers uploading the same public
  list do not collide with each other.
- Append-only: triggers on `audit_logs`, `balance_entries`, `gameplay_records`,
  `deposit_status_changes`. Implemented as triggers rather than `GRANT` so the
  guarantee holds regardless of which database role the application connects as.
- Money and `month_key` format checks; reservation completeness so a RESERVED row can
  always be reclaimed by the sweeper.
- Partial indexes for the three hot paths: available-record pick, overdue gameplay,
  open task sessions.

**Verification.** PostgreSQL has no native Windows ARM64 build and the EnterpriseDB
installer returns 403, so there is no local Postgres. Rather than ship ~760 lines of
unexecuted SQL, `ops/scripts/verify-migrations.mjs` applies both migrations to PGlite
(real PostgreSQL compiled to WASM) and asserts 24 invariants actually hold. Run with
`npm run verify:db`. All 24 pass.

**Bug the harness caught immediately:** `notifications.entity_id` was nullable, and
PostgreSQL treats NULLs as distinct in a unique index — so the dedupe key silently did
nothing for any alert without an entity, which is exactly the repeating ones (low test
data, monthly target approaching). Every cron tick would have created a duplicate row.
Fixed to `NOT NULL DEFAULT ''`. **Do not make this column nullable again.**

**Dependency choices:**
- `@node-rs/argon2` over `argon2`: prebuilt for `win32-arm64-msvc`, so the dev machine
  needs no native build toolchain. Both are Argon2id; this is purely about install.
- `multer` pinned to 2.x. 1.x is deprecated with known vulnerabilities.

**Known limitation:** PGlite is single-connection, so it cannot prove
`FOR UPDATE SKIP LOCKED` works under genuinely parallel transactions. That test needs a
real PostgreSQL server and is pending VPS access.

---

## 2026-08-15 — Decision 1 reversed: Super Admin pool is shared

**Commit:** `85f7db4`

Originally set to strict separation. The user revised it: Super Admin uploads are a
central pool that all managers' offers may consume.

- `data_source_policy` now defaults to `OWNER_PLUS_SUPER_ADMIN`.
- Assignment order is **own pool first, central pool as fallback**. A manager's own
  records are usable by nobody else, so spending them first preserves the shared
  reserve. The reverse order would let one manager drain the centre while their private
  records sit idle.
- **Consumption is shared; visibility is not.** A manager still cannot browse, search,
  filter, count, or export Super Admin records. This distinction is the whole design —
  do not "simplify" it by letting the test-data list use the same owner set as the
  assignment query.
- Manager-to-manager isolation is untouched. Only the Super Admin pool is shared.

Known trade-off, recorded rather than solved: managers now compete for the central
pool. Atomic reservation keeps this a fairness question rather than a correctness one,
so it is handled by pool-depth reporting and low-data alerts. A per-manager quota can
be added later with no schema change.

---

## 2026-08-15 — Four blocking decisions settled

**Commit:** `1607ccc`

| Decision | Outcome |
|---|---|
| Deposit identity source | `NEW_IDENTITY` — deposits draw a fresh record, independent of leads |
| Monthly targets | Shared across all assigned publishers, not per publisher |
| Timezone | `Asia/Kolkata` for every month/day boundary and `month_key` |
| Pool | (superseded the same day — see the entry above) |

Consequence of the first two together: both task types consume the pool, so an offer
wanting 100 leads and 50 deposits needs 150 identities per month. Low-data alerts count
leads plus deposits outstanding, never leads alone.

`deposits.test_data_id` gained a UNIQUE constraint mirroring `leads.test_data_id`, so
any identity is consumed exactly once by exactly one activity. `deposits.lead_id` is
retained but unused, so an offer can be switched to `FROM_PRIOR_LEAD` later without a
migration.

---

## 2026-08-15 — Phase 1: architecture

**Commit:** `8db5fb4`

Repository was empty: one commit, a 38-byte README, no code of any kind. Greenfield.

Produced `docs/ARCHITECTURE.md`, `docs/SCHEMA.md`, `docs/PERMISSIONS.md`,
`docs/DECISIONS.md`, `docs/ROADMAP.md`, and the `CLAUDE.md` contract. Added
`.gitignore` (blocks `.env*`, dumps, uploads) and `.gitattributes` (LF normalisation,
since the dev machine is Windows and the deploy target is Linux — without it the
`ops/` shell scripts would reach the VPS with CRLF endings and fail).

Fifteen open questions were raised in `DECISIONS.md`; four blocked the schema.

---

## Environment notes

Facts about this setup that cost time to discover.

| Fact | Consequence |
|---|---|
| Dev machine is **Windows on ARM64** | No native PostgreSQL build exists; the EDB installer 403s. Use PGlite for local verification, or a real server over SSH. |
| Node 24.19.0 installed via winget, user scope | PATH needs a shell restart after install. In scripts, reload from Machine + User env. |
| npm 11 blocks install scripts by default | Prisma and esbuild need approval: `npm approve-scripts`. Recorded in root `package.json` under `allowScripts`. |
| No global git config existed | Identity set locally on this repo only, not globally. |
| PowerShell `Out-File -Encoding utf8` writes a **BOM** | A BOM at the top of a `.sql` file makes Postgres fail with `syntax error at or near "﻿"`. Write SQL with `UTF8Encoding($false)`. |
| VPS `srv1836208.hstgr.cloud` | Reachable, sshd accepts publickey and password. Key generated at `~/.ssh/id_ed25519_hstgr` but **not yet installed** — VPS contents still uninspected. |
