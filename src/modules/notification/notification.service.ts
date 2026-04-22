import prisma from '@/config/prisma';
import { NotificationCategory, NotificationSeverity, Prisma } from '@prisma/client';
import logger from '@/utils/logger';

export interface CreateNotificationInput {
  tenantId: string;
  userId?: string | null;
  category: NotificationCategory;
  severity?: NotificationSeverity;
  title: string;
  message: string;
  actionUrl?: string;
  data?: Record<string, unknown>;
  sourceEventId?: string;
  sourceTopic?: string;
}

export interface ListQuery {
  tenantId: string;
  userId?: string;
  isRead?: boolean;
  category?: NotificationCategory;
  skipCount?: number;
  maxResultCount?: number;
}

export class NotificationService {
  async create(input: CreateNotificationInput) {
    // Idempotent on (sourceEventId, category) when sourceEventId is given,
    // so re-delivered Kafka messages don't duplicate the bell.
    if (input.sourceEventId) {
      const existing = await prisma.notification.findFirst({
        where: { tenantId: input.tenantId, sourceEventId: input.sourceEventId, category: input.category },
      });
      if (existing) {
        logger.info('Notification already exists for sourceEventId=%s, skipping', input.sourceEventId);
        return existing;
      }
    }
    return prisma.notification.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId ?? null,
        category: input.category,
        severity: input.severity ?? 'info',
        title: input.title.substring(0, 200),
        message: input.message.substring(0, 2000),
        actionUrl: input.actionUrl,
        data: (input.data ?? {}) as Prisma.JsonObject,
        sourceEventId: input.sourceEventId,
        sourceTopic: input.sourceTopic,
      },
    });
  }

  async list(q: ListQuery) {
    const skip = Math.max(0, q.skipCount ?? 0);
    const take = Math.min(200, Math.max(1, q.maxResultCount ?? 50));
    const where: Prisma.NotificationWhereInput = {
      tenantId: q.tenantId,
      // include both user-specific AND tenant-broadcast (userId IS NULL)
      OR: q.userId ? [{ userId: q.userId }, { userId: null }] : undefined,
      isRead: q.isRead,
      category: q.category,
    };
    const [items, total] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.notification.count({ where }),
    ]);
    return { items, total };
  }

  async unreadCount(tenantId: string, userId: string) {
    return prisma.notification.count({
      where: {
        tenantId,
        isRead: false,
        OR: [{ userId }, { userId: null }],
      },
    });
  }

  async markRead(id: string, tenantId: string, userId: string) {
    const n = await prisma.notification.findFirst({
      where: { id, tenantId, OR: [{ userId }, { userId: null }] },
    });
    if (!n) return null;
    if (n.isRead) return n;
    return prisma.notification.update({
      where: { id },
      data: { isRead: true, readAt: new Date() },
    });
  }

  async markAllRead(tenantId: string, userId: string) {
    const r = await prisma.notification.updateMany({
      where: { tenantId, isRead: false, OR: [{ userId }, { userId: null }] },
      data: { isRead: true, readAt: new Date() },
    });
    return r.count;
  }
}

export default new NotificationService();
