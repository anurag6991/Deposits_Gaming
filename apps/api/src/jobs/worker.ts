import cron from 'node-cron';
import { env } from '../config/env.js';
import { disconnect } from '../db/prisma.js';
import { logger } from '../lib/logger.js';
import {
  markExpiredOffers,
  notifyExpiringOffers,
  notifyOverdueGameplay,
  purgeExpiredSessions,
  sweepExpiredReservations,
} from './index.js';

/**
 * The cron worker.
 *
 * Runs as a SINGLE PM2 process (`instances: 1`), separate from the clustered
 * API. Under cluster mode every instance would fire the same schedule on the
 * same tick — duplicate sweeps and duplicate notifications.
 *
 * Schedules use the app timezone so "03:00" means 03:00 IST, not UTC.
 */

const TZ = env.APP_TIMEZONE;

function schedule(expression: string, name: string, fn: () => Promise<unknown>) {
  cron.schedule(
    expression,
    async () => {
      const started = Date.now();
      try {
        const result = await fn();
        logger.info({ job: name, ms: Date.now() - started, result }, 'job complete');
      } catch (err) {
        logger.error({ job: name, err }, 'job failed');
      }
    },
    { timezone: TZ },
  );
  logger.info({ job: name, expression, timezone: TZ }, 'job scheduled');
}

// Frequent: an abandoned task should return to the pool quickly, since a
// starved offer blocks real work.
schedule('*/5 * * * *', 'sweepExpiredReservations', sweepExpiredReservations);

// Hourly is enough for a status that only matters at day granularity.
schedule('0 * * * *', 'markExpiredOffers', markExpiredOffers);

// Once each morning, so publishers see it at the start of the working day
// rather than being pinged through the night.
schedule('0 9 * * *', 'notifyOverdueGameplay', notifyOverdueGameplay);
schedule('30 9 * * *', 'notifyExpiringOffers', notifyExpiringOffers);

// Overnight housekeeping.
schedule('0 3 * * *', 'purgeExpiredSessions', purgeExpiredSessions);

logger.info({ timezone: TZ }, 'cron worker started');

async function shutdown(signal: string) {
  logger.info({ signal }, 'cron worker shutting down');
  await disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
