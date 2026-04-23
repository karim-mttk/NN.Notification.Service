# NN.Notification.Service

Cross-service notification hub. Single Node 20 / TypeScript / Express / Prisma /
KafkaJS service (port **5070**).

## Responsibilities

1. Consume `payment.events` from Kafka (produced by `NN.Payment.Backend` after a
   Stripe webhook).
2. For estimate payments → call `POST /api/estimates/{id}/payment-status` on
   `NN.Operational.Backend` to flip `PaymentStatus → Paid`.
3. Persist a row in the `Notifications` table (per tenant + user) so the UI bell
   has history + unread count.
4. Publish to `notifications.realtime` so the WebSocket Gateway broadcasts to
   connected browsers.
5. Expose REST for the frontend bell:
   - `POST /api/notifications` — create a notification row (used by trusted backend services)
   - `GET /api/notifications` — list (filter by `isRead`, `category`)
   - `GET /api/notifications/unread-count`
   - `PATCH /api/notifications/:id/read`
   - `PATCH /api/notifications/read-all`

All REST endpoints require the same JWT (HS256) issued by the Auth Server, with
a `tenant_id` claim.

## Env

See [`.env.example`](.env.example). All Kafka behaviour is gated on
`KAFKA_ENABLED=true` so local dev without Kafka still boots cleanly.

## Local

```bash
npm install
npx prisma generate
npx prisma db push
npm run dev
```

## Docker

The service is included in the root `docker-compose.yml`. Standalone:

```bash
docker compose up --build
```
