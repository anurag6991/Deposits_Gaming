import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { authenticate, authorize, requireActor, superAdminOnly } from '../middleware/auth.js';
import { handler, ok, query, validate } from '../middleware/common.js';
import { auditContext } from './audit/audit.service.js';
import * as advances from './advances/advances.service.js';
import * as deposits from './deposits/deposits.service.js';
import * as leads from './leads/leads.service.js';
import * as offers from './offers/offers.service.js';
import * as proxies from './proxies/proxies.service.js';
import * as reports from './reports/reports.service.js';
import * as settings from './settings/settings.service.js';
import * as testData from './test-data/import.service.js';
import * as users from './users/users.service.js';
import { prisma } from '../db/prisma.js';
import { testDataScope } from '../db/scope.js';

/**
 * Route definitions for every module except auth and tasks, which have their own
 * files because their middleware differs.
 *
 * Each route declares its capability with `authorize`. The data scope is applied
 * inside the service, never here — see docs/PERMISSIONS.md for why both layers
 * are needed.
 */

const uuid = z.string().uuid();
const money = z.string().regex(/^\d+(\.\d{1,2})?$/, 'Use a number such as 100 or 100.50');
const monthKeyParam = z.string().regex(/^\d{4}-\d{2}$/);

// Files are held in memory, parsed, and discarded. Uploads are never written to
// disk, which removes a whole class of path-traversal and leftover-file issues.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});

export const apiRouter = Router();
apiRouter.use(authenticate);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const usersRouter = Router();

usersRouter.get(
  '/',
  authorize('publisher.read'),
  validate({
    query: z.object({
      role: z.enum(['MANAGER', 'PUBLISHER']).optional(),
      managerId: uuid.optional(),
      status: z.enum(['ACTIVE', 'DISABLED']).optional(),
      search: z.string().max(100).optional(),
    }),
  }),
  handler(async (req, res) => ok(res, await users.listUsers(requireActor(req), query(req)))),
);

usersRouter.get(
  '/:id',
  authorize('publisher.read'),
  validate({ params: z.object({ id: uuid }) }),
  handler(async (req, res) => ok(res, await users.getUser(requireActor(req), req.params.id as string))),
);

usersRouter.post(
  '/',
  authorize('publisher.create'),
  validate({
    body: z.object({
      email: z.string().email().max(255),
      fullName: z.string().min(1).max(120),
      password: z.string().min(12).max(200),
      role: z.enum(['MANAGER', 'PUBLISHER']),
      phone: z.string().max(40).optional(),
      managerId: uuid.optional(),
    }),
  }),
  handler(async (req, res) =>
    ok(res, await users.createUser(requireActor(req), auditContext(req), req.body), 201),
  ),
);

usersRouter.patch(
  '/:id',
  authorize('publisher.update'),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({
      fullName: z.string().min(1).max(120).optional(),
      phone: z.string().max(40).nullable().optional(),
    }),
  }),
  handler(async (req, res) =>
    ok(res, await users.updateUser(requireActor(req), auditContext(req), req.params.id as string, req.body)),
  ),
);

usersRouter.post(
  '/:id/status',
  authorize('publisher.disable'),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({ status: z.enum(['ACTIVE', 'DISABLED']) }),
  }),
  handler(async (req, res) =>
    ok(
      res,
      await users.setUserStatus(
        requireActor(req),
        auditContext(req),
        req.params.id as string,
        req.body.status,
      ),
    ),
  ),
);

usersRouter.post(
  '/:id/assign-manager',
  superAdminOnly,
  validate({ params: z.object({ id: uuid }), body: z.object({ managerId: uuid }) }),
  handler(async (req, res) =>
    ok(
      res,
      await users.reassignPublisher(
        requireActor(req),
        auditContext(req),
        req.params.id as string,
        req.body.managerId,
      ),
    ),
  ),
);

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

const offersRouter = Router();

const offerBody = z.object({
  name: z.string().min(1).max(120),
  brand: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  notes: z.string().max(2000).optional(),
  publisherInstructions: z.string().max(2000).optional(),
  countryCode: z.string().length(2),
  url: z.string().url().max(500),
  startDate: z.string().optional(),
  expiryDate: z.string().optional(),
  monthlyLeadTarget: z.number().int().min(0).max(1_000_000),
  monthlyDepositTarget: z.number().int().min(0).max(1_000_000),
  monthlyDepositAmountTarget: money,
  lifetimeDepositAmountTarget: money.optional(),
  leadIntervalSeconds: z.number().int().min(0).max(2_592_000),
  depositIntervalSeconds: z.number().int().min(0).max(2_592_000),
  gameplayIntervalDays: z.number().int().min(1).max(365),
  dataSourcePolicy: z.enum(['OWNER_PLUS_SUPER_ADMIN', 'OWNER_ONLY']).optional(),
  lowDataThreshold: z.number().int().min(0).max(100_000).optional(),
  status: z.enum(['DRAFT', 'ACTIVE']).optional(),
});

offersRouter.get(
  '/',
  authorize('offer.read'),
  validate({
    query: z.object({
      status: z.string().optional(),
      countryCode: z.string().length(2).optional(),
      search: z.string().max(100).optional(),
    }),
  }),
  handler(async (req, res) => ok(res, await offers.listOffers(requireActor(req), query(req)))),
);

offersRouter.post(
  '/',
  authorize('offer.create'),
  validate({ body: offerBody }),
  handler(async (req, res) =>
    ok(res, await offers.createOffer(requireActor(req), auditContext(req), req.body), 201),
  ),
);

offersRouter.get(
  '/:id/progress',
  authorize('offer.read'),
  validate({ params: z.object({ id: uuid }), query: z.object({ monthKey: monthKeyParam.optional() }) }),
  handler(async (req, res) =>
    ok(
      res,
      await offers.offerProgress(
        requireActor(req),
        req.params.id as string,
        query<{ monthKey?: string }>(req).monthKey,
      ),
    ),
  ),
);

offersRouter.get(
  '/:id/data-health',
  authorize('offer.read'),
  validate({ params: z.object({ id: uuid }) }),
  handler(async (req, res) =>
    ok(res, await offers.offerDataHealth(requireActor(req), req.params.id as string)),
  ),
);

offersRouter.patch(
  '/:id',
  authorize('offer.update'),
  validate({ params: z.object({ id: uuid }), body: offerBody.partial() }),
  handler(async (req, res) =>
    ok(res, await offers.updateOffer(requireActor(req), auditContext(req), req.params.id as string, req.body)),
  ),
);

offersRouter.post(
  '/:id/status',
  authorize('offer.status'),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({
      status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'EXPIRED', 'COMPLETED', 'ARCHIVED']),
    }),
  }),
  handler(async (req, res) =>
    ok(
      res,
      await offers.setOfferStatus(
        requireActor(req),
        auditContext(req),
        req.params.id as string,
        req.body.status,
      ),
    ),
  ),
);

offersRouter.post(
  '/:id/extend',
  authorize('offer.extend'),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({ newExpiryDate: z.string(), reason: z.string().max(500).optional() }),
  }),
  handler(async (req, res) =>
    ok(res, await offers.extendOffer(requireActor(req), auditContext(req), req.params.id as string, req.body)),
  ),
);

offersRouter.post(
  '/:id/publishers',
  authorize('offer.assign'),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({ publisherIds: z.array(uuid).min(1).max(200) }),
  }),
  handler(async (req, res) =>
    ok(
      res,
      await offers.assignPublishers(
        requireActor(req),
        auditContext(req),
        req.params.id as string,
        req.body.publisherIds,
      ),
    ),
  ),
);

offersRouter.delete(
  '/:id/publishers/:publisherId',
  authorize('offer.assign'),
  validate({ params: z.object({ id: uuid, publisherId: uuid }) }),
  handler(async (req, res) => {
    await offers.unassignPublisher(
      requireActor(req),
      auditContext(req),
      req.params.id as string,
      req.params.publisherId as string,
    );
    return ok(res, { unassigned: true });
  }),
);

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const testDataRouter = Router();

testDataRouter.get(
  '/',
  authorize('testdata.read'),
  validate({
    query: z.object({
      countryCode: z.string().length(2).optional(),
      status: z.enum(['AVAILABLE', 'RESERVED', 'USED', 'RELEASED', 'DISABLED']).optional(),
      search: z.string().max(100).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
    }),
  }),
  handler(async (req, res) => {
    const actor = requireActor(req);
    const q = query<{
      countryCode?: string;
      status?: string;
      search?: string;
      page: number;
      pageSize: number;
    }>(req);

    const where = {
      ...testDataScope(actor),
      ...(q.countryCode ? { countryCode: q.countryCode.toUpperCase() } : {}),
      ...(q.status ? { status: q.status as 'AVAILABLE' } : {}),
      ...(q.search
        ? {
            OR: [
              { firstName: { contains: q.search, mode: 'insensitive' as const } },
              { lastName: { contains: q.search, mode: 'insensitive' as const } },
              { email: { contains: q.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.testData.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        select: {
          id: true,
          countryCode: true,
          firstName: true,
          lastName: true,
          email: true,
          phone: true,
          city: true,
          state: true,
          postalCode: true,
          status: true,
          usedAt: true,
          createdAt: true,
        },
      }),
      prisma.testData.count({ where }),
    ]);

    return ok(res, { rows, total, page: q.page, pageSize: q.pageSize });
  }),
);

testDataRouter.get(
  '/stats',
  authorize('testdata.stats'),
  handler(async (req, res) => ok(res, await testData.poolStats(requireActor(req)))),
);

testDataRouter.post(
  '/imports',
  authorize('testdata.upload'),
  upload.single('file'),
  handler(async (req, res) => {
    if (!req.file) throw new AppError('VALIDATION_FAILED', { fields: { file: 'Choose a file to upload.' } });

    const countryCode = String(req.body?.countryCode ?? '');
    const mapping = req.body?.mapping ? JSON.parse(String(req.body.mapping)) : undefined;

    return ok(
      res,
      await testData.previewImport(requireActor(req), {
        buffer: req.file.buffer,
        filename: req.file.originalname,
        countryCode,
        mapping,
      }),
      201,
    );
  }),
);

testDataRouter.post(
  '/imports/:id/confirm',
  authorize('testdata.upload'),
  upload.single('file'),
  validate({ params: z.object({ id: uuid }) }),
  handler(async (req, res) => {
    if (!req.file) throw new AppError('VALIDATION_FAILED', { fields: { file: 'Re-attach the same file to confirm.' } });

    const mapping = req.body?.mapping ? JSON.parse(String(req.body.mapping)) : undefined;

    return ok(
      res,
      await testData.confirmImport(requireActor(req), auditContext(req), {
        batchId: req.params.id as string,
        buffer: req.file.buffer,
        mapping,
      }),
    );
  }),
);

testDataRouter.post(
  '/:id/manage',
  authorize('testdata.manage'),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({
      action: z.enum(['release', 'disable', 'reset']),
      reason: z.string().max(500).optional(),
    }),
  }),
  handler(async (req, res) =>
    ok(
      res,
      await testData.manageRecord(
        requireActor(req),
        auditContext(req),
        req.params.id as string,
        req.body.action,
        req.body.reason,
      ),
    ),
  ),
);

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

const depositsRouter = Router();

depositsRouter.get(
  '/',
  authorize('deposit.read'),
  validate({
    query: z.object({
      offerId: uuid.optional(),
      publisherId: uuid.optional(),
      managerId: uuid.optional(),
      status: z.enum(['ACTIVE', 'COMPLETED']).optional(),
      gameplay: z.enum(['ALL', 'OK', 'DUE', 'OVERDUE']).optional(),
      monthKey: monthKeyParam.optional(),
      from: z.string().optional(),
      to: z.string().optional(),
      search: z.string().max(100).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
    }),
  }),
  handler(async (req, res) => ok(res, await deposits.listDeposits(requireActor(req), query(req)))),
);

depositsRouter.post(
  '/',
  authorize('deposit.create'),
  validate({
    body: z.object({
      taskSessionId: uuid,
      accountName: z.string().min(1).max(120),
      accountEmail: z.string().email().max(255),
      accountSecret: z.string().max(200).optional(),
      amount: money,
      method: z.string().min(1).max(60),
      notes: z.string().max(1000).optional(),
    }),
  }),
  handler(async (req, res) =>
    ok(res, await deposits.createDeposit(requireActor(req), auditContext(req), req.body), 201),
  ),
);

depositsRouter.post(
  '/:id/status',
  authorize('deposit.status'),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({ status: z.enum(['ACTIVE', 'COMPLETED']), note: z.string().max(500).optional() }),
  }),
  handler(async (req, res) => {
    await deposits.changeDepositStatus(
      requireActor(req),
      auditContext(req),
      req.params.id as string,
      req.body,
    );
    return ok(res, { updated: true });
  }),
);

depositsRouter.post(
  '/:id/balance',
  authorize('deposit.balance'),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({ newBalance: money, note: z.string().max(500).optional() }),
  }),
  handler(async (req, res) =>
    ok(res, await deposits.updateBalance(requireActor(req), auditContext(req), req.params.id as string, req.body)),
  ),
);

depositsRouter.post(
  '/:id/gameplay',
  authorize('gameplay.confirm'),
  validate({ params: z.object({ id: uuid }) }),
  handler(async (req, res) =>
    ok(res, await deposits.confirmGameplay(requireActor(req), auditContext(req), req.params.id as string)),
  ),
);

depositsRouter.post(
  '/:id/withdrawals',
  authorize('withdrawal.create'),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({
      amount: money,
      method: z.string().max(60).optional(),
      withdrawnAt: z.string().optional(),
      notes: z.string().max(500).optional(),
    }),
  }),
  handler(async (req, res) =>
    ok(
      res,
      await deposits.createWithdrawal(requireActor(req), auditContext(req), req.params.id as string, req.body),
      201,
    ),
  ),
);

depositsRouter.get(
  '/:id/secret',
  authorize('deposit.secret.reveal'),
  validate({ params: z.object({ id: uuid }) }),
  handler(async (req, res) =>
    ok(res, await deposits.revealDepositSecret(requireActor(req), auditContext(req), req.params.id as string)),
  ),
);

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

const leadsRouter = Router();

leadsRouter.post(
  '/:id/reset',
  superAdminOnly,
  validate({
    params: z.object({ id: uuid }),
    // A reason is mandatory: this rewrites history and returns a consumed
    // identity to the pool.
    body: z.object({ reason: z.string().min(3).max(500) }),
  }),
  handler(async (req, res) => {
    await leads.resetLead(requireActor(req), auditContext(req), req.params.id as string, req.body.reason);
    return ok(res, { reset: true });
  }),
);

// ---------------------------------------------------------------------------
// Advances, proxies, reports, settings, notifications, audit
// ---------------------------------------------------------------------------

const withdrawalsRouter = Router();

withdrawalsRouter.get(
  '/',
  authorize('withdrawal.read'),
  validate({
    query: z.object({
      publisherId: uuid.optional(),
      offerId: uuid.optional(),
      monthKey: monthKeyParam.optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    }),
  }),
  handler(async (req, res) => ok(res, await deposits.listWithdrawals(requireActor(req), query(req)))),
);

const advancesRouter = Router();

advancesRouter.get(
  '/',
  authorize('advance.read'),
  validate({
    query: z.object({
      publisherId: uuid.optional(),
      monthKey: monthKeyParam.optional(),
      status: z.enum(['PENDING', 'PAID', 'CANCELLED']).optional(),
    }),
  }),
  handler(async (req, res) => ok(res, await advances.listAdvances(requireActor(req), query(req)))),
);

advancesRouter.post(
  '/',
  authorize('advance.create'),
  validate({
    body: z.object({
      publisherId: uuid,
      amount: money,
      monthKey: monthKeyParam.optional(),
      paidOn: z.string().optional(),
      notes: z.string().max(500).optional(),
    }),
  }),
  handler(async (req, res) =>
    ok(res, await advances.createAdvance(requireActor(req), auditContext(req), req.body), 201),
  ),
);

advancesRouter.patch(
  '/:id',
  authorize('advance.create'),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({
      status: z.enum(['PENDING', 'PAID', 'CANCELLED']).optional(),
      paidOn: z.string().nullable().optional(),
      notes: z.string().max(500).optional(),
    }),
  }),
  handler(async (req, res) =>
    ok(res, await advances.updateAdvance(requireActor(req), auditContext(req), req.params.id as string, req.body)),
  ),
);

const proxiesRouter = Router();

proxiesRouter.get(
  '/',
  authorize('proxy.read'),
  handler(async (req, res) => ok(res, await proxies.listProxies(requireActor(req)))),
);

proxiesRouter.get(
  '/:id/credentials',
  authorize('proxy.credentials.reveal'),
  validate({ params: z.object({ id: uuid }) }),
  handler(async (req, res) =>
    ok(res, await proxies.revealProxyCredentials(requireActor(req), auditContext(req), req.params.id as string)),
  ),
);

const reportsRouter = Router();

reportsRouter.get(
  '/dashboard',
  authorize('report.read'),
  handler(async (req, res) => ok(res, await reports.dashboard(requireActor(req)))),
);

reportsRouter.get(
  '/offers',
  authorize('report.read'),
  validate({ query: z.object({ monthKey: monthKeyParam.optional() }) }),
  handler(async (req, res) => ok(res, await reports.offerReport(requireActor(req), query(req)))),
);

reportsRouter.get(
  '/publishers',
  authorize('report.read'),
  validate({ query: z.object({ monthKey: monthKeyParam.optional() }) }),
  handler(async (req, res) => ok(res, await reports.publisherReport(requireActor(req), query(req)))),
);

const settingsRouter = Router();

settingsRouter.get(
  '/',
  superAdminOnly,
  handler(async (_req, res) => ok(res, await settings.getAllSettings())),
);

settingsRouter.patch(
  '/',
  superAdminOnly,
  validate({
    body: z.object({
      key: z.enum([
        'app_timezone',
        'offer_default_duration_days',
        'reservation_ttl_minutes',
        'task_session_ttl_minutes',
        'low_data_threshold_default',
        'max_upload_mb',
        'offer_expiry_warning_days',
      ]),
      value: z.union([z.string(), z.number(), z.boolean()]),
    }),
  }),
  handler(async (req, res) => {
    await settings.setSetting(req.body.key, req.body.value, requireActor(req).id);
    return ok(res, { updated: true });
  }),
);

const notificationsRouter = Router();

notificationsRouter.get(
  '/',
  handler(async (req, res) => {
    const actor = requireActor(req);
    const rows = await prisma.notification.findMany({
      where: { userId: actor.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const unread = await prisma.notification.count({ where: { userId: actor.id, readAt: null } });
    return ok(res, { rows, unread });
  }),
);

notificationsRouter.post(
  '/:id/read',
  validate({ params: z.object({ id: uuid }) }),
  handler(async (req, res) => {
    const actor = requireActor(req);
    // Scoped by userId so one user cannot mark another's notification read.
    await prisma.notification.updateMany({
      where: { id: req.params.id as string, userId: actor.id },
      data: { readAt: new Date() },
    });
    return ok(res, { read: true });
  }),
);

const auditRouter = Router();

auditRouter.get(
  '/',
  authorize('audit.read'),
  validate({
    query: z.object({
      entityType: z.string().max(60).optional(),
      entityId: z.string().max(60).optional(),
      action: z.string().max(60).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(200).default(50),
    }),
  }),
  handler(async (req, res) => {
    const actor = requireActor(req);
    const q = query<{
      entityType?: string;
      entityId?: string;
      action?: string;
      page: number;
      pageSize: number;
    }>(req);

    const where = {
      // A manager may read the log, but only their own actions. Full history is
      // Super Admin only.
      ...(actor.role === 'SUPER_ADMIN' ? {} : { actorUserId: actor.id }),
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.action ? { action: q.action } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { actor: { select: { id: true, fullName: true, role: true } } },
      }),
      prisma.auditLog.count({ where }),
    ]);

    return ok(res, { rows, total, page: q.page, pageSize: q.pageSize });
  }),
);

apiRouter.use('/users', usersRouter);
apiRouter.use('/offers', offersRouter);
apiRouter.use('/test-data', testDataRouter);
apiRouter.use('/deposits', depositsRouter);
apiRouter.use('/leads', leadsRouter);
apiRouter.use('/withdrawals', withdrawalsRouter);
apiRouter.use('/advances', advancesRouter);
apiRouter.use('/proxies', proxiesRouter);
apiRouter.use('/reports', reportsRouter);
apiRouter.use('/settings', settingsRouter);
apiRouter.use('/notifications', notificationsRouter);
apiRouter.use('/audit-logs', auditRouter);
