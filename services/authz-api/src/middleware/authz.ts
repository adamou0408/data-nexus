import { Request, Response, NextFunction } from 'express';
import { pool } from '../db';
import type { JWTClaims } from './jwt';
import { audit } from '../audit';

// Map HTTP method → action_id for audit logging on middleware denials.
function methodToAction(method: string): string {
  switch (method.toUpperCase()) {
    case 'GET': return 'read';
    case 'POST': return 'write';
    case 'PUT':
    case 'PATCH': return 'update';
    case 'DELETE': return 'delete';
    default: return method.toLowerCase();
  }
}

// Normalize the unauth subject id. Use the raw header if present so attempts
// with bogus headers are still attributable; otherwise fall back to a constant.
function unauthSubject(req: Request): string {
  const raw = req.headers['x-user-id'];
  return (typeof raw === 'string' && raw.length > 0) ? raw : 'anonymous';
}

export interface AuthzUser {
  user_id: string;
  groups: string[];
  department?: string;
  job_level?: number;
  security_clearance?: string;
}

// Extract user context from JWT claims (preferred) or request headers (fallback)
export function extractUser(req: Request): AuthzUser | null {
  // JWT-first: if optionalJWT middleware decoded a token, use claims
  if (req.jwtClaims) {
    const claims = req.jwtClaims;
    const roles = claims.realm_access?.roles || [];
    const groups = claims.groups || [];
    return {
      user_id: claims.preferred_username || claims.sub,
      groups: [...groups, ...roles],
      department: claims.department as string | undefined,
      job_level: claims.job_level as number | undefined,
      security_clearance: claims.security_clearance as string | undefined,
    };
  }

  // Fallback: X-User-Id header (POC / backward compatible)
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return null;
  const groupsHeader = req.headers['x-user-groups'] as string || '';
  const groups = groupsHeader.split(',').filter(Boolean);
  return { user_id: userId, groups };
}

// Resolve groups from DB if not provided in headers
async function resolveUserGroups(user: { user_id: string; groups: string[] }): Promise<{ user_id: string; groups: string[] }> {
  if (user.groups.length > 0) return user;
  try {
    const result = await pool.query(
      'SELECT authz_resolve_user_groups($1) AS groups',
      [user.user_id]
    );
    const dbGroups: string[] = result.rows[0]?.groups || [];
    // Strip 'group:' prefix — PG functions like _authz_resolve_roles()
    // expect plain group names (e.g., 'AUTHZ_ADMINS' not 'group:AUTHZ_ADMINS')
    // because they prepend 'group:' internally when matching subject_role.
    const stripped = dbGroups.map(g => g.replace(/^group:/, ''));
    return { user_id: user.user_id, groups: stripped };
  } catch {
    return user;
  }
}

// Middleware: require authentication (any valid user)
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = extractUser(req);
  if (!user) {
    audit({
      access_path: 'B',
      subject_id: unauthSubject(req),
      action_id: methodToAction(req.method),
      resource_id: `route:${req.path}`,
      decision: 'deny',
      context: { reason: 'unauthenticated', method: req.method },
    });
    return res.status(401).json({ error: 'Missing X-User-Id header' });
  }
  (req as any).authzUser = await resolveUserGroups(user);
  next();
}

// Middleware factory: require specific permission via authz_check()
export function requirePermission(action: string, resource: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = extractUser(req);
    if (!user) {
      audit({
        access_path: 'B',
        subject_id: unauthSubject(req),
        action_id: action,
        resource_id: resource,
        decision: 'deny',
        context: { reason: 'unauthenticated', method: req.method, route: req.path },
      });
      return res.status(401).json({ error: 'Missing X-User-Id header' });
    }
    try {
      const resolved = await resolveUserGroups(user);
      const result = await pool.query(
        'SELECT authz_check($1, $2, $3, $4) AS allowed',
        [resolved.user_id, resolved.groups, action, resource]
      );
      if (!result.rows[0].allowed) {
        audit({
          access_path: 'B',
          subject_id: resolved.user_id,
          action_id: action,
          resource_id: resource,
          decision: 'deny',
          context: { reason: 'authz_check_failed', method: req.method, route: req.path },
        });
        return res.status(403).json({
          error: 'Forbidden',
          detail: `${resolved.user_id} lacks ${action} on ${resource}`,
        });
      }
      (req as any).authzUser = resolved;
      next();
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  };
}

// Middleware factory: require one of the specified roles
export function requireRole(...roles: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = extractUser(req);
    if (!user) {
      audit({
        access_path: 'B',
        subject_id: unauthSubject(req),
        action_id: methodToAction(req.method),
        resource_id: `route:${req.path}`,
        decision: 'deny',
        context: { reason: 'unauthenticated', required_roles: roles, method: req.method },
      });
      return res.status(401).json({ error: 'Missing X-User-Id header' });
    }
    try {
      const resolved = await resolveUserGroups(user);
      const result = await pool.query(
        'SELECT _authz_resolve_roles($1, $2) AS roles',
        [resolved.user_id, resolved.groups]
      );
      const userRoles: string[] = result.rows[0].roles || [];
      const hasRole = roles.some(r => userRoles.includes(r));
      if (!hasRole) {
        audit({
          access_path: 'B',
          subject_id: resolved.user_id,
          action_id: methodToAction(req.method),
          resource_id: `route:${req.path}`,
          decision: 'deny',
          context: { reason: 'role_check_failed', required_roles: roles, user_roles: userRoles, method: req.method },
        });
        return res.status(403).json({
          error: 'Forbidden',
          detail: `Requires role: ${roles.join(' or ')}`,
        });
      }
      (req as any).authzUser = resolved;
      (req as any).authzRoles = userRoles;
      next();
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  };
}
