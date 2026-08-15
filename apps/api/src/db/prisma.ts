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
 * Takes the per-(offer, publisher) mutex.
 *
 * Every path that checks a timer or a monthly target must call this FIRST, inside
 * the transaction, before reading counts. It serialises concurrent activity for
 * that one pair while leaving every other publisher unblocked.
 *
 * Without it, two simultaneous submissions both read "99 of 100 done" and both
 * insert, overshooting the target — the classic check-then-act race.
 *
 * Returns null when the publisher is not assigned to the offer.
 */
export async function lockOfferPublisher(
  tx: Tx,
  offerId: string,
  publisherId: string,
): Promise<{ id: string; monthlyLeadCap: number | null; monthlyDepositCap: number | null; active: boolean } | null> {
  const rows = await tx.$queryRaw<
    { id: string; monthly_lead_cap: number | null; monthly_deposit_cap: number | null; active: boolean }[]
  >`
    SELECT id, monthly_lead_cap, monthly_deposit_cap, active
      FROM offer_publishers
     WHERE offer_id = ${offerId}::uuid
       AND publisher_id = ${publisherId}::uuid
     FOR UPDATE
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
