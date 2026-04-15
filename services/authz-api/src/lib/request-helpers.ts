import { Request, Response } from 'express';
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

/**
 * Centralized API error handler — maps PG error codes to appropriate HTTP status codes.
 * Replaces blanket status(500) with 400/409/503 where applicable.
 */
export function handleApiError(res: Response, err: unknown): void {
  const pgCode = (err as any)?.code;

  // PostgreSQL constraint violations
  if (pgCode === '23505') {
    res.status(409).json({ error: 'Duplicate entry', detail: String(err) });
    return;
  }
  if (pgCode === '23503') {
    res.status(409).json({ error: 'Referenced record not found or in use', detail: String(err) });
    return;
  }
  if (pgCode === '23502' || pgCode === '23514' || pgCode === '22P02') {
    res.status(400).json({ error: 'Invalid input', detail: String(err) });
    return;
  }

  // Connection / availability errors
  const message = String(err);
  if (pgCode === '08001' || pgCode === '08006' || pgCode === '57P01'
      || message.includes('ECONNREFUSED') || message.includes('ETIMEDOUT')
      || message.includes('connection terminated') || message.includes('Connection terminated')) {
    res.status(503).json({ error: 'Database unavailable', detail: message });
    return;
  }

  // Default: internal server error
  res.status(500).json({ error: message });
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
