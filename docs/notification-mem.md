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

1. Confirm notifications are still being created in the Notification DB.
2. Confirm the missing notification belongs to the active org, not just the JWT
   org claim.
3. Confirm the frontend request is going through
   `/api/notifications` on port `3000`, not directly to port `5070`.
4. Confirm both services have the same `NOTIFICATION_PROXY_SECRET` value.
5. Rebuild both Docker services before trusting any runtime result.
6. Only after that, revisit Kafka/dispatcher issues.