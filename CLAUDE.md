# Deposits Gaming — Build Instructions

Internal testing management platform. Super Admin creates Managers, Managers create
Publishers, either creates Offers, Publishers execute lead and deposit test tasks
against country-matched test identities, and the system tracks targets, timers,
balances, gameplay, withdrawals, and advances.

**This file is the contract. Read `docs/` before making changes.**

| Document | Contents |
|---|---|
| **`docs/BUILD_LOG.md`** | **What was built when and why, newest first. Read this first when resuming.** |
| `docs/ARCHITECTURE.md` | Stack, repo layout, environments, deployment, API surface, core algorithms |
| `docs/SCHEMA.md` | Full database design and rationale |
| `docs/PERMISSIONS.md` | Role and permission matrix, data-scoping rules |
| `docs/DECISIONS.md` | Open questions and the defaults in force |
| `docs/ROADMAP.md` | Phased plan and suggested features |
| `docs/RUNBOOK.md` | Operations (written in Phase 5) |

**When you change something, append to `docs/BUILD_LOG.md`.** Code shows what the
system does; the log records why, and which alternatives were rejected. A future
session that cannot see the reasoning will re-litigate settled decisions or undo a
fix without knowing what it was for.

## Where things live

```
apps/api/src/
  config/env.ts            Zod-validated environment; exits at boot if wrong
  lib/errors.ts            AppError + code-to-HTTP-status mapping
  lib/logger.ts            Pino + the redaction list (secrets can never be logged)
  lib/crypto.ts            Argon2id passwords, AES-256-GCM secrets, sha256 tokens
  db/prisma.ts             Client, withTransaction, lockOfferPublisher  <-- the mutex
  db/scope.ts              scopeFilter helpers  <-- the ONLY place role becomes a WHERE
  middleware/auth.ts       authenticate (re-reads the user), authorize (capability)
  middleware/common.ts     requestId, validate, rate limiters, handler, ok
  middleware/error.ts      The only place an error becomes a response
  modules/audit/           writeAudit(tx, ...) — joins the caller's transaction
  modules/auth/            Login, refresh rotation with reuse detection, logout
  modules/settings/        System settings with a short cache
  modules/proxies/         Resolution priority + audited credential reveal
  modules/tasks/           startTask, abandonTask, eligibleOffers  <-- concurrency core
  modules/leads/           completeLead, resetLead
  app.ts / server.ts       Express wiring; graceful shutdown

apps/api/prisma/
  schema.prisma            20 models, 14 enums
  migrations/001_initial   Generated DDL
  migrations/002_...       Hand-written CHECKs, triggers, partial indexes

packages/shared/src/
  permissions.ts           ROLE_PERMISSIONS, can(), scopeFor()
  time.ts                  monthKey, dayKey, monthRange, dayRange (IST)
  errors.ts                ERROR_CODES — the shared code/message table

ops/scripts/
  verify-migrations.mjs    Applies migrations to PGlite, asserts 24 invariants
  guard-dev-only.mjs       Refuses destructive commands when NODE_ENV=production
```

## Commands

```bash
npm install                # workspaces; scripts pre-approved in package.json
npm run verify:db          # apply migrations to PGlite + assert invariants
npm run db:validate        # prisma validate
npm run db:generate        # prisma generate
npm test                   # vitest
npx tsc -p apps/api/tsconfig.json --noEmit
```

---

## Absolute rules

These are not preferences. Violating any of them is a defect.

1. **Never destroy production data.** No `DROP DATABASE`, `DROP TABLE`,
   `prisma migrate reset`, `prisma db push`, or `TRUNCATE` against production — not in
   a script, not in a deploy step, not "just this once". Deployments run
   `prisma migrate deploy` and nothing else.
2. **Never commit secrets.** No passwords, JWT secrets, encryption keys, proxy
   credentials, or connection strings in the repository. `.env.example` carries names
   only.
3. **Backend authorises, frontend decorates.** Every permission is enforced server-side.
   A hidden button is not a permission.
4. **Scope every query.** Any query that can return another user's rows must go through
   `scopeFilter(user)` — lists, single reads, search, exports, counts, aggregates.
5. **Money is `Decimal`.** `NUMERIC(14,2)` in Postgres, Prisma `Decimal` in code. Never
   a JS `number` for an amount.
6. **The server owns the counters.** Targets, progress, timers, and due dates are
   computed from the database. The frontend displays what the API returns and computes
   nothing that matters.
7. **Test-data assignment is atomic.** Always `FOR UPDATE SKIP LOCKED` inside a
   transaction. Two publishers must never receive the same identity.
8. **Audit the consequential.** Every create, update, status change, reveal, reset, and
   login writes an `audit_logs` row in the same transaction as the change. Audit logs
   are insert-only.
9. **Ledgers, not overwrites.** Balances change by appending a `balance_entries` row and
   updating the cached value in the same transaction. Never overwrite a balance alone.
10. **Ask before destructive or irreversible changes.** Schema changes that drop columns
    or tables, data migrations, and anything touching production require explicit
    confirmation first.

---

## Conventions

**Backend**

- One folder per domain in `apps/api/src/modules/`, each with `.router.ts`,
  `.service.ts`, `.schema.ts`, `.test.ts`. Routers handle HTTP only; all logic lives in
  services; services never touch `req` or `res`.
- Every handler validates input with a Zod schema from `packages/shared`.
- Every service function that reads user-owned data takes the requesting user as its
  first argument and applies `scopeFilter`.
- Multi-step writes run in `prisma.$transaction`. Anything checking a timer or a target
  first takes the `offer_publishers` row lock.
- Errors are thrown as `AppError(code, message, httpStatus)`. The error middleware is
  the only place that formats a response. Internal details never reach the client.

**Frontend**

- Server Components for reads, Client Components only where interactivity requires it.
- TanStack Query for all API access; no bare `fetch` in components.
- Timers are rendered from a server-supplied `next_available_at` timestamp. Never
  count down from a client-side number, and always re-validate on submit.
- Publisher pages are designed at 375px first and must be usable one-handed.
- No chart libraries unless a chart genuinely beats a number. Progress bars and plain
  figures are preferred.

**UI tone**

Plain language, no jargon. "Next lead in 4:32", not "cooldown active". Sidebars stay
short. One clear primary action per screen. The publisher screen must be
understandable without training.

**Database**

- Every migration is a file, reviewed before it runs. Never edit production schema by
  hand.
- Index anything that appears in a `WHERE` or `ORDER BY` on a table that will grow.
- Enums for fixed sets, `CHECK` constraints for invariants that must never be violated.
  Put invariants in the database, not only in application code.

**Testing**

Critical paths need tests before the phase is considered done: concurrency, role
isolation, timers, target enforcement, money arithmetic, expiry boundaries. Use a real
Postgres — mocks cannot prove `SKIP LOCKED` works.

---

## Confirmed business rules

These are settled. Do not re-litigate them; change them only on explicit instruction.

1. **Super Admin data is a shared central pool.**
   `data_source_policy = OWNER_PLUS_SUPER_ADMIN` by default. An offer consumes its own
   owner's uploads first, then falls back to the Super Admin pool.
   **Consumption is shared; visibility is not.** A Manager still sees only their own
   uploads in every list, search, filter, count, and export — consuming a central
   record must never make it visible. Manager-to-manager isolation is absolute: only
   the Super Admin pool is shared.
2. **Deposits use a fresh identity.** `deposit_identity_source = NEW_IDENTITY`. A
   deposit task draws a new identity from the pool exactly as a lead does; the
   publisher registers and deposits in one session. Leads and deposits are independent
   and both consume pool records.
3. **Monthly targets are shared** across all publishers assigned to an offer. 100
   leads/month means 100 total, not 100 each. Per-publisher caps exist but stay NULL.
4. **Timezone is `Asia/Kolkata` (IST).** Every month boundary, day boundary, "today"
   counter, and `month_key` uses it. The server clock stays UTC.

## Current status

**Phase 1 complete** — architecture and all blocking decisions settled.
**Phase 2 complete** — schema, both migrations, shared package. 24/24 invariant checks
pass under `npm run verify:db`.
**Phase 3 in progress** — backend foundation, auth, and the task/lead concurrency core
are written and typecheck clean; 15/15 timezone tests pass.

Still to build in Phase 3: users, offers, test-data import, deposits, gameplay,
withdrawals, advances, proxy CRUD, reports, notifications, and the cron worker.
Then Phase 4 (frontend), 5 (deployment), 6 (security review).

### Known gaps — do not mistake these for done

1. **No real PostgreSQL yet.** The dev machine is Windows ARM64 and no native build
   exists. PGlite covers schema and invariants but is **single-connection**, so it
   cannot prove `FOR UPDATE SKIP LOCKED` works under genuinely parallel transactions.
   That test is written against a real server and is still pending.
2. **The VPS has never been inspected.** The SSH key at `~/.ssh/id_ed25519_hstgr` is
   generated but not installed.
3. **No frontend exists.**
4. **Nothing has been deployed.** No Nginx, PM2, TLS, or backups yet.
