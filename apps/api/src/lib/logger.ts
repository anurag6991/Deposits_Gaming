import pino from 'pino';
import { env, isProduction } from '../config/env.js';

/**
 * Application logger.
 *
 * The redaction list is the important part. Handlers routinely log a whole
 * request or entity for context, and without redaction that is how a password,
 * a refresh token, or a proxy secret ends up sitting in a log file forever.
 * Redaction is applied centrally so no call site has to remember.
 */

const REDACT = [
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'password_hash',
  'token',
  'accessToken',
  'refreshToken',
  'refreshTokenHash',
  'authorization',
  'cookie',
  'accountSecret',
  'accountSecretEnc',
  'proxyPassword',
  'passwordEnc',
  'ENCRYPTION_KEY',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'DATABASE_URL',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.passwordHash',
  '*.token',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: REDACT, censor: '[redacted]' },
  base: { service: 'deposits-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isProduction
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }),
});

export type Logger = typeof logger;
