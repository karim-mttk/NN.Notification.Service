import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { errorHandler, requestLogger } from '@/middleware';
import notificationRoutes from '@/modules/notification/notification.routes';

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(compression());
  app.use(express.json({ limit: '1mb' }));

  const allowed = (process.env.CORS_ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(
    cors({
      origin: allowed.includes('*') ? true : allowed,
      credentials: true,
    })
  );

  app.use(requestLogger);

  app.get('/health', (_req: Request, res: Response) =>
    res.json({ status: 'ok', service: 'notification-service', uptime: process.uptime() })
  );

  app.use('/api/notifications', notificationRoutes);

  app.use(errorHandler);
  return app;
}
