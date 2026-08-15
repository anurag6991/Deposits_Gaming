import { dayKey } from '@deposits/shared';
import { appTimezone, prisma, withTransaction } from '../db/prisma.js';
import { logger } from '../lib/logger.js';
import { getSettingNumber } from '../modules/settings/settings.service.js';

/**
 * Background jobs.
 *
 * These run in ONE dedicated worker process, never inside the clustered API.
 * Under PM2 cluster mode every instance would otherwise fire the same cron on
 * the same tick, so a sweeper would run twice and notifications would duplicate.
 *
 * Each job is written to be safe if it runs twice anyway — the sweeper is
 * guarded on status, and notifications are deduplicated by a unique index — but
 * the single-worker deployment is the primary control.
 */

/**
 * Returns abandoned reservations to the pool.
 *
 * A publisher who starts a task and closes their laptop holds an identity
 * forever otherwise, and the pool bleeds a record at a time until an offer
 * starves for no visible reason.
 */
export async function sweepExpiredReservations(): Promise<{ released: number; sessions: number }> {
  const now = new Date();

  return withTransaction(async (tx) => {
    const expired = await tx.taskSession.findMany({
      where: { status: 'OPEN', expiresAt: { lt: now } },
      select: { id: true, testDataId: true, publisherId: true, offerId: true },
      take: 500,
    });

    if (expired.length === 0) return { released: 0, sessions: 0 };

    await tx.taskSession.updateMany({
      where: { id: { in: expired.map((s) => s.id) } },
      data: { status: 'EXPIRED', completedAt: now },
    });

    const dataIds = expired.map((s) => s.testDataId).filter((id): id is string => id !== null);

    // Guarded on RESERVED so a record consumed in the meantime is never
    // resurrected back into the pool.
    const released = await tx.testData.updateMany({
      where: { id: { in: dataIds }, status: 'RESERVED' },
      data: {
        status: 'AVAILABLE',
        reservedByUserId: null,
        reservedAt: null,
        reservationExpiresAt: null,
      },
    });

    for (const session of expired) {
      await tx.auditLog.create({
        data: {
          actorUserId: null,
          actorRole: null,
          action: 'testdata.reservation_expired',
          entityType: 'task_session',
          entityId: session.id,
          metadata: {
            publisherId: session.publisherId,
            offerId: session.offerId,
            testDataId: session.testDataId,
          },
        },
      });
    }

    return { released: released.count, sessions: expired.length };
  });
}

/**
 * Marks offers past their expiry date.
 *
 * The UI's red highlight comes from comparing the date at read time, so this job
 * is not what makes an offer look expired — it only moves the status so expired
 * offers stop accepting work and appear in status filters.
 */
export async function markExpiredOffers(): Promise<number> {
  const today = new Date();

  const result = await prisma.offer.updateMany({
    where: {
      expiryDate: { lt: today },
      status: { in: ['ACTIVE', 'PAUSED', 'DRAFT'] },
    },
    data: { status: 'EXPIRED' },
  });

  return result.count;
}

/**
 * Notifies about deposits whose gameplay is overdue.
 *
 * Deduplicated per user, per deposit, per day by the unique index on
 * notifications — without it a job running hourly would produce 24 rows a day
 * for the same overdue deposit and bury everything else.
 */
export async function notifyOverdueGameplay(): Promise<number> {
  const now = new Date();
  const day = dayKey(now, appTimezone);

  const overdue = await prisma.deposit.findMany({
    where: { status: 'ACTIVE', nextGameplayDueAt: { lt: now } },
    select: {
      id: true,
      publisherId: true,
      managerId: true,
      amount: true,
      offer: { select: { name: true } },
    },
    take: 1000,
  });

  let created = 0;

  for (const deposit of overdue) {
    // The publisher acts on it; the manager needs to know it is slipping.
    for (const userId of new Set([deposit.publisherId, deposit.managerId])) {
      const result = await prisma.notification.createMany({
        data: [
          {
            userId,
            type: 'GAMEPLAY_OVERDUE',
            title: 'Gameplay overdue',
            body: `${deposit.offer.name}: a $${deposit.amount.toString()} deposit needs gameplay.`,
            entityType: 'deposit',
            entityId: deposit.id,
            dedupeDay: day,
          },
        ],
        skipDuplicates: true,
      });
      created += result.count;
    }
  }

  return created;
}

/** Warns owners about offers approaching expiry, so nothing lapses silently. */
export async function notifyExpiringOffers(): Promise<number> {
  const now = new Date();
  const day = dayKey(now, appTimezone);
  const warningDays = await getSettingNumber('offer_expiry_warning_days', 14);
  const horizon = new Date(now.getTime() + warningDays * 86_400_000);

  const expiring = await prisma.offer.findMany({
    where: { status: 'ACTIVE', expiryDate: { gte: now, lt: horizon } },
    select: { id: true, name: true, expiryDate: true, ownerUserId: true },
  });

  let created = 0;

  for (const offer of expiring) {
    const result = await prisma.notification.createMany({
      data: [
        {
          userId: offer.ownerUserId,
          type: 'OFFER_EXPIRING',
          title: 'Offer expiring soon',
          body: `${offer.name} expires on ${offer.expiryDate.toISOString().slice(0, 10)}. Extend it if it is still needed.`,
          entityType: 'offer',
          entityId: offer.id,
          dedupeDay: day,
        },
      ],
      skipDuplicates: true,
    });
    created += result.count;
  }

  return created;
}

/** Removes expired sessions. Purely housekeeping; nothing depends on the rows. */
export async function purgeExpiredSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const result = await prisma.session.deleteMany({
    where: { OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }] },
  });
  return result.count;
}

/** Runs a job and logs the outcome without letting a failure kill the worker. */
async function safely(name: string, fn: () => Promise<unknown>): Promise<void> {
  const started = Date.now();
  try {
    const result = await fn();
    logger.info({ job: name, ms: Date.now() - started, result }, 'job complete');
  } catch (err) {
    // One failing job must not stop the others from running on the next tick.
    logger.error({ job: name, err }, 'job failed');
  }
}

/** Every job, in order. Exposed so tests and a manual trigger can call it. */
export async function runAllJobs(): Promise<void> {
  await safely('sweepExpiredReservations', sweepExpiredReservations);
  await safely('markExpiredOffers', markExpiredOffers);
  await safely('notifyOverdueGameplay', notifyOverdueGameplay);
  await safely('notifyExpiringOffers', notifyExpiringOffers);
  await safely('purgeExpiredSessions', purgeExpiredSessions);
}
