import { createApp } from './app.js';
import { env } from './config/env.js';
import { disconnect } from './db/prisma.js';
import { logger } from './lib/logger.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV, tz: env.APP_TIMEZONE }, 'api listening');
});

/**
 * Graceful shutdown. PM2 sends SIGINT on reload; finishing in-flight requests
 * before closing the pool is what makes a deploy zero-downtime rather than
 * merely fast.
 */
async function shutdown(signal: string) {
  logger.info({ signal }, 'shutting down');

  const forced = setTimeout(() => {
    logger.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10_000);
  forced.unref();

  server.close(async () => {
    await disconnect();
    clearTimeout(forced);
    logger.info('shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception, exiting');
  process.exit(1);
});
