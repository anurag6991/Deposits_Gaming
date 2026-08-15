import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { ERROR_CODES, type ApiErrorBody } from '@deposits/shared';
import { isProduction } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * The only place an error becomes a response.
 *
 * Two rules: the client learns a stable code and a sentence a human can act on,
 * and it learns nothing else. Stack traces, SQL, constraint names, and file paths
 * go to the log, never the wire — they are a map of the system for anyone probing it.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = req.requestId;

  // ---- Known application errors -------------------------------------------
  if (err instanceof AppError) {
    // Expected business refusals are not warnings; they are normal traffic.
    const level = err.status >= 500 ? 'error' : 'debug';
    logger[level]({ requestId, code: err.code, internal: err.internal }, err.message);

    const body: ApiErrorBody = { success: false, code: err.code, message: err.message };
    if (err.fields) body.fields = err.fields;
    return res.status(err.status).json(body);
  }

  // ---- Validation ----------------------------------------------------------
  if (err instanceof ZodError) {
    const fields: Record<string, string> = {};
    for (const issue of err.issues) {
      const key = issue.path.join('.') || '_';
      fields[key] ??= issue.message;
    }
    logger.debug({ requestId, fields }, 'validation failed');
    return res.status(422).json({
      success: false,
      code: 'VALIDATION_FAILED',
      message: ERROR_CODES.VALIDATION_FAILED,
      fields,
    } satisfies ApiErrorBody);
  }

  // ---- Prisma --------------------------------------------------------------
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // Log the full detail; return a generic message. The constraint name would
    // tell an attacker the schema.
    logger.warn({ requestId, prismaCode: err.code, meta: err.meta }, 'prisma known error');

    if (err.code === 'P2002') {
      return res.status(409).json({
        success: false,
        code: 'CONFLICT',
        message: 'That value is already in use.',
      } satisfies ApiErrorBody);
    }
    if (err.code === 'P2025') {
      return res.status(404).json({
        success: false,
        code: 'NOT_FOUND',
        message: ERROR_CODES.NOT_FOUND,
      } satisfies ApiErrorBody);
    }
    if (err.code === 'P2003') {
      return res.status(409).json({
        success: false,
        code: 'CONFLICT',
        message: 'That item is still referenced by other records.',
      } satisfies ApiErrorBody);
    }
  }

  // A CHECK constraint or trigger fired — a bug, since the service layer should
  // have caught it first. Log loudly, tell the user nothing specific.
  if (
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientRustPanicError
  ) {
    logger.error({ requestId, err }, 'prisma low-level failure');
  }

  // ---- Anything else -------------------------------------------------------
  logger.error(
    { requestId, err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
    'unhandled error',
  );

  return res.status(500).json({
    success: false,
    code: 'INTERNAL',
    message: isProduction
      ? ERROR_CODES.INTERNAL
      : `${ERROR_CODES.INTERNAL} (${err instanceof Error ? err.message : String(err)})`,
  } satisfies ApiErrorBody);
}

/** 404 for unmatched routes, in the same envelope as everything else. */
export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({
    success: false,
    code: 'NOT_FOUND',
    message: ERROR_CODES.NOT_FOUND,
  } satisfies ApiErrorBody);
}
