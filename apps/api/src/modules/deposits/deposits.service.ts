import { Prisma } from '@prisma/client';
import { monthKey } from '@deposits/shared';
import { appTimezone, lockOfferPublisher, prisma, withTransaction, type Tx } from '../../db/prisma.js';
import { activityScope, type Actor } from '../../db/scope.js';
import { encryptSecret, decryptSecret } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { writeAudit, type AuditContext } from '../audit/audit.service.js';

/**
 * Deposits, balances, gameplay, and withdrawals.
 *
 * The money rule throughout: `deposits.current_balance` is a cache. The truth is
 * the append-only `balance_entries` ledger. Every change writes a ledger row
 * carrying balance_before and balance_after and updates the cache in the same
 * transaction, so the two can never disagree and history is never lost.
 */

const D = (v: Prisma.Decimal | string | number) => new Prisma.Decimal(v);

/** Gameplay due date from the offer's interval. Null interval means no requirement. */
function nextGameplayDue(from: Date, intervalDays: number): Date {
  return new Date(from.getTime() + intervalDays * 86_400_000);
}

export interface CreateDepositInput {
  taskSessionId: string;
  accountName: string;
  accountEmail: string;
  accountSecret?: string;
  amount: string;
  method: string;
  notes?: string;
}

/**
 * Records a deposit and closes the task session that produced it.
 *
 * Mirrors completeLead: the same (offer, publisher) row lock, the same timer and
 * target re-validation. A deposit consumes its own identity under the confirmed
 * NEW_IDENTITY model, so the test-data record is marked USED here too.
 */
export async function createDeposit(
  actor: Actor,
  ctx: AuditContext,
  input: CreateDepositInput,
): Promise<{ depositId: string; nextAvailableAt: Date | null }> {
  const now = new Date();
  const amount = D(input.amount);

  if (amount.lessThanOrEqualTo(0)) throw new AppError('INVALID_AMOUNT');

  return withTransaction(async (tx) => {
    const session = await tx.taskSession.findFirst({
      where: { id: input.taskSessionId, publisherId: actor.id },
      select: {
        id: true,
        offerId: true,
        managerId: true,
        type: true,
        status: true,
        testDataId: true,
        expiresAt: true,
      },
    });

    if (!session) throw new AppError('NOT_FOUND');
    if (session.type !== 'DEPOSIT') throw new AppError('TASK_NOT_OPEN');
    if (session.status !== 'OPEN') throw new AppError('TASK_NOT_OPEN');
    if (session.expiresAt <= now) throw new AppError('TASK_EXPIRED');

    const assignment = await lockOfferPublisher(tx, session.offerId, actor.id);
    if (!assignment || !assignment.active) throw new AppError('NOT_ASSIGNED');

    const offer = await tx.offer.findUniqueOrThrow({
      where: { id: session.offerId },
      select: {
        id: true,
        status: true,
        monthlyDepositTarget: true,
        depositIntervalSeconds: true,
        gameplayIntervalDays: true,
        currency: true,
      },
    });
    if (offer.status !== 'ACTIVE') throw new AppError('OFFER_NOT_ACTIVE');

    const key = monthKey(now, appTimezone);

    const [offerCount, publisherCount, lastDeposit] = await Promise.all([
      tx.deposit.count({ where: { offerId: offer.id, monthKey: key } }),
      tx.deposit.count({ where: { offerId: offer.id, publisherId: actor.id, monthKey: key } }),
      tx.deposit.findFirst({
        where: { offerId: offer.id, publisherId: actor.id },
        orderBy: { depositedAt: 'desc' },
        select: { depositedAt: true },
      }),
    ]);

    if (offerCount >= offer.monthlyDepositTarget) throw new AppError('TARGET_REACHED');
    if (assignment.monthlyDepositCap !== null && publisherCount >= assignment.monthlyDepositCap) {
      throw new AppError('TARGET_REACHED');
    }
    if (lastDeposit) {
      const nextAt = new Date(
        lastDeposit.depositedAt.getTime() + offer.depositIntervalSeconds * 1000,
      );
      if (nextAt > now) throw new AppError('TIMER_ACTIVE');
    }

    const deposit = await tx.deposit.create({
      data: {
        offerId: offer.id,
        publisherId: actor.id,
        managerId: session.managerId,
        testDataId: session.testDataId,
        taskSessionId: session.id,
        accountName: input.accountName,
        accountEmail: input.accountEmail.trim().toLowerCase(),
        accountSecretEnc: input.accountSecret ? encryptSecret(input.accountSecret) : null,
        amount,
        method: input.method,
        currency: offer.currency,
        status: 'ACTIVE',
        // The deposit itself is the opening balance.
        currentBalance: amount,
        // Gameplay is due from the deposit, not from a first play that has not
        // happened yet — otherwise a deposit nobody ever plays never goes red.
        lastGameplayAt: null,
        nextGameplayDueAt: nextGameplayDue(now, offer.gameplayIntervalDays),
        depositedAt: now,
        monthKey: key,
        notes: input.notes ?? null,
      },
      select: { id: true },
    });

    await tx.balanceEntry.create({
      data: {
        depositId: deposit.id,
        type: 'OPENING',
        amount,
        balanceBefore: D(0),
        balanceAfter: amount,
        note: 'Initial deposit',
        createdById: actor.id,
      },
    });

    if (session.testDataId) {
      await tx.testData.update({
        where: { id: session.testDataId },
        data: {
          status: 'USED',
          usedAt: now,
          usedByUserId: actor.id,
          usedOfferId: offer.id,
          reservedByUserId: null,
          reservedAt: null,
          reservationExpiresAt: null,
        },
      });
    }

    await tx.taskSession.update({
      where: { id: session.id },
      data: { status: 'COMPLETED', completedAt: now },
    });

    await writeAudit(tx, ctx, {
      action: 'deposit.created',
      entityType: 'deposit',
      entityId: deposit.id,
      // Amount is business data, not a secret. The account password is neither
      // logged nor audited.
      metadata: { offerId: offer.id, amount: amount.toString(), method: input.method },
    });

    return {
      depositId: deposit.id,
      nextAvailableAt:
        offer.depositIntervalSeconds > 0
          ? new Date(now.getTime() + offer.depositIntervalSeconds * 1000)
          : null,
    };
  });
}

/**
 * Adjusts the recorded balance.
 *
 * Takes the new absolute balance, which is what a publisher reads off the screen,
 * and derives the delta for the ledger. Storing only the new value would lose the
 * movement; storing only the delta would drift from what they actually saw.
 */
export async function updateBalance(
  actor: Actor,
  ctx: AuditContext,
  depositId: string,
  input: { newBalance: string; note?: string },
): Promise<{ balanceBefore: string; balanceAfter: string }> {
  const newBalance = D(input.newBalance);
  if (newBalance.lessThan(0)) throw new AppError('INVALID_AMOUNT');

  return withTransaction(async (tx) => {
    const deposit = await lockDeposit(tx, actor, depositId);
    if (deposit.status === 'COMPLETED') throw new AppError('DEPOSIT_COMPLETED');

    const before = deposit.currentBalance;
    const delta = newBalance.minus(before);

    await tx.balanceEntry.create({
      data: {
        depositId: deposit.id,
        type: 'ADJUSTMENT',
        amount: delta.abs(),
        balanceBefore: before,
        balanceAfter: newBalance,
        note: input.note ?? null,
        createdById: actor.id,
      },
    });

    await tx.deposit.update({
      where: { id: deposit.id },
      data: { currentBalance: newBalance },
    });

    await writeAudit(tx, ctx, {
      action: 'deposit.balance_updated',
      entityType: 'deposit',
      entityId: deposit.id,
      metadata: { before: before.toString(), after: newBalance.toString() },
    });

    return { balanceBefore: before.toString(), balanceAfter: newBalance.toString() };
  });
}

/**
 * Records a withdrawal: a ledger entry, a withdrawal row, and a balance update,
 * all in one transaction.
 */
export async function createWithdrawal(
  actor: Actor,
  ctx: AuditContext,
  depositId: string,
  input: { amount: string; method?: string; withdrawnAt?: string; notes?: string },
): Promise<{ withdrawalId: string; balanceAfter: string }> {
  const amount = D(input.amount);
  if (amount.lessThanOrEqualTo(0)) throw new AppError('INVALID_AMOUNT');

  const withdrawnAt = input.withdrawnAt ? new Date(input.withdrawnAt) : new Date();

  return withTransaction(async (tx) => {
    const deposit = await lockDeposit(tx, actor, depositId);

    const before = deposit.currentBalance;
    if (amount.greaterThan(before)) throw new AppError('INSUFFICIENT_BALANCE');

    const after = before.minus(amount);

    const entry = await tx.balanceEntry.create({
      data: {
        depositId: deposit.id,
        type: 'WITHDRAWAL',
        amount,
        balanceBefore: before,
        balanceAfter: after,
        note: input.notes ?? null,
        createdById: actor.id,
      },
      select: { id: true },
    });

    const withdrawal = await tx.withdrawal.create({
      data: {
        depositId: deposit.id,
        publisherId: deposit.publisherId,
        managerId: deposit.managerId,
        offerId: deposit.offerId,
        amount,
        method: input.method ?? null,
        withdrawnAt,
        notes: input.notes ?? null,
        balanceEntryId: entry.id,
        monthKey: monthKey(withdrawnAt, appTimezone),
      },
      select: { id: true },
    });

    await tx.deposit.update({ where: { id: deposit.id }, data: { currentBalance: after } });

    await writeAudit(tx, ctx, {
      action: 'withdrawal.created',
      entityType: 'withdrawal',
      entityId: withdrawal.id,
      metadata: { depositId: deposit.id, amount: amount.toString(), balanceAfter: after.toString() },
    });

    return { withdrawalId: withdrawal.id, balanceAfter: after.toString() };
  });
}

/**
 * Confirms gameplay and recalculates the next due date.
 *
 * `wasOverdue` is captured at confirmation time. Once the next due date is
 * recalculated the lateness would be unrecoverable otherwise, and whether
 * publishers keep up is exactly what a manager wants to see.
 */
export async function confirmGameplay(
  actor: Actor,
  ctx: AuditContext,
  depositId: string,
): Promise<{ lastGameplayAt: Date; nextGameplayDueAt: Date }> {
  const now = new Date();

  return withTransaction(async (tx) => {
    const deposit = await lockDeposit(tx, actor, depositId);
    if (deposit.status === 'COMPLETED') throw new AppError('DEPOSIT_COMPLETED');

    const offer = await tx.offer.findUniqueOrThrow({
      where: { id: deposit.offerId },
      select: { gameplayIntervalDays: true },
    });

    const wasOverdue = deposit.nextGameplayDueAt !== null && deposit.nextGameplayDueAt < now;
    const nextDue = nextGameplayDue(now, offer.gameplayIntervalDays);

    await tx.gameplayRecord.create({
      data: {
        depositId: deposit.id,
        publisherId: deposit.publisherId,
        confirmedAt: now,
        dueAtWhenConfirmed: deposit.nextGameplayDueAt,
        wasOverdue,
      },
    });

    await tx.deposit.update({
      where: { id: deposit.id },
      data: { lastGameplayAt: now, nextGameplayDueAt: nextDue },
    });

    await writeAudit(tx, ctx, {
      action: 'gameplay.confirmed',
      entityType: 'deposit',
      entityId: deposit.id,
      metadata: { wasOverdue, nextGameplayDueAt: nextDue.toISOString() },
    });

    return { lastGameplayAt: now, nextGameplayDueAt: nextDue };
  });
}

export async function changeDepositStatus(
  actor: Actor,
  ctx: AuditContext,
  depositId: string,
  input: { status: 'ACTIVE' | 'COMPLETED'; note?: string },
): Promise<void> {
  await withTransaction(async (tx) => {
    const deposit = await lockDeposit(tx, actor, depositId);
    if (deposit.status === input.status) return;

    await tx.depositStatusChange.create({
      data: {
        depositId: deposit.id,
        fromStatus: deposit.status,
        toStatus: input.status,
        changedById: actor.id,
        note: input.note ?? null,
      },
    });

    await tx.deposit.update({
      where: { id: deposit.id },
      data: {
        status: input.status,
        // A completed deposit stops being chased for gameplay.
        nextGameplayDueAt: input.status === 'COMPLETED' ? null : deposit.nextGameplayDueAt,
      },
    });

    await writeAudit(tx, ctx, {
      action: 'deposit.status_changed',
      entityType: 'deposit',
      entityId: deposit.id,
      metadata: { from: deposit.status, to: input.status },
    });
  });
}

/**
 * Loads a deposit for mutation, scoped to the actor and row-locked.
 *
 * The scope filter is part of the WHERE clause rather than a check afterwards,
 * so a wrong-owner id simply finds nothing. FOR UPDATE prevents two concurrent
 * balance updates from both reading the same starting value.
 */
async function lockDeposit(tx: Tx, actor: Actor, depositId: string) {
  const scope = activityScope(actor);

  const deposit = await tx.deposit.findFirst({
    where: { id: depositId, ...scope },
    select: {
      id: true,
      offerId: true,
      publisherId: true,
      managerId: true,
      status: true,
      currentBalance: true,
      nextGameplayDueAt: true,
    },
  });
  if (!deposit) throw new AppError('NOT_FOUND');

  await tx.$queryRaw`SELECT id FROM deposits WHERE id = ${depositId}::uuid FOR UPDATE`;

  // Re-read inside the lock: the row may have changed between the scoped read
  // and acquiring the lock.
  const locked = await tx.deposit.findUniqueOrThrow({
    where: { id: depositId },
    select: {
      id: true,
      offerId: true,
      publisherId: true,
      managerId: true,
      status: true,
      currentBalance: true,
      nextGameplayDueAt: true,
    },
  });

  return locked;
}

export interface DepositFilters {
  offerId?: string;
  publisherId?: string;
  managerId?: string;
  status?: 'ACTIVE' | 'COMPLETED';
  gameplay?: 'ALL' | 'OK' | 'DUE' | 'OVERDUE';
  monthKey?: string;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

/** The main deposits table, with every filter the brief asks for. */
export async function listDeposits(actor: Actor, filters: DepositFilters) {
  const now = new Date();
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50));

  const where: Prisma.DepositWhereInput = {
    ...activityScope(actor),
    ...(filters.offerId ? { offerId: filters.offerId } : {}),
    ...(filters.publisherId ? { publisherId: filters.publisherId } : {}),
    ...(filters.managerId ? { managerId: filters.managerId } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.monthKey ? { monthKey: filters.monthKey } : {}),
    ...(filters.from || filters.to
      ? {
          depositedAt: {
            ...(filters.from ? { gte: new Date(filters.from) } : {}),
            ...(filters.to ? { lte: new Date(filters.to) } : {}),
          },
        }
      : {}),
    ...(filters.search
      ? {
          OR: [
            { accountName: { contains: filters.search, mode: 'insensitive' } },
            { accountEmail: { contains: filters.search, mode: 'insensitive' } },
            { offer: { name: { contains: filters.search, mode: 'insensitive' } } },
            { offer: { brand: { contains: filters.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  // Overdue is computed from the due date rather than a stored flag, so the
  // filter and the red highlight can never disagree.
  if (filters.gameplay === 'OVERDUE') {
    where.status = 'ACTIVE';
    where.nextGameplayDueAt = { lt: now };
  } else if (filters.gameplay === 'DUE') {
    where.status = 'ACTIVE';
    where.nextGameplayDueAt = { gte: now, lt: new Date(now.getTime() + 86_400_000) };
  } else if (filters.gameplay === 'OK') {
    where.nextGameplayDueAt = { gte: new Date(now.getTime() + 86_400_000) };
  }

  const [rows, total] = await Promise.all([
    prisma.deposit.findMany({
      where,
      orderBy: { depositedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        depositedAt: true,
        amount: true,
        method: true,
        currency: true,
        status: true,
        currentBalance: true,
        accountName: true,
        accountEmail: true,
        lastGameplayAt: true,
        nextGameplayDueAt: true,
        monthKey: true,
        offer: { select: { id: true, name: true, brand: true, countryCode: true } },
        publisher: { select: { id: true, fullName: true } },
        manager: { select: { id: true, fullName: true } },
        // accountSecretEnc deliberately absent from list responses.
      },
    }),
    prisma.deposit.count({ where }),
  ]);

  return {
    rows: rows.map((r) => ({
      ...r,
      amount: r.amount.toString(),
      currentBalance: r.currentBalance.toString(),
      overdue: r.status === 'ACTIVE' && r.nextGameplayDueAt !== null && r.nextGameplayDueAt < now,
    })),
    page,
    pageSize,
    total,
  };
}

/** Audited reveal of the test-account password. */
export async function revealDepositSecret(
  actor: Actor,
  ctx: AuditContext,
  depositId: string,
): Promise<{ secret: string | null }> {
  return withTransaction(async (tx) => {
    const deposit = await tx.deposit.findFirst({
      where: { id: depositId, ...activityScope(actor) },
      select: { id: true, accountSecretEnc: true },
    });
    if (!deposit) throw new AppError('NOT_FOUND');

    await writeAudit(tx, ctx, {
      action: 'deposit.secret_revealed',
      entityType: 'deposit',
      entityId: deposit.id,
      metadata: { revealedTo: actor.id },
    });

    return { secret: decryptSecret(deposit.accountSecretEnc) };
  });
}
