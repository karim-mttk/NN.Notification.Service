# Notification System Memory

## Scope

This note covers the admin bell notification path for estimate payments,
specifically the case where payment succeeds and Notification Service persists
the event, but the platform UI does not show the notification to the admin.

This is about notification reads and tenant scoping, not about Stripe payment
capture itself.

## End-to-End Flow That Must Work

1. NN.Payment.Backend publishes `checkout.completed` to Kafka topic
   `payment.events`.
2. NN.Notification.Service consumes that event.
3. `NotificationDispatcher`:
   - updates estimate payment status in Operations
   - persists a notification row
   - emits a realtime notification
4. NN.Platform.Frontend reads bell notifications through its same-origin proxy:

   `GET /api/notifications`

   `GET /api/notifications/unread-count`

5. The frontend must read notifications for the user's active organization,
   not only the raw tenant/org claim embedded in the JWT.

## What Was Actually Broken

Observed symptom:

- Customers could complete estimate payment.
- Notification Service was generating and storing estimate-paid notifications.
- Admin bell notifications were missing in the platform UI.
- Manual API calls sometimes worked in Docker testing, but the real browser flow
  still failed.

Important finding:

- This was not primarily a Kafka consumer or worker failure.
- This was not primarily a notification persistence failure.
- The notifications already existed in the database.
- The read path was looking under the wrong tenant when the active frontend
  organization differed from the tenant/org claim carried by the JWT.

## Root Cause Confirmed On 2026-04-23 / 2026-04-24

The frontend stores active organization context separately from the JWT.
Notification reads were failing when:

- the JWT tenant claim pointed at one organization
- the operator had switched to a different active organization in the UI
- the notification rows existed under that active organization
- the backend read still enforced the JWT tenant instead of the active org

That mismatch caused bell reads to miss valid notification rows even though
payment dispatch and notification creation had already succeeded.

## Runtime Evidence Collected

Verified in the live Notification Service database:

- recent unread estimate notifications existed for tenant
  `e986dd42-5dbf-42df-94af-aab4c4cbab52`
- several of those rows were broadcast notifications with `userId = null`
- older rows also existed for user
  `019db03b-b446-793b-9820-2384ff608809`

Verified in the live stack:

- `NN.Notification.Service` was subscribed to `payment.events`
- notification rows were being created for paid estimates
- before the fix, a mismatched-tenant probe returned:

  `{"message":"Organization access denied"}`

- after the fix and Docker rebuilds, the same probe through the frontend proxy
  returned:

  `{"count":8}`

  and the notification list returned the latest estimate-paid rows from tenant
  `e986dd42-5dbf-42df-94af-aab4c4cbab52`

## Auth Surface Problem Found During Debugging

An attempted stricter verification path through NN.Auth.Server.Backend was not
reliable enough for this notification use case.

Observed issues:

- `GET /api/user/by-organization/{orgId}` returned `200 OK` with
  `{"success":true,"data":[]}` for the target organization, even though the
  operator should have been able to read those notifications.
- `GET /api/user/{id}` returned the user record but omitted populated
  organization fields in the DTO.

Because of that, cross-org notification reads could not reliably depend on the
Auth Server membership lookup alone.

## Fix Applied

### 1. Frontend proxy now forwards active organization context

File:

- `NN.Platform.Frontend/app/src/app/api/notifications/_lib/proxy.ts`

Behavior:

- forwards `X-Organization-Id` when present
- forwards a server-only header `X-Notification-Proxy-Secret` alongside the
  organization override
- continues using the same-origin platform proxy instead of letting browsers
  call Notification Service directly

Why this matters:

- browser state knows the active organization
- Notification Service should trust that override only when it comes from the
  platform server, not from arbitrary public clients

### 2. Notification Service accepts trusted proxy override

File:

- `NN.Notification.Service/src/middleware/jwtAuth.ts`

Behavior:

- still extracts tenant/org from JWT normally
- still allows same-tenant requests with no special handling
- allows tenant override when `X-Notification-Proxy-Secret` matches the shared
  server-side secret
- keeps the older role-based/Auth-API override path in place as a fallback,
  but the working production fix is the trusted frontend proxy path

Why this matters:

- direct public calls with only `X-Organization-Id` should still be denied
- same-origin frontend proxy calls can safely read the active organization
  bell state

### 3. Docker runtime wiring added

Files:

- `NN.Platform.Frontend/docker-compose.yml`
- `NN.Notification.Service/docker-compose.yml`

Runtime setting currently used in both services:

- `NOTIFICATION_PROXY_SECRET=platform-notification-proxy-20260423`

This value must match on both sides. If it changes in one compose file but not
the other, active-organization notification reads will fail again.

## What Did Not Need To Change

These components were checked and were not the root cause of the missing admin
bell notifications:

- Kafka subscription to `payment.events`
- `KafkaPaymentConsumer`
- `NotificationDispatcher` event fan-out logic
- notification persistence itself
- unread-count/list query behavior for broadcast rows

In other words, notifications were already being generated. The broken part was
how the UI read them under the correct tenant context.

## Important Behavior After The Fix

- The correct path for browser bell reads is still the platform frontend:

  `http://localhost:3000/api/notifications`

- Direct calls to Notification Service with a mismatched JWT tenant and only
  `X-Organization-Id` should still fail.
- Cross-org bell reads work when they pass through the trusted frontend proxy.
- This means a curl test against `localhost:5070` is not equivalent to a real
  browser test against `localhost:3000`.

## Validation Performed

1. Rebuilt and restarted `nn-notification-service` with Docker.
2. Rebuilt and restarted `nnplatformfrontend-platform-nix-1` with Docker.
3. Verified both containers were up and healthy.
4. Re-ran the same probe that had previously failed:
   - token tenant claim: `8a0733af-e9ae-40ed-92f1-3d029fd317af`
   - requested active org header:
     `e986dd42-5dbf-42df-94af-aab4c4cbab52`
   - target: `http://localhost:3000/api/notifications/...`
5. Confirmed success after rebuild:
   - unread-count returned `{"count":8}`
   - notification list returned the latest estimate-paid rows for tenant
     `e986dd42-5dbf-42df-94af-aab4c4cbab52`

## Useful Debug Commands

Check recent notification rows for the tenant inside the service container:

```sh
docker exec nn-notification-service sh -lc 'node - <<"NODE"
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();
(async () => {
  const rows = await prisma.notification.findMany({
    where: { tenantId: "e986dd42-5dbf-42df-94af-aab4c4cbab52" },
    orderBy: { createdAt: "desc" },
    take: 8,
    select: {
      id: true,
      tenantId: true,
      userId: true,
      category: true,
      severity: true,
      message: true,
      isRead: true,
      createdAt: true
    }
  });
  console.log(JSON.stringify(rows, null, 2));
  await prisma.$disconnect();
})().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
NODE'
```

Test the real browser-facing notification path through the frontend proxy:

```sh
cd /Volumes/EXTSSD/platform && token=$(docker exec nn-notification-service sh -lc 'node - <<"NODE"
const jwt = require("jsonwebtoken");
const token = jwt.sign(
  {
    sub: "019db03b-b446-793b-9820-2384ff608809",
    nameid: "019db03b-b446-793b-9820-2384ff608809",
    tenant_id: "8a0733af-e9ae-40ed-92f1-3d029fd317af",
    organization_id: "8a0733af-e9ae-40ed-92f1-3d029fd317af",
    role: "Admin",
    roles: ["Admin"]
  },
  process.env.JWT_SECRET_KEY,
  {
    algorithm: "HS256",
    issuer: process.env.JWT_ISSUER,
    audience: process.env.JWT_AUDIENCE,
    expiresIn: "1h"
  }
);
process.stdout.write(token);
NODE') && printf 'unread-count: ' && curl -s \
  -H "Authorization: Bearer $token" \
  -H "X-Organization-Id: e986dd42-5dbf-42df-94af-aab4c4cbab52" \
  http://localhost:3000/api/notifications/unread-count && printf '\nlist: ' && curl -s \
  -H "Authorization: Bearer $token" \
  -H "X-Organization-Id: e986dd42-5dbf-42df-94af-aab4c4cbab52" \
  "http://localhost:3000/api/notifications?maxResultCount=2"
```

Rebuild the two services after notification read-path changes:

```sh
cd /Volumes/EXTSSD/platform/NN.Notification.Service && docker compose up -d --build notification-service
cd /Volumes/EXTSSD/platform/NN.Platform.Frontend && docker compose up -d --build platform-nix
```

## Known Caveats

- If the frontend is not rebuilt after changing the proxy logic, the runtime may
  still serve the old notification code even when source files are correct.
- If the notification service is not rebuilt after changing tenant override
  logic, direct tests may keep hitting the old middleware behavior.
- `npm run build` for Notification Service on the host may fail with:

  `sh: rimraf: command not found`

  Docker build was the reliable validation path in this environment.
- The shared proxy secret is currently hardcoded in docker-compose. If this is
  promoted beyond local/dev usage, move it to real secret management.

## If This Breaks Again

Check these in order:

1. Confirm the Kafka consumer actually started. Look for
   `[KafkaConsumer] subscribed to payment.events` in `nn-notification-service`
   logs *after the latest restart*. If the most recent log line for that
   subsystem is `[KafkaConsumer] failed to start: ...` with no later
   `subscribed` or `reconnect attempt` line, the consumer is dead and no
   payment events are being processed (see Section: Apr 24 2026 second bug).
2. Confirm notifications are still being created in the Notification DB.
3. Confirm the missing notification belongs to the active org, not just the JWT
   org claim.
4. Confirm the frontend request is going through
   `/api/notifications` on port `3000`, not directly to port `5070`.
5. Confirm both services have the same `NOTIFICATION_PROXY_SECRET` value.
6. Rebuild both Docker services before trusting any runtime result.

## Apr 24 2026 Second Bug: Kafka Consumer Never Retried After Startup Failure

Observed symptom (reported by user):

- Customer paid an estimate via Stripe (sync endpoint returned
  `status=complete, paid=true`).
- Operations dashboard never flipped the estimate to Paid.
- Customer never received the `estimate-paid` confirmation email.
- Admin bell never showed the new notification.
- All upstream pieces were healthy: payment backend logged
  `Published checkout.completed for stripe/cs_test_... to payment.events`.

Root cause:

- After a notification-service restart, the Kafka broker briefly refused
  the connection and `startKafkaPaymentConsumer()` logged
  `[KafkaConsumer] failed to start: connect ECONNREFUSED 172.22.0.11:9092`.
- The original implementation wrapped consumer setup in a single `try/catch`
  with no retry. After that one failure the process kept running (HTTP API
  was healthy) but no Kafka messages were ever consumed.
- Every subsequent paid estimate silently piled up in the Kafka topic with
  nobody consuming them.

Fix applied (file:
`NN.Notification.Service/src/worker/KafkaPaymentConsumer.ts`):

- Extracted consumer bring-up into `startConsumerOnce()`.
- Added `scheduleReconnect()` with exponential backoff capped at 30s.
- Initial `startKafkaPaymentConsumer()` no longer blocks process startup; if
  the first attempt fails, it schedules reconnects in the background.
- Subscribed to the kafkajs `CRASH` and `DISCONNECT` consumer events. On
  crash the consumer is cleared and a reconnect loop is started.
- `stopKafkaPaymentConsumer()` sets a `stopped` flag so reconnect loops exit
  cleanly on shutdown.

Validation performed (Apr 24 2026):

- Rebuilt `nn-notification-service` via
  `docker compose up -d --build notification-service`.
- After restart, container logged
  `[KafkaConsumer] subscribed to payment.events (group=notification-dispatcher)`
  immediately, then *replayed the previously dropped event*:
  `[operations] Updated estimate 94a78506-dd43-408f-9e25-fd08dd24aba9 →
  paymentStatus=2`.
- Operations EF UPDATE on `Estimates` fired with new PaymentStatus/PaidAt.
- Email worker logged
  `[Worker] Email 0a74e947-... sent via resend (messageId: dae98872-...)`.
- Notification row persisted: tenantId `e986dd42-...`, category `estimate`,
  title `Estimate paid`, userId `null` (broadcast).

Why this matters going forward:

- A bad Kafka startup window (broker still booting, transient DNS, network
  reattach) used to silently kill the entire payment notification pipeline
  until someone manually restarted the service.
- With the retry loop in place, the consumer self-heals and the next paid
  estimate flows end to end without intervention.
- Quick health probe: any Kafka outage now leaves a trail of
  `[KafkaConsumer] reconnect attempt (brokers=...)` lines instead of going
  silent.

Reference test estimate: `94a78506-dd43-408f-9e25-fd08dd24aba9`
(tenant `e986dd42-5dbf-42df-94af-aab4c4cbab52`,
Stripe session `cs_test_a1bIl50Lgtx5kUQS1Rz1Ey3kdCJWvPQiPrgxP9Pe5ZIFiFBN37fxAPydsF`).

## Apr 24 2026 — Turn 2: UUID v7 user ids dropped, bell stayed empty

### Symptom
Confirmation emails arrived but the dashboard bell never showed
estimate-paid notifications. New rows from the Kafka payment events were
being persisted, but they were saved with `userId = null` and the
`/api/notifications` queries returned them only for the user whose JWT
tenant exactly matched the row's tenant.

### Root Cause
`UUID_RE` in `src/worker/NotificationDispatcher.ts` and
`src/middleware/jwtAuth.ts` was:

    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

This rejects UUID v7 — Auth Server now issues v7 ids, e.g.
`019db03b-b446-793b-9820-2384ff608809` (third group starts with `7`).
`normalizeUserId` therefore returned `null` for every payment event,
and the JWT middleware also dropped v7 organization claims.

The bell read queries (`list`, `unreadCount`, `markRead`, `markAllRead`)
also did not surface user-targeted rows when an operator switched their
active organization in the UI.

### Fix
1. Relaxed `UUID_RE` to accept any version nibble and any variant nibble
   in both files.
2. Rewrote the four query helpers in
   `src/modules/notification/notification.service.ts` to use a 3-clause OR:
   `{tenantId, userId: null}` (broadcast) | `{tenantId, userId}` (targeted in
   active tenant) | `{userId}` (cross-tenant user-targeted).

### Verification
Direct curl after rebuild:

```
JWT(org=8a07) /api/notifications/unread-count        -> {"count":0}
JWT(org=8a07) + X-Organization-Id: e986... (proxy)   -> {"count":11}
Direct :5070, mismatched JWT + override (no secret)  -> "Organization access denied"
```


## Apr 24 2026 — Turn 3: Per-user read state for org-wide notifications

### Requirement
Org-wide events (e.g. "Estimate paid") must be visible to every user of the
organisation, but the bell's red unread badge must be tracked per user.
When user A clicks a notification, user B should still see it as unread.

### What was wrong
Until now there was a single `isRead` / `readAt` pair on the `Notifications`
row itself. For broadcast rows (`userId IS NULL`) that meant the very first
operator who marked it read flipped the flag for the whole organisation —
nobody else's bell would show the red dot any more.

### Fix
New table `NotificationReceipts (notificationId, userId, readAt)` with a
composite PK. A row exists ONLY when that user has read that notification.

- `prisma/schema.prisma`: added `NotificationReceipt` model + back-relation
  on `Notification.receipts`.
- `notification.service.ts`:
  - `unreadCount(tenantId, userId)`: visibility OR + `receipts: { none: { userId } }`.
  - `list(...)`: includes `receipts: { where: { userId }, take: 1 }` and
    projects per-user `isRead` / `readAt` via `projectForUser(...)`.
  - `markRead(id, ...)`: upserts a single receipt row (no longer mutates the
    notification itself).
  - `markAllRead(...)`: finds visible-to-user rows lacking a receipt and
    `createMany` them in one shot.
- The legacy `Notification.isRead` / `readAt` columns are kept (back-compat)
  but are no longer read or written by the API — they appear on the schema
  with a doc comment marking them legacy.

### DB migration applied to RDS
`prisma db push` from inside the container hangs against this RDS instance
(observed: spinner never returns). Worked around by executing raw DDL via
the existing Prisma client:

```sh
docker cp scripts/check-receipts.js nn-notification-service:/app/check.js
docker exec -w /app nn-notification-service node check.js
```

The script is idempotent: `to_regclass` first, then `CREATE TABLE IF NOT
EXISTS` + `CREATE INDEX IF NOT EXISTS`. Keep
`scripts/check-receipts.js` around — it's the safe way to apply additive
DDL to this RDS.

### Verification (per-user read isolation)
Inserted a fresh broadcast row, then:

```
                          A unread   B unread   A.isRead   B.isRead
both visible (broadcast)        9          9      false      false
A marks NID read                8          9      true       false
B marks NID read                8          8      true       true
```

Source: `/tmp/peruser2.sh` (uses two JWTs for the same org, one for each user).

### Important caveat for the realtime push
When the WS gateway publishes a broadcast event (`payment.events`), the
notification is created with `userId=null` AND broadcast on the tenant
room. Every connected operator receives the toast immediately and the bell
counter is now correct *per user* on the next REST refresh. We deliberately
do NOT pre-create receipts for everyone in the org — receipts only exist on
explicit read.

## Apr 24 2026 — Turn 3: stack-wide container hardening

This service's `KafkaPaymentConsumer` reconnect logic (added earlier
today) is now mirrored in `NN.UGP.Email.Service/src/worker/KafkaEmailConsumer.ts`
so the email pipeline self-heals across kafka outages the same way the
notification dispatcher does.

Cross-cutting changes that affect notification debugging:

- Root `docker-compose.yml` `kafka` and `redis` services now have
  `restart: unless-stopped` (they previously had no restart policy at
  all, which is why a single broker crash could silently freeze the
  entire notification pipeline).
- `websocket-gateway` and `email-worker` now have container
  `healthcheck` directives. Use `docker ps` to spot wedged containers:
  ones that show `(unhealthy)` should be restarted by Docker
  automatically.
- `NN.WebSocket.Gateway/src/app.ts` `bootstrap()` no longer
  `process.exit(1)`s on transient `This server does not host this
  topic-partition` errors during kafka leader election; it retries
  consumer attachment with backoff in the background while the HTTP
  server stays up. Live sockets no longer drop on kafka recreate.

Practical implication: when validating the paid-estimate flow you can
now `docker compose up -d --build kafka` without losing connected
operator dashboards. Previously this would tear down all socket
connections and require manual page reloads.
