import { Prisma } from '@prisma/client';
import { monthKey } from '@deposits/shared';
import { appTimezone, prisma, withTransaction } from '../../db/prisma.js';
import type { Actor } from '../../db/scope.js';
import { AppError } from '../../lib/errors.js';
import { writeAudit, type AuditContext } from '../audit/audit.service.js';

/**
 * Monthly advances paid to publishers.
 *
 * Recorded as PENDING and marked PAID when the money actually moves, so the
 * register distinguishes "promised" from "transferred" rather than conflating
 * them (see docs/DECISIONS.md item 9).
 */

export async function createAdvance(
  actor: Actor,
  ctx: AuditContext,
  input: { publisherId: string; amount: string; monthKey?: string; notes?: string; paidOn?: string },
) {
  const amount = new Prisma.Decimal(input.amount);
  if (amount.lessThanOrEqualTo(0)) throw new AppError('INVALID_AMOUNT');

  const publisher = await prisma.user.findFirst({
    where: {
      id: input.publisherId,
      role: 'PUBLISHER',
      // A manager may only advance to their own publishers.
      ...(actor.role === 'MANAGER' ? { managerId: actor.id } : {}),
    },
    select: { id: true, managerId: true },
  });
  if (!publisher) throw new AppError('NOT_FOUND');

  const key = input.monthKey ?? monthKey(new Date(), appTimezone);

  return withTransaction(async (tx) => {
    const advance = await tx.advance.create({
      data: {
        publisherId: publisher.id,
        managerId: publisher.managerId as string,
        monthKey: key,
        amount,
        notes: input.notes ?? null,
        paidOn: input.paidOn ? new Date(input.paidOn) : null,
        status: input.paidOn ? 'PAID' : 'PENDING',
        createdById: actor.id,
      },
      select: { id: true, amount: true, monthKey: true, status: true },
    });

    await writeAudit(tx, ctx, {
      action: 'advance.created',
      entityType: 'advance',
      entityId: advance.id,
      metadata: { publisherId: publisher.id, amount: amount.toString(), monthKey: key },
    });

    return { ...advance, amount: advance.amount.toString() };
  });
}

export async function updateAdvance(
  actor: Actor,
  ctx: AuditContext,
  id: string,
  input: { status?: 'PENDING' | 'PAID' | 'CANCELLED'; paidOn?: string; notes?: string },
) {
  if (actor.role === 'PUBLISHER') throw new AppError('FORBIDDEN');

  const advance = await prisma.advance.findFirst({
    where: { id, ...(actor.role === 'MANAGER' ? { managerId: actor.id } : {}) },
    select: { id: true, status: true },
  });
  if (!advance) throw new AppError('NOT_FOUND');

  return withTransaction(async (tx) => {
    const updated = await tx.advance.update({
      where: { id },
      data: {
        ...(input.status ? { status: input.status } : {}),
        ...(input.paidOn !== undefined ? { paidOn: input.paidOn ? new Date(input.paidOn) : null } : {}),
        ...(input.notes !== undefined ? { notes: input.notes } : {}),
      },
      select: { id: true, status: true, amount: true },
    });

    await writeAudit(tx, ctx, {
      action: 'advance.updated',
      entityType: 'advance',
      entityId: id,
      metadata: { from: advance.status, to: updated.status },
    });

    return { ...updated, amount: updated.amount.toString() };
  });
}

export async function listAdvances(
  actor: Actor,
  filters: { publisherId?: string; monthKey?: string; status?: 'PENDING' | 'PAID' | 'CANCELLED' },
) {
  const scope =
    actor.role === 'SUPER_ADMIN'
      ? {}
      : actor.role === 'MANAGER'
        ? { managerId: actor.id }
        : { publisherId: actor.id };

  const rows = await prisma.advance.findMany({
    where: {
      ...scope,
      ...(filters.publisherId ? { publisherId: filters.publisherId } : {}),
      ...(filters.monthKey ? { monthKey: filters.monthKey } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    },
    orderBy: [{ monthKey: 'desc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      amount: true,
      currency: true,
      monthKey: true,
      status: true,
      paidOn: true,
      notes: true,
      createdAt: true,
      publisher: { select: { id: true, fullName: true } },
      manager: { select: { id: true, fullName: true } },
    },
  });

  const total = rows
    .filter((r) => r.status !== 'CANCELLED')
    .reduce((sum, r) => sum.plus(r.amount), new Prisma.Decimal(0));

  return {
    rows: rows.map((r) => ({ ...r, amount: r.amount.toString() })),
    total: total.toString(),
  };
}
