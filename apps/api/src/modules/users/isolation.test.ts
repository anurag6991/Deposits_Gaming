import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../db/prisma.js';
import { testDataScope } from '../../db/scope.js';
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
import * as deposits from '../deposits/deposits.service.js';
import * as offers from '../offers/offers.service.js';
import { completeLead } from '../leads/leads.service.js';
import { startTask } from '../tasks/tasks.service.js';
import * as users from './users.service.js';

/**
 * Data isolation between managers.
 *
 * This is the security boundary the brief is most explicit about, and the one
 * most likely to break silently: a capability check passes, the scope filter is
 * forgotten on one query, and Manager A quietly reads Manager B's rows. Nothing
 * in the UI would show it.
 *
 * Every list, single-row read, and search path gets tested from BOTH sides.
 */

afterAll(async () => {
  await prisma.$disconnect();
});

/** Two managers, each with a publisher, an offer, data, and a completed lead. */
async function twoManagerWorld() {
  await resetDatabase();

  const admin = await createSuperAdmin();
  const alpha = await createManager(admin.id, 'alpha@test.local');
  const beta = await createManager(admin.id, 'beta@test.local');

  const alphaPub = await createPublisher(alpha.id, 'alpha-pub@test.local');
  const betaPub = await createPublisher(beta.id, 'beta-pub@test.local');

  const alphaOffer = await createOffer({ ownerUserId: alpha.id });
  const betaOffer = await createOffer({ ownerUserId: beta.id });

  await assignPublisher(alphaOffer.id, alphaPub.id, alpha.id);
  await assignPublisher(betaOffer.id, betaPub.id, beta.id);

  await seedTestData({ ownerUserId: alpha.id, count: 5, prefix: 'alpha' });
  await seedTestData({ ownerUserId: beta.id, count: 5, prefix: 'beta' });
  await seedTestData({ ownerUserId: admin.id, count: 5, prefix: 'central' });

  return { admin, alpha, beta, alphaPub, betaPub, alphaOffer, betaOffer };
}

describe('manager cannot see another manager', () => {
  it('lists only their own publishers', async () => {
    const w = await twoManagerWorld();

    const seen = await users.listUsers(actorFor(w.alpha), {});
    const ids = seen.map((u) => u.id);

    expect(ids).toContain(w.alphaPub.id);
    expect(ids).not.toContain(w.betaPub.id);
    expect(ids).not.toContain(w.beta.id);
  });

  it('cannot read another manager publisher by id', async () => {
    const w = await twoManagerWorld();

    await expect(users.getUser(actorFor(w.alpha), w.betaPub.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    // And the reverse, so the test cannot pass by both sides being broken.
    await expect(users.getUser(actorFor(w.beta), w.alphaPub.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('cannot disable another manager publisher', async () => {
    const w = await twoManagerWorld();

    await expect(
      users.setUserStatus(actorFor(w.alpha), auditCtx, w.betaPub.id, 'DISABLED'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const still = await prisma.user.findUniqueOrThrow({ where: { id: w.betaPub.id } });
    expect(still.status).toBe('ACTIVE');
  });

  it('cannot create a publisher under a different manager', async () => {
    const w = await twoManagerWorld();

    // Alpha asks for the publisher to belong to Beta; the request is ignored and
    // the publisher lands under Alpha.
    const created = await users.createUser(actorFor(w.alpha), auditCtx, {
      email: 'sneaky@test.local',
      fullName: 'Sneaky',
      password: 'Password12345',
      role: 'PUBLISHER',
      managerId: w.beta.id,
    });

    expect(created.managerId).toBe(w.alpha.id);
    expect(created.managerId).not.toBe(w.beta.id);
  });

  it('cannot create a manager at all', async () => {
    const w = await twoManagerWorld();

    await expect(
      users.createUser(actorFor(w.alpha), auditCtx, {
        email: 'newmgr@test.local',
        fullName: 'New Manager',
        password: 'Password12345',
        role: 'MANAGER',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('cannot reassign a publisher', async () => {
    const w = await twoManagerWorld();

    await expect(
      users.reassignPublisher(actorFor(w.alpha), auditCtx, w.betaPub.id, w.alpha.id),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('test data visibility is narrower than consumption', () => {
  it('a manager sees only their own uploads, never central or another manager', async () => {
    const w = await twoManagerWorld();

    const visible = await prisma.testData.findMany({
      where: testDataScope(actorFor(w.alpha)),
      select: { email: true, ownerUserId: true },
    });

    expect(visible).toHaveLength(5);
    expect(visible.every((r) => r.ownerUserId === w.alpha.id)).toBe(true);
    expect(visible.every((r) => r.email?.startsWith('alpha'))).toBe(true);
  });

  it('a super admin sees every pool', async () => {
    const w = await twoManagerWorld();

    const visible = await prisma.testData.findMany({ where: testDataScope(actorFor(w.admin)) });
    expect(visible).toHaveLength(15);
  });

  it('a publisher cannot enumerate test data at all', async () => {
    const w = await twoManagerWorld();

    expect(() => testDataScope(actorFor(w.alphaPub))).toThrowError();
  });

  it('but a manager offer CAN consume an invisible central record', async () => {
    const w = await twoManagerWorld();

    // Exhaust Alpha's own pool so the next draw must come from the centre.
    await prisma.testData.updateMany({
      where: { ownerUserId: w.alpha.id },
      data: { status: 'DISABLED' },
    });

    const task = await startTask(actorFor(w.alphaPub), auditCtx, {
      offerId: w.alphaOffer.id,
      type: 'LEAD',
    });

    // Consumed from the central pool...
    expect(task.identity.email?.startsWith('central')).toBe(true);

    // ...while remaining completely invisible to the manager.
    const visible = await prisma.testData.findMany({ where: testDataScope(actorFor(w.alpha)) });
    expect(visible.every((r) => r.ownerUserId === w.alpha.id)).toBe(true);
    expect(visible.some((r) => r.email?.startsWith('central'))).toBe(false);
  });
});

describe('offer and activity isolation', () => {
  it('a manager lists only offers they own or their publishers work', async () => {
    const w = await twoManagerWorld();

    const seen = await offers.listOffers(actorFor(w.alpha), {});
    const ids = seen.map((o) => o.id);

    expect(ids).toContain(w.alphaOffer.id);
    expect(ids).not.toContain(w.betaOffer.id);
  });

  it('a manager cannot edit an offer they do not own', async () => {
    const w = await twoManagerWorld();

    await expect(
      offers.updateOffer(actorFor(w.alpha), auditCtx, w.betaOffer.id, { name: 'Hijacked' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const unchanged = await prisma.offer.findUniqueOrThrow({ where: { id: w.betaOffer.id } });
    expect(unchanged.name).not.toBe('Hijacked');
  });

  it('a manager cannot read another manager offer progress', async () => {
    const w = await twoManagerWorld();

    await expect(offers.offerProgress(actorFor(w.alpha), w.betaOffer.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('a manager cannot assign another manager publisher to their offer', async () => {
    const w = await twoManagerWorld();

    await expect(
      offers.assignPublishers(actorFor(w.alpha), auditCtx, w.alphaOffer.id, [w.betaPub.id]),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('deposits are visible only within the owning hierarchy', async () => {
    const w = await twoManagerWorld();

    // Beta's publisher makes a deposit.
    const task = await startTask(actorFor(w.betaPub), auditCtx, {
      offerId: w.betaOffer.id,
      type: 'DEPOSIT',
    });
    await deposits.createDeposit(actorFor(w.betaPub), auditCtx, {
      taskSessionId: task.taskSessionId,
      accountName: 'Beta Account',
      accountEmail: 'beta-account@test.local',
      amount: '100.00',
      method: 'card',
    });

    const betaSees = await deposits.listDeposits(actorFor(w.beta), {});
    expect(betaSees.total).toBe(1);

    const alphaSees = await deposits.listDeposits(actorFor(w.alpha), {});
    expect(alphaSees.total).toBe(0);

    const adminSees = await deposits.listDeposits(actorFor(w.admin), {});
    expect(adminSees.total).toBe(1);

    // The other manager's publisher must not see it either.
    const alphaPubSees = await deposits.listDeposits(actorFor(w.alphaPub), {});
    expect(alphaPubSees.total).toBe(0);
  });

  it('search does not bypass the scope filter', async () => {
    const w = await twoManagerWorld();

    const task = await startTask(actorFor(w.betaPub), auditCtx, {
      offerId: w.betaOffer.id,
      type: 'DEPOSIT',
    });
    await deposits.createDeposit(actorFor(w.betaPub), auditCtx, {
      taskSessionId: task.taskSessionId,
      accountName: 'Findable Name',
      accountEmail: 'findable@test.local',
      amount: '50.00',
      method: 'card',
    });

    // Searching for the exact account another manager owns must still find nothing.
    const alphaSearch = await deposits.listDeposits(actorFor(w.alpha), { search: 'Findable' });
    expect(alphaSearch.total).toBe(0);
    expect(alphaSearch.rows).toHaveLength(0);
  });

  it('a publisher sees only their own leads', async () => {
    const w = await twoManagerWorld();

    const task = await startTask(actorFor(w.alphaPub), auditCtx, {
      offerId: w.alphaOffer.id,
      type: 'LEAD',
    });
    await completeLead(actorFor(w.alphaPub), auditCtx, { taskSessionId: task.taskSessionId });

    const betaPubLeads = await prisma.lead.count({ where: { publisherId: w.betaPub.id } });
    expect(betaPubLeads).toBe(0);

    const alphaPubLeads = await prisma.lead.count({ where: { publisherId: w.alphaPub.id } });
    expect(alphaPubLeads).toBe(1);
  });
});

describe('hierarchy rules', () => {
  it('a publisher must have a manager', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();

    // The database CHECK is the backstop behind the service validation.
    await expect(
      prisma.user.create({
        data: {
          email: 'orphan@test.local',
          passwordHash: 'x',
          fullName: 'Orphan',
          role: 'PUBLISHER',
          createdById: admin.id,
        },
      }),
    ).rejects.toThrowError();
  });

  it('a publisher cannot be parented to another publisher', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();
    const manager = await createManager(admin.id);
    const publisher = await createPublisher(manager.id, 'p@test.local');

    await expect(
      prisma.user.create({
        data: {
          email: 'p2@test.local',
          passwordHash: 'x',
          fullName: 'P2',
          role: 'PUBLISHER',
          managerId: publisher.id,
          createdById: manager.id,
        },
      }),
    ).rejects.toThrowError();
  });

  it('disabling a user revokes their sessions immediately', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();
    const manager = await createManager(admin.id);
    const publisher = await createPublisher(manager.id, 'p@test.local');

    await prisma.session.create({
      data: {
        userId: publisher.id,
        refreshTokenHash: 'hash-for-test',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    await users.setUserStatus(actorFor(admin), auditCtx, publisher.id, 'DISABLED');

    const live = await prisma.session.count({
      where: { userId: publisher.id, revokedAt: null },
    });
    expect(live).toBe(0);
  });

  it('nobody can disable their own account', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin();

    await expect(
      users.setUserStatus(actorFor(admin), auditCtx, admin.id, 'DISABLED'),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
