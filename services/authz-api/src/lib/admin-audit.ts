// ============================================================
// Admin Audit Logger
// Logs management operations to authz_admin_audit_log (Phase 5).
// Separate from data-access audit (audit.ts → authz_audit_log).
// ============================================================

import { Pool } from 'pg';

export interface AdminAuditEntry {
  userId: string;
  action: string;       // CREATE_POLICY, UPDATE_ROLE, DELETE_RESOURCE, etc.
  resourceType: string; // policy, role, resource, data_source, subject, credential
  resourceId?: string;
  details?: Record<string, unknown>;
  ip?: string;
}

export async function logAdminAction(pool: Pool, entry: AdminAuditEntry): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO authz_admin_audit_log (user_id, action, resource_type, resource_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6::inet)`,
      [
        entry.userId,
        entry.action,
        entry.resourceType,
        entry.resourceId || null,
        JSON.stringify(entry.details || {}),
        entry.ip || null,
      ]
    );
  } catch (err) {
    // Admin audit should not break the request — log and continue
    console.error('Admin audit log failed:', err);
  }
}
