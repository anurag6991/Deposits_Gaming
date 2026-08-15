import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../../db/prisma.js';
import { AppError } from '../../lib/errors.js';
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
} from '../../test/fixtures.js';
import { completeLead } from '../leads/leads.service.js';
import { startTask } from './tasks.service.js';

/**
 * The tests this whole system's correctness rests on.
 *
 * Everything here fires genuinely simultaneous requests against a real
 * PostgreSQL server. These cannot pass — or fail — against a mock: the
 * guarantees under test are properties of the database engine, delivered by
 * `FOR UPDATE SKIP LOCKED` and row locking.
 *
 * If any of these start failing, stop and fix the cause. Do not adjust the
 * assertions.
 */

afterAll(async () => {
  await prisma.$disconnect();
});

describe('concurrent test-data assignment', () => {
  it('never hands the same identity to two publishers', async () => {
    await resetDatabase();

    const admin = await createSuperAdmin();
    const manager = await createManager(admin.id);
    const offer = await createOffer({ ownerUserId: admin.id });

    // 20 publishers, 20 identities, everyone starting at once.
    const publishers = await Promise.all(
      Array.from({ length: 20 }, (_, i) => createPublisher(manager.id, `p${i}@test.local`)),
    );
    await Promise.all(publishers.map((p) => assignPublisher(offer.id, p.id, admin.id)));
    await seedTestData({ ownerUserId: admin.id, count: 20 });

    const results = await Promise.all(
      publishers.map((p) =>
        startTask(actorFor(p), auditCtx, { offerId: offer.id, type: 'LEAD' }).catch((e) => e),
      ),
    );

    const started = results.filter((r) => !(r instanceof Error));
    expect(started).toHaveLength(20);

    // The assertion that matters: every publisher got a DIFFERENT identity.
    const emails = started.map((r) => r.identity.email);
    expect(new Set(emails).size).toBe(20);

    const reserved = await prisma.testData.count({ where: { status: 'RESERVED' } });
    expect(reserved).toBe(20);
  });

  it('gives out only as many identities as exist, and refuses the rest cleanly', async () => {
    await resetDatabase();

    const admin = await createSuperAdmin();
    const manager = await createManager(admin.id);
    const offer = await createOffer({ ownerUserId: admin.id });

    // 15 publishers competing for 5 records.
    const publishers = await Promise.all(
      Array.from({ length: 15 }, (_, i) => createPublisher(manager.id, `p${i}@test.local`)),
    );
    await Promise.all(publishers.map((p) => assignPublisher(offer.id, p.id, admin.id)));
    await seedTestData({ ownerUserId: admin.id, count: 5 });

    const results = await Promise.all(
      publishers.map((p) =>
        startTask(actorFor(p), auditCtx, { offerId: offer.id, type: 'LEAD' }).catch((e) => e),
      ),
    );

    const started = results.filter((r) => !(r instanceof Error));
    const failed = results.filter((r) => r instanceof AppError);

    expect(started).toHaveLength(5);
    expect(failed).toHaveLength(10);
    // The 10 losers get a clear business error, not a deadlock or a crash.
    expect(failed.every((e) => (e as AppError).code === 'NO_TEST_DATA')).toBe(true);
    expect(new Set(started.map((r) => r.identity.email)).size).toBe(5);
  });

  it('draws from the offer owner pool before the Super Admin central pool', async () => {
    await resetDatabase();

    const admin = await createSuperAdmin();
    const manager = await createManager(admin.id);
    const publisher = await createPublisher(manager.id, 'p@test.local');

    // Manager owns the offer and has 2 of their own records; the centre has 10.
    const offer = await createOffer({
      ownerUserId: manager.id,
      dataSourcePolicy: 'OWNER_PLUS_SUPER_ADMIN',
    });
    await assignPublisher(offer.id, publisher.id, manager.id);
    await seedTestData({ ownerUserId: manager.id, count: 2, prefix: 'own' });
    await seedTestData({ ownerUserId: admin.id, count: 10, prefix: 'central' });

    // Three sequential tasks: the first two must spend the manager's own records.
    const seen: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const task = await startTask(actorFor(publisher), auditCtx, {
        offerId: offer.id,
        type: 'LEAD',
      });
      seen.push(task.identity.email ?? '');
      await completeLead(actorFor(publisher), auditCtx, { taskSessionId: task.taskSessionId });
    }

    expect(seen[0]?.startsWith('own')).toBe(true);
    expect(seen[1]?.startsWith('own')).toBe(true);
    // Own pool exhausted, so the third falls back to the centre.
    expect(seen[2]?.startsWith('central')).toBe(true);
  });

  it('never crosses country boundaries', async () => {
    await resetDatabase();

    const admin = await createSuperAdmin();
    const manager = await createManager(admin.id);
    const publisher = await createPublisher(manager.id, 'p@test.local');

    const ukOffer = await createOffer({ ownerUserId: admin.id, countryCode: 'GB' });
    await assignPublisher(ukOffer.id, publisher.id, admin.id);

    // Plenty of US data, a single UK record.
    await seedTestData({ ownerUserId: admin.id, countryCode: 'US', count: 50, prefix: 'us' });
    await seedTestData({ ownerUserId: admin.id, countryCode: 'GB', count: 1, prefix: 'gb' });

    const task = await startTask(actorFor(publisher), auditCtx, {
      offerId: ukOffer.id,
      type: 'LEAD',
    });
    expect(task.identity.email?.startsWith('gb')).toBe(true);

    await completeLead(actorFor(publisher), auditCtx, { taskSessionId: task.taskSessionId });

    // UK pool is now empty; the 50 US records must not be substituted.
    await expect(
      startTask(actorFor(publisher), auditCtx, { offerId: ukOffer.id, type: 'LEAD' }),
    ).rejects.toMatchObject({ code: 'NO_TEST_DATA' });
  });

  it('respects OWNER_ONLY by refusing to touch the central pool', async () => {
    await resetDatabase();

    const admin = await createSuperAdmin();
    const manager = await createManager(admin.id);
    const publisher = await createPublisher(manager.id, 'p@test.local');

    const offer = await createOffer({ ownerUserId: manager.id, dataSourcePolicy: 'OWNER_ONLY' });
    await assignPublisher(offer.id, publisher.id, manager.id);
    // Only the centre has data. A sealed offer must still starve.
    await seedTestData({ ownerUserId: admin.id, count: 25, prefix: 'central' });

    await expect(
      startTask(actorFor(publisher), auditCtx, { offerId: offer.id, type: 'LEAD' }),
    ).rejects.toMatchObject({ code: 'NO_TEST_DATA' });
  });
});

describe('concurrent target enforcement', () => {
  it('cannot be pushed past the monthly target by simultaneous completions', async () => {
    await resetDatabase();

    const admin = await createSuperAdmin();
    const manager = await createManager(admin.id);

    // Target of 5. Ten publishers each hold an open task and submit at once.
    const offer = await createOffer({ ownerUserId: admin.id, monthlyLeadTarget: 5 });
    const publishers = await Promise.all(
      Array.from({ length: 10 }, (_, i) => createPublisher(manager.id, `p${i}@test.local`)),
    );
    await Promise.all(publishers.map((p) => assignPublisher(offer.id, p.id, admin.id)));
    await seedTestData({ ownerUserId: admin.id, count: 10 });

    // Start sequentially so all ten hold a reserved identity before any submits.
    const tasks = [];
    for (const p of publishers) {
      tasks.push({
        publisher: p,
        task: await startTask(actorFor(p), auditCtx, { offerId: offer.id, type: 'LEAD' }),
      });
    }

    // Now everyone submits simultaneously.
    const results = await Promise.all(
      tasks.map(({ publisher, task }) =>
        completeLead(actorFor(publisher), auditCtx, { taskSessionId: task.taskSessionId }).catch(
          (e) => e,
        ),
      ),
    );

    const succeeded = results.filter((r) => !(r instanceof Error));
    const rejected = results.filter((r) => r instanceof AppError);

    // Exactly the target, never more. This is the check-then-act race.
    expect(succeeded).toHaveLength(5);
    expect(rejected).toHaveLength(5);
    expect(rejected.every((e) => (e as AppError).code === 'TARGET_REACHED')).toBe(true);

    expect(await prisma.lead.count({ where: { offerId: offer.id } })).toBe(5);
  });

  it('an identity can never produce two leads', async () => {
    await resetDatabase();

    const admin = await createSuperAdmin();
    const manager = await createManager(admin.id);
    const publisher = await createPublisher(manager.id, 'p@test.local');
    const offer = await createOffer({ ownerUserId: admin.id });

    await assignPublisher(offer.id, publisher.id, admin.id);
    await seedTestData({ ownerUserId: admin.id, count: 1 });

    const task = await startTask(actorFor(publisher), auditCtx, {
      offerId: offer.id,
      type: 'LEAD',
    });

    // Submitting the same session twice, at the same time.
    const [a, b] = await Promise.all([
      completeLead(actorFor(publisher), auditCtx, { taskSessionId: task.taskSessionId }).catch(
        (e) => e,
      ),
      completeLead(actorFor(publisher), auditCtx, { taskSessionId: task.taskSessionId }).catch(
        (e) => e,
      ),
    ]);

    const ok = [a, b].filter((r) => !(r instanceof Error));
    expect(ok).toHaveLength(1);
    expect(await prisma.lead.count()).toBe(1);
  });
});

describe('per-publisher timers', () => {
  it('blocks the same publisher but not a colleague', async () => {
    await resetDatabase();

    const admin = await createSuperAdmin();
    const manager = await createManager(admin.id);
    const alice = await createPublisher(manager.id, 'alice@test.local');
    const bob = await createPublisher(manager.id, 'bob@test.local');

    const offer = await createOffer({ ownerUserId: admin.id, leadIntervalSeconds: 300 });
    await assignPublisher(offer.id, alice.id, admin.id);
    await assignPublisher(offer.id, bob.id, admin.id);
    await seedTestData({ ownerUserId: admin.id, count: 10 });

    const first = await startTask(actorFor(alice), auditCtx, {
      offerId: offer.id,
      type: 'LEAD',
    });
    await completeLead(actorFor(alice), auditCtx, { taskSessionId: first.taskSessionId });

    // Alice is now inside her five-minute gap.
    await expect(
      startTask(actorFor(alice), auditCtx, { offerId: offer.id, type: 'LEAD' }),
    ).rejects.toMatchObject({ code: 'TIMER_ACTIVE' });

    // Bob is unaffected — the timer is per publisher, not global.
    const bobTask = await startTask(actorFor(bob), auditCtx, {
      offerId: offer.id,
      type: 'LEAD',
    });
    expect(bobTask.taskSessionId).toBeTruthy();
  });

  it('allows a second offer while the first is on cooldown', async () => {
    await resetDatabase();

    const admin = await createSuperAdmin();
    const manager = await createManager(admin.id);
    const publisher = await createPublisher(manager.id, 'p@test.local');

    const offerA = await createOffer({ ownerUserId: admin.id, leadIntervalSeconds: 300 });
    const offerB = await createOffer({ ownerUserId: admin.id, leadIntervalSeconds: 300 });
    await assignPublisher(offerA.id, publisher.id, admin.id);
    await assignPublisher(offerB.id, publisher.id, admin.id);
    await seedTestData({ ownerUserId: admin.id, count: 10 });

    const a = await startTask(actorFor(publisher), auditCtx, {
      offerId: offerA.id,
      type: 'LEAD',
    });
    await completeLead(actorFor(publisher), auditCtx, { taskSessionId: a.taskSessionId });

    await expect(
      startTask(actorFor(publisher), auditCtx, { offerId: offerA.id, type: 'LEAD' }),
    ).rejects.toMatchObject({ code: 'TIMER_ACTIVE' });

    // Offer B has its own timer, so work continues there.
    const b = await startTask(actorFor(publisher), auditCtx, {
      offerId: offerB.id,
      type: 'LEAD',
    });
    expect(b.offer.id).toBe(offerB.id);
  });

  it('holds only one open task at a time per publisher', async () => {
    await resetDatabase();

    const admin = await createSuperAdmin();
    const manager = await createManager(admin.id);
    const publisher = await createPublisher(manager.id, 'p@test.local');

    const offerA = await createOffer({ ownerUserId: admin.id });
    const offerB = await createOffer({ ownerUserId: admin.id });
    await assignPublisher(offerA.id, publisher.id, admin.id);
    await assignPublisher(offerB.id, publisher.id, admin.id);
    await seedTestData({ ownerUserId: admin.id, count: 10 });

    await startTask(actorFor(publisher), auditCtx, { offerId: offerA.id, type: 'LEAD' });

    // Otherwise a publisher could hoard reserved identities and drain the pool.
    await expect(
      startTask(actorFor(publisher), auditCtx, { offerId: offerB.id, type: 'LEAD' }),
    ).rejects.toMatchObject({ code: 'TASK_ALREADY_OPEN' });

    expect(await prisma.testData.count({ where: { status: 'RESERVED' } })).toBe(1);
  });
});

describe('assignment and eligibility', () => {
  it('refuses a publisher who is not assigned to the offer', async () => {
    await resetDatabase();

    const admin = await createSuperAdmin();
    const manager = await createManager(admin.id);
    const outsider = await createPublisher(manager.id, 'outsider@test.local');
    const offer = await createOffer({ ownerUserId: admin.id });
    await seedTestData({ ownerUserId: admin.id, count: 5 });

    await expect(
      startTask(actorFor(outsider), auditCtx, { offerId: offer.id, type: 'LEAD' }),
    ).rejects.toMatchObject({ code: 'NOT_ASSIGNED' });
  });

  it('returns the identity to the pool when a task is abandoned', async () => {
    await resetDatabase();

    const admin = await createSuperAdmin();
    const manager = await createManager(admin.id);
    const publisher = await createPublisher(manager.id, 'p@test.local');
    const offer = await createOffer({ ownerUserId: admin.id });
    await assignPublisher(offer.id, publisher.id, admin.id);
    await seedTestData({ ownerUserId: admin.id, count: 1 });

    const task = await startTask(actorFor(publisher), auditCtx, {
      offerId: offer.id,
      type: 'LEAD',
    });
    expect(await prisma.testData.count({ where: { status: 'AVAILABLE' } })).toBe(0);

    const { abandonTask } = await import('./tasks.service.js');
    await abandonTask(actorFor(publisher), auditCtx, task.taskSessionId);

    // AVAILABLE, not USED — a misclick must not consume a record.
    expect(await prisma.testData.count({ where: { status: 'AVAILABLE' } })).toBe(1);
    expect(await prisma.testData.count({ where: { status: 'USED' } })).toBe(0);
  });
});
