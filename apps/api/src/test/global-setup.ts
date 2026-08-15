import { execSync } from 'node:child_process';

/**
 * Brings the test database up to the current migration state once per run.
 *
 * `migrate deploy` rather than `migrate reset`: deploy is the same command
 * production uses, so the tests exercise the real migration path. Per-test
 * isolation is handled by truncation in the test helpers, which is far faster
 * than recreating the schema each time.
 *
 * globalSetup runs before vitest injects `test.env`, so the URL is resolved here
 * rather than read from that config.
 */
const DEFAULT_TEST_DATABASE_URL =
  'postgresql://postgres:devlocal@127.0.0.1:5433/deposits_test?schema=public';

export default function setup() {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;

  // A misconfigured URL here would truncate a real database on every test run.
  if (!/deposits_test/.test(url)) {
    throw new Error(`Refusing to run tests against a database that is not deposits_test: ${url}`);
  }

  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}
