// Service-to-service auth: requests a system JWT from NN.Auth.Server.Backend
// using a shared API key. Cached and refreshed before expiry.

import axios from 'axios';
import jwt from 'jsonwebtoken';
import logger from '@/utils/logger';

const AUTH_API_URL = process.env.AUTH_API_URL || '';
const SERVICE_API_KEY = process.env.AUTH_SERVICE_API_KEY || '';
const JWT_SECRET_KEY = process.env.JWT_SECRET_KEY || '';
const JWT_ISSUER = process.env.JWT_ISSUER || '';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || '';

let cachedToken: { value: string; expiresAt: number } | null = null;

function buildTenantScopedFallbackToken(tenantId: string, userId?: string | null): string | null {
  if (!JWT_SECRET_KEY || !JWT_ISSUER || !JWT_AUDIENCE || !tenantId) {
    return null;
  }

  const subject = userId?.trim() || 'notification-service';
  return jwt.sign(
    {
      sub: subject,
      userId: subject,
      tenant_id: tenantId,
      roles: ['SystemAdmin'],
      service: 'notification-service',
    },
    JWT_SECRET_KEY,
    {
      algorithm: 'HS256',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      expiresIn: '1h',
    },
  );
}

export async function getServiceToken(tenantId?: string, userId?: string | null): Promise<string | null> {
  // Optional: only used when wanting authenticated calls into Operations etc.
  if (!AUTH_API_URL || !SERVICE_API_KEY) {
    const fallback = tenantId ? buildTenantScopedFallbackToken(tenantId, userId) : null;
    if (!fallback) {
      logger.warn('[auth] No AUTH_SERVICE_API_KEY configured and JWT fallback is unavailable');
    }
    return fallback;
  }

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
    const fallback = tenantId ? buildTenantScopedFallbackToken(tenantId, userId) : null;
    if (!fallback) {
      logger.warn('[auth] JWT fallback token unavailable after auth-server failure');
    }
    return fallback;
  }
}
