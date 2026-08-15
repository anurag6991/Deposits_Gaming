import type { Request } from 'express';
import type { Role } from '@deposits/shared';
import type { Tx } from '../../db/prisma.js';
import { prisma } from '../../db/prisma.js';

/**
 * Audit logging.
 *
 * `writeAudit` takes a transaction client rather than reaching for the global
 * one. That is the whole point: the log entry and the change it describes commit
 * together or not at all. Using the global client here would let an audit row
 * survive a rolled-back transaction, producing a permanent record of something
 * that never happened — worse than no log, because it is trusted.
 *
 * The table is append-only, enforced by a database trigger (migration 002).
 */

export type AuditAction =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.logout'
  | 'auth.password_changed'
  | 'user.created'
  | 'user.updated'
  | 'user.disabled'
  | 'user.enabled'
  | 'user.reassigned'
  | 'offer.created'
  | 'offer.updated'
  | 'offer.status_changed'
  | 'offer.extended'
  | 'offer.publisher_assigned'
  | 'offer.publisher_unassigned'
  | 'testdata.imported'
  | 'testdata.released'
  | 'testdata.disabled'
  | 'testdata.reset'
  | 'testdata.reserved'
  | 'testdata.reservation_expired'
  | 'task.started'
  | 'task.abandoned'
  | 'lead.completed'
  | 'lead.reset'
  | 'deposit.created'
  | 'deposit.status_changed'
  | 'deposit.balance_updated'
  | 'deposit.secret_revealed'
  | 'gameplay.confirmed'
  | 'withdrawal.created'
  | 'advance.created'
  | 'advance.updated'
  | 'proxy.created'
  | 'proxy.updated'
  | 'proxy.disabled'
  | 'proxy.assigned'
  | 'proxy.credentials_revealed'
  | 'settings.updated';

export interface AuditContext {
  actorUserId: string | null;
  actorRole: Role | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuditEntry {
  action: AuditAction;
  entityType: string;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Extracts the audit context from a request. */
export function auditContext(req: Request): AuditContext {
  return {
    actorUserId: req.actor?.id ?? null,
    actorRole: req.actor?.role ?? null,
    ipAddress: req.ip ?? null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  };
}

/**
 * Writes an audit row inside the caller's transaction.
 *
 * Metadata should describe what changed in business terms — never include
 * passwords, tokens, decrypted secrets, or full test-identity records.
 */
export async function writeAudit(
  tx: Tx,
  ctx: AuditContext,
  entry: AuditEntry,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: (entry.metadata ?? {}) as object,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    },
  });
}

/**
 * For events that must be recorded even when the surrounding work failed —
 * a failed login being the main one, since there is no transaction to join and
 * the whole point is to record the failure.
 */
export async function writeAuditStandalone(ctx: AuditContext, entry: AuditEntry): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorUserId: ctx.actorUserId,
      actorRole: ctx.actorRole,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      metadata: (entry.metadata ?? {}) as object,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    },
  });
}
