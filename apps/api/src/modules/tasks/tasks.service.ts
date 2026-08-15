import { monthKey, dayRange, monthRange } from '@deposits/shared';
import { appTimezone, lockOfferPublisher, prisma, withTransaction, type Tx } from '../../db/prisma.js';
import { consumableOwnerIds, type Actor } from '../../db/scope.js';
import { AppError } from '../../lib/errors.js';
import { getSettingNumber } from '../settings/settings.service.js';
import { writeAudit, type AuditContext } from '../audit/audit.service.js';
import { resolveProxyForTask } from '../proxies/proxies.service.js';

/**
 * Task assignment — the concurrency-critical heart of the system.
 *
 * Two guarantees this file exists to provide:
 *
 *   1. Two publishers requesting work at the same instant never receive the same
 *      test identity. Delivered by SELECT ... FOR UPDATE SKIP LOCKED.
 *   2. Concurrent completions cannot push an offer past its monthly target, and
 *      cannot bypass the per-publisher timer. Delivered by locking the
 *      offer_publishers row first, which serialises that one pair.
 *
 * Neither can be tested with mocks. See the concurrency tests.
 */

export interface StartTaskInput {
  offerId: string;
  type: 'LEAD' | 'DEPOSIT';
}

/** What the publisher is shown once a task is started. */
export interface StartedTask {
  taskSessionId: string;
  type: 'LEAD' | 'DEPOSIT';
  expiresAt: Date;
  offer: {
    id: string;
    name: string;
    brand: string;
    countryCode: string;
    url: string;
    instructions: string | null;
  };
  identity: {
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    address: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    dateOfBirth: Date | null;
    extra: unknown;
  };
  proxy: { id: string; host: string; port: number; protocol: string; username: string | null } | null;
}

/**
 * Cached super-admin id list. Used to resolve the central consumption pool.
 * Super admins are created once and essentially never change, so re-reading them
 * on every task start would be pure overhead.
 */
let superAdminIdCache: { ids: string[]; at: number } | null = null;
const SUPER_ADMIN_CACHE_MS = 60_000;

async function superAdminIds(tx: Tx): Promise<string[]> {
  const now = Date.now();
  if (superAdminIdCache && now - superAdminIdCache.at < SUPER_ADMIN_CACHE_MS) {
    return superAdminIdCache.ids;
  }
  const rows = await tx.user.findMany({
    where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
    select: { id: true },
  });
  const ids = rows.map((r) => r.id);
  superAdminIdCache = { ids, at: now };
  return ids;
}

/** Testing hook; also called when a super admin is created or disabled. */
export function invalidateSuperAdminCache(): void {
  superAdminIdCache = null;
}

/**
 * Atomically reserves one eligible test identity.
 *
 * SKIP LOCKED is what makes this safe under load: a concurrent transaction that
 * has already locked the oldest row does not block us and does not hand us the
 * same row — we simply skip past it to the next one. Without SKIP LOCKED the
 * second caller would wait, then read the row as still AVAILABLE if the first
 * transaction rolled back, or block for the whole transaction if it did not.
 *
 * Ordering puts the offer owner's own pool ahead of the Super Admin central pool.
 * A manager's records are usable by nobody else, so spending them first preserves
 * the shared reserve.
 */
async function reserveIdentity(
  tx: Tx,
  params: {
    countryCode: string;
    ownerIds: string[];
    offerOwnerId: string;
    publisherId: string;
    ttlMinutes: number;
  },
): Promise<{ id: string } | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id
      FROM test_data
     WHERE country_code = ${params.countryCode}
       AND status = 'AVAILABLE'
       AND owner_user_id = ANY(${params.ownerIds}::uuid[])
     ORDER BY (owner_user_id = ${params.offerOwnerId}::uuid) DESC, created_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  `;

  const picked = rows[0];
  if (!picked) return null;

  await tx.testData.update({
    where: { id: picked.id },
    data: {
      status: 'RESERVED',
      reservedByUserId: params.publisherId,
      reservedAt: new Date(),
      reservationExpiresAt: new Date(Date.now() + params.ttlMinutes * 60_000),
    },
  });

  return picked;
}

/**
 * Computes when this publisher may next act on this offer.
 * Derived from the last activity rather than stored, so it cannot drift.
 */
async function nextAvailableAt(
  tx: Tx,
  offerId: string,
  publisherId: string,
  type: 'LEAD' | 'DEPOSIT',
  intervalSeconds: number,
): Promise<Date | null> {
  const last =
    type === 'LEAD'
      ? await tx.lead.findFirst({
          where: { offerId, publisherId },
          orderBy: { completedAt: 'desc' },
          select: { completedAt: true },
        })
      : await tx.deposit.findFirst({
          where: { offerId, publisherId },
          orderBy: { depositedAt: 'desc' },
          select: { depositedAt: true },
        });

  if (!last) return null;

  const lastAt = 'completedAt' in last ? last.completedAt : last.depositedAt;
  return new Date(lastAt.getTime() + intervalSeconds * 1000);
}

/** Counts completed activity for the current month, offer-wide and for this publisher. */
async function monthlyCounts(
  tx: Tx,
  offerId: string,
  publisherId: string,
  type: 'LEAD' | 'DEPOSIT',
  now: Date,
): Promise<{ offerTotal: number; publisherTotal: number }> {
  const key = monthKey(now, appTimezone);

  if (type === 'LEAD') {
    const [offerTotal, publisherTotal] = await Promise.all([
      tx.lead.count({ where: { offerId, monthKey: key } }),
      tx.lead.count({ where: { offerId, publisherId, monthKey: key } }),
    ]);
    return { offerTotal, publisherTotal };
  }

  const [offerTotal, publisherTotal] = await Promise.all([
    tx.deposit.count({ where: { offerId, monthKey: key } }),
    tx.deposit.count({ where: { offerId, publisherId, monthKey: key } }),
  ]);
  return { offerTotal, publisherTotal };
}

/**
 * Starts a task: validates eligibility, reserves an identity, opens a session.
 *
 * Everything happens in one transaction holding the (offer, publisher) lock, so
 * the eligibility checks and the reservation cannot be interleaved with another
 * request from the same publisher.
 */
export async function startTask(
  actor: Actor,
  ctx: AuditContext,
  input: StartTaskInput,
): Promise<StartedTask> {
  const now = new Date();
  const ttlMinutes = await getSettingNumber('task_session_ttl_minutes', 30);

  return withTransaction(async (tx) => {
    // One open task at a time. Otherwise a publisher could hold several reserved
    // identities hostage and drain the pool.
    const existing = await tx.taskSession.findFirst({
      where: { publisherId: actor.id, status: 'OPEN', expiresAt: { gt: now } },
      select: { id: true },
    });
    if (existing) throw new AppError('TASK_ALREADY_OPEN');

    // Take the per-pair mutex BEFORE reading any counters.
    const assignment = await lockOfferPublisher(tx, input.offerId, actor.id);
    if (!assignment || !assignment.active) throw new AppError('NOT_ASSIGNED');

    const offer = await tx.offer.findUnique({
      where: { id: input.offerId },
      select: {
        id: true,
        name: true,
        brand: true,
        countryCode: true,
        url: true,
        publisherInstructions: true,
        status: true,
        expiryDate: true,
        ownerUserId: true,
        dataSourcePolicy: true,
        monthlyLeadTarget: true,
        monthlyDepositTarget: true,
        leadIntervalSeconds: true,
        depositIntervalSeconds: true,
      },
    });
    if (!offer) throw new AppError('NOT_FOUND');
    if (offer.status !== 'ACTIVE') throw new AppError('OFFER_NOT_ACTIVE');

    // Expiry is compared against the date, matching the UI's red highlight.
    if (offer.expiryDate < startOfToday(now)) throw new AppError('OFFER_EXPIRED');

    const intervalSeconds =
      input.type === 'LEAD' ? offer.leadIntervalSeconds : offer.depositIntervalSeconds;

    const nextAt = await nextAvailableAt(tx, offer.id, actor.id, input.type, intervalSeconds);
    if (nextAt && nextAt > now) {
      throw new AppError('TIMER_ACTIVE', {
        internal: { nextAvailableAt: nextAt },
        message: `This offer is not available yet. Next available at ${nextAt.toISOString()}.`,
      });
    }

    // Targets are shared across all assigned publishers (decision 3), so the
    // offer-wide count is the gate. A per-publisher cap, when set, is an
    // additional restriction rather than a replacement.
    const counts = await monthlyCounts(tx, offer.id, actor.id, input.type, now);
    const offerTarget =
      input.type === 'LEAD' ? offer.monthlyLeadTarget : offer.monthlyDepositTarget;
    const publisherCap =
      input.type === 'LEAD' ? assignment.monthlyLeadCap : assignment.monthlyDepositCap;

    if (counts.offerTotal >= offerTarget) throw new AppError('TARGET_REACHED');
    if (publisherCap !== null && counts.publisherTotal >= publisherCap) {
      throw new AppError('TARGET_REACHED');
    }

    // Reserve an identity from the permitted pools.
    const ownerIds = consumableOwnerIds(
      offer.ownerUserId,
      offer.dataSourcePolicy,
      await superAdminIds(tx),
    );

    const reserved = await reserveIdentity(tx, {
      countryCode: offer.countryCode,
      ownerIds,
      offerOwnerId: offer.ownerUserId,
      publisherId: actor.id,
      ttlMinutes,
    });
    if (!reserved) throw new AppError('NO_TEST_DATA');

    const identity = await tx.testData.findUniqueOrThrow({
      where: { id: reserved.id },
      select: {
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        address: true,
        city: true,
        state: true,
        postalCode: true,
        dateOfBirth: true,
        extra: true,
      },
    });

    const proxy = await resolveProxyForTask(tx, {
      testDataId: reserved.id,
      publisherId: actor.id,
      offerId: offer.id,
      countryCode: offer.countryCode,
    });

    const session = await tx.taskSession.create({
      data: {
        offerId: offer.id,
        publisherId: actor.id,
        managerId: actor.managerId ?? offer.ownerUserId,
        type: input.type,
        testDataId: reserved.id,
        proxyId: proxy?.id ?? null,
        status: 'OPEN',
        expiresAt: new Date(now.getTime() + ttlMinutes * 60_000),
      },
      select: { id: true, expiresAt: true },
    });

    await writeAudit(tx, ctx, {
      action: 'task.started',
      entityType: 'task_session',
      entityId: session.id,
      metadata: { offerId: offer.id, type: input.type, testDataId: reserved.id },
    });

    return {
      taskSessionId: session.id,
      type: input.type,
      expiresAt: session.expiresAt,
      offer: {
        id: offer.id,
        name: offer.name,
        brand: offer.brand,
        countryCode: offer.countryCode,
        url: offer.url,
        instructions: offer.publisherInstructions,
      },
      identity,
      proxy: proxy
        ? {
            id: proxy.id,
            host: proxy.host,
            port: proxy.port,
            protocol: proxy.protocol,
            username: proxy.username,
          }
        : null,
    };
  });
}

/**
 * Cancels an open task and returns the identity to the pool.
 *
 * The record goes back to AVAILABLE, not USED — an abandoned attempt must not
 * consume a record. Publishers make mistakes and a misclick should cost nothing.
 */
export async function abandonTask(
  actor: Actor,
  ctx: AuditContext,
  taskSessionId: string,
): Promise<void> {
  await withTransaction(async (tx) => {
    const session = await tx.taskSession.findFirst({
      where: { id: taskSessionId, publisherId: actor.id },
      select: { id: true, status: true, testDataId: true },
    });
    if (!session) throw new AppError('NOT_FOUND');
    if (session.status !== 'OPEN') throw new AppError('TASK_NOT_OPEN');

    await tx.taskSession.update({
      where: { id: session.id },
      data: { status: 'ABANDONED', completedAt: new Date() },
    });

    if (session.testDataId) {
      await releaseReservation(tx, session.testDataId);
    }

    await writeAudit(tx, ctx, {
      action: 'task.abandoned',
      entityType: 'task_session',
      entityId: session.id,
      metadata: { testDataId: session.testDataId },
    });
  });
}

/** Returns a reserved record to the pool. Shared by abandon and the sweeper. */
export async function releaseReservation(tx: Tx, testDataId: string): Promise<void> {
  await tx.testData.updateMany({
    // Guarded on RESERVED so a record that has since been consumed is never
    // resurrected by a late-arriving release.
    where: { id: testDataId, status: 'RESERVED' },
    data: {
      status: 'AVAILABLE',
      reservedByUserId: null,
      reservedAt: null,
      reservationExpiresAt: null,
    },
  });
}

/**
 * The offer list a publisher sees, with live timers and progress.
 *
 * Every number here comes from the database. The client renders a countdown from
 * `nextAvailableAt` purely for display; the server re-checks on submit, so a
 * tampered clock buys nothing.
 */
export async function eligibleOffers(actor: Actor) {
  const now = new Date();
  const key = monthKey(now, appTimezone);
  const today = dayRange(now, appTimezone);

  const assignments = await prisma.offerPublisher.findMany({
    where: { publisherId: actor.id, active: true, offer: { status: 'ACTIVE' } },
    select: {
      monthlyLeadCap: true,
      monthlyDepositCap: true,
      offer: {
        select: {
          id: true,
          name: true,
          brand: true,
          countryCode: true,
          expiryDate: true,
          monthlyLeadTarget: true,
          monthlyDepositTarget: true,
          monthlyDepositAmountTarget: true,
          leadIntervalSeconds: true,
          depositIntervalSeconds: true,
        },
      },
    },
  });

  return Promise.all(
    assignments.map(async (a) => {
      const offer = a.offer;

      const [leadsMonth, depositsMonth, leadsToday, depositsToday, lastLead, lastDeposit, amount] =
        await Promise.all([
          prisma.lead.count({ where: { offerId: offer.id, monthKey: key } }),
          prisma.deposit.count({ where: { offerId: offer.id, monthKey: key } }),
          prisma.lead.count({
            where: { offerId: offer.id, publisherId: actor.id, completedAt: { gte: today.start, lt: today.end } },
          }),
          prisma.deposit.count({
            where: { offerId: offer.id, publisherId: actor.id, depositedAt: { gte: today.start, lt: today.end } },
          }),
          prisma.lead.findFirst({
            where: { offerId: offer.id, publisherId: actor.id },
            orderBy: { completedAt: 'desc' },
            select: { completedAt: true },
          }),
          prisma.deposit.findFirst({
            where: { offerId: offer.id, publisherId: actor.id },
            orderBy: { depositedAt: 'desc' },
            select: { depositedAt: true },
          }),
          prisma.deposit.aggregate({
            where: { offerId: offer.id, monthKey: key },
            _sum: { amount: true },
          }),
        ]);

      const leadNextAt = lastLead
        ? new Date(lastLead.completedAt.getTime() + offer.leadIntervalSeconds * 1000)
        : null;
      const depositNextAt = lastDeposit
        ? new Date(lastDeposit.depositedAt.getTime() + offer.depositIntervalSeconds * 1000)
        : null;

      return {
        offerId: offer.id,
        name: offer.name,
        brand: offer.brand,
        countryCode: offer.countryCode,
        expired: offer.expiryDate < startOfToday(now),
        lead: {
          completed: leadsMonth,
          target: offer.monthlyLeadTarget,
          remaining: Math.max(0, offer.monthlyLeadTarget - leadsMonth),
          today: leadsToday,
          nextAvailableAt: leadNextAt && leadNextAt > now ? leadNextAt : null,
          available: leadsMonth < offer.monthlyLeadTarget && !(leadNextAt && leadNextAt > now),
        },
        deposit: {
          completed: depositsMonth,
          target: offer.monthlyDepositTarget,
          remaining: Math.max(0, offer.monthlyDepositTarget - depositsMonth),
          today: depositsToday,
          amountCompleted: amount._sum.amount?.toString() ?? '0',
          amountTarget: offer.monthlyDepositAmountTarget.toString(),
          nextAvailableAt: depositNextAt && depositNextAt > now ? depositNextAt : null,
          available:
            depositsMonth < offer.monthlyDepositTarget && !(depositNextAt && depositNextAt > now),
        },
      };
    }),
  );
}

/** Midnight today in the app timezone, as a UTC instant. */
function startOfToday(now: Date): Date {
  return dayRange(now, appTimezone).start;
}

export { monthRange };
