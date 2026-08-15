# Deposits Gaming — Build Instructions

Internal testing management platform. Super Admin creates Managers, Managers create
Publishers, either creates Offers, Publishers execute lead and deposit test tasks
against country-matched test identities, and the system tracks targets, timers,
balances, gameplay, withdrawals, and advances.

**This file is the contract. Read `docs/` before making changes.**

| Document | Contents |
|---|---|
| `docs/ARCHITECTURE.md` | Stack, repo layout, environments, deployment, API surface, core algorithms |
| `docs/SCHEMA.md` | Full database design and rationale |
| `docs/PERMISSIONS.md` | Role and permission matrix, data-scoping rules |
| `docs/DECISIONS.md` | Open questions and the defaults in force |
| `docs/ROADMAP.md` | Phased plan and suggested features |
| `docs/RUNBOOK.md` | Operations (written in Phase 5) |

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

## Current status

**Phase 1 complete.** Architecture, schema, permissions, and plan documented.
**Phase 2 blocked** pending answers in `docs/DECISIONS.md`, particularly items 1, 2, 3,
and 5, which affect the schema.

Nothing has been built yet. The repository contains documentation only.
