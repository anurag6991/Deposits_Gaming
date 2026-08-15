# Deposits Gaming

Internal testing management platform for lead and deposit testing across gaming brands.

Super Admin creates Managers, Managers create Publishers, either creates Offers with
country targeting and monthly targets, and Publishers execute lead and deposit tasks
against country-matched test identities. The system tracks progress, per-offer timers,
deposit balances, gameplay reminders, withdrawals, and advances.

## Status

**Phase 1 — architecture.** Documentation only; no code yet.

## Documentation

- [CLAUDE.md](CLAUDE.md) — build rules and conventions
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — stack, layout, deployment, algorithms
- [docs/SCHEMA.md](docs/SCHEMA.md) — database design
- [docs/PERMISSIONS.md](docs/PERMISSIONS.md) — role and permission matrix
- [docs/DECISIONS.md](docs/DECISIONS.md) — open questions
- [docs/ROADMAP.md](docs/ROADMAP.md) — phased plan and feature ideas

## Stack

Next.js · Node.js · TypeScript · Express · PostgreSQL · Prisma · Nginx · PM2 · Hostinger VPS
