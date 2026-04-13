// ============================================================
// JWT/OIDC Authentication Middleware
// Ported from EdgePolicy engine/auth/jwt.py + OptionalJWTMiddleware
//
// Optional JWT validation — if JWT_ISSUER is set, validates Bearer tokens.
// Falls back to X-User-Id header when JWT is not configured (dev mode).
// ============================================================

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

export interface JWTConfig {
  issuer: string;
  issuerAliases?: string[];
  audience?: string;
  jwksUri?: string;
}

export interface JWTClaims {
  sub: string;
  preferred_username?: string;
  email?: string;
  groups?: string[];
  department?: string;
  job_level?: number;
  security_clearance?: string;
  realm_access?: { roles: string[] };
  resource_access?: Record<string, { roles: string[] }>;
  [key: string]: unknown;
}

// Extend Express Request to carry JWT claims
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      jwtClaims?: JWTClaims;
    }
  }
}

let _jwksClient: jwksClient.JwksClient | null = null;

function getJwksClient(config: JWTConfig): jwksClient.JwksClient {
  if (!_jwksClient) {
    const uri = config.jwksUri || `${config.issuer}/protocol/openid-connect/certs`;
    _jwksClient = jwksClient({
      jwksUri: uri,
      cache: true,
      cacheMaxEntries: 5,
      cacheMaxAge: 600_000, // 10 minutes
    });
  }
  return _jwksClient;
}

function getSigningKey(config: JWTConfig): jwt.GetPublicKeyOrSecret {
  return (header, callback) => {
    const client = getJwksClient(config);
    client.getSigningKey(header.kid, (err, key) => {
      if (err) return callback(err);
      const signingKey = key?.getPublicKey();
      callback(null, signingKey);
    });
  };
}

function buildIssuerCandidates(config: JWTConfig): string[] {
  const candidates = new Set<string>();
  candidates.add(config.issuer);
  if (config.issuerAliases) {
    for (const alias of config.issuerAliases) candidates.add(alias);
  }
  // Common aliases for local dev (ported from EdgePolicy)
  const url = new URL(config.issuer);
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    candidates.add(config.issuer.replace(url.hostname, 'localhost'));
    candidates.add(config.issuer.replace(url.hostname, '127.0.0.1'));
  }
  return Array.from(candidates);
}

/**
 * Optional JWT middleware.
 * - If config is null (JWT_ISSUER not set) → skip, let X-User-Id fallback work
 * - If Authorization: Bearer present → validate JWT, set req.jwtClaims
 * - If no Bearer header → skip (fallback to X-User-Id in authz.ts)
 */
export function optionalJWT(config: JWTConfig | null) {
  const skipPaths = ['/health', '/ready', '/metrics'];

  return async (req: Request, res: Response, next: NextFunction) => {
    // No JWT config → dev mode, skip entirely
    if (!config) return next();

    // Skip health/metrics endpoints
    if (skipPaths.some(p => req.path.startsWith(p))) return next();

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // No Bearer token → fallback to X-User-Id (transition period)
      return next();
    }

    const token = authHeader.slice(7);
    const issuers = buildIssuerCandidates(config);

    try {
      const decoded = await new Promise<JWTClaims>((resolve, reject) => {
        jwt.verify(
          token,
          getSigningKey(config),
          {
            algorithms: ['RS256'],
            issuer: issuers as [string, ...string[]],
            audience: config.audience || undefined,
          },
          (err: jwt.VerifyErrors | null, payload: jwt.JwtPayload | string | undefined) => {
            if (err) return reject(err);
            resolve(payload as JWTClaims);
          },
        );
      });

      req.jwtClaims = decoded;
      next();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('jwt expired')) {
        return res.status(401).json({ error: 'Token expired' });
      }
      return res.status(401).json({ error: 'Invalid token', detail: message });
    }
  };
}

/**
 * Build JWT config from environment variables.
 * Returns null if JWT_ISSUER is not set (dev mode).
 */
export function buildJWTConfig(): JWTConfig | null {
  const issuer = process.env.JWT_ISSUER;
  if (!issuer || process.env.JWT_ENABLED === 'false') return null;

  return {
    issuer,
    issuerAliases: process.env.JWT_ISSUER_ALIASES?.split(',').filter(Boolean),
    audience: process.env.JWT_AUDIENCE,
    jwksUri: process.env.JWT_JWKS_URI,
  };
}
