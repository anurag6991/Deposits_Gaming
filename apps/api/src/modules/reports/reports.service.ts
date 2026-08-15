import { Prisma } from '@prisma/client';
import { dayRange, monthKey } from '@deposits/shared';
import { appTimezone, prisma } from '../../db/prisma.js';
import { activityScope, offerScope, testDataScope, type Actor } from '../../db/scope.js';

/**
 * Dashboards and rollups.
 *
 * Every number here is computed from the database at request time. None of it is
 * cached in a column, and none of it is recomputed in the browser: a stale
 * counter is how a publisher overshoots a target without anyone noticing.
 *
 * Each role gets the same shape with a different scope applied, so the frontend
 * renders one component rather than three.
 */

const ZERO = new Prisma.Decimal(0);

export async function dashboard(actor: Actor) {
  const now = new Date();
  const key = monthKey(now, appTimezone);
  const today = dayRange(now, appTimezone);

  const scope = activityScope(actor);

  const [
    leadsToday,
    leadsMonth,
    depositsToday,
    depositsMonth,
    amountMonth,
    activeDeposits,
    completedDeposits,
    overdueGameplay,
  ] = await Promise.all([
    prisma.lead.count({ where: { ...scope, completedAt: { gte: today.start, lt: today.end } } }),
    prisma.lead.count({ where: { ...scope, monthKey: key } }),
    prisma.deposit.count({
      where: { ...scope, depositedAt: { gte: today.start, lt: today.end } },
    }),
    prisma.deposit.count({ where: { ...scope, monthKey: key } }),
    prisma.deposit.aggregate({ where: { ...scope, monthKey: key }, _sum: { amount: true } }),
    prisma.deposit.count({ where: { ...scope, status: 'ACTIVE' } }),
    prisma.deposit.count({ where: { ...scope, status: 'COMPLETED' } }),
    prisma.deposit.count({
      where: { ...scope, status: 'ACTIVE', nextGameplayDueAt: { lt: now } },
    }),
  ]);

  // Targets are summed across the offers in scope, so "12 / 40 leads" means the
  // same thing on every dashboard.
  const offers = await prisma.offer.findMany({
    where: { ...offerScope(actor), status: 'ACTIVE' },
    select: {
      id: true,
      monthlyLeadTarget: true,
      monthlyDepositTarget: true,
      monthlyDepositAmountTarget: true,
      expiryDate: true,
    },
  });

  const targets = offers.reduce(
    (acc, o) => ({
      leads: acc.leads + o.monthlyLeadTarget,
      deposits: acc.deposits + o.monthlyDepositTarget,
      amount: acc.amount.plus(o.monthlyDepositAmountTarget),
    }),
    { leads: 0, deposits: 0, amount: ZERO },
  );

  const base = {
    monthKey: key,
    leads: {
      today: leadsToday,
      month: leadsMonth,
      target: targets.leads,
      remaining: Math.max(0, targets.leads - leadsMonth),
    },
    deposits: {
      today: depositsToday,
      month: depositsMonth,
      target: targets.deposits,
      remaining: Math.max(0, targets.deposits - depositsMonth),
      active: activeDeposits,
      completed: completedDeposits,
    },
    depositAmount: {
      month: (amountMonth._sum.amount ?? ZERO).toString(),
      target: targets.amount.toString(),
      remaining: Prisma.Decimal.max(0, targets.amount.minus(amountMonth._sum.amount ?? ZERO)).toString(),
    },
    activeOffers: offers.length,
    expiringSoon: offers.filter(
      (o) => o.expiryDate < new Date(now.getTime() + 14 * 86_400_000),
    ).length,
    overdueGameplay,
  };

  if (actor.role === 'PUBLISHER') {
    // The publisher dashboard is deliberately minimal: today, this month, and
    // what needs attention. Nothing organisational.
    const waiting = await countWaitingTimers(actor, now);
    return { ...base, waitingTimers: waiting };
  }

  const [managers, publishers, lowPools] = await Promise.all([
    actor.role === 'SUPER_ADMIN'
      ? prisma.user.count({ where: { role: 'MANAGER', status: 'ACTIVE' } })
      : Promise.resolve(0),
    prisma.user.count({
      where: {
        role: 'PUBLISHER',
        status: 'ACTIVE',
        ...(actor.role === 'MANAGER' ? { managerId: actor.id } : {}),
      },
    }),
    lowDataPools(actor),
  ]);

  return { ...base, managers, publishers, lowDataPools: lowPools };
}

/** How many of this publisher's offers are currently on cooldown. */
async function countWaitingTimers(actor: Actor, now: Date): Promise<number> {
  const assignments = await prisma.offerPublisher.findMany({
    where: { publisherId: actor.id, active: true, offer: { status: 'ACTIVE' } },
    select: {
      offer: { select: { id: true, leadIntervalSeconds: true, depositIntervalSeconds: true } },
    },
  });

  let waiting = 0;
  for (const a of assignments) {
    const [lastLead, lastDeposit] = await Promise.all([
      prisma.lead.findFirst({
        where: { offerId: a.offer.id, publisherId: actor.id },
        orderBy: { completedAt: 'desc' },
        select: { completedAt: true },
      }),
      prisma.deposit.findFirst({
        where: { offerId: a.offer.id, publisherId: actor.id },
        orderBy: { depositedAt: 'desc' },
        select: { depositedAt: true },
      }),
    ]);

    const leadReady =
      !lastLead ||
      new Date(lastLead.completedAt.getTime() + a.offer.leadIntervalSeconds * 1000) <= now;
    const depositReady =
      !lastDeposit ||
      new Date(lastDeposit.depositedAt.getTime() + a.offer.depositIntervalSeconds * 1000) <= now;

    if (!leadReady && !depositReady) waiting += 1;
  }

  return waiting;
}

/**
 * Country pools running low, measured against real outstanding demand.
 *
 * Demand is leads PLUS deposits remaining, because both task types consume the
 * pool. Counting leads alone under-reports and lets an offer run dry mid-month.
 */
export async function lowDataPools(actor: Actor) {
  if (actor.role === 'PUBLISHER') return [];

  const scope = testDataScope(actor);

  const available = await prisma.testData.groupBy({
    by: ['countryCode'],
    where: { ...scope, status: 'AVAILABLE' },
    _count: { _all: true },
  });

  const availableByCountry = new Map(available.map((a) => [a.countryCode, a._count._all]));

  const offers = await prisma.offer.findMany({
    where: { ...offerScope(actor), status: 'ACTIVE' },
    select: {
      id: true,
      countryCode: true,
      monthlyLeadTarget: true,
      monthlyDepositTarget: true,
      lowDataThreshold: true,
    },
  });

  const key = monthKey(new Date(), appTimezone);
  const demandByCountry = new Map<string, number>();
  const thresholdByCountry = new Map<string, number>();

  for (const offer of offers) {
    const [leads, deposits] = await Promise.all([
      prisma.lead.count({ where: { offerId: offer.id, monthKey: key } }),
      prisma.deposit.count({ where: { offerId: offer.id, monthKey: key } }),
    ]);

    const remaining =
      Math.max(0, offer.monthlyLeadTarget - leads) +
      Math.max(0, offer.monthlyDepositTarget - deposits);

    demandByCountry.set(offer.countryCode, (demandByCountry.get(offer.countryCode) ?? 0) + remaining);
    thresholdByCountry.set(
      offer.countryCode,
      Math.max(thresholdByCountry.get(offer.countryCode) ?? 0, offer.lowDataThreshold),
    );
  }

  const rows = [];
  for (const [countryCode, demand] of demandByCountry) {
    const stock = availableByCountry.get(countryCode) ?? 0;
    const threshold = thresholdByCountry.get(countryCode) ?? 10;
    if (stock < demand || stock <= threshold) {
      rows.push({ countryCode, available: stock, demand, shortfall: Math.max(0, demand - stock) });
    }
  }

  return rows.sort((a, b) => b.shortfall - a.shortfall);
}

/** Per-offer rollup for the reports screen. */
export async function offerReport(actor: Actor, filters: { monthKey?: string }) {
  const key = filters.monthKey ?? monthKey(new Date(), appTimezone);
  const now = new Date();

  const offers = await prisma.offer.findMany({
    where: offerScope(actor),
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
    },
    orderBy: { name: 'asc' },
  });

  return Promise.all(
    offers.map(async (offer) => {
      const [leads, deposits, amount] = await Promise.all([
        prisma.lead.count({ where: { offerId: offer.id, monthKey: key } }),
        prisma.deposit.count({ where: { offerId: offer.id, monthKey: key } }),
        prisma.deposit.aggregate({
          where: { offerId: offer.id, monthKey: key },
          _sum: { amount: true },
        }),
      ]);

      const sum = amount._sum.amount ?? ZERO;

      return {
        offerId: offer.id,
        name: offer.name,
        brand: offer.brand,
        countryCode: offer.countryCode,
        status: offer.status,
        expired: offer.expiryDate < now,
        leads: { completed: leads, target: offer.monthlyLeadTarget },
        deposits: { completed: deposits, target: offer.monthlyDepositTarget },
        amount: { completed: sum.toString(), target: offer.monthlyDepositAmountTarget.toString() },
      };
    }),
  );
}

/** Per-publisher rollup. Managers see their own team, Super Admin sees everyone. */
export async function publisherReport(actor: Actor, filters: { monthKey?: string }) {
  if (actor.role === 'PUBLISHER') return [];

  const key = filters.monthKey ?? monthKey(new Date(), appTimezone);

  const publishers = await prisma.user.findMany({
    where: {
      role: 'PUBLISHER',
      ...(actor.role === 'MANAGER' ? { managerId: actor.id } : {}),
    },
    select: { id: true, fullName: true, status: true, manager: { select: { fullName: true } } },
    orderBy: { fullName: 'asc' },
  });

  return Promise.all(
    publishers.map(async (p) => {
      const [leads, deposits, amount, advance, overdue] = await Promise.all([
        prisma.lead.count({ where: { publisherId: p.id, monthKey: key } }),
        prisma.deposit.count({ where: { publisherId: p.id, monthKey: key } }),
        prisma.deposit.aggregate({
          where: { publisherId: p.id, monthKey: key },
          _sum: { amount: true },
        }),
        prisma.advance.aggregate({
          where: { publisherId: p.id, monthKey: key, status: { not: 'CANCELLED' } },
          _sum: { amount: true },
        }),
        prisma.deposit.count({
          where: { publisherId: p.id, status: 'ACTIVE', nextGameplayDueAt: { lt: new Date() } },
        }),
      ]);

      return {
        publisherId: p.id,
        fullName: p.fullName,
        status: p.status,
        manager: p.manager?.fullName ?? null,
        leads,
        deposits,
        depositAmount: (amount._sum.amount ?? ZERO).toString(),
        advance: (advance._sum.amount ?? ZERO).toString(),
        overdueGameplay: overdue,
      };
    }),
  );
}
