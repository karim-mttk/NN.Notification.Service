import notificationService from '@/modules/notification/notification.service';
import { publishRealtimeNotification } from '@/kafka/producer';
import { updateEstimatePaymentStatus, PAYMENT_STATUS } from '@/clients/operationsClient';
import logger from '@/utils/logger';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeUserId(userId?: string | null): string | null {
  if (!userId) return null;
  return UUID_RE.test(userId) ? userId : null;
}

/**
 * Wire-format of a payment event published by NN.Payment.Backend.
 * Property names are camelCase to match the .NET serializer.
 */
export interface PaymentEvent {
  eventType: string; // e.g. "checkout.completed"
  source: string; // e.g. "stripe"
  checkoutSessionId: string;
  gatewaySessionId: string;
  tenantId: string;
  userId?: string | null;
  customerId?: string | null;
  amount: number;
  currency: string;
  checkoutType: string; // e.g. "EstimatePayment"
  estimateId?: string | null;
  invoiceId?: string | null;
  occurredAt: string;
}

/**
 * Fans a single payment event out to:
 *   1. NN.Operational.Backend (PATCH estimate payment status)
 *   2. WebSocket Gateway (via notifications.realtime topic)
 *   3. Email Service (payment-receipt template via emails.outbound topic)
 *   4. Local Notification table (for the bell history)
 */
export async function dispatchPaymentEvent(evt: PaymentEvent): Promise<void> {
  if (evt.eventType !== 'checkout.completed') {
    logger.info('[dispatch] ignoring eventType=%s', evt.eventType);
    return;
  }

  const isEstimate = evt.checkoutType === 'EstimatePayment' && !!evt.estimateId;
  const notificationUserId = normalizeUserId(evt.userId);

  // 1. Operational backend callback (only for estimate payments)
  if (isEstimate && evt.estimateId) {
    await updateEstimatePaymentStatus(evt.tenantId, evt.estimateId, {
      paymentStatus: PAYMENT_STATUS.Paid,
      paymentSessionId: evt.gatewaySessionId,
      amountPaid: evt.amount,
      paidAt: evt.occurredAt,
    }, notificationUserId);
  }

  const title = isEstimate ? 'Estimate paid' : 'Payment received';
  const message = isEstimate
    ? `Estimate payment of ${evt.amount.toFixed(2)} ${evt.currency.toUpperCase()} has been received.`
    : `A payment of ${evt.amount.toFixed(2)} ${evt.currency.toUpperCase()} has been received.`;
  const actionUrl = isEstimate ? `/operations/payments` : `/operations/payments`;

  // 2. Persisted bell history
  try {
    await notificationService.create({
      tenantId: evt.tenantId,
      userId: notificationUserId,
      category: isEstimate ? 'estimate' : 'payment',
      severity: 'success',
      title,
      message,
      actionUrl,
      data: {
        estimateId: evt.estimateId,
        invoiceId: evt.invoiceId,
        amount: evt.amount,
        currency: evt.currency,
        sessionId: evt.gatewaySessionId,
      },
      sourceEventId: evt.gatewaySessionId,
      sourceTopic: 'payment.events',
    });
  } catch (err: any) {
    logger.error('[dispatch] failed to persist notification: %s', err.message);
  }

  // 3. Realtime push via WebSocket Gateway
  try {
    await publishRealtimeNotification({
      tenantId: evt.tenantId,
      userId: notificationUserId,
      type: isEstimate ? 'estimate.paid' : 'payment.received',
      title,
      message,
      severity: 'success',
      data: {
        estimateId: evt.estimateId,
        invoiceId: evt.invoiceId,
        amount: evt.amount,
        currency: evt.currency,
        sessionId: evt.gatewaySessionId,
        actionUrl,
      },
    });
  } catch (err: any) {
    logger.error('[dispatch] failed to publish realtime notification: %s', err.message);
  }

  // 4. Receipt email via Email Service.
  // We don't know the customer's email here — only the customerId. The Email
  // Service's payment-receipt template is responsible for resolving customer
  // contact details from the data payload, OR the Operational Backend's
  // /api/estimates/{id}/payment-status callback will trigger its own receipt.
  // We still fire-and-forget a receipt request when we have a customer email
  // hint in the event metadata.
  // (Stripe sends receipts on its own; this is supplementary.)
  // No-op for now — receipts are sent by Stripe and by the Operational
  // Backend's /payment-status callback if the project wants a custom one.
}
