import { Request, Response, NextFunction } from 'express';
import { pool } from '../db';

// Extract user context from request headers (simulated auth)
// In production this would come from JWT/session validation
export function extractUser(req: Request): { user_id: string; groups: string[] } | null {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) return null;
  const groups = (req.headers['x-user-groups'] as string || '').split(',').filter(Boolean);
  return { user_id: userId, groups };
}

// Middleware: require authentication (any valid user)
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = extractUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Missing X-User-Id header' });
  }
  (req as any).authzUser = user;
  next();
}

// Middleware factory: require specific permission via authz_check()
export function requirePermission(action: string, resource: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const user = extractUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Missing X-User-Id header' });
    }
    try {
      const result = await pool.query(
        'SELECT authz_check($1, $2, $3, $4) AS allowed',
        [user.user_id, user.groups, action, resource]
      );
      if (!result.rows[0].allowed) {
        return res.status(403).json({
          error: 'Forbidden',
          detail: `${user.user_id} lacks ${action} on ${resource}`,
        });
      }
      (req as any).authzUser = user;
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
      return res.status(401).json({ error: 'Missing X-User-Id header' });
    }
    try {
      const result = await pool.query(
        'SELECT _authz_resolve_roles($1, $2) AS roles',
        [user.user_id, user.groups]
      );
      const userRoles: string[] = result.rows[0].roles || [];
      const hasRole = roles.some(r => userRoles.includes(r));
      if (!hasRole) {
        return res.status(403).json({
          error: 'Forbidden',
          detail: `Requires role: ${roles.join(' or ')}`,
        });
      }
      (req as any).authzUser = user;
      (req as any).authzRoles = userRoles;
      next();
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  };
}
