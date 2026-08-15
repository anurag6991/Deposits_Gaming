import { Prisma } from '@prisma/client';
import { prisma, withTransaction } from '../../db/prisma.js';
import { userScope, type Actor } from '../../db/scope.js';
import { hashPassword } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { writeAudit, type AuditContext } from '../audit/audit.service.js';
import { invalidateSuperAdminCache } from '../tasks/tasks.service.js';

/**
 * Managers and publishers.
 *
 * Two rules enforced here and re-enforced by database constraints:
 *   - only a Super Admin creates a Manager
 *   - a Manager may only create publishers under themselves, and may only touch
 *     publishers who are already theirs
 */

const PUBLIC_FIELDS = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  status: true,
  phone: true,
  managerId: true,
  lastLoginAt: true,
  mustChangePassword: true,
  createdAt: true,
  manager: { select: { id: true, fullName: true } },
} satisfies Prisma.UserSelect;

export async function listUsers(
  actor: Actor,
  filters: { role?: 'MANAGER' | 'PUBLISHER'; managerId?: string; status?: 'ACTIVE' | 'DISABLED'; search?: string },
) {
  return prisma.user.findMany({
    where: {
      ...userScope(actor),
      ...(filters.role ? { role: filters.role } : {}),
      ...(filters.managerId ? { managerId: filters.managerId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.search
        ? {
            OR: [
              { fullName: { contains: filters.search, mode: 'insensitive' } },
              { email: { contains: filters.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: [{ role: 'asc' }, { fullName: 'asc' }],
    select: PUBLIC_FIELDS,
  });
}

export async function getUser(actor: Actor, id: string) {
  // Scope is part of the query, so a wrong-scope id simply finds nothing rather
  // than relying on a follow-up ownership check that could be forgotten.
  const user = await prisma.user.findFirst({
    where: { id, ...userScope(actor) },
    select: PUBLIC_FIELDS,
  });
  if (!user) throw new AppError('NOT_FOUND');
  return user;
}

export interface CreateUserInput {
  email: string;
  fullName: string;
  password: string;
  role: 'MANAGER' | 'PUBLISHER';
  phone?: string;
  /** Required when a Super Admin creates a publisher; ignored for managers. */
  managerId?: string;
}

export async function createUser(actor: Actor, ctx: AuditContext, input: CreateUserInput) {
  const email = input.email.trim().toLowerCase();

  if (input.role === 'MANAGER' && actor.role !== 'SUPER_ADMIN') {
    throw new AppError('FORBIDDEN');
  }

  // A manager's publishers are always their own; they cannot park one under a
  // different manager, and the request cannot ask them to.
  let managerId: string | null = null;
  if (input.role === 'PUBLISHER') {
    managerId = actor.role === 'MANAGER' ? actor.id : (input.managerId ?? null);
    if (!managerId) {
      throw new AppError('VALIDATION_FAILED', {
        fields: { managerId: 'Choose a manager for this publisher.' },
      });
    }

    const manager = await prisma.user.findUnique({
      where: { id: managerId },
      select: { id: true, role: true, status: true },
    });
    if (!manager || manager.role !== 'MANAGER') {
      throw new AppError('VALIDATION_FAILED', {
        fields: { managerId: 'That manager does not exist.' },
      });
    }
    if (manager.status === 'DISABLED') {
      throw new AppError('VALIDATION_FAILED', {
        fields: { managerId: 'That manager is disabled.' },
      });
    }
  }

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    throw new AppError('VALIDATION_FAILED', {
      fields: { email: 'That email address is already in use.' },
    });
  }

  const passwordHash = await hashPassword(input.password);

  return withTransaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        fullName: input.fullName.trim(),
        passwordHash,
        role: input.role,
        phone: input.phone?.trim() || null,
        managerId,
        createdById: actor.id,
        // The creator chose this password, so the account holder must replace it
        // before doing anything else.
        mustChangePassword: true,
      },
      select: PUBLIC_FIELDS,
    });

    await writeAudit(tx, ctx, {
      action: 'user.created',
      entityType: 'user',
      entityId: user.id,
      metadata: { role: input.role, managerId },
    });

    return user;
  });
}

export async function updateUser(
  actor: Actor,
  ctx: AuditContext,
  id: string,
  input: { fullName?: string; phone?: string | null },
) {
  const target = await prisma.user.findFirst({
    where: { id, ...userScope(actor) },
    select: { id: true, role: true },
  });
  if (!target) throw new AppError('NOT_FOUND');

  // A manager can edit their publishers, not other managers and not themselves
  // into a different shape.
  if (actor.role === 'MANAGER' && target.role !== 'PUBLISHER' && target.id !== actor.id) {
    throw new AppError('FORBIDDEN');
  }

  return withTransaction(async (tx) => {
    const user = await tx.user.update({
      where: { id },
      data: {
        ...(input.fullName !== undefined ? { fullName: input.fullName.trim() } : {}),
        ...(input.phone !== undefined ? { phone: input.phone?.trim() || null } : {}),
      },
      select: PUBLIC_FIELDS,
    });

    await writeAudit(tx, ctx, { action: 'user.updated', entityType: 'user', entityId: id });
    return user;
  });
}

/**
 * Disables or re-enables an account.
 *
 * Disabling never deletes and never hides history: past leads, deposits, and
 * reports stay visible and attributed. It only stops new work and new logins.
 */
export async function setUserStatus(
  actor: Actor,
  ctx: AuditContext,
  id: string,
  status: 'ACTIVE' | 'DISABLED',
) {
  if (id === actor.id) {
    throw new AppError('VALIDATION_FAILED', { fields: { id: 'You cannot disable your own account.' } });
  }

  const target = await prisma.user.findFirst({
    where: { id, ...userScope(actor) },
    select: { id: true, role: true, status: true },
  });
  if (!target) throw new AppError('NOT_FOUND');

  if (actor.role === 'MANAGER' && target.role !== 'PUBLISHER') throw new AppError('FORBIDDEN');

  return withTransaction(async (tx) => {
    const user = await tx.user.update({
      where: { id },
      data: { status },
      select: PUBLIC_FIELDS,
    });

    // A disabled account must lose access immediately, not when its access token
    // happens to expire.
    if (status === 'DISABLED') {
      await tx.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    if (target.role === 'SUPER_ADMIN') invalidateSuperAdminCache();

    await writeAudit(tx, ctx, {
      action: status === 'DISABLED' ? 'user.disabled' : 'user.enabled',
      entityType: 'user',
      entityId: id,
    });

    return user;
  });
}

/** Super Admin only: moves a publisher to a different manager. */
export async function reassignPublisher(
  actor: Actor,
  ctx: AuditContext,
  publisherId: string,
  newManagerId: string,
) {
  if (actor.role !== 'SUPER_ADMIN') throw new AppError('FORBIDDEN');

  const [publisher, manager] = await Promise.all([
    prisma.user.findUnique({ where: { id: publisherId }, select: { id: true, role: true, managerId: true } }),
    prisma.user.findUnique({ where: { id: newManagerId }, select: { id: true, role: true } }),
  ]);

  if (!publisher || publisher.role !== 'PUBLISHER') throw new AppError('NOT_FOUND');
  if (!manager || manager.role !== 'MANAGER') {
    throw new AppError('VALIDATION_FAILED', { fields: { managerId: 'That manager does not exist.' } });
  }

  return withTransaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: publisherId },
      data: { managerId: newManagerId },
      select: PUBLIC_FIELDS,
    });

    // Historical leads and deposits keep their original manager_id snapshot on
    // purpose: past work stays attributed to whoever actually supervised it.
    await writeAudit(tx, ctx, {
      action: 'user.reassigned',
      entityType: 'user',
      entityId: publisherId,
      metadata: { from: publisher.managerId, to: newManagerId },
    });

    return updated;
  });
}
