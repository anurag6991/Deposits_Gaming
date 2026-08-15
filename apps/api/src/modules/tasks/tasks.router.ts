import { Router } from 'express';
import { z } from 'zod';
import { authenticate, authorize, requireActor } from '../../middleware/auth.js';
import { handler, ok, validate } from '../../middleware/common.js';
import { auditContext } from '../audit/audit.service.js';
import * as leads from '../leads/leads.service.js';
import * as service from './tasks.service.js';

export const tasksRouter = Router();

tasksRouter.use(authenticate);

const uuid = z.string().uuid();

/** The publisher's offer dropdown: progress, targets, and live timers. */
tasksRouter.get(
  '/eligible-offers',
  authorize('task.perform'),
  handler(async (req, res) => ok(res, await service.eligibleOffers(requireActor(req)))),
);

tasksRouter.post(
  '/start',
  authorize('task.perform'),
  validate({ body: z.object({ offerId: uuid, type: z.enum(['LEAD', 'DEPOSIT']) }) }),
  handler(async (req, res) =>
    ok(res, await service.startTask(requireActor(req), auditContext(req), req.body), 201),
  ),
);

tasksRouter.post(
  '/:id/abandon',
  authorize('task.perform'),
  validate({ params: z.object({ id: uuid }) }),
  handler(async (req, res) => {
    await service.abandonTask(requireActor(req), auditContext(req), req.params.id as string);
    return ok(res, { abandoned: true });
  }),
);

/** Completing a LEAD task. Deposits complete through /deposits. */
tasksRouter.post(
  '/:id/complete-lead',
  authorize('task.perform'),
  validate({
    params: z.object({ id: uuid }),
    body: z.object({ notes: z.string().max(1000).optional() }),
  }),
  handler(async (req, res) =>
    ok(
      res,
      await leads.completeLead(requireActor(req), auditContext(req), {
        taskSessionId: req.params.id as string,
        notes: req.body.notes,
      }),
      201,
    ),
  ),
);
