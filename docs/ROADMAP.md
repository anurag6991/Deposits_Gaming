# Phased Implementation Plan

Each phase ends in something you can look at and approve. Nothing destructive happens
without explicit confirmation, and from Phase 5 onward the production database is
untouchable by any routine operation.

---

## Phase 1 — Architecture (this document set) ✅

Inspection, stack, schema, permission matrix, API surface, page structure, open
decisions. **Awaiting your answers to DECISIONS.md before Phase 2 begins.**

---

## Phase 2 — Database

- Monorepo scaffold, TypeScript configs, lint, `.env.example`
- `schema.prisma` implementing docs/SCHEMA.md in full
- `migration_001_initial` — all tables, enums, indexes, foreign keys
- `migration_002_constraints` — CHECK constraints, partial unique indexes, the
  `manager_id` role trigger, append-only grant on `audit_logs`
- Dev seed: 1 super admin, 2 managers, 5 publishers, 3 offers, 200 fake test rows,
  sample deposits across three months. **Dev only, never runs in production.**
- Production bootstrap script that creates the single Super Admin from environment
  variables and forces a password change on first login

**Deliverable:** a working local database you can inspect, plus an ER diagram.

---

## Phase 3 — Backend

Built module by module, each with tests before moving on.

1. Config + env validation, logging, error envelope, health check
2. Auth: login, refresh rotation, logout, lockout, password change
3. RBAC middleware + `scopeFilter` + audit-log helper
4. Users: managers, publishers, assignment
5. Offers: CRUD, status, extension, progress computation
6. Test data: import pipeline (upload → parse → map → validate → preview → confirm),
   pool stats, release/disable/reset
7. Tasks: `eligible-offers`, atomic `start`, abandon, the reservation sweeper
8. Leads: completion with the offer_publishers mutex
9. Deposits: creation, status history, balance ledger, withdrawals
10. Gameplay: confirmation, due-date computation, overdue queries
11. Advances, proxies (with encrypted credential reveal)
12. Reports, notifications, settings, audit-log reader
13. Cron worker: sweeper, offer expiry, gameplay alerts, low-data alerts, session purge

**Mandatory tests before Phase 4:**

- Two concurrent `POST /tasks/start` never receive the same identity (real parallel
  transactions against a real Postgres, not mocks)
- Concurrent lead completions cannot exceed the monthly target
- Timer cannot be bypassed by replaying the request
- Manager A receives zero rows belonging to Manager B across every list, single-read,
  search, and export endpoint
- Manager cannot see Super Admin test data
- Publisher cannot enumerate test data
- Balance arithmetic across a top-up + withdrawal + adjustment sequence
- Gameplay due-date maths across timezone and daylight-saving boundaries
- Offer expiry at exactly the boundary date

**Deliverable:** a documented API with a passing test suite.

---

## Phase 4 — Frontend

Built in this order, because the publisher is the one who uses it all day.

1. Login, session handling, role-based routing
2. **Publisher:** dashboard, offer selector with live timers, task screen (identity +
   copy buttons + proxy + complete), deposits with gameplay traffic-light, withdrawals,
   advances — mobile-first
3. **Manager:** dashboard, offers, publishers, test data import, deposits, advances
4. **Super Admin:** everything above plus managers, proxies, audit logs, settings
5. Shared: filters, date ranges, search, CSV export, notification bell

**Deliverable:** the working application on your local machine or the dev environment.

---

## Phase 5 — Deployment

- VPS hardening: non-root deploy user, SSH keys only, UFW, fail2ban, unattended-upgrades
- PostgreSQL 16 install, separate dev and prod databases and roles, localhost-only bind
- Nginx + certbot + HTTPS + security headers
- PM2 ecosystem (web, api cluster, single cron worker), boot persistence
- `.env.production` created directly on the VPS, chmod 600, never in git
- Deploy script with pre-deploy backup, `migrate deploy`, symlink swap, health check,
  automatic rollback
- Backup cron, retention, off-VPS copy, weekly restore verification
- `docs/RUNBOOK.md`: deploy, rollback, restore, add a user, rotate secrets
- **A real restore test before go-live** — an untested backup is not a backup

**Deliverable:** the platform live on HTTPS, with a verified restore.

---

## Phase 6 — Security review

Line-by-line against section 34 and 6 of the brief: authentication, authorisation, data
isolation between managers, sensitive-data exposure in every response shape, upload
handling, rate limits, headers, cookie flags, secret handling, audit coverage,
firewall, backup integrity. Findings fixed before sign-off.

---

# Suggested additions

Things worth building that the brief does not mention. Nothing here changes the
schema in a way that blocks it being added later.

## Strongly recommended

| Feature | Why |
|---|---|
| **Sticky proxy per identity** | Same test account always from the same IP. Without it, accounts get flagged and your test results are noise. Costs one nullable column. |
| **Proof upload on deposit** | One screenshot per deposit. Turns "he says he deposited" into evidence. Local disk, path in DB. |
| **Cancel / abandon task** | Already needed for reservation cleanup, but as a visible button it stops publishers burning identities on mistakes. |
| **Lead → deposit conversion view** | Falls out of decision 2 for free and is the single most useful number for judging an offer. |
| **Monthly close** | Lock a month so historical reports stop moving. Prevents late edits silently changing last month's numbers. |
| **CSV export everywhere** | You will want this on day two. Cheap now, annoying to retrofit. |
| **"View as publisher"** | Super Admin sees exactly what a publisher sees. Makes support trivial. Read-only, audited. |

## Worth having

| Feature | Why |
|---|---|
| Browser notification when a timer expires | Publishers stop watching the clock and idle time drops |
| PWA install for publishers | Home-screen icon on phone, works like an app |
| Publisher leaderboard | Simple ranking by leads/deposits this month |
| Offer templates | Cloning a US offer for the UK takes one click instead of refilling the form |
| Bulk assign publishers to offers | Ten publishers to one offer without ten clicks |
| Data pool health per country | "US: 412 available, UK: 6 available" on the admin dashboard |
| Per-offer notes shown at task time | Promo codes, quirks, "use the app not the site" |
| Activity timeline per identity | Everything that ever happened to one test account on one page |
| Duplicate-detection warnings | Flags when the same phone or address appears across imports |

## Later, once the system is in daily use

Two-factor authentication for Super Admin and Managers; IP allowlisting; multi-currency;
webhook and API integrations; scheduled emailed reports; target-based bonus
calculations; custom roles beyond the three.

## Deliberately not recommended

Automated form filling or browser automation for the leads themselves. It changes the
platform from a tracking tool into automation infrastructure, and it is where this kind
of system becomes fragile and hard to maintain. Keep the human in the loop; the
platform tracks and coordinates.
