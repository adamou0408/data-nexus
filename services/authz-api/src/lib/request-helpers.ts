import { Request } from 'express';
import { Pool } from 'pg';

export function getUserId(req: Request): string {
  return (req as any).authzUser?.user_id
    || (req.headers['x-user-id'] as string)
    || 'unknown';
}

export function getClientIp(req: Request): string | undefined {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string') return xff.split(',')[0].trim();
  return req.socket.remoteAddress;
}

export async function isAdminUser(pool: Pool, userId: string, groups: string[]): Promise<boolean> {
  try {
    const result = await pool.query(
      'SELECT _authz_resolve_roles($1, $2) AS roles',
      [userId, groups]
    );
    const roles: string[] = result.rows[0]?.roles || [];
    return roles.some(r => r === 'ADMIN' || r === 'AUTHZ_ADMIN');
  } catch {
    return false;
  }
}
