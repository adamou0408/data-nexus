import { Request, Response, NextFunction } from 'express';
import { pool } from '../db';

// Extract user context from request headers
// Falls back to DB lookup via authz_group_member if X-User-Groups not provided
export function extractUser(req: Request): { user_id: string; groups: string[] } | null {
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
      return res.status(401).json({ error: 'Missing X-User-Id header' });
    }
    try {
      const resolved = await resolveUserGroups(user);
      const result = await pool.query(
        'SELECT authz_check($1, $2, $3, $4) AS allowed',
        [resolved.user_id, resolved.groups, action, resource]
      );
      if (!result.rows[0].allowed) {
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
