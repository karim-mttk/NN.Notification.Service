// Service-to-service auth: requests a system JWT from NN.Auth.Server.Backend
// using a shared API key. Cached and refreshed before expiry.

import axios from 'axios';
import logger from '@/utils/logger';

const AUTH_API_URL = process.env.AUTH_API_URL || '';
const SERVICE_API_KEY = process.env.AUTH_SERVICE_API_KEY || '';

let cachedToken: { value: string; expiresAt: number } | null = null;

export async function getServiceToken(): Promise<string | null> {
  // Optional: only used when wanting authenticated calls into Operations etc.
  if (!AUTH_API_URL || !SERVICE_API_KEY) return null;

  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt - 60_000 > now) return cachedToken.value;

  try {
    const url = `${AUTH_API_URL.replace(/\/$/, '')}/api/auth/service-token`;
    const res = await axios.post(
      url,
      { service: 'notification-service' },
      { headers: { 'X-API-Key': SERVICE_API_KEY }, timeout: 5_000 }
    );
    const token = res.data?.access_token ?? res.data?.token;
    const expiresIn = Number(res.data?.expires_in ?? 3600);
    if (!token) {
      logger.warn('[auth] Service token endpoint returned no token');
      return null;
    }
    cachedToken = { value: token, expiresAt: now + expiresIn * 1000 };
    return token;
  } catch (err: any) {
    logger.warn('[auth] Failed to obtain service token: %s', err.message);
    return null;
  }
}
