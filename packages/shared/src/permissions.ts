/**
 * The single definition of who may do what.
 *
 * Imported by the backend to ENFORCE and by the frontend to RENDER. The frontend
 * copy decides which sidebar links and buttons exist; it is never the control.
 * Every route re-checks server-side.
 *
 * Capability answers "may this role do this at all". It does NOT answer "may this
 * user touch this row" — that is the data scope, applied separately by
 * scopeFilter(). A capability check without a scope filter is the classic hole
 * (Manager A calling GET /deposits/:id with Manager B's id), so services take the
 * requesting user and filter single-row reads as well as lists.
 */

export const ROLES = ['SUPER_ADMIN', 'MANAGER', 'PUBLISHER'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  // users
  'manager.create',
  'manager.update',
  'manager.disable',
  'manager.read',
  'publisher.create',
  'publisher.update',
  'publisher.disable',
  'publisher.read',
  'publisher.reassign',

  // offers
  'offer.create',
  'offer.update',
  'offer.status',
  'offer.extend',
  'offer.assign',
  'offer.read',

  // test data
  'testdata.upload',
  'testdata.read',
  'testdata.manage', // release / disable / reset
  'testdata.stats',

  // tasks and activity
  'task.perform',
  'lead.read',
  'lead.reset',

  // deposits
  'deposit.create',
  'deposit.read',
  'deposit.status',
  'deposit.balance',
  'deposit.secret.reveal',
  'gameplay.confirm',

  // money
  'withdrawal.create',
  'withdrawal.read',
  'advance.create',
  'advance.read',

  // proxies
  'proxy.manage',
  'proxy.read',
  'proxy.credentials.reveal',
  'proxy.assign',

  // system
  'report.read',
  'audit.read',
  'audit.read.all',
  'settings.manage',
  'export.data',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PUBLISHER_PERMISSIONS: Permission[] = [
  'offer.read',
  'task.perform',
  'lead.read',
  'deposit.create',
  'deposit.read',
  'deposit.status',
  'deposit.balance',
  'deposit.secret.reveal',
  'gameplay.confirm',
  'withdrawal.create',
  'withdrawal.read',
  'advance.read',
  'proxy.credentials.reveal',
  'report.read',
];

const MANAGER_PERMISSIONS: Permission[] = [
  'publisher.create',
  'publisher.update',
  'publisher.disable',
  'publisher.read',
  'offer.create',
  'offer.update',
  'offer.status',
  'offer.extend',
  'offer.assign',
  'offer.read',
  'testdata.upload',
  'testdata.read',
  'testdata.manage',
  'testdata.stats',
  'lead.read',
  'deposit.read',
  'deposit.status',
  'deposit.balance',
  'deposit.secret.reveal',
  'gameplay.confirm',
  'withdrawal.read',
  'advance.create',
  'advance.read',
  'proxy.manage',
  'proxy.read',
  'proxy.credentials.reveal',
  'proxy.assign',
  'report.read',
  'audit.read',
  'export.data',
];

/** Super Admin holds every permission. Listed by derivation, not by hand, so a new
 *  permission is never accidentally withheld from them. */
const SUPER_ADMIN_PERMISSIONS: Permission[] = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SUPER_ADMIN: SUPER_ADMIN_PERMISSIONS,
  MANAGER: MANAGER_PERMISSIONS,
  PUBLISHER: PUBLISHER_PERMISSIONS,
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Data scope for a role. Capability says "may do"; this says "to which rows".
 *
 *  ALL   - no filter (Super Admin)
 *  OWNED - rows this manager owns, plus rows belonging to their publishers
 *  SELF  - rows belonging to this user only
 */
export type DataScope = 'ALL' | 'OWNED' | 'SELF';

export function scopeFor(role: Role): DataScope {
  switch (role) {
    case 'SUPER_ADMIN':
      return 'ALL';
    case 'MANAGER':
      return 'OWNED';
    case 'PUBLISHER':
      return 'SELF';
  }
}

/**
 * Test data visibility, which is deliberately NARROWER than consumption.
 *
 * A manager's offers may CONSUME from the Super Admin central pool, but a manager
 * may never SEE those records — not in a list, search, filter, count, or export.
 * Returns the set of owner ids whose records this user may view.
 */
export function testDataVisibleOwnerIds(user: { id: string; role: Role }): string[] | 'ALL' {
  return user.role === 'SUPER_ADMIN' ? 'ALL' : [user.id];
}
