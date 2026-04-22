// JWT auth middleware — validates the same HS256 tokens issued by NN.Auth.Server.Backend.
// Mirrors the verification used by NN.UGP.Email.Service.

import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload, VerifyErrors } from 'jsonwebtoken';
import logger from '../utils/logger';

const JWT_SECRET = process.env.JWT_SECRET_KEY!;
const JWT_ISSUER = process.env.JWT_ISSUER!;
const JWT_AUDIENCE = process.env.JWT_AUDIENCE!;

if (!JWT_SECRET) throw new Error('JWT_SECRET_KEY env variable is required');
if (!JWT_ISSUER) throw new Error('JWT_ISSUER env variable is required');
if (!JWT_AUDIENCE) throw new Error('JWT_AUDIENCE env variable is required');

const NAMEID = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier';
const ROLE = 'http://schemas.microsoft.com/ws/2008/06/identity/claims/role';

function extractUserId(p: JwtPayload): string | undefined {
  return (p[NAMEID] as string | undefined) ?? (p['sub'] as string | undefined) ?? (p['userId'] as string | undefined);
}
function extractTenantId(p: JwtPayload): string | undefined {
  return (
    (p['organization_id'] as string | undefined) ??
    (p['OrganizationId'] as string | undefined) ??
    (p['tenant_id'] as string | undefined) ??
    (p['TenantId'] as string | undefined)
  );
}
function extractRoles(p: JwtPayload): string[] {
  const fromArray = (p['roles'] as string[] | undefined) ?? [];
  const single = (p[ROLE] as string | string[] | undefined) ?? (p['role'] as string | undefined);
  if (Array.isArray(single)) return [...fromArray, ...single];
  if (single) return [...fromArray, single];
  return fromArray;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: {
      userId: string;
      tenantId?: string;
      roles: string[];
      raw: JwtPayload;
    };
  }
}

export function authenticate(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Missing bearer token' });
  }
  const token = auth.substring('Bearer '.length).trim();

  jwt.verify(
    token,
    JWT_SECRET,
    {
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
      clockTolerance: 300,
    },
    (err: VerifyErrors | null, decoded: any) => {
      if (err || !decoded) {
        logger.warn('JWT verification failed: %s', err?.message);
        return res.status(401).json({ message: 'Invalid token' });
      }
      const payload = decoded as JwtPayload;
      const userId = extractUserId(payload);
      if (!userId) {
        return res.status(401).json({ message: 'Token missing user id' });
      }
      req.user = {
        userId,
        tenantId: extractTenantId(payload),
        roles: extractRoles(payload),
        raw: payload,
      };
      next();
    }
  );
}

export function requireTenant(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.tenantId) return res.status(403).json({ message: 'Tenant context required' });
  next();
}
