import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { can, type Permission } from '@deposits/shared';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import type { Actor } from '../db/scope.js';
import { AppError } from '../lib/errors.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
      requestId?: string;
    }
  }
}

export interface AccessTokenPayload {
  sub: string;
  role: Actor['role'];
  sid: string;
}

/**
 * Verifies the access token and loads the current user.
 *
 * The database read on every request is deliberate. A JWT is a snapshot: if an
 * account is disabled, or a publisher is moved to a different manager, a
 * token-only check would keep honouring the stale claims until it expires — up
 * to fifteen minutes of access that should already have been revoked. For an
 * internal tool at this scale the lookup is cheap and the correctness is worth
 * more than the microseconds.
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new AppError('UNAUTHENTICATED');

    const token = header.slice(7);

    let payload: AccessTokenPayload;
    try {
      payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
    } catch (err) {
      const expired = err instanceof jwt.TokenExpiredError;
      throw new AppError(expired ? 'SESSION_EXPIRED' : 'UNAUTHENTICATED');
    }

    const [user, session] = await Promise.all([
      prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, role: true, managerId: true, status: true, mustChangePassword: true },
      }),
      prisma.session.findUnique({
        where: { id: payload.sid },
        select: { revokedAt: true, expiresAt: true },
      }),
    ]);

    if (!user) throw new AppError('UNAUTHENTICATED');
    if (user.status === 'DISABLED') throw new AppError('ACCOUNT_DISABLED');

    // A logged-out or expired session must stop working immediately, not when
    // the access token happens to expire.
    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      throw new AppError('SESSION_EXPIRED');
    }

    // A user under a forced password change may only reach the endpoints that
    // let them change it. Everything else is closed.
    //
    // Built from baseUrl + path, not req.path alone: inside a mounted router
    // req.path is relative to the mount point, so '/api/v1/auth/me' arrives here
    // as '/me' and a naive comparison silently never matches.
    const fullPath = `${req.baseUrl}${req.path}`;
    const allowedWhilePasswordChangePending = [
      '/api/v1/auth/change-password',
      '/api/v1/auth/me',
      '/api/v1/auth/logout',
    ].includes(fullPath);

    if (user.mustChangePassword && !allowedWhilePasswordChangePending) {
      throw new AppError('PASSWORD_CHANGE_REQUIRED');
    }

    req.actor = { id: user.id, role: user.role, managerId: user.managerId };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Capability check. Answers "may this role do this at all", never "to which
 * rows" — that is the scope filter's job, applied inside each service.
 */
export function authorize(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const actor = req.actor;
    if (!actor) return next(new AppError('UNAUTHENTICATED'));

    const allowed = permissions.every((p) => can(actor.role, p));
    if (!allowed) return next(new AppError('FORBIDDEN'));

    next();
  };
}

/** For routes only a Super Admin may reach, regardless of permission table. */
export function superAdminOnly(req: Request, _res: Response, next: NextFunction) {
  if (req.actor?.role !== 'SUPER_ADMIN') return next(new AppError('FORBIDDEN'));
  next();
}

export function requireActor(req: Request): Actor {
  if (!req.actor) throw new AppError('UNAUTHENTICATED');
  return req.actor;
}
