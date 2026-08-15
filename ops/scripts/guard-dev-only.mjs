#!/usr/bin/env node
/**
 * Refuses to run when NODE_ENV=production.
 *
 * Guards the commands that can destroy data — `prisma migrate dev` (which may drop
 * and recreate the database) and the dev seed. Production only ever runs
 * `prisma migrate deploy`, which is additive and never resets.
 *
 * This is a safety net, not the primary control. The primary control is that the
 * deploy script never invokes these commands at all.
 */

const env = process.env.NODE_ENV ?? 'development';

if (env === 'production') {
  console.error(
    '\n  BLOCKED: this command is not permitted with NODE_ENV=production.\n\n' +
      '  `prisma migrate dev` and the dev seed can drop or overwrite data.\n' +
      '  Production migrations run through `npm run db:deploy`\n' +
      '  (prisma migrate deploy), which only applies pending migrations.\n',
  );
  process.exit(1);
}

// A production-looking DATABASE_URL with NODE_ENV unset is the more likely accident.
const url = process.env.DATABASE_URL ?? '';
if (/deposits_prod/i.test(url)) {
  console.error(
    '\n  BLOCKED: DATABASE_URL points at a database named "deposits_prod".\n' +
      '  Refusing to run a destructive command against it.\n',
  );
  process.exit(1);
}
