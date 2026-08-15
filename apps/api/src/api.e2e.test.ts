import { afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { prisma } from './db/prisma.js';
import { hashPassword } from './lib/crypto.js';
import {
  assignPublisher,
  createManager,
  createOffer,
  createPublisher,
  createSuperAdmin,
  resetDatabase,
  seedTestData,
} from './test/fixtures.js';

/**
 * End-to-end tests over real HTTP.
 *
 * The service tests call functions directly, which skips everything in front of
 * them: authentication, the capability middleware, Zod validation, the error
 * envelope, and the route wiring itself. A route mounted with the wrong
 * permission, or a service never reachable at all, passes every service test and
 * fails here.
 */

const app = createApp();

afterAll(async () => {
  await prisma.$disconnect();
});

const PASSWORD = 'TestPassword123';

async function withPassword(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(PASSWORD), mustChangePassword: false },
  });
}

async function login(email: string) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return { token: res.body?.data?.accessToken as string, res };
}

async function world() {
  await resetDatabase();

  const admin = await createSuperAdmin('admin@e2e.local');
  const manager = await createManager(admin.id, 'manager@e2e.local');
  const publisher = await createPublisher(manager.id, 'publisher@e2e.local');

  await Promise.all([withPassword(admin.id), withPassword(manager.id), withPassword(publisher.id)]);

  const offer = await createOffer({ ownerUserId: admin.id });
  await assignPublisher(offer.id, publisher.id, admin.id);
  await seedTestData({ ownerUserId: admin.id, count: 10 });

  return { admin, manager, publisher, offer };
}

describe('authentication', () => {
  it('rejects an unauthenticated request', async () => {
    await world();
    const res = await request(app).get('/api/v1/offers');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  it('logs in and returns a usable token', async () => {
    await world();
    const { token, res } = await login('admin@e2e.local');

    expect(res.status).toBe(200);
    expect(token).toBeTruthy();
    expect(res.body.data.user.role).toBe('SUPER_ADMIN');

    const offers = await request(app).get('/api/v1/offers').set('Authorization', `Bearer ${token}`);
    expect(offers.status).toBe(200);
  });

  it('never reveals whether an email exists', async () => {
    await world();

    const unknown = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@e2e.local', password: PASSWORD });
    const wrongPassword = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@e2e.local', password: 'WrongPassword123' });

    expect(unknown.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    // Identical responses, so the two cases cannot be told apart.
    expect(unknown.body.code).toBe(wrongPassword.body.code);
    expect(unknown.body.message).toBe(wrongPassword.body.message);
  });

  it('locks an account after repeated failures', async () => {
    await world();

    for (let i = 0; i < 5; i += 1) {
      await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'publisher@e2e.local', password: 'WrongPassword123' });
    }

    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'publisher@e2e.local', password: PASSWORD });

    // Even the correct password is refused while locked.
    expect(res.body.code).toBe('ACCOUNT_LOCKED');
  });

  it('rejects a token once the account is disabled', async () => {
    const w = await world();
    const { token } = await login('publisher@e2e.local');

    expect(
      (await request(app).get('/api/v1/reports/dashboard').set('Authorization', `Bearer ${token}`))
        .status,
    ).toBe(200);

    await prisma.user.update({ where: { id: w.publisher.id }, data: { status: 'DISABLED' } });

    // The token is still cryptographically valid; the request must fail anyway.
    const after = await request(app)
      .get('/api/v1/reports/dashboard')
      .set('Authorization', `Bearer ${token}`);

    expect(after.status).toBe(403);
    expect(after.body.code).toBe('ACCOUNT_DISABLED');
  });

  it('forces a password change before anything else', async () => {
    await resetDatabase();
    const admin = await createSuperAdmin('admin@e2e.local');
    await prisma.user.update({
      where: { id: admin.id },
      data: { passwordHash: await hashPassword(PASSWORD), mustChangePassword: true },
    });

    const { token } = await login('admin@e2e.local');

    const blocked = await request(app).get('/api/v1/offers').set('Authorization', `Bearer ${token}`);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');

    // /auth/me stays reachable so the UI can render who is logged in.
    const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
  });
});

describe('authorization over HTTP', () => {
  it('a publisher cannot create an offer', async () => {
    await world();
    const { token } = await login('publisher@e2e.local');

    const res = await request(app)
      .post('/api/v1/offers')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: 'Sneaky',
        brand: 'B',
        countryCode: 'US',
        url: 'https://example.com',
        monthlyLeadTarget: 10,
        monthlyDepositTarget: 5,
        monthlyDepositAmountTarget: '1000',
        leadIntervalSeconds: 0,
        depositIntervalSeconds: 0,
        gameplayIntervalDays: 3,
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(await prisma.offer.count({ where: { name: 'Sneaky' } })).toBe(0);
  });

  it('a manager cannot create another manager', async () => {
    await world();
    const { token } = await login('manager@e2e.local');

    const res = await request(app)
      .post('/api/v1/users')
      .set('Authorization', `Bearer ${token}`)
      .send({
        email: 'newmanager@e2e.local',
        fullName: 'New Manager',
        password: 'AnotherPassword123',
        role: 'MANAGER',
      });

    expect(res.status).toBe(403);
  });

  it('a publisher cannot list test data', async () => {
    await world();
    const { token } = await login('publisher@e2e.local');

    const res = await request(app).get('/api/v1/test-data').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('a manager cannot read audit logs beyond their own actions', async () => {
    await world();
    const { token } = await login('manager@e2e.local');

    const res = await request(app).get('/api/v1/audit-logs').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);

    const actorIds = (res.body.data.rows as Array<{ actorUserId: string | null }>).map(
      (r) => r.actorUserId,
    );
    const manager = await prisma.user.findUniqueOrThrow({ where: { email: 'manager@e2e.local' } });
    expect(actorIds.every((id) => id === manager.id)).toBe(true);
  });

  it('only a super admin can change settings', async () => {
    await world();

    const managerToken = (await login('manager@e2e.local')).token;
    const denied = await request(app)
      .patch('/api/v1/settings')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ key: 'reservation_ttl_minutes', value: 5 });
    expect(denied.status).toBe(403);

    const adminToken = (await login('admin@e2e.local')).token;
    const allowed = await request(app)
      .patch('/api/v1/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ key: 'reservation_ttl_minutes', value: 5 });
    expect(allowed.status).toBe(200);
  });
});

describe('validation over HTTP', () => {
  it('returns field-level errors', async () => {
    await world();
    const { token } = await login('admin@e2e.local');

    const res = await request(app)
      .post('/api/v1/offers')
      .set('Authorization', `Bearer ${token}`)
      .send({
        name: '',
        brand: 'B',
        countryCode: 'USA',
        url: 'not-a-url',
        monthlyLeadTarget: -5,
        monthlyDepositTarget: 5,
        monthlyDepositAmountTarget: 'abc',
        leadIntervalSeconds: 0,
        depositIntervalSeconds: 0,
        gameplayIntervalDays: 0,
      });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.body.fields).length).toBeGreaterThan(3);
    expect(res.body.fields).toHaveProperty('url');
  });

  it('does not reveal which routes exist to an unauthenticated caller', async () => {
    // Authentication runs before route matching under /api/v1, so an unknown
    // path is refused as 401 rather than 404. That is deliberate: a 404 here
    // would let anyone map the API surface without credentials.
    const res = await request(app).get('/api/v1/nonexistent');
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('returns 404 in the standard envelope for an authenticated caller', async () => {
    await world();
    const { token } = await login('admin@e2e.local');

    const res = await request(app)
      .get('/api/v1/nonexistent')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('never leaks internals in an error body', async () => {
    await world();
    const { token } = await login('admin@e2e.local');

    const res = await request(app)
      .get('/api/v1/offers/00000000-0000-0000-0000-000000000000/progress')
      .set('Authorization', `Bearer ${token}`);

    const body = JSON.stringify(res.body).toLowerCase();
    expect(body).not.toContain('prisma');
    expect(body).not.toContain('select');
    expect(body).not.toContain('stack');
  });
});

describe('a full working day', () => {
  it('creates an offer, assigns a publisher, and runs a lead and a deposit', async () => {
    const w = await world();
    const adminToken = (await login('admin@e2e.local')).token;
    const pubToken = (await login('publisher@e2e.local')).token;

    // Admin creates and activates an offer.
    const created = await request(app)
      .post('/api/v1/offers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        name: 'E2E Casino',
        brand: 'E2EBrand',
        countryCode: 'US',
        url: 'https://example.com/offer',
        monthlyLeadTarget: 10,
        monthlyDepositTarget: 5,
        monthlyDepositAmountTarget: '5000',
        leadIntervalSeconds: 0,
        depositIntervalSeconds: 0,
        gameplayIntervalDays: 3,
        status: 'ACTIVE',
      });
    expect(created.status).toBe(201);
    const offerId = created.body.data.id as string;

    // Admin assigns the publisher.
    const assigned = await request(app)
      .post(`/api/v1/offers/${offerId}/publishers`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ publisherIds: [w.publisher.id] });
    expect(assigned.status).toBe(200);

    // Publisher sees it in their dropdown.
    const eligible = await request(app)
      .get('/api/v1/tasks/eligible-offers')
      .set('Authorization', `Bearer ${pubToken}`);
    expect(eligible.status).toBe(200);
    expect((eligible.body.data as Array<{ offerId: string }>).some((o) => o.offerId === offerId)).toBe(
      true,
    );

    // Publisher starts a lead and receives an identity.
    const leadTask = await request(app)
      .post('/api/v1/tasks/start')
      .set('Authorization', `Bearer ${pubToken}`)
      .send({ offerId, type: 'LEAD' });
    expect(leadTask.status).toBe(201);
    expect(leadTask.body.data.identity.firstName).toBeTruthy();
    expect(leadTask.body.data.offer.url).toBe('https://example.com/offer');

    const completed = await request(app)
      .post(`/api/v1/tasks/${leadTask.body.data.taskSessionId}/complete-lead`)
      .set('Authorization', `Bearer ${pubToken}`)
      .send({});
    expect(completed.status).toBe(201);

    // Publisher does a deposit.
    const depositTask = await request(app)
      .post('/api/v1/tasks/start')
      .set('Authorization', `Bearer ${pubToken}`)
      .send({ offerId, type: 'DEPOSIT' });
    expect(depositTask.status).toBe(201);

    const deposit = await request(app)
      .post('/api/v1/deposits')
      .set('Authorization', `Bearer ${pubToken}`)
      .send({
        taskSessionId: depositTask.body.data.taskSessionId,
        accountName: 'E2E Account',
        accountEmail: 'e2e-account@example.com',
        accountSecret: 'account-password',
        amount: '250.00',
        method: 'card',
      });
    expect(deposit.status).toBe(201);
    const depositId = deposit.body.data.depositId as string;

    // Progress reflects both, computed server-side.
    const progress = await request(app)
      .get(`/api/v1/offers/${offerId}/progress`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(progress.body.data.leads.completed).toBe(1);
    expect(progress.body.data.deposits.completed).toBe(1);
    expect(progress.body.data.depositAmount.completed).toBe('250');
    expect(progress.body.data.depositAmount.remaining).toBe('4750');

    // Balance update, then a withdrawal.
    const balance = await request(app)
      .post(`/api/v1/deposits/${depositId}/balance`)
      .set('Authorization', `Bearer ${pubToken}`)
      .send({ newBalance: '300.00' });
    expect(balance.body.data.balanceAfter).toBe('300');

    const withdrawal = await request(app)
      .post(`/api/v1/deposits/${depositId}/withdrawals`)
      .set('Authorization', `Bearer ${pubToken}`)
      .send({ amount: '120.00', method: 'bank' });
    expect(withdrawal.status).toBe(201);
    expect(withdrawal.body.data.balanceAfter).toBe('180');

    // Gameplay confirmation.
    const gameplay = await request(app)
      .post(`/api/v1/deposits/${depositId}/gameplay`)
      .set('Authorization', `Bearer ${pubToken}`);
    expect(gameplay.status).toBe(200);

    // The deposits list shows it, with the secret absent.
    const list = await request(app)
      .get('/api/v1/deposits')
      .set('Authorization', `Bearer ${pubToken}`);
    expect(list.body.data.total).toBe(1);
    expect(JSON.stringify(list.body)).not.toContain('account-password');

    // Dashboard agrees with everything above.
    const dashboard = await request(app)
      .get('/api/v1/reports/dashboard')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(dashboard.body.data.leads.month).toBe(1);
    expect(dashboard.body.data.deposits.month).toBe(1);
    expect(dashboard.body.data.overdueGameplay).toBe(0);
  });

  it('records an advance visible to the publisher', async () => {
    const w = await world();
    const managerToken = (await login('manager@e2e.local')).token;
    const pubToken = (await login('publisher@e2e.local')).token;

    const created = await request(app)
      .post('/api/v1/advances')
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ publisherId: w.publisher.id, amount: '500.00', notes: 'August advance' });
    expect(created.status).toBe(201);

    const seen = await request(app)
      .get('/api/v1/advances')
      .set('Authorization', `Bearer ${pubToken}`);
    expect(seen.body.data.rows).toHaveLength(1);
    expect(seen.body.data.total).toBe('500');

    // A publisher may read their advance but not create one.
    const denied = await request(app)
      .post('/api/v1/advances')
      .set('Authorization', `Bearer ${pubToken}`)
      .send({ publisherId: w.publisher.id, amount: '1000.00' });
    expect(denied.status).toBe(403);
  });
});
