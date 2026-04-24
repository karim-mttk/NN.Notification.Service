const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  try {
    const r = await p.$queryRawUnsafe(
      `SELECT to_regclass('public."NotificationReceipts"')::text AS t`
    );
    console.log('exists:', r);
    if (!r[0].t) {
      console.log('Creating table...');
      await p.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "NotificationReceipts" (
        "notificationId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "readAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "NotificationReceipts_pkey" PRIMARY KEY ("notificationId","userId"),
        CONSTRAINT "NotificationReceipts_notificationId_fkey"
          FOREIGN KEY ("notificationId") REFERENCES "Notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )`);
      await p.$executeRawUnsafe(
        `CREATE INDEX IF NOT EXISTS "NotificationReceipts_userId_readAt_idx" ON "NotificationReceipts"("userId","readAt")`
      );
      console.log('Created.');
    }
  } finally {
    await p.$disconnect();
  }
})().catch((e) => { console.error(e); process.exit(1); });
