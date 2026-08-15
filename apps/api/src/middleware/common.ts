import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { AnyZodObject, ZodTypeAny } from 'zod';
import { ERROR_CODES } from '@deposits/shared';
import { env } from '../config/env.js';

/** Correlates every log line for one request. Echoed back for support. */
export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers['x-request-id'];
  req.requestId = typeof incoming === 'string' && incoming.length <= 64 ? incoming : randomUUID();
  res.setHeader('x-request-id', req.requestId);
  next();
}

/**
 * Validates and REPLACES the request part with the parsed result, so handlers
 * receive coerced, stripped values rather than raw strings. Unknown keys are
 * dropped by Zod's default object behaviour, which is what stops a client from
 * smuggling extra fields into a create call.
 */
export function validate(schemas: {
  body?: AnyZodObject | ZodTypeAny;
  query?: AnyZodObject | ZodTypeAny;
  params?: AnyZodObject | ZodTypeAny;
}) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
      if (schemas.query) {
        // req.query is a getter in Express 5; assign to a side channel instead.
        Object.defineProperty(req, 'validatedQuery', {
          value: schemas.query.parse(req.query),
          writable: false,
          configurable: true,
        });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Typed accessor for the validated query, set by `validate`. */
export function query<T>(req: Request): T {
  return (req as unknown as { validatedQuery: T }).validatedQuery;
}

const limiterResponse = {
  success: false as const,
  code: 'RATE_LIMITED' as const,
  message: ERROR_CODES.RATE_LIMITED,
};

export const generalLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: limiterResponse,
});

/**
 * Tighter limit on credential endpoints.
 *
 * Keyed by IP *and* submitted email, so one attacker cannot lock every account
 * from a single address, and a distributed attack still hits the per-account
 * ceiling. Per-account lockout in the auth service is the second layer.
 */
export const authLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: limiterResponse,
  keyGenerator: (req) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase() : '';
    return `${req.ip}:${email}`;
  },
});

/** Wraps an async handler so a rejected promise reaches the error middleware. */
export function handler<T>(
  fn: (req: Request, res: Response) => Promise<T>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

/** The success envelope. Mirrors ApiSuccessBody in the shared package. */
export function ok<T>(res: Response, data: T, status = 200) {
  return res.status(status).json({ success: true, data });
}
