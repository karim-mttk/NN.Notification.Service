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
    // Visibility model:
    //   - org broadcast row (userId=null) in the active tenant is shown to
    //     every user of that tenant.
    //   - user-targeted row in the active tenant is shown to that user.
    //   - user-targeted row in a different tenant is also shown to that user
    //     (covers operators that switched their active org in the UI).
    // Read state is per-user, derived from NotificationReceipt — see below.
    const visibility: Prisma.NotificationWhereInput[] = [
      { tenantId: q.tenantId, userId: null },
    ];
    if (q.userId) {
      visibility.push({ tenantId: q.tenantId, userId: q.userId });
      visibility.push({ userId: q.userId });
    }
    const where: Prisma.NotificationWhereInput = {
      OR: visibility,
      category: q.category,
    };
    if (q.isRead !== undefined && q.userId) {
      // Filter by the per-user receipt rather than the legacy row-level flag.
      where.receipts = q.isRead
        ? { some: { userId: q.userId } }
        : { none: { userId: q.userId } };
    }
    const [rows, total] = await Promise.all([
      prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: q.userId
          ? { receipts: { where: { userId: q.userId }, take: 1 } }
          : undefined,
      }),
      prisma.notification.count({ where }),
    ]);
    const items = rows.map((r) => projectForUser(r, q.userId));
    return { items, total };
  }

  async unreadCount(tenantId: string, userId: string) {
    return prisma.notification.count({
      where: {
        OR: [
          { tenantId, userId: null },
          { tenantId, userId },
          { userId },
        ],
        receipts: { none: { userId } },
      },
    });
  }

  async markRead(id: string, tenantId: string, userId: string) {
    const n = await prisma.notification.findFirst({
      where: {
        id,
        OR: [
          { tenantId, userId: null },
          { tenantId, userId },
          { userId },
        ],
      },
      include: { receipts: { where: { userId }, take: 1 } },
    });
    if (!n) return null;
    if (n.receipts.length > 0) return projectForUser(n, userId);
    await prisma.notificationReceipt.upsert({
      where: { notificationId_userId: { notificationId: id, userId } },
      create: { notificationId: id, userId, readAt: new Date() },
      update: {},
    });
    return projectForUser(
      { ...n, receipts: [{ notificationId: id, userId, readAt: new Date() }] as any },
      userId,
    );
  }

  async markAllRead(tenantId: string, userId: string) {
    // Find every visible-to-user notification that does NOT yet have a
    // receipt for this user, then create the receipts in one shot.
    const targets = await prisma.notification.findMany({
      where: {
        OR: [
          { tenantId, userId: null },
          { tenantId, userId },
          { userId },
        ],
        receipts: { none: { userId } },
      },
      select: { id: true },
    });
    if (targets.length === 0) return 0;
    const result = await prisma.notificationReceipt.createMany({
      data: targets.map((t) => ({ notificationId: t.id, userId })),
      skipDuplicates: true,
    });
    return result.count;
  }
}

/// Strip receipt rows from the persisted notification and project per-user
/// `isRead` / `readAt` so REST consumers (the platform bell) keep their
/// existing DTO shape.
function projectForUser(
  row: any,
  userId: string | undefined,
): any {
  const { receipts, ...rest } = row;
  if (!userId) return { ...rest, isRead: false, readAt: null };
  const receipt = Array.isArray(receipts) && receipts.length > 0 ? receipts[0] : null;
  return {
    ...rest,
    isRead: !!receipt,
    readAt: receipt ? receipt.readAt : null,
  };
}

export default new NotificationService();
