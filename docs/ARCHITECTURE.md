# Architecture — Deposits Gaming (Internal Testing Platform)

## 0. Inspection result (as of clone)

| Item | Finding |
|---|---|
| Repository | `anurag6991/Deposits_Gaming`, single commit, `README.md` only (38 bytes) |
| Existing frontend | None |
| Existing backend | None |
| Existing dependencies | None (no `package.json`) |
| Existing DB config | None |
| Existing deploy config | None (no CI, no Dockerfile, no workflows) |
| Branches | `main` only |
| Local toolchain | `git` present; **Node, npm, Docker, psql NOT installed locally** |
| VPS | `srv1836208.hstgr.cloud` reachable, sshd accepts `publickey,password`. **Contents unknown — key not yet installed** |

Nothing exists yet. This is a greenfield build, so there is no existing work to preserve
and no database to protect *yet*. From the first production deploy onward, the
non-destructive rules in this document apply absolutely.

## 1. Stack (locked)

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 15 (App Router) + TypeScript | One framework, SSR for fast dashboards, good mobile story |
| UI | Tailwind CSS + shadcn/ui | Plain, consistent, no design work needed |
| Data fetching | TanStack Query | Cache + polling for timers and counters |
| Backend | Node.js 22 LTS + TypeScript + Express | Boring, well understood, easy to run under PM2 |
| Validation | Zod (shared package, used by both FE and BE) | One schema, validated on both sides |
| Database | PostgreSQL 16 | Required |
| ORM | Prisma | Migrations, type safety; raw SQL escape hatch for locking queries |
| Auth | JWT access token (15 min) + rotating refresh token in httpOnly cookie, session rows in DB | Revocable, no tokens in localStorage |
| Hashing | Argon2id | Required |
| Secret encryption | AES-256-GCM via `ENCRYPTION_KEY` | Proxy and test-account secrets |
| Process | PM2 (cluster mode, 2 instances) | Simpler than Docker on a single VPS |
| Reverse proxy | Nginx | TLS termination, static assets, `/api` upstream |
| TLS | Lets Encrypt (certbot, auto-renew) | Required |
| Jobs | `node-cron` inside a **single** dedicated PM2 worker process | Avoids duplicate cron firing under cluster mode |
| Tests | Vitest + Supertest against a real disposable Postgres | Concurrency tests need a real database |
| Logging | Pino to JSON files, rotated by logrotate | Request IDs, no secrets |

Deliberately NOT used: Docker/Kubernetes, microservices, GraphQL, Redis, message
queues, object storage, or third-party SaaS. A modular monolith on one VPS is correct
for this scale. Redis is the one thing likely to be added later (shared rate-limit and
job locking across PM2 instances); until then rate limiting is per-instance, which is
acceptable for an internal tool.

## 2. Repository layout (monorepo, npm workspaces)

```
Deposits_Gaming/
├── apps/
│   ├── api/                      # Express + Prisma
│   │   ├── prisma/
│   │   │   ├── schema.prisma
│   │   │   ├── migrations/
│   │   │   └── seed.ts           # dev-only seed
│   │   └── src/
│   │       ├── config/           # env loading + validation (Zod)
│   │       ├── db/               # prisma client, transaction helpers
│   │       ├── middleware/       # auth, rbac, rateLimit, error, requestId, audit
│   │       ├── modules/          # one folder per domain
│   │       │   ├── auth/  users/  offers/  test-data/  leads/
│   │       │   ├── deposits/  gameplay/  withdrawals/  advances/
│   │       │   ├── proxies/  reports/  audit/  notifications/  settings/
│   │       │   └── (each: .router.ts .service.ts .schema.ts .test.ts)
│   │       ├── jobs/             # reservation sweeper, expiry marking, alerts
│   │       ├── lib/              # crypto, dates/timezone, money, errors
│   │       └── server.ts
│   └── web/                      # Next.js
│       ├── app/(auth)/login
│       ├── app/(admin)/...       # super admin + manager, permission-gated
│       ├── app/(publisher)/...
│       ├── components/ui/        # shadcn primitives
│       ├── components/           # shared app components
│       └── lib/api/              # typed API client
├── packages/
│   ├── shared/                   # Zod schemas, enums, permission matrix, types
│   └── config/                   # eslint, tsconfig bases
├── docs/
├── ops/
│   ├── nginx/  pm2/
│   ├── backup/pg_backup.sh
│   └── deploy/deploy.sh
└── .github/workflows/ci.yml
```

## 3. Environments

| | Development | Production |
|---|---|---|
| Location | Local machine, or a `dev` folder on the VPS | VPS `/srv/deposits/current` |
| Database | `deposits_dev` | `deposits_prod` (separate Postgres role) |
| Branch | `develop` | `main` |
| Env file | `.env.development` | `.env.production` (chmod 600, on VPS only, never in git) |
| Seed data | Yes, fake | Never |

`.env.example` is committed with variable *names* only. `.gitignore` blocks `.env*`
except `.env.example`. A pre-commit hook (gitleaks) blocks accidental secret commits.

Required variables:

```
NODE_ENV  PORT  APP_URL  API_URL  APP_TIMEZONE
DATABASE_URL  SHADOW_DATABASE_URL
JWT_ACCESS_SECRET  JWT_REFRESH_SECRET  COOKIE_SECRET
ENCRYPTION_KEY                    # 32-byte base64, for AES-256-GCM
BACKUP_DIR  BACKUP_RETENTION_DAYS  BACKUP_REMOTE_TARGET
MAX_UPLOAD_MB  RATE_LIMIT_WINDOW_MS  RATE_LIMIT_MAX
LOG_LEVEL  LOG_DIR
```

## 4. Deployment architecture

```
Browser ──HTTPS──> Nginx (443)
                     ├── /            -> Next.js  (127.0.0.1:3000, PM2)
                     └── /api         -> Express  (127.0.0.1:4000, PM2 cluster x2)
                                             └──> PostgreSQL (127.0.0.1:5432)
                                                    └──> /var/backups/deposits
```

- Postgres binds to localhost only. UFW allows 22, 80, 443 only.
- The Postgres data directory lives at `/var/lib/postgresql/16/main`, completely
  outside the git checkout. Nothing in the repo can touch it.
- Deploys use a release-directory pattern with an atomic symlink swap:

```
/srv/deposits/
├── releases/2026-08-15-1030/    # git checkout + build
├── current -> releases/...      # symlink, swapped last
└── shared/.env.production       # symlinked into each release
```

`ops/deploy/deploy.sh` steps:

1. `pg_dump` pre-deploy safety backup
2. `git fetch` and check out the target SHA into a new release directory
3. `npm ci && npm run build`
4. `prisma migrate deploy` — **never** `migrate reset`, `migrate dev`, or `db push`
5. Swap the `current` symlink
6. `pm2 reload` (zero downtime)
7. Poll `/api/health`; on failure, swap the symlink back and reload

`prisma migrate reset`, `migrate dev`, and `db push` are hard-blocked in production by
a guard script that refuses to run when `NODE_ENV=production`.

## 5. Backups

`ops/backup/pg_backup.sh`, run by cron at 03:00 server time:

- `pg_dump -Fc deposits_prod` to `/var/backups/deposits/deposits_prod_YYYYMMDD_HHMM.dump`
- gzip, with a recorded `sha256sum`
- weekly restore verification: restore into a scratch database, run row-count sanity
  checks, then drop the scratch database
- retention: 30 daily plus 12 weekly
- off-VPS copy via rclone or rsync to a second location (`BACKUP_REMOTE_TARGET`)
- every run appends to `/var/log/deposits/backup.log`; a failed backup raises a Super
  Admin notification on next login

The restore procedure is documented in `docs/RUNBOOK.md` (written in Phase 5) and must
be tested once before go-live.

## 6. API structure

All routes live under `/api/v1`. Every route passes through
`requestId → rateLimit → authenticate → authorize(permission) → validate(zod) → handler`.

```
POST   /auth/login                     POST /auth/refresh   POST /auth/logout
GET    /auth/me                        POST /auth/change-password

GET    /users                          POST /users            # role-gated creation
PATCH  /users/:id                      POST /users/:id/disable
POST   /users/:id/assign-manager

GET    /offers                         POST /offers
GET    /offers/:id                     PATCH /offers/:id
POST   /offers/:id/extend              POST /offers/:id/status
GET    /offers/:id/progress            # server-computed counters
POST   /offers/:id/publishers          DELETE /offers/:id/publishers/:publisherId

POST   /test-data/imports              # upload, returns preview + validation report
POST   /test-data/imports/:id/confirm
GET    /test-data                      GET /test-data/stats      # pool health by country
PATCH  /test-data/:id                  POST /test-data/:id/release
POST   /test-data/:id/disable          POST /test-data/bulk-action

GET    /tasks/eligible-offers          # publisher dropdown with timers + counts
POST   /tasks/start                    # {offerId, type} -> atomically reserves identity
POST   /tasks/:id/abandon
GET    /tasks/:id

POST   /leads                          # complete a lead (taskSessionId)
GET    /leads

POST   /deposits                       GET /deposits
PATCH  /deposits/:id                   POST /deposits/:id/status
POST   /deposits/:id/balance           # ledger entry
POST   /deposits/:id/gameplay          # confirm gameplay
POST   /deposits/:id/withdrawals

GET    /withdrawals                    GET /advances    POST /advances
GET    /proxies                        POST /proxies    PATCH /proxies/:id
GET    /proxies/:id/credentials        # audited reveal, task-scoped
POST   /proxies/:id/assign

GET    /reports/dashboard              GET /reports/offers   GET /reports/publishers
GET    /audit-logs
GET    /settings                       PATCH /settings
GET    /notifications                  POST /notifications/:id/read
GET    /health                         # db ping + migration state
```

Error envelope (never leaks internals):

```json
{ "success": false, "code": "NO_TEST_DATA", "message": "No eligible test data is currently available for this offer." }
```

## 7. Frontend page structure

**Publisher** (mobile-first — this is the priority build)

```
/                 Dashboard: today's leads/deposits, offer cards, overdue gameplay banner
/work             Task screen: offer selector, Lead or Deposit, identity + proxy + buttons
/deposits         Table/cards, gameplay traffic-light, PLAY GAME, balance update
/withdrawals      Record withdrawal, running balance
/advances         Read-only monthly advance
```

**Admin** — Super Admin and Manager share the same routes. The sidebar and the data are
filtered by permission; a Manager simply never receives out-of-scope rows from the API.

```
/admin                     Dashboard
/admin/offers              List (red = expired) plus create/edit and publisher assignment
/admin/offers/[id]         Detail: progress bars, assigned publishers, activity
/admin/managers            Super Admin only
/admin/publishers          Create, assign to manager, disable
/admin/test-data           Import wizard, pool health, release/disable
/admin/leads               Filterable activity log
/admin/deposits            The main table with all filters
/admin/advances            Record and list
/admin/withdrawals         List
/admin/proxies             Super Admin only (Managers see assignment, not credentials)
/admin/reports             Monthly rollups, CSV export
/admin/audit-logs          Super Admin only
/admin/settings            Super Admin only
```

## 8. Core algorithms

### 8.1 Atomic test-data assignment

Inside one transaction:

```sql
SELECT id FROM test_data
 WHERE country_code  = $1           -- the offer's target country, never anything else
   AND status        = 'AVAILABLE'
   AND owner_user_id = ANY($2)      -- allowed owners, from offer.data_source_policy
 ORDER BY (owner_user_id = $3) DESC, -- $3 = offer owner: own pool before central
          created_at                 -- then oldest first
 FOR UPDATE SKIP LOCKED
 LIMIT 1;
```

`$2` is resolved from the policy: `OWNER_ONLY` gives `[offer.owner_user_id]`, and the
default `OWNER_PLUS_SUPER_ADMIN` gives `[offer.owner_user_id, <super admin ids>]`.

The `ORDER BY` puts the offer owner's own records first and falls back to the Super
Admin central pool only when the owner's pool is dry. In Postgres a boolean sorts false
before true, so `DESC` yields own-first. Own-pool-first is deliberate: a Manager's
records are usable by nobody else, so spending them first preserves the shared reserve.

`FOR UPDATE SKIP LOCKED` guarantees two concurrent publishers can never receive the
same row. The row moves to `RESERVED` with
`reservation_expires_at = now() + settings.reservation_ttl`. A cron sweeper returns
expired reservations to `AVAILABLE` and writes an audit entry.

Consuming from the central pool never grants visibility into it. The reserved record is
returned to the publisher as a single identity payload; no endpoint lets a Manager or
Publisher list, count, search, or export Super Admin records.

### 8.2 Timer and target enforcement (one mutex, both checks)

`POST /tasks/start` and the completion endpoints both begin by taking a row lock:

```sql
SELECT * FROM offer_publishers
 WHERE offer_id = $1 AND publisher_id = $2 FOR UPDATE;
```

This serialises everything for that (offer, publisher) pair, so inside the same
transaction we can safely check the timer, check the monthly target, insert the
activity, and commit. No double-spend, no target overshoot, and no global lock that
would block unrelated publishers.

Timers are **derived**, never stored as countdowns:
`next_available_at = MAX(completed_at for that offer + publisher) + offer.interval`.
The client renders a countdown for display only; the server re-validates on submit.

### 8.3 Gameplay status

`next_gameplay_due_at = last_gameplay_at + offer.gameplay_interval_days`.

Overdue (red) is **computed at read time** (`now() > next_gameplay_due_at`), not a
stored flag flipped by a job, so it can never drift out of sync. The cron job only
creates notifications; it does not own the truth.

### 8.4 Money and balances

`NUMERIC(14,2)`, Prisma `Decimal`, never JS floats. `deposits.current_balance` is a
cached value; the truth is the append-only `balance_entries` ledger. Every change
(top-up, adjustment, withdrawal) writes a ledger row carrying `balance_before` and
`balance_after`, and updates the cache in the same transaction.

### 8.5 Months

"This month" means calendar month in `APP_TIMEZONE`, confirmed as **`Asia/Kolkata`**
(IST, UTC+5:30). It is a system setting, not hard-coded. Activity rows store a
generated `month_key` (`YYYY-MM`) computed in that timezone, so monthly grouping is a
plain indexed equality filter rather than a range scan.

The server clock stays UTC; only date logic converts. A lead completed at 02:00 IST on
1 September belongs to September even though UTC still reads 31 August. India observes
no daylight saving, so there are no DST boundaries to handle.

### 8.6 Pool consumption

Both task types draw from the same test-data pool: a lead consumes one identity and a
deposit consumes one identity (confirmed `NEW_IDENTITY` model). An offer targeting 100
leads and 50 deposits therefore needs 150 identities for the month, not 100.

Supply comes from the offer owner's own uploads first, then the Super Admin central
pool. Because every Manager shares that central pool, demand across all offers is what
matters, not demand per offer. The Super Admin dashboard therefore shows central-pool
depth per country alongside total outstanding demand (leads plus deposits remaining
across every active offer), and the low-data alert fires against that combined figure.
