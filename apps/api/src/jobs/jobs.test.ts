import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../db/prisma.js';
import {
  actorFor,
  assignPublisher,
  auditCtx,
  createManager,
  createOffer,
  createPublisher,
  createSuperAdmin,
  resetDatabase,
  seedTestData,
} from '../test/fixtures.js';
import { startTask } from '../modules/tasks/tasks.service.js';
import {
  markExpiredOffers,
  notifyExpiringOffers,
  notifyOverdueGameplay,
  purgeExpiredSessions,
  sweepExpiredReservations,
} from './index.js';

/**
 * Background jobs.
 *
 * Each is tested for idempotency as well as effect. The worker runs as a single
 * process so they should not double-fire, but a restart mid-run or a future
 * scaling mistake should not corrupt anything — so running twice must be safe.
 */

afterAll(async () => {
  await prisma.$disconnect();
});

async function world() {
  await resetDatabase();
  const admin = await createSuperAdmin();
  const manager = await createManager(admin.id);
  const publisher = await createPublisher(manager.id, 'p@test.local');
  const offer = await createOffer({ ownerUserId: admin.id });
  await assignPublisher(offer.id, publisher.id, admin.id);
  await seedTestData({ ownerUserId: admin.id, count: 5 });
  return { admin, manager, publisher, offer };
}

describe('reservation sweeper', () => {
  it('returns an abandoned identity to the pool', async () => {
    const w = await world();

    const task = await startTask(actorFor(w.publisher), auditCtx, {
      offerId: w.offer.id,
      type: 'LEAD',
    });

    expect(await prisma.testData.count({ where: { status: 'AVAILABLE' } })).toBe(4);

    // Nothing expired yet, so the sweeper must leave it alone.
    expect((await sweepExpiredReservations()).released).toBe(0);
    expect(await prisma.testData.count({ where: { status: 'RESERVED' } })).toBe(1);

    // Simulate the publisher walking away.
    await prisma.taskSession.update({
      where: { id: task.taskSessionId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    const result = await sweepExpiredReservations();
    expect(result.released).toBe(1);
    expect(result.sessions).toBe(1);

    // AVAILABLE, not USED — an abandoned attempt costs nothing.
    expect(await prisma.testData.count({ where: { status: 'AVAILABLE' } })).toBe(5);
    expect(await prisma.testData.count({ where: { status: 'USED' } })).toBe(0);

    const session = await prisma.taskSession.findUniqueOrThrow({
      where: { id: task.taskSessionId },
    });
    expect(session.status).toBe('EXPIRED');
  });

  it('frees the publisher to start again', async () => {
    const w = await world();

    const first = await startTask(actorFor(w.publisher), auditCtx, {
      offerId: w.offer.id,
      type: 'LEAD',
    });

    // While the stale task is open, a new one is refused.
    await expect(
      startTask(actorFor(w.publisher), auditCtx, { offerId: w.offer.id, type: 'LEAD' }),
    ).rejects.toMatchObject({ code: 'TASK_ALREADY_OPEN' });

    await prisma.taskSession.update({
      where: { id: first.taskSessionId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await sweepExpiredReservations();

    const second = await startTask(actorFor(w.publisher), auditCtx, {
      offerId: w.offer.id,
      type: 'LEAD',
    });
    expect(second.taskSessionId).toBeTruthy();
  });

  it('never resurrects a record that was consumed in the meantime', async () => {
    const w = await world();

    const task = await startTask(actorFor(w.publisher), auditCtx, {
      offerId: w.offer.id,
      type: 'LEAD',
    });

    const { completeLead } = await import('../modules/leads/leads.service.js');
    await completeLead(actorFor(w.publisher), auditCtx, { taskSessionId: task.taskSessionId });

    // A stale sweep arriving after completion must not put a USED record back.
    await prisma.taskSession.updateMany({
      where: { id: task.taskSessionId },
      data: { status: 'OPEN', expiresAt: new Date(Date.now() - 60_000) },
    });

    await sweepExpiredReservations();

    expect(await prisma.testData.count({ where: { status: 'USED' } })).toBe(1);
    expect(await prisma.testData.count({ where: { status: 'AVAILABLE' } })).toBe(4);
  });

  it('is safe to run twice', async () => {
    const w = await world();
    const task = await startTask(actorFor(w.publisher), auditCtx, {
      offerId: w.offer.id,
      type: 'LEAD',
    });
    await prisma.taskSession.update({
      where: { id: task.taskSessionId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });

    await sweepExpiredReservations();
    const second = await sweepExpiredReservations();

    expect(second.released).toBe(0);
    expect(await prisma.testData.count({ where: { status: 'AVAILABLE' } })).toBe(5);
  });
});

describe('offer expiry', () => {
  it('marks a past-dated offer expired without deleting it', async () => {
    const w = await world();

    await prisma.offer.update({
      where: { id: w.offer.id },
      data: { expiryDate: new Date(Date.now() - 86_400_000) },
    });

    expect(await markExpiredOffers()).toBe(1);

    const offer = await prisma.offer.findUniqueOrThrow({ where: { id: w.offer.id } });
    expect(offer.status).toBe('EXPIRED');

    // History survives; only the status moved.
    expect(await prisma.offer.count()).toBe(1);
  });

  it('leaves a current offer alone and does not re-mark an expired one', async () => {
    const w = await world();

    expect(await markExpiredOffers()).toBe(0);

    await prisma.offer.update({
      where: { id: w.offer.id },
      data: { expiryDate: new Date(Date.now() - 86_400_000) },
    });
    await markExpiredOffers();
    expect(await markExpiredOffers()).toBe(0);
  });

  it('an expired offer refuses new work', async () => {
    const w = await world();

    await prisma.offer.update({
      where: { id: w.offer.id },
      data: { expiryDate: new Date(Date.now() - 86_400_000) },
    });
    await markExpiredOffers();

    await expect(
      startTask(actorFor(w.publisher), auditCtx, { offerId: w.offer.id, type: 'LEAD' }),
    ).rejects.toMatchObject({ code: 'OFFER_NOT_ACTIVE' });
  });
});

describe('notifications', () => {
  it('notifies both the publisher and their manager about overdue gameplay', async () => {
    const w = await world();

    const task = await startTask(actorFor(w.publisher), auditCtx, {
      offerId: w.offer.id,
      type: 'DEPOSIT',
    });
    const { createDeposit } = await import('../modules/deposits/deposits.service.js');
    const { depositId } = await createDeposit(actorFor(w.publisher), auditCtx, {
      taskSessionId: task.taskSessionId,
      accountName: 'A',
      accountEmail: 'a@test.local',
      amount: '100',
      method: 'card',
    });

    await prisma.deposit.update({
      where: { id: depositId },
      data: { nextGameplayDueAt: new Date(Date.now() - 86_400_000) },
    });

    const created = await notifyOverdueGameplay();
    expect(created).toBe(2);

    expect(await prisma.notification.count({ where: { userId: w.publisher.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: w.manager.id } })).toBe(1);
  });

  it('does not duplicate the same alert within a day', async () => {
    const w = await world();

    const task = await startTask(actorFor(w.publisher), auditCtx, {
      offerId: w.offer.id,
      type: 'DEPOSIT',
    });
    const { createDeposit } = await import('../modules/deposits/deposits.service.js');
    const { depositId } = await createDeposit(actorFor(w.publisher), auditCtx, {
      taskSessionId: task.taskSessionId,
      accountName: 'A',
      accountEmail: 'a@test.local',
      amount: '100',
      method: 'card',
    });
    await prisma.deposit.update({
      where: { id: depositId },
      data: { nextGameplayDueAt: new Date(Date.now() - 86_400_000) },
    });

    await notifyOverdueGameplay();
    // An hourly job would otherwise bury the user in 24 identical rows a day.
    expect(await notifyOverdueGameplay()).toBe(0);
    expect(await prisma.notification.count()).toBe(2);
  });

  it('warns the owner about an offer nearing expiry', async () => {
    const w = await world();

    await prisma.offer.update({
      where: { id: w.offer.id },
      data: { expiryDate: new Date(Date.now() + 7 * 86_400_000) },
    });

    expect(await notifyExpiringOffers()).toBe(1);

    const notification = await prisma.notification.findFirstOrThrow({
      where: { type: 'OFFER_EXPIRING' },
    });
    expect(notification.userId).toBe(w.admin.id);

    // Deduped, like the gameplay alert.
    expect(await notifyExpiringOffers()).toBe(0);
  });

  it('does not warn about an offer far from expiry', async () => {
    const w = await world();
    await prisma.offer.update({
      where: { id: w.offer.id },
      data: { expiryDate: new Date(Date.now() + 120 * 86_400_000) },
    });

    expect(await notifyExpiringOffers()).toBe(0);
  });
});

describe('session purge', () => {
  it('removes long-expired sessions and keeps live ones', async () => {
    const w = await world();

    await prisma.session.createMany({
      data: [
        {
          userId: w.publisher.id,
          refreshTokenHash: 'old-hash',
          expiresAt: new Date(Date.now() - 60 * 86_400_000),
        },
        {
          userId: w.publisher.id,
          refreshTokenHash: 'live-hash',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      ],
    });

    expect(await purgeExpiredSessions()).toBe(1);

    const remaining = await prisma.session.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.refreshTokenHash).toBe('live-hash');
  });
});
