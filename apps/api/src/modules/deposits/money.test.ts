import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../db/prisma.js';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';
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
import { startTask } from '../tasks/tasks.service.js';
import * as deposits from './deposits.service.js';

/**
 * Money and gameplay.
 *
 * Money bugs are silent — nothing crashes, the number is simply wrong, and
 * nobody notices until a reconciliation months later. So these tests assert on
 * exact decimal strings rather than approximate equality, and check the ledger
 * as well as the cached balance.
 */

afterAll(async () => {
  await prisma.$disconnect();
});

async function world(opts: { gameplayIntervalDays?: number } = {}) {
  await resetDatabase();

  const admin = await createSuperAdmin();
  const manager = await createManager(admin.id);
  const publisher = await createPublisher(manager.id, 'p@test.local');
  const offer = await createOffer({
    ownerUserId: admin.id,
    gameplayIntervalDays: opts.gameplayIntervalDays ?? 3,
  });

  await assignPublisher(offer.id, publisher.id, admin.id);
  await seedTestData({ ownerUserId: admin.id, count: 30 });

  return { admin, manager, publisher, offer };
}

async function makeDeposit(
  w: Awaited<ReturnType<typeof world>>,
  amount: string,
  extras: Partial<{ accountSecret: string }> = {},
) {
  const task = await startTask(actorFor(w.publisher), auditCtx, {
    offerId: w.offer.id,
    type: 'DEPOSIT',
  });

  return deposits.createDeposit(actorFor(w.publisher), auditCtx, {
    taskSessionId: task.taskSessionId,
    accountName: 'Test Account',
    accountEmail: 'account@test.local',
    amount,
    method: 'card',
    ...extras,
  });
}

describe('deposit creation', () => {
  it('opens the ledger with the deposit amount', async () => {
    const w = await world();
    const { depositId } = await makeDeposit(w, '250.50');

    const deposit = await prisma.deposit.findUniqueOrThrow({ where: { id: depositId } });
    expect(deposit.amount.toString()).toBe('250.5');
    expect(deposit.currentBalance.toString()).toBe('250.5');

    const entries = await prisma.balanceEntry.findMany({ where: { depositId } });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe('OPENING');
    expect(entries[0]?.balanceBefore.toString()).toBe('0');
    expect(entries[0]?.balanceAfter.toString()).toBe('250.5');
  });

  it('rejects a zero or negative amount without burning the task', async () => {
    const w = await world();

    const task = await startTask(actorFor(w.publisher), auditCtx, {
      offerId: w.offer.id,
      type: 'DEPOSIT',
    });

    const submit = (amount: string) =>
      deposits.createDeposit(actorFor(w.publisher), auditCtx, {
        taskSessionId: task.taskSessionId,
        accountName: 'Test Account',
        accountEmail: 'account@test.local',
        amount,
        method: 'card',
      });

    await expect(submit('0')).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });
    await expect(submit('-10')).rejects.toMatchObject({ code: 'INVALID_AMOUNT' });

    // A typo must not cost the publisher their reserved identity: the session
    // stays open and the same identity is still theirs to submit against.
    const session = await prisma.taskSession.findUniqueOrThrow({
      where: { id: task.taskSessionId },
    });
    expect(session.status).toBe('OPEN');

    const { depositId } = await submit('42.00');
    const deposit = await prisma.deposit.findUniqueOrThrow({ where: { id: depositId } });
    expect(deposit.amount.toString()).toBe('42');
    expect(deposit.testDataId).toBe(session.testDataId);
  });

  it('keeps exact decimal precision, not floating point', async () => {
    const w = await world();

    // 0.1 + 0.2 is the canonical float trap. With Decimal this stays exact.
    const { depositId } = await makeDeposit(w, '0.10');
    await deposits.updateBalance(actorFor(w.publisher), auditCtx, depositId, {
      newBalance: '0.30',
    });

    const deposit = await prisma.deposit.findUniqueOrThrow({ where: { id: depositId } });
    expect(deposit.currentBalance.toString()).toBe('0.3');

    const entry = await prisma.balanceEntry.findFirst({
      where: { depositId, type: 'ADJUSTMENT' },
    });
    // 0.30 - 0.10 must be exactly 0.2, never 0.19999999999999998.
    expect(entry?.amount.toString()).toBe('0.2');
  });

  it('consumes a fresh identity and marks it used', async () => {
    const w = await world();
    const before = await prisma.testData.count({ where: { status: 'AVAILABLE' } });

    const { depositId } = await makeDeposit(w, '100');

    const after = await prisma.testData.count({ where: { status: 'AVAILABLE' } });
    expect(after).toBe(before - 1);

    const deposit = await prisma.deposit.findUniqueOrThrow({ where: { id: depositId } });
    expect(deposit.testDataId).toBeTruthy();

    const used = await prisma.testData.findUniqueOrThrow({
      where: { id: deposit.testDataId as string },
    });
    expect(used.status).toBe('USED');
  });
});

describe('balance ledger', () => {
  it('records every movement with before and after', async () => {
    const w = await world();
    const { depositId } = await makeDeposit(w, '1000.00');
    const actor = actorFor(w.publisher);

    await deposits.updateBalance(actor, auditCtx, depositId, { newBalance: '1250.00' });
    await deposits.createWithdrawal(actor, auditCtx, depositId, { amount: '200.00' });
    await deposits.updateBalance(actor, auditCtx, depositId, { newBalance: '975.25' });

    const entries = await prisma.balanceEntry.findMany({
      where: { depositId },
      orderBy: { createdAt: 'asc' },
    });

    expect(entries.map((e) => e.type)).toEqual([
      'OPENING',
      'ADJUSTMENT',
      'WITHDRAWAL',
      'ADJUSTMENT',
    ]);

    // Each entry's "after" must be the next entry's "before" — an unbroken chain.
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i]?.balanceBefore.toString()).toBe(entries[i - 1]?.balanceAfter.toString());
    }

    const deposit = await prisma.deposit.findUniqueOrThrow({ where: { id: depositId } });
    expect(deposit.currentBalance.toString()).toBe('975.25');
    // The cached balance must equal the last ledger entry.
    expect(deposit.currentBalance.toString()).toBe(
      entries[entries.length - 1]?.balanceAfter.toString(),
    );
  });

  it('refuses a withdrawal larger than the balance', async () => {
    const w = await world();
    const { depositId } = await makeDeposit(w, '100.00');

    await expect(
      deposits.createWithdrawal(actorFor(w.publisher), auditCtx, depositId, { amount: '100.01' }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });

    // Nothing partial was written.
    const deposit = await prisma.deposit.findUniqueOrThrow({ where: { id: depositId } });
    expect(deposit.currentBalance.toString()).toBe('100');
    expect(await prisma.withdrawal.count({ where: { depositId } })).toBe(0);
    expect(await prisma.balanceEntry.count({ where: { depositId } })).toBe(1);
  });

  it('allows withdrawing the entire balance, leaving zero', async () => {
    const w = await world();
    const { depositId } = await makeDeposit(w, '75.00');

    const result = await deposits.createWithdrawal(actorFor(w.publisher), auditCtx, depositId, {
      amount: '75.00',
    });

    expect(result.balanceAfter).toBe('0');
  });

  it('links each withdrawal to its ledger entry', async () => {
    const w = await world();
    const { depositId } = await makeDeposit(w, '500.00');

    const { withdrawalId } = await deposits.createWithdrawal(
      actorFor(w.publisher),
      auditCtx,
      depositId,
      { amount: '120.00', method: 'bank' },
    );

    const withdrawal = await prisma.withdrawal.findUniqueOrThrow({
      where: { id: withdrawalId },
      include: { balanceEntry: true },
    });

    expect(withdrawal.amount.toString()).toBe('120');
    expect(withdrawal.balanceEntry.balanceBefore.toString()).toBe('500');
    expect(withdrawal.balanceEntry.balanceAfter.toString()).toBe('380');
  });

  it('the ledger cannot be rewritten', async () => {
    const w = await world();
    const { depositId } = await makeDeposit(w, '100.00');
    const entry = await prisma.balanceEntry.findFirstOrThrow({ where: { depositId } });

    // The append-only trigger from migration 002.
    await expect(
      prisma.balanceEntry.update({ where: { id: entry.id }, data: { amount: '999999' } }),
    ).rejects.toThrowError();

    await expect(
      prisma.balanceEntry.delete({ where: { id: entry.id } }),
    ).rejects.toThrowError();
  });

  it('serialises concurrent withdrawals so the balance cannot go negative', async () => {
    const w = await world();
    const { depositId } = await makeDeposit(w, '100.00');
    const actor = actorFor(w.publisher);

    // Two simultaneous withdrawals of 60 against a balance of 100.
    const results = await Promise.all([
      deposits.createWithdrawal(actor, auditCtx, depositId, { amount: '60.00' }).catch((e) => e),
      deposits.createWithdrawal(actor, auditCtx, depositId, { amount: '60.00' }).catch((e) => e),
    ]);

    const succeeded = results.filter((r) => !(r instanceof Error));
    expect(succeeded).toHaveLength(1);

    const deposit = await prisma.deposit.findUniqueOrThrow({ where: { id: depositId } });
    expect(deposit.currentBalance.toString()).toBe('40');
    expect(Number(deposit.currentBalance)).toBeGreaterThanOrEqual(0);
  });
});

describe('gameplay', () => {
  it('sets the first due date from the deposit, not from a play that never happened', async () => {
    const w = await world({ gameplayIntervalDays: 3 });
    const { depositId } = await makeDeposit(w, '100.00');

    const deposit = await prisma.deposit.findUniqueOrThrow({ where: { id: depositId } });

    // Otherwise a deposit nobody ever plays would never turn red.
    expect(deposit.lastGameplayAt).toBeNull();
    expect(deposit.nextGameplayDueAt).not.toBeNull();

    const days =
      ((deposit.nextGameplayDueAt as Date).getTime() - deposit.depositedAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(3);
  });

  it('moves the due date forward on confirmation', async () => {
    const w = await world({ gameplayIntervalDays: 5 });
    const { depositId } = await makeDeposit(w, '100.00');

    const result = await deposits.confirmGameplay(actorFor(w.publisher), auditCtx, depositId);

    const days =
      (result.nextGameplayDueAt.getTime() - result.lastGameplayAt.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(5);

    const records = await prisma.gameplayRecord.findMany({ where: { depositId } });
    expect(records).toHaveLength(1);
    expect(records[0]?.wasOverdue).toBe(false);
  });

  it('records that a confirmation was late', async () => {
    const w = await world({ gameplayIntervalDays: 3 });
    const { depositId } = await makeDeposit(w, '100.00');

    // Push the due date into the past.
    await prisma.deposit.update({
      where: { id: depositId },
      data: { nextGameplayDueAt: new Date(Date.now() - 86_400_000) },
    });

    await deposits.confirmGameplay(actorFor(w.publisher), auditCtx, depositId);

    const record = await prisma.gameplayRecord.findFirstOrThrow({ where: { depositId } });
    // Captured at confirmation time; recalculating the due date would otherwise
    // erase the fact that it was ever late.
    expect(record.wasOverdue).toBe(true);
  });

  it('overdue filtering matches the computed state', async () => {
    const w = await world({ gameplayIntervalDays: 3 });
    const a = await makeDeposit(w, '100.00');
    const b = await makeDeposit(w, '200.00');

    await prisma.deposit.update({
      where: { id: a.depositId },
      data: { nextGameplayDueAt: new Date(Date.now() - 86_400_000) },
    });

    const overdue = await deposits.listDeposits(actorFor(w.publisher), { gameplay: 'OVERDUE' });
    expect(overdue.total).toBe(1);
    expect(overdue.rows[0]?.id).toBe(a.depositId);
    expect(overdue.rows[0]?.overdue).toBe(true);

    const all = await deposits.listDeposits(actorFor(w.publisher), {});
    expect(all.total).toBe(2);
    expect(all.rows.find((r) => r.id === b.depositId)?.overdue).toBe(false);
  });

  it('a completed deposit stops being chased for gameplay', async () => {
    const w = await world();
    const { depositId } = await makeDeposit(w, '100.00');

    await deposits.changeDepositStatus(actorFor(w.publisher), auditCtx, depositId, {
      status: 'COMPLETED',
    });

    const deposit = await prisma.deposit.findUniqueOrThrow({ where: { id: depositId } });
    expect(deposit.status).toBe('COMPLETED');
    expect(deposit.nextGameplayDueAt).toBeNull();

    await expect(
      deposits.confirmGameplay(actorFor(w.publisher), auditCtx, depositId),
    ).rejects.toMatchObject({ code: 'DEPOSIT_COMPLETED' });
  });

  it('keeps a history of status changes', async () => {
    const w = await world();
    const { depositId } = await makeDeposit(w, '100.00');
    const actor = actorFor(w.publisher);

    await deposits.changeDepositStatus(actor, auditCtx, depositId, { status: 'COMPLETED' });
    await deposits.changeDepositStatus(actor, auditCtx, depositId, {
      status: 'ACTIVE',
      note: 'reopened',
    });

    const history = await prisma.depositStatusChange.findMany({
      where: { depositId },
      orderBy: { createdAt: 'asc' },
    });

    expect(history).toHaveLength(2);
    expect(history[0]?.toStatus).toBe('COMPLETED');
    expect(history[1]?.toStatus).toBe('ACTIVE');
    expect(history[1]?.note).toBe('reopened');
  });
});

describe('account secrets', () => {
  it('round-trips through encryption', () => {
    const secret = 'Test-Account-Password-123!';
    const encrypted = encryptSecret(secret);

    // Never stored as readable text.
    expect(Buffer.from(encrypted).toString('utf8')).not.toContain(secret);
    expect(decryptSecret(encrypted)).toBe(secret);
  });

  it('detects tampering rather than returning corrupted plaintext', () => {
    const encrypted = encryptSecret('original-secret');
    const tampered = new Uint8Array(encrypted);
    tampered[tampered.length - 1] ^= 0xff;

    // GCM is authenticated, so a modified ciphertext throws.
    expect(() => decryptSecret(tampered)).toThrowError();
  });

  it('is never included in a list response', async () => {
    const w = await world();
    await makeDeposit(w, '100.00', { accountSecret: 'super-secret-pw' });

    const list = await deposits.listDeposits(actorFor(w.publisher), {});
    const row = list.rows[0] as Record<string, unknown>;

    expect(row).not.toHaveProperty('accountSecretEnc');
    expect(JSON.stringify(list)).not.toContain('super-secret-pw');
  });

  it('is revealed only through the audited endpoint', async () => {
    const w = await world();
    const { depositId } = await makeDeposit(w, '100.00', { accountSecret: 'super-secret-pw' });

    const before = await prisma.auditLog.count({ where: { action: 'deposit.secret_revealed' } });

    const revealed = await deposits.revealDepositSecret(actorFor(w.publisher), auditCtx, depositId);
    expect(revealed.secret).toBe('super-secret-pw');

    const after = await prisma.auditLog.count({ where: { action: 'deposit.secret_revealed' } });
    expect(after).toBe(before + 1);
  });
});
