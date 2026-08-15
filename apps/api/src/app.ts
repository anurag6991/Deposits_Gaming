import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env.js';
import { prisma } from './db/prisma.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { generalLimiter, ok, requestId } from './middleware/common.js';
import { authRouter } from './modules/auth/auth.router.js';
import { apiRouter } from './modules/routes.js';
import { tasksRouter } from './modules/tasks/tasks.router.js';

/**
 * Express application, separated from server.ts so tests can mount it without
 * binding a port.
 */
export function createApp() {
  const app = express();

  // Behind Nginx. Without this, req.ip is the proxy and per-IP rate limiting
  // would treat every user as the same client.
  app.set('trust proxy', 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(
    cors({
      origin: env.APP_URL,
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieParser(env.COOKIE_SECRET));
  app.use(requestId);

  // Health check is deliberately before the rate limiter so monitoring cannot
  // be throttled into reporting a false outage.
  app.get('/api/v1/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return ok(res, { status: 'ok', uptime: process.uptime() });
    } catch {
      return res.status(503).json({ success: false, code: 'INTERNAL', message: 'Database unavailable.' });
    }
  });

  app.use('/api/v1', generalLimiter);
  app.use('/api/v1/auth', authRouter);
  app.use('/api/v1/tasks', tasksRouter);
  app.use('/api/v1', apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
