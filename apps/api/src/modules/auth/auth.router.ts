import { Router } from 'express';
import { z } from 'zod';
import { env, isProduction } from '../../config/env.js';
import { authenticate, requireActor } from '../../middleware/auth.js';
import { authLimiter, handler, ok, validate } from '../../middleware/common.js';
import { auditContext } from '../audit/audit.service.js';
import * as service from './auth.service.js';

export const authRouter = Router();

const REFRESH_COOKIE = 'dg_refresh';

/**
 * The refresh token lives in an httpOnly cookie so page JavaScript cannot read
 * it — that is the difference between an XSS bug leaking one session and it
 * leaking a persistent credential. `sameSite: strict` covers CSRF for this
 * cookie; it is only ever sent to the refresh and logout endpoints.
 */
const cookieOptions = {
  httpOnly: true,
  secure: isProduction,
  sameSite: 'strict' as const,
  path: '/api/v1/auth',
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
};

const passwordRules = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200)
  .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v), {
    message: 'Include an uppercase letter, a lowercase letter, and a number',
  });

authRouter.post(
  '/login',
  authLimiter,
  validate({
    body: z.object({
      email: z.string().email().max(255),
      password: z.string().min(1).max(200),
    }),
  }),
  handler(async (req, res) => {
    const result = await service.login(auditContext(req), req.body);
    res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions);
    return ok(res, { accessToken: result.accessToken, user: result.user });
  }),
);

authRouter.post(
  '/refresh',
  authLimiter,
  handler(async (req, res) => {
    const presented = req.cookies?.[REFRESH_COOKIE];
    const result = await service.refresh(auditContext(req), presented ?? '');
    res.cookie(REFRESH_COOKIE, result.refreshToken, cookieOptions);
    return ok(res, { accessToken: result.accessToken });
  }),
);

authRouter.post(
  '/logout',
  handler(async (req, res) => {
    await service.logout(auditContext(req), req.cookies?.[REFRESH_COOKIE]);
    res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
    return ok(res, { loggedOut: true });
  }),
);

authRouter.get(
  '/me',
  authenticate,
  handler(async (req, res) => ok(res, await service.currentUser(requireActor(req).id))),
);

authRouter.post(
  '/change-password',
  authenticate,
  validate({
    body: z.object({
      currentPassword: z.string().min(1).max(200),
      newPassword: passwordRules,
    }),
  }),
  handler(async (req, res) => {
    await service.changePassword(auditContext(req), requireActor(req).id, req.body);
    res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
    return ok(res, { changed: true });
  }),
);
