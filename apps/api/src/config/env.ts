/**
 * Environment configuration, validated once at boot.
 *
 * Failing fast with a readable list beats discovering a missing variable as
 * `undefined` three layers deep in a request handler at 2am.
 */

import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_URL: z.string().url(),
  API_URL: z.string().url(),
  APP_TIMEZONE: z.string().default('Asia/Kolkata'),

  DATABASE_URL: z.string().min(1),

  JWT_ACCESS_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'must be at least 32 characters'),
  COOKIE_SECRET: z.string().min(32, 'must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

  /** 32 bytes, base64. Encrypts proxy passwords and test-account secrets. */
  ENCRYPTION_KEY: z.string().refine(
    (v) => {
      try {
        return Buffer.from(v, 'base64').length === 32;
      } catch {
        return false;
      }
    },
    { message: 'must be exactly 32 bytes, base64 encoded (openssl rand -base64 32)' },
  ),

  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_DIR: z.string().default('./logs'),
});

function load() {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    // Deliberately console.error, not the logger — the logger needs config.
    console.error(`\nInvalid environment configuration:\n${lines.join('\n')}\n`);
    console.error('See .env.example for the full list of required variables.\n');
    process.exit(1);
  }

  return parsed.data;
}

export const env = load();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Decoded once; used by the crypto helpers. */
export const encryptionKey = Buffer.from(env.ENCRYPTION_KEY, 'base64');
