import axios from 'axios';
import { getServiceToken } from './authClient';
import logger from '@/utils/logger';

const OPERATIONS_API_URL = process.env.OPERATIONS_API_URL || '';

export interface UpdateEstimatePaymentDto {
  paymentStatus: number; // matches the .NET enum index
  paymentSessionId?: string;
  paymentCheckoutUrl?: string;
  amountPaid?: number;
  paidAt?: string; // ISO
}

export const PAYMENT_STATUS = {
  NotInitiated: 0,
  AwaitingPayment: 1,
  Paid: 2,
  Failed: 3,
  Expired: 4,
  Refunded: 5,
} as const;

export async function updateEstimatePaymentStatus(
  tenantId: string,
  estimateId: string,
  body: UpdateEstimatePaymentDto,
  userId?: string | null,
): Promise<boolean> {
  if (!OPERATIONS_API_URL) {
    logger.warn('[operations] OPERATIONS_API_URL not configured, skipping callback');
    return false;
  }
  const token = await getServiceToken(tenantId, userId);
  if (!token) {
    logger.warn('[operations] No service token available, callback skipped for %s', estimateId);
    return false;
  }
  try {
    const url = `${OPERATIONS_API_URL.replace(/\/$/, '')}/api/estimates/${estimateId}/payment-status`;
    await axios.post(url, body, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      timeout: 7_000,
    });
    logger.info('[operations] Updated estimate %s → paymentStatus=%s', estimateId, body.paymentStatus);
    return true;
  } catch (err: any) {
    logger.error(
      '[operations] Failed to update estimate %s: %s',
      estimateId,
      err.response?.data ? JSON.stringify(err.response.data) : err.message
    );
    return false;
  }
}
