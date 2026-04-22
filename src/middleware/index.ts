import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  logger.error('Unhandled error on %s %s: %s', req.method, req.url, err?.message ?? err);
  if (res.headersSent) return;
  res.status(err?.status ?? 500).json({
    message: err?.message ?? 'Internal Server Error',
  });
}

export function requestLogger(req: Request, _res: Response, next: NextFunction) {
  logger.info('%s %s', req.method, req.url);
  next();
}
