import { Prisma } from '@prisma/client';
import { monthKey } from '@deposits/shared';
import { appTimezone, prisma, withTransaction } from '../../db/prisma.js';
import { offerScope, type Actor } from '../../db/scope.js';
import { AppError } from '../../lib/errors.js';
import { writeAudit, type AuditContext } from '../audit/audit.service.js';
import { getSettingNumber } from '../settings/settings.service.js';

/**
 * Offers: creation, targets, assignment, expiry, and progress.
 *
 * Progress numbers are computed here from the database on every request. They
 * are never cached in a column and never calculated in the browser — a stale
 * counter would silently let publishers overshoot a target.
 */

export interface CreateOfferInput {
  name: string;
  brand: string;
  description?: string;
  notes?: string;
  publisherInstructions?: string;
  countryCode: string;
  url: string;
  startDate?: string;
  expiryDate?: string;
  monthlyLeadTarget: number;
  monthlyDepositTarget: number;
  monthlyDepositAmountTarget: string;
  lifetimeDepositAmountTarget?: string;
  leadIntervalSeconds: number;
  depositIntervalSeconds: number;
  gameplayIntervalDays: number;
  dataSourcePolicy?: 'OWNER_PLUS_SUPER_ADMIN' | 'OWNER_ONLY';
  lowDataThreshold?: number;
  status?: 'DRAFT' | 'ACTIVE';
}

export async function createOffer(actor: Actor, ctx: AuditContext, input: CreateOfferInput) {
  const defaultDurationDays = await getSettingNumber('offer_default_duration_days', 90);

  const startDate = input.startDate ? new Date(input.startDate) : new Date();
  const expiryDate = input.expiryDate
    ? new Date(input.expiryDate)
    : new Date(startDate.getTime() + defaultDurationDays * 86_400_000);

  if (expiryDate < startDate) {
    throw new AppError('VALIDATION_FAILED', {
      fields: { expiryDate: 'Expiry cannot be before the start date.' },
    });
  }

  return withTransaction(async (tx) => {
    const offer = await tx.offer.create({
      data: {
        name: input.name.trim(),
        brand: input.brand.trim(),
        description: input.description?.trim() || null,
        notes: input.notes?.trim() || null,
        publisherInstructions: input.publisherInstructions?.trim() || null,
        countryCode: input.countryCode.toUpperCase(),
        url: input.url.trim(),
        status: input.status ?? 'DRAFT',
        // The creator owns it, which drives both the consumption pool and
        // manager visibility.
        ownerUserId: actor.id,
        createdById: actor.id,
        startDate,
        expiryDate,
        monthlyLeadTarget: input.monthlyLeadTarget,
        monthlyDepositTarget: input.monthlyDepositTarget,
        monthlyDepositAmountTarget: new Prisma.Decimal(input.monthlyDepositAmountTarget),
        lifetimeDepositAmountTarget: input.lifetimeDepositAmountTarget
          ? new Prisma.Decimal(input.lifetimeDepositAmountTarget)
          : null,
        leadIntervalSeconds: input.leadIntervalSeconds,
        depositIntervalSeconds: input.depositIntervalSeconds,
        gameplayIntervalDays: input.gameplayIntervalDays,
        dataSourcePolicy: input.dataSourcePolicy ?? 'OWNER_PLUS_SUPER_ADMIN',
        lowDataThreshold: input.lowDataThreshold ?? 10,
      },
      select: { id: true, name: true, status: true, expiryDate: true },
    });

    await writeAudit(tx, ctx, {
      action: 'offer.created',
      entityType: 'offer',
      entityId: offer.id,
      metadata: { name: offer.name, countryCode: input.countryCode.toUpperCase() },
    });

    return offer;
  });
}

export async function updateOffer(
  actor: Actor,
  ctx: AuditContext,
  id: string,
  input: Partial<CreateOfferInput>,
) {
  const offer = await loadEditable(actor, id);

  return withTransaction(async (tx) => {
    const updated = await tx.offer.update({
      where: { id: offer.id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.brand !== undefined ? { brand: input.brand.trim() } : {}),
        ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
        ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
        ...(input.publisherInstructions !== undefined
          ? { publisherInstructions: input.publisherInstructions?.trim() || null }
          : {}),
        ...(input.url !== undefined ? { url: input.url.trim() } : {}),
        ...(input.countryCode !== undefined ? { countryCode: input.countryCode.toUpperCase() } : {}),
        ...(input.monthlyLeadTarget !== undefined ? { monthlyLeadTarget: input.monthlyLeadTarget } : {}),
        ...(input.monthlyDepositTarget !== undefined
          ? { monthlyDepositTarget: input.monthlyDepositTarget }
          : {}),
        ...(input.monthlyDepositAmountTarget !== undefined
          ? { monthlyDepositAmountTarget: new Prisma.Decimal(input.monthlyDepositAmountTarget) }
          : {}),
        ...(input.leadIntervalSeconds !== undefined
          ? { leadIntervalSeconds: input.leadIntervalSeconds }
          : {}),
        ...(input.depositIntervalSeconds !== undefined
          ? { depositIntervalSeconds: input.depositIntervalSeconds }
          : {}),
        ...(input.gameplayIntervalDays !== undefined
          ? { gameplayIntervalDays: input.gameplayIntervalDays }
          : {}),
        ...(input.dataSourcePolicy !== undefined ? { dataSourcePolicy: input.dataSourcePolicy } : {}),
        ...(input.lowDataThreshold !== undefined ? { lowDataThreshold: input.lowDataThreshold } : {}),
      },
      select: { id: true, name: true, status: true },
    });

    await writeAudit(tx, ctx, { action: 'offer.updated', entityType: 'offer', entityId: id });
    return updated;
  });
}

export async function setOfferStatus(
  actor: Actor,
  ctx: AuditContext,
  id: string,
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'EXPIRED' | 'COMPLETED' | 'ARCHIVED',
) {
  const offer = await loadEditable(actor, id);

  return withTransaction(async (tx) => {
    const updated = await tx.offer.update({
      where: { id: offer.id },
      data: { status },
      select: { id: true, status: true },
    });

    await writeAudit(tx, ctx, {
      action: 'offer.status_changed',
      entityType: 'offer',
      entityId: id,
      metadata: { from: offer.status, to: status },
    });

    return updated;
  });
}

/**
 * Extends an offer's expiry.
 *
 * Never deletes or recreates: the extension is recorded as its own row so the
 * history of who extended what, when, and why survives.
 */
export async function extendOffer(
  actor: Actor,
  ctx: AuditContext,
  id: string,
  input: { newExpiryDate: string; reason?: string },
) {
  const offer = await loadEditable(actor, id);
  const newExpiry = new Date(input.newExpiryDate);

  if (newExpiry <= offer.expiryDate) {
    throw new AppError('VALIDATION_FAILED', {
      fields: { newExpiryDate: 'The new date must be later than the current expiry.' },
    });
  }

  return withTransaction(async (tx) => {
    await tx.offerExtension.create({
      data: {
        offerId: offer.id,
        previousExpiryDate: offer.expiryDate,
        newExpiryDate: newExpiry,
        extendedById: actor.id,
        reason: input.reason ?? null,
      },
    });

    const updated = await tx.offer.update({
      where: { id: offer.id },
      data: {
        expiryDate: newExpiry,
        // An offer auto-marked EXPIRED becomes workable again once extended.
        status: offer.status === 'EXPIRED' ? 'ACTIVE' : offer.status,
      },
      select: { id: true, expiryDate: true, status: true },
    });

    await writeAudit(tx, ctx, {
      action: 'offer.extended',
      entityType: 'offer',
      entityId: id,
      metadata: {
        from: offer.expiryDate.toISOString(),
        to: newExpiry.toISOString(),
        reason: input.reason ?? null,
      },
    });

    return updated;
  });
}

export async function assignPublishers(
  actor: Actor,
  ctx: AuditContext,
  offerId: string,
  publisherIds: string[],
) {
  const offer = await loadEditable(actor, offerId);

  // A manager may only assign their own publishers.
  const publishers = await prisma.user.findMany({
    where: {
      id: { in: publisherIds },
      role: 'PUBLISHER',
      ...(actor.role === 'MANAGER' ? { managerId: actor.id } : {}),
    },
    select: { id: true },
  });

  if (publishers.length !== publisherIds.length) {
    throw new AppError('FORBIDDEN', {
      message: 'One or more of those publishers cannot be assigned by you.',
    });
  }

  return withTransaction(async (tx) => {
    for (const p of publishers) {
      await tx.offerPublisher.upsert({
        where: { offerId_publisherId: { offerId: offer.id, publisherId: p.id } },
        create: { offerId: offer.id, publisherId: p.id, assignedById: actor.id, active: true },
        update: { active: true },
      });
    }

    await writeAudit(tx, ctx, {
      action: 'offer.publisher_assigned',
      entityType: 'offer',
      entityId: offer.id,
      metadata: { publisherIds: publishers.map((p) => p.id) },
    });

    return { assigned: publishers.length };
  });
}

export async function unassignPublisher(
  actor: Actor,
  ctx: AuditContext,
  offerId: string,
  publisherId: string,
) {
  const offer = await loadEditable(actor, offerId);

  return withTransaction(async (tx) => {
    // Deactivated, not deleted: the assignment row is referenced by history and
    // may carry per-publisher caps worth keeping.
    await tx.offerPublisher.updateMany({
      where: { offerId: offer.id, publisherId },
      data: { active: false },
    });

    await writeAudit(tx, ctx, {
      action: 'offer.publisher_unassigned',
      entityType: 'offer',
      entityId: offer.id,
      metadata: { publisherId },
    });
  });
}

/** Server-computed progress. The single source of truth for every counter. */
export async function offerProgress(actor: Actor, offerId: string, forMonth?: string) {
  const offer = await prisma.offer.findFirst({
    where: { id: offerId, ...offerScope(actor) },
    select: {
      id: true,
      name: true,
      brand: true,
      countryCode: true,
      status: true,
      expiryDate: true,
      monthlyLeadTarget: true,
      monthlyDepositTarget: true,
      monthlyDepositAmountTarget: true,
      lifetimeDepositAmountTarget: true,
      lowDataThreshold: true,
      ownerUserId: true,
      dataSourcePolicy: true,
    },
  });
  if (!offer) throw new AppError('NOT_FOUND');

  const key = forMonth ?? monthKey(new Date(), appTimezone);

  const [leads, deposits, amount, lifetimeAmount] = await Promise.all([
    prisma.lead.count({ where: { offerId, monthKey: key } }),
    prisma.deposit.count({ where: { offerId, monthKey: key } }),
    prisma.deposit.aggregate({ where: { offerId, monthKey: key }, _sum: { amount: true } }),
    prisma.deposit.aggregate({ where: { offerId }, _sum: { amount: true } }),
  ]);

  const depositAmount = amount._sum.amount ?? new Prisma.Decimal(0);

  return {
    offer: {
      id: offer.id,
      name: offer.name,
      brand: offer.brand,
      countryCode: offer.countryCode,
      status: offer.status,
      expiryDate: offer.expiryDate,
      expired: offer.expiryDate < new Date(),
    },
    monthKey: key,
    leads: {
      completed: leads,
      target: offer.monthlyLeadTarget,
      remaining: Math.max(0, offer.monthlyLeadTarget - leads),
    },
    deposits: {
      completed: deposits,
      target: offer.monthlyDepositTarget,
      remaining: Math.max(0, offer.monthlyDepositTarget - deposits),
    },
    depositAmount: {
      completed: depositAmount.toString(),
      target: offer.monthlyDepositAmountTarget.toString(),
      remaining: Prisma.Decimal.max(
        0,
        offer.monthlyDepositAmountTarget.minus(depositAmount),
      ).toString(),
      lifetimeCompleted: (lifetimeAmount._sum.amount ?? new Prisma.Decimal(0)).toString(),
      lifetimeTarget: offer.lifetimeDepositAmountTarget?.toString() ?? null,
    },
  };
}

/**
 * Remaining eligible test data for an offer, against outstanding demand.
 *
 * Both task types consume the pool (decision 2), so demand is leads plus
 * deposits remaining — counting leads alone would under-report and let an offer
 * run dry mid-month.
 */
export async function offerDataHealth(actor: Actor, offerId: string) {
  const progress = await offerProgress(actor, offerId);

  const offer = await prisma.offer.findUniqueOrThrow({
    where: { id: offerId },
    select: { countryCode: true, ownerUserId: true, dataSourcePolicy: true, lowDataThreshold: true },
  });

  const superAdmins = await prisma.user.findMany({
    where: { role: 'SUPER_ADMIN', status: 'ACTIVE' },
    select: { id: true },
  });

  const ownerIds =
    offer.dataSourcePolicy === 'OWNER_ONLY'
      ? [offer.ownerUserId]
      : [...new Set([offer.ownerUserId, ...superAdmins.map((s) => s.id)])];

  const available = await prisma.testData.count({
    where: { countryCode: offer.countryCode, status: 'AVAILABLE', ownerUserId: { in: ownerIds } },
  });

  const demand = progress.leads.remaining + progress.deposits.remaining;

  return {
    available,
    demand,
    shortfall: Math.max(0, demand - available),
    low: available <= offer.lowDataThreshold || available < demand,
  };
}

export async function listOffers(
  actor: Actor,
  filters: { status?: string; countryCode?: string; search?: string },
) {
  const now = new Date();

  const offers = await prisma.offer.findMany({
    where: {
      ...offerScope(actor),
      ...(filters.status ? { status: filters.status as Prisma.EnumOfferStatusFilter['equals'] } : {}),
      ...(filters.countryCode ? { countryCode: filters.countryCode.toUpperCase() } : {}),
      ...(filters.search
        ? {
            OR: [
              { name: { contains: filters.search, mode: 'insensitive' } },
              { brand: { contains: filters.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      brand: true,
      countryCode: true,
      status: true,
      startDate: true,
      expiryDate: true,
      monthlyLeadTarget: true,
      monthlyDepositTarget: true,
      monthlyDepositAmountTarget: true,
      createdAt: true,
      owner: { select: { id: true, fullName: true } },
      _count: { select: { assignments: { where: { active: true } } } },
    },
  });

  return offers.map((o) => ({
    ...o,
    monthlyDepositAmountTarget: o.monthlyDepositAmountTarget.toString(),
    // Red in the UI comes from this comparison, not a stored flag, so it is
    // correct even if the nightly expiry job has not run.
    expired: o.expiryDate < now,
    assignedPublishers: o._count.assignments,
  }));
}

/** Loads an offer the actor is allowed to modify. */
async function loadEditable(actor: Actor, id: string) {
  const offer = await prisma.offer.findFirst({
    where: {
      id,
      // Viewing is broader than editing: a manager can see an offer their
      // publishers work, but may only edit one they own.
      ...(actor.role === 'SUPER_ADMIN' ? {} : { ownerUserId: actor.id }),
    },
    select: { id: true, status: true, expiryDate: true, ownerUserId: true },
  });
  if (!offer) throw new AppError('NOT_FOUND');
  return offer;
}
