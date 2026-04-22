import { Request, Response } from 'express';
import service from './notification.service';
import { NotificationCategory } from '@prisma/client';

function tenant(req: Request) {
  return req.user!.tenantId!;
}
function user(req: Request) {
  return req.user!.userId;
}

export class NotificationController {
  async list(req: Request, res: Response) {
    const isReadQ = req.query.isRead;
    const isRead =
      isReadQ === undefined || isReadQ === '' ? undefined : String(isReadQ).toLowerCase() === 'true';
    const result = await service.list({
      tenantId: tenant(req),
      userId: user(req),
      isRead,
      category: req.query.category ? (String(req.query.category) as NotificationCategory) : undefined,
      skipCount: req.query.skipCount ? Number(req.query.skipCount) : 0,
      maxResultCount: req.query.maxResultCount ? Number(req.query.maxResultCount) : 50,
    });
    res.json(result);
  }

  async unreadCount(req: Request, res: Response) {
    const count = await service.unreadCount(tenant(req), user(req));
    res.json({ count });
  }

  async markRead(req: Request, res: Response) {
    const n = await service.markRead(req.params.id, tenant(req), user(req));
    if (!n) return res.status(404).json({ message: 'Notification not found' });
    res.json(n);
  }

  async markAllRead(req: Request, res: Response) {
    const updated = await service.markAllRead(tenant(req), user(req));
    res.json({ updated });
  }
}

export default new NotificationController();
