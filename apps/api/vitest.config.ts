import { defineConfig } from 'vitest/config';

/**
 * Tests run against a REAL PostgreSQL server (127.0.0.1:5433, database
 * deposits_test), not a mock and not PGlite.
 *
 * That matters for one specific reason: the concurrency guarantees in this
 * system are provided by `FOR UPDATE SKIP LOCKED` and row locks. Those are
 * behaviours of the database engine under genuinely parallel transactions.
 * A mock cannot exhibit them, and PGlite is single-connection so it cannot
 * either. Testing them anywhere else would be testing nothing.
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    // Concurrency tests open many simultaneous transactions; a shared database
    // across parallel test files would make them interfere.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: ['./src/test/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      PORT: '4001',
      APP_URL: 'http://localhost:3000',
      API_URL: 'http://localhost:4001',
      APP_TIMEZONE: 'Asia/Kolkata',
      DATABASE_URL: 'postgresql://postgres:devlocal@127.0.0.1:5433/deposits_test?schema=public',
      JWT_ACCESS_SECRET: 'test-only-access-secret-padding-to-32-chars!!',
      JWT_REFRESH_SECRET: 'test-only-refresh-secret-padding-to-32-chars',
      COOKIE_SECRET: 'test-only-cookie-secret-padding-to-32-chars!',
      ENCRYPTION_KEY: 'dGVzdC1vbmx5LWtleS1ub3QtZm9yLXByb2R1Y3QhISE=',
      LOG_LEVEL: 'silent',
      // Generous so the shared in-memory limiter does not trip partway through a
      // suite and fail an unrelated assertion. Limiter behaviour is asserted in
      // its own focused test, which sets its own ceiling.
      RATE_LIMIT_MAX: '100000',
      AUTH_RATE_LIMIT_MAX: '100000',
    },
  },
});
