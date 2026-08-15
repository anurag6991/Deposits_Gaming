import type { Role } from '@deposits/shared';
import { forbidden } from '../lib/errors.js';

/**
 * Data scoping — the one place a role becomes a WHERE clause.
 *
 * Capability ("may a MANAGER read deposits at all?") is checked by the authorize
 * middleware. This file answers the separate and more dangerous question: "WHICH
 * deposits?". A capability check without a scope filter is the classic hole —
 * Manager A calling GET /deposits/:id with an id belonging to Manager B.
 *
 * Every service that reads user-owned data calls one of these and spreads the
 * result into its `where`. Single-row reads included: fetching by id and then
 * checking ownership in JavaScript is easy to forget, so the filter goes into the
 * query itself and a wrong-owner read simply returns nothing.
 */

export interface Actor {
  id: string;
  role: Role;
  managerId: string | null;
}

/**
 * Activity rows (leads, deposits, withdrawals) carry both publisher_id and a
 * denormalised manager_id, so scoping is a straight equality on one of them.
 */
export function activityScope(actor: Actor) {
  switch (actor.role) {
    case 'SUPER_ADMIN':
      return {};
    case 'MANAGER':
      return { managerId: actor.id };
    case 'PUBLISHER':
      return { publisherId: actor.id };
  }
}

/**
 * Offers. A manager sees offers they own plus any offer their publishers are
 * assigned to (a Super Admin offer worked by their team is legitimately theirs to
 * monitor). A publisher sees only offers they are actively assigned to.
 */
export function offerScope(actor: Actor) {
  switch (actor.role) {
    case 'SUPER_ADMIN':
      return {};
    case 'MANAGER':
      return {
        OR: [
          { ownerUserId: actor.id },
          { assignments: { some: { publisher: { managerId: actor.id } } } },
        ],
      };
    case 'PUBLISHER':
      return { assignments: { some: { publisherId: actor.id, active: true } } };
  }
}

/**
 * Users. A manager sees themselves and their own publishers, nobody else.
 */
export function userScope(actor: Actor) {
  switch (actor.role) {
    case 'SUPER_ADMIN':
      return {};
    case 'MANAGER':
      return { OR: [{ id: actor.id }, { managerId: actor.id }] };
    case 'PUBLISHER':
      return { id: actor.id };
  }
}

/**
 * Test data VISIBILITY, which is deliberately narrower than consumption.
 *
 * A manager's offers may consume from the Super Admin central pool, but a manager
 * may never SEE those records. Do not reuse the consumption owner-set here — that
 * conflation is precisely the bug this separation exists to prevent.
 *
 * Publishers get no visibility at all; they receive one reserved identity through
 * the task endpoints and can never enumerate the table.
 */
export function testDataScope(actor: Actor) {
  switch (actor.role) {
    case 'SUPER_ADMIN':
      return {};
    case 'MANAGER':
      return { ownerUserId: actor.id };
    case 'PUBLISHER':
      throw forbidden();
  }
}

/**
 * Test data CONSUMPTION — which owners' records an offer may draw from.
 * Wider than visibility by design. See docs/DECISIONS.md item 1.
 */
export function consumableOwnerIds(
  offerOwnerId: string,
  policy: 'OWNER_ONLY' | 'OWNER_PLUS_SUPER_ADMIN',
  superAdminIds: string[],
): string[] {
  if (policy === 'OWNER_ONLY') return [offerOwnerId];
  return [...new Set([offerOwnerId, ...superAdminIds])];
}

/**
 * Guards a mutation on a row already loaded from the database.
 *
 * Use only where the filter could not be pushed into the query. Prefer scoping
 * the query itself.
 */
export function assertCanTouch(
  actor: Actor,
  row: { publisherId?: string; managerId?: string | null; ownerUserId?: string },
): void {
  if (actor.role === 'SUPER_ADMIN') return;

  if (actor.role === 'MANAGER') {
    if (row.managerId === actor.id || row.ownerUserId === actor.id) return;
    throw forbidden();
  }

  if (row.publisherId === actor.id) return;
  throw forbidden();
}
