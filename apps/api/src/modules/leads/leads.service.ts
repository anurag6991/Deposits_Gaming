import { monthKey } from '@deposits/shared';
import { appTimezone, lockOfferPublisher, withTransaction } from '../../db/prisma.js';
import type { Actor } from '../../db/scope.js';
import { AppError } from '../../lib/errors.js';
import { writeAudit, type AuditContext } from '../audit/audit.service.js';

/**
 * Lead completion.
 *
 * The timer and target are re-validated here, not just at task start. A publisher
 * could otherwise open a task while eligible, wait out a target being filled by
 * colleagues, and still submit. The server is the source of truth at the moment
 * of the write, never at the moment of the read that preceded it.
 */

export async function completeLead(
  actor: Actor,
  ctx: AuditContext,
  input: { taskSessionId: string; notes?: string },
): Promise<{ leadId: string; nextAvailableAt: Date | null }> {
  const now = new Date();

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
        proxyId: true,
        expiresAt: true,
      },
    });

    if (!session) throw new AppError('NOT_FOUND');
    if (session.type !== 'LEAD') throw new AppError('TASK_NOT_OPEN');
    if (session.status !== 'OPEN') throw new AppError('TASK_NOT_OPEN');
    if (session.expiresAt <= now) throw new AppError('TASK_EXPIRED');
    if (!session.testDataId) throw new AppError('NO_TEST_DATA');

    // Same mutex as task start: serialises this (offer, publisher) pair so the
    // target check below cannot race a colleague's simultaneous submission.
    const assignment = await lockOfferPublisher(tx, session.offerId, actor.id);
    if (!assignment || !assignment.active) throw new AppError('NOT_ASSIGNED');

    const offer = await tx.offer.findUniqueOrThrow({
      where: { id: session.offerId },
      select: { id: true, status: true, monthlyLeadTarget: true, leadIntervalSeconds: true },
    });
    if (offer.status !== 'ACTIVE') throw new AppError('OFFER_NOT_ACTIVE');

    const key = monthKey(now, appTimezone);

    const [offerCount, publisherCount, lastLead] = await Promise.all([
      tx.lead.count({ where: { offerId: offer.id, monthKey: key } }),
      tx.lead.count({ where: { offerId: offer.id, publisherId: actor.id, monthKey: key } }),
      tx.lead.findFirst({
        where: { offerId: offer.id, publisherId: actor.id },
        orderBy: { completedAt: 'desc' },
        select: { completedAt: true },
      }),
    ]);

    if (offerCount >= offer.monthlyLeadTarget) throw new AppError('TARGET_REACHED');
    if (assignment.monthlyLeadCap !== null && publisherCount >= assignment.monthlyLeadCap) {
      throw new AppError('TARGET_REACHED');
    }

    if (lastLead) {
      const nextAt = new Date(lastLead.completedAt.getTime() + offer.leadIntervalSeconds * 1000);
      if (nextAt > now) throw new AppError('TIMER_ACTIVE');
    }

    const lead = await tx.lead.create({
      data: {
        offerId: offer.id,
        publisherId: actor.id,
        managerId: session.managerId,
        testDataId: session.testDataId,
        taskSessionId: session.id,
        proxyId: session.proxyId,
        completedAt: now,
        monthKey: key,
        notes: input.notes ?? null,
      },
      select: { id: true },
    });

    // The identity is now spent. The unique constraint on leads.test_data_id is
    // the real guarantee; this status update is what keeps it out of the pick query.
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

    await tx.taskSession.update({
      where: { id: session.id },
      data: { status: 'COMPLETED', completedAt: now },
    });

    await writeAudit(tx, ctx, {
      action: 'lead.completed',
      entityType: 'lead',
      entityId: lead.id,
      metadata: { offerId: offer.id, testDataId: session.testDataId },
    });

    return {
      leadId: lead.id,
      nextAvailableAt:
        offer.leadIntervalSeconds > 0
          ? new Date(now.getTime() + offer.leadIntervalSeconds * 1000)
          : null,
    };
  });
}

/**
 * Super Admin only: undoes a lead and returns the identity to the pool.
 *
 * Publishers misclick. Without this the identity would be burned permanently and
 * the monthly counter would be permanently wrong. A reason is required and the
 * whole thing is audited, because this rewrites history.
 */
export async function resetLead(
  actor: Actor,
  ctx: AuditContext,
  leadId: string,
  reason: string,
): Promise<void> {
  if (actor.role !== 'SUPER_ADMIN') throw new AppError('FORBIDDEN');

  await withTransaction(async (tx) => {
    const lead = await tx.lead.findUnique({
      where: { id: leadId },
      select: { id: true, offerId: true, publisherId: true, testDataId: true },
    });
    if (!lead) throw new AppError('NOT_FOUND');

    await tx.lead.delete({ where: { id: lead.id } });

    await tx.testData.update({
      where: { id: lead.testDataId },
      data: {
        status: 'AVAILABLE',
        usedAt: null,
        usedByUserId: null,
        usedOfferId: null,
        reservedByUserId: null,
        reservedAt: null,
        reservationExpiresAt: null,
      },
    });

    await writeAudit(tx, ctx, {
      action: 'lead.reset',
      entityType: 'lead',
      entityId: lead.id,
      metadata: {
        reason,
        offerId: lead.offerId,
        publisherId: lead.publisherId,
        testDataId: lead.testDataId,
      },
    });
  });
}
