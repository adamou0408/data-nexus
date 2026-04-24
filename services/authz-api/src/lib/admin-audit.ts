// ============================================================
// Admin Audit Logger
// Logs management operations to authz_admin_audit_log (Phase 5).
// Separate from data-access audit (audit.ts → authz_audit_log).
//
// Constitution v2.0 §9.7 fields (actor_type/agent_id/model_id/consent_given)
// added by V049. Default to human + human_explicit so existing call sites
// keep working unchanged; AI call sites (Q1 2027) MUST set them explicitly.
// ============================================================

import { Pool } from 'pg';

export type AdminAuditActorType = 'ai_agent' | 'human' | 'system';
export type AdminAuditConsent =
  | 'human_explicit'
  | 'human_via_suggestion_card'
  | 'agent_auto_read'
  | 'agent_unauthorized';

export interface AdminAuditEntry {
  userId: string;
  action: string;       // CREATE_POLICY, UPDATE_ROLE, DELETE_RESOURCE, etc.
  resourceType: string; // policy, role, resource, data_source, subject, credential
  resourceId?: string;
  details?: Record<string, unknown>;
  ip?: string;
  // Constitution §9.7 — required for AI-originated entries (CHECK enforces agent_id).
  actorType?: AdminAuditActorType;
  agentId?: string;
  modelId?: string;
  consentGiven?: AdminAuditConsent;
}

export async function logAdminAction(pool: Pool, entry: AdminAuditEntry): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO authz_admin_audit_log (
         user_id, action, resource_type, resource_id, details, ip_address,
         actor_type, agent_id, model_id, consent_given
       )
       VALUES ($1, $2, $3, $4, $5, $6::inet, $7, $8, $9, $10)`,
      [
        entry.userId,
        entry.action,
        entry.resourceType,
        entry.resourceId || null,
        JSON.stringify(entry.details || {}),
        entry.ip || null,
        entry.actorType ?? 'human',
        entry.agentId ?? null,
        entry.modelId ?? null,
        entry.consentGiven ?? 'human_explicit',
      ]
    );
  } catch (err) {
    // Admin audit should not break the request — log and continue
    console.error('Admin audit log failed:', err);
  }
}
