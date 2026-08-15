import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { prisma, withTransaction } from '../../db/prisma.js';
import { hashPassword, hashToken, randomToken, verifyPassword } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import { writeAudit, writeAuditStandalone, type AuditContext } from '../audit/audit.service.js';

/**
 * Authentication.
 *
 * Access tokens are short-lived JWTs. Refresh tokens are opaque random strings
 * stored as sha256 digests and rotated on every use, so a stolen database yields
 * nothing replayable and a stolen token is usable at most once.
 */

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    fullName: string;
    role: 'SUPER_ADMIN' | 'MANAGER' | 'PUBLISHER';
    mustChangePassword: boolean;
  };
}

function signAccessToken(userId: string, role: string, sessionId: string): string {
  return jwt.sign({ sub: userId, role, sid: sessionId }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL,
  } as jwt.SignOptions);
}

export async function login(
  ctx: AuditContext,
  input: { email: string; password: string },
): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      status: true,
      passwordHash: true,
      failedLoginCount: true,
      lockedUntil: true,
      mustChangePassword: true,
    },
  });

  // Hash a dummy password when the user does not exist so the response time does
  // not reveal which emails are registered.
  if (!user) {
    await verifyPassword('$argon2id$v=19$m=19456,t=2,p=1$aaaaaaaaaaaaaaaa$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', input.password);
    await writeAuditStandalone(
      { ...ctx, actorUserId: null, actorRole: null },
      { action: 'auth.login_failed', entityType: 'user', metadata: { email, reason: 'no_such_user' } },
    );
    throw new AppError('INVALID_CREDENTIALS');
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    throw new AppError('ACCOUNT_LOCKED');
  }

  const valid = await verifyPassword(user.passwordHash, input.password);

  if (!valid) {
    const attempts = user.failedLoginCount + 1;
    const locked = attempts >= MAX_FAILED_ATTEMPTS;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: locked ? 0 : attempts,
        lockedUntil: locked ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000) : null,
      },
    });

    await writeAuditStandalone(
      { ...ctx, actorUserId: user.id, actorRole: user.role },
      {
        action: 'auth.login_failed',
        entityType: 'user',
        entityId: user.id,
        metadata: { attempts, locked },
      },
    );

    throw new AppError(locked ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS');
  }

  // Checked after password verification so a disabled account cannot be probed
  // with a wrong password to learn that it exists.
  if (user.status === 'DISABLED') throw new AppError('ACCOUNT_DISABLED');

  const refreshToken = randomToken();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

  const session = await withTransaction(async (tx) => {
    const created = await tx.session.create({
      data: {
        userId: user.id,
        refreshTokenHash: hashToken(refreshToken),
        expiresAt,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      },
      select: { id: true },
    });

    await tx.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    await writeAudit(
      tx,
      { ...ctx, actorUserId: user.id, actorRole: user.role },
      { action: 'auth.login', entityType: 'session', entityId: created.id },
    );

    return created;
  });

  return {
    accessToken: signAccessToken(user.id, user.role, session.id),
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      mustChangePassword: user.mustChangePassword,
    },
  };
}

/**
 * Rotates a refresh token.
 *
 * Reuse detection: presenting a token that was already rotated means either the
 * client replayed it or an attacker stole it. We cannot tell which, so we revoke
 * every session for that user and force a fresh login.
 */
export async function refresh(
  ctx: AuditContext,
  presentedToken: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const digest = hashToken(presentedToken);

  return withTransaction(async (tx) => {
    const session = await tx.session.findUnique({
      where: { refreshTokenHash: digest },
      select: {
        id: true,
        userId: true,
        expiresAt: true,
        revokedAt: true,
        user: { select: { role: true, status: true } },
      },
    });

    if (!session) throw new AppError('SESSION_EXPIRED');

    if (session.revokedAt) {
      await tx.session.updateMany({
        where: { userId: session.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await writeAudit(
        tx,
        { ...ctx, actorUserId: session.userId, actorRole: session.user.role },
        {
          action: 'auth.logout',
          entityType: 'session',
          entityId: session.id,
          metadata: { reason: 'refresh_token_reuse_detected' },
        },
      );
      throw new AppError('SESSION_EXPIRED');
    }

    if (session.expiresAt < new Date()) throw new AppError('SESSION_EXPIRED');
    if (session.user.status === 'DISABLED') throw new AppError('ACCOUNT_DISABLED');

    const nextToken = randomToken();

    await tx.session.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });

    const rotated = await tx.session.create({
      data: {
        userId: session.userId,
        refreshTokenHash: hashToken(nextToken),
        expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      },
      select: { id: true },
    });

    return {
      accessToken: signAccessToken(session.userId, session.user.role, rotated.id),
      refreshToken: nextToken,
    };
  });
}

export async function logout(ctx: AuditContext, refreshTokenValue: string | undefined): Promise<void> {
  if (!refreshTokenValue) return;

  const digest = hashToken(refreshTokenValue);
  const session = await prisma.session.findUnique({
    where: { refreshTokenHash: digest },
    select: { id: true, userId: true },
  });
  if (!session) return;

  await withTransaction(async (tx) => {
    await tx.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    await writeAudit(tx, ctx, {
      action: 'auth.logout',
      entityType: 'session',
      entityId: session.id,
    });
  });
}

export async function changePassword(
  ctx: AuditContext,
  userId: string,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, passwordHash: true, role: true },
  });

  const valid = await verifyPassword(user.passwordHash, input.currentPassword);
  if (!valid) throw new AppError('INVALID_CREDENTIALS');

  const hash = await hashPassword(input.newPassword);

  await withTransaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { passwordHash: hash, mustChangePassword: false },
    });

    // Every other session is invalidated. A password change is how a user
    // responds to suspected compromise; leaving old sessions alive defeats it.
    await tx.session.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await writeAudit(tx, ctx, {
      action: 'auth.password_changed',
      entityType: 'user',
      entityId: user.id,
    });
  });
}

export async function currentUser(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      fullName: true,
      role: true,
      status: true,
      managerId: true,
      mustChangePassword: true,
      manager: { select: { id: true, fullName: true } },
    },
  });
}
