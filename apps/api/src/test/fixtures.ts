import { prisma } from '../db/prisma.js';
import type { Actor } from '../db/scope.js';
import type { AuditContext } from '../modules/audit/audit.service.js';
import { invalidateSuperAdminCache } from '../modules/tasks/tasks.service.js';
import { invalidateSettingsCache } from '../modules/settings/settings.service.js';

/** Wipes every table between tests. Faster than recreating the schema. */
export async function resetDatabase(): Promise<void> {
  // RESTART IDENTITY CASCADE in one statement so foreign keys never block it.
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      audit_logs, notifications, system_settings,
      gameplay_records, withdrawals, balance_entries, deposit_status_changes,
      deposits, leads, task_sessions,
      proxy_assignments, proxies,
      advances, offer_publishers, offer_extensions, offers,
      test_data, import_batches, sessions, users
    RESTART IDENTITY CASCADE
  `);
  invalidateSuperAdminCache();
  invalidateSettingsCache();
}

export const auditCtx: AuditContext = {
  actorUserId: null,
  actorRole: null,
  ipAddress: '127.0.0.1',
  userAgent: 'vitest',
};

export async function createSuperAdmin(email = 'admin@test.local') {
  return prisma.user.create({
    data: {
      email,
      passwordHash: 'x',
      fullName: 'Super Admin',
      role: 'SUPER_ADMIN',
      mustChangePassword: false,
    },
  });
}

export async function createManager(createdById: string, email = 'manager@test.local') {
  return prisma.user.create({
    data: {
      email,
      passwordHash: 'x',
      fullName: 'Manager',
      role: 'MANAGER',
      createdById,
      mustChangePassword: false,
    },
  });
}

export async function createPublisher(managerId: string, email: string) {
  return prisma.user.create({
    data: {
      email,
      passwordHash: 'x',
      fullName: `Publisher ${email}`,
      role: 'PUBLISHER',
      managerId,
      createdById: managerId,
      mustChangePassword: false,
    },
  });
}

export async function createOffer(params: {
  ownerUserId: string;
  countryCode?: string;
  monthlyLeadTarget?: number;
  monthlyDepositTarget?: number;
  leadIntervalSeconds?: number;
  depositIntervalSeconds?: number;
  gameplayIntervalDays?: number;
  dataSourcePolicy?: 'OWNER_ONLY' | 'OWNER_PLUS_SUPER_ADMIN';
}) {
  return prisma.offer.create({
    data: {
      name: 'Test Offer',
      brand: 'TestBrand',
      countryCode: params.countryCode ?? 'US',
      url: 'https://example.test',
      status: 'ACTIVE',
      ownerUserId: params.ownerUserId,
      createdById: params.ownerUserId,
      startDate: new Date('2020-01-01'),
      expiryDate: new Date('2099-12-31'),
      monthlyLeadTarget: params.monthlyLeadTarget ?? 1000,
      monthlyDepositTarget: params.monthlyDepositTarget ?? 1000,
      monthlyDepositAmountTarget: '100000',
      leadIntervalSeconds: params.leadIntervalSeconds ?? 0,
      depositIntervalSeconds: params.depositIntervalSeconds ?? 0,
      gameplayIntervalDays: params.gameplayIntervalDays ?? 3,
      dataSourcePolicy: params.dataSourcePolicy ?? 'OWNER_PLUS_SUPER_ADMIN',
    },
  });
}

export async function assignPublisher(offerId: string, publisherId: string, assignedById: string) {
  return prisma.offerPublisher.create({
    data: { offerId, publisherId, assignedById, active: true },
  });
}

export async function seedTestData(params: {
  ownerUserId: string;
  countryCode?: string;
  count: number;
  prefix?: string;
}) {
  const country = params.countryCode ?? 'US';
  const prefix = params.prefix ?? 'rec';

  await prisma.testData.createMany({
    data: Array.from({ length: params.count }, (_, i) => ({
      ownerUserId: params.ownerUserId,
      countryCode: country,
      firstName: `First${i}`,
      lastName: `Last${i}`,
      email: `${prefix}${i}@test.local`,
      phone: `555${String(i).padStart(7, '0')}`,
      status: 'AVAILABLE' as const,
    })),
  });
}

export function actorFor(user: { id: string; role: string; managerId: string | null }): Actor {
  return { id: user.id, role: user.role as Actor['role'], managerId: user.managerId };
}
