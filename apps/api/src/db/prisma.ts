import { Prisma, PrismaClient } from '@prisma/client';
import { env, isProduction } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * Prisma client and the transaction helpers used by every write path.
 */

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: isProduction
      ? [{ emit: 'event', level: 'error' }]
      : [
          { emit: 'event', level: 'error' },
          { emit: 'event', level: 'warn' },
        ],
  });

prisma.$on('error' as never, (e: unknown) => logger.error({ prisma: e }, 'prisma error'));

// tsx watch re-imports modules on change; without this each reload opens a new pool.
if (!isProduction) globalForPrisma.prisma = prisma;

/** The transaction-scoped client. Services accept this so they compose. */
export type Tx = Prisma.TransactionClient;

/**
 * Runs work in a transaction.
 *
 * Serializable is deliberately NOT the default. The concurrency-critical paths
 * use explicit row locks (see lockOfferPublisher and the SKIP LOCKED pick), which
 * are cheaper and do not produce serialisation failures that would need retry
 * logic on every endpoint.
 */
export function withTransaction<T>(
  fn: (tx: Tx) => Promise<T>,
  options?: { timeoutMs?: number },
): Promise<T> {
  return prisma.$transaction(fn, {
    maxWait: 5_000,
    timeout: options?.timeoutMs ?? 15_000,
  });
}

/**
 * Takes the per-OFFER activity mutex, then loads the publisher's assignment.
 *
 * Every path that checks a timer or a monthly target must call this FIRST,
 * inside the transaction, before reading any count.
 *
 * The lock is per OFFER, not per (offer, publisher). That distinction is the
 * whole point and it was originally wrong: monthly targets are SHARED across all
 * publishers assigned to an offer (decision 3), so a lock scoped to one pair does
 * not serialise anything — ten publishers hold ten different rows, all read
 * "4 of 5 done" simultaneously, and all ten insert. A shared counter requires a
 * shared lock. The concurrency test proved this; do not narrow the scope again.
 *
 * An advisory transaction lock rather than `SELECT ... FROM offers FOR UPDATE`:
 * it costs no row visibility, releases automatically at commit or rollback, and
 * does not block unrelated writes to the offer row such as an admin editing the
 * description while publishers work.
 *
 * The cost is that activity on one offer serialises. That is inherent to a shared
 * counter, the transactions are short, and different offers never contend.
 *
 * Returns null when the publisher is not assigned to the offer.
 */
export async function lockOfferPublisher(
  tx: Tx,
  offerId: string,
  publisherId: string,
): Promise<{ id: string; monthlyLeadCap: number | null; monthlyDepositCap: number | null; active: boolean } | null> {
  // Blocks until every other transaction working this offer has committed.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${offerId}::text, 0))`;

  const rows = await tx.$queryRaw<
    { id: string; monthly_lead_cap: number | null; monthly_deposit_cap: number | null; active: boolean }[]
  >`
    SELECT id, monthly_lead_cap, monthly_deposit_cap, active
      FROM offer_publishers
     WHERE offer_id = ${offerId}::uuid
       AND publisher_id = ${publisherId}::uuid
  `;

  const row = rows[0];
  if (!row) return null;

  return {
    id: row.id,
    monthlyLeadCap: row.monthly_lead_cap,
    monthlyDepositCap: row.monthly_deposit_cap,
    active: row.active,
  };
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}

export { Prisma };
export const appTimezone = env.APP_TIMEZONE;
