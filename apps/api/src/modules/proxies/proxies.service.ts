import type { Tx } from '../../db/prisma.js';
import { prisma } from '../../db/prisma.js';
import { decryptSecret } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import type { Actor } from '../../db/scope.js';
import { writeAudit, type AuditContext } from '../audit/audit.service.js';
import { withTransaction } from '../../db/prisma.js';

/**
 * Proxy management and resolution.
 *
 * Credentials are encrypted at rest and never appear in a list response. They are
 * revealed only through an explicit, task-scoped, audited call.
 */

export interface ResolvedProxy {
  id: string;
  host: string;
  port: number;
  protocol: string;
  username: string | null;
}

/**
 * Picks the proxy for a task, in priority order:
 *
 *   1. sticky to the identity   — the same test account always from the same IP
 *   2. this publisher + offer
 *   3. this publisher
 *   4. any active proxy in the offer's country
 *   5. none (the task proceeds; the UI warns)
 *
 * Identity-stickiness is first for a reason: brands fingerprint accounts by IP,
 * and an account that appears from a new address every session gets flagged,
 * which contaminates the test results the whole platform exists to produce.
 */
export async function resolveProxyForTask(
  tx: Tx,
  params: { testDataId: string; publisherId: string; offerId: string; countryCode: string },
): Promise<ResolvedProxy | null> {
  const select = {
    id: true,
    host: true,
    port: true,
    protocol: true,
    username: true,
    status: true,
  } as const;

  const sticky = await tx.proxyAssignment.findFirst({
    where: { testDataId: params.testDataId, active: true, proxy: { status: 'ACTIVE' } },
    select: { proxy: { select } },
  });
  if (sticky?.proxy) return strip(sticky.proxy);

  const perOffer = await tx.proxyAssignment.findFirst({
    where: {
      publisherId: params.publisherId,
      offerId: params.offerId,
      active: true,
      proxy: { status: 'ACTIVE' },
    },
    select: { proxy: { select } },
  });
  if (perOffer?.proxy) return strip(perOffer.proxy);

  const perPublisher = await tx.proxyAssignment.findFirst({
    where: {
      publisherId: params.publisherId,
      offerId: null,
      testDataId: null,
      active: true,
      proxy: { status: 'ACTIVE' },
    },
    select: { proxy: { select } },
  });
  if (perPublisher?.proxy) return strip(perPublisher.proxy);

  const byCountry = await tx.proxy.findFirst({
    where: { countryCode: params.countryCode, status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    select,
  });
  if (byCountry) {
    // Make it sticky from now on, so this identity keeps this IP for its lifetime.
    await tx.proxyAssignment.create({
      data: {
        proxyId: byCountry.id,
        testDataId: params.testDataId,
        publisherId: params.publisherId,
        offerId: params.offerId,
        active: true,
        assignedById: params.publisherId,
      },
    });
    return strip(byCountry);
  }

  return null;
}

function strip(p: {
  id: string;
  host: string;
  port: number;
  protocol: string;
  username: string | null;
}): ResolvedProxy {
  return { id: p.id, host: p.host, port: p.port, protocol: p.protocol, username: p.username };
}

/**
 * Reveals a proxy password.
 *
 * A publisher may only reveal credentials for a proxy attached to a task session
 * they currently have open. Without that constraint, "publisher can reveal proxy
 * credentials" would let any publisher dump every proxy password in the system.
 * Every reveal is audited.
 */
export async function revealProxyCredentials(
  actor: Actor,
  ctx: AuditContext,
  proxyId: string,
): Promise<{ username: string | null; password: string | null }> {
  return withTransaction(async (tx) => {
    if (actor.role === 'PUBLISHER') {
      const openTask = await tx.taskSession.findFirst({
        where: { publisherId: actor.id, proxyId, status: 'OPEN', expiresAt: { gt: new Date() } },
        select: { id: true },
      });
      if (!openTask) throw new AppError('FORBIDDEN');
    }

    const proxy = await tx.proxy.findUnique({
      where: { id: proxyId },
      select: { id: true, username: true, passwordEnc: true, ownerUserId: true },
    });
    if (!proxy) throw new AppError('NOT_FOUND');

    if (actor.role === 'MANAGER' && proxy.ownerUserId !== actor.id) {
      throw new AppError('FORBIDDEN');
    }

    await writeAudit(tx, ctx, {
      action: 'proxy.credentials_revealed',
      entityType: 'proxy',
      entityId: proxy.id,
      // Deliberately records that a reveal happened, never what was revealed.
      metadata: { revealedTo: actor.id, role: actor.role },
    });

    return { username: proxy.username, password: decryptSecret(proxy.passwordEnc) };
  });
}

/** List view. Never includes credentials, for any role. */
export async function listProxies(actor: Actor) {
  const where = actor.role === 'SUPER_ADMIN' ? {} : { ownerUserId: actor.id };

  return prisma.proxy.findMany({
    where,
    orderBy: [{ countryCode: 'asc' }, { label: 'asc' }],
    select: {
      id: true,
      label: true,
      host: true,
      port: true,
      protocol: true,
      username: true,
      countryCode: true,
      status: true,
      lastCheckedAt: true,
      lastCheckOk: true,
      createdAt: true,
      // passwordEnc deliberately absent.
    },
  });
}
