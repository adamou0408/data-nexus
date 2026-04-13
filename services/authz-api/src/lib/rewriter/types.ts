// ============================================================
// SQL Rewrite Engine — Shared Types
// Ported from EdgePolicy core/policy/models.py
// ============================================================

export type PolicyType = 'column_mask' | 'row_filter' | 'column_acl' | 'operation_acl';

export type MaskFunction =
  | 'full_mask'
  | 'partial_mask'
  | 'hash'
  | 'nullify'
  | 'email_mask'
  | 'redact';

export interface RewritePolicy {
  name: string;
  policy_type: PolicyType;
  target_schema: string;
  target_table: string;
  target_columns: string[];
  rule_definition: Record<string, unknown>;
  priority: number;
}

export interface PolicyAssignment {
  assignment_type: 'role' | 'department' | 'security_level' | 'user' | 'job_level_below' | 'group';
  assignment_value: string;
  is_exception: boolean;
}

export interface UserContext {
  user_id: string;
  groups: string[];
  roles: string[];
  department?: string;
  job_level?: number;
  security_clearance?: string;
  attributes: Record<string, unknown>;
}

export type PolicyAction = 'ALLOW' | 'MASK' | 'FILTER' | 'DENY';

export interface PolicyEvalResult {
  action: PolicyAction;
  mask_policies: RewritePolicy[];
  filter_policies: RewritePolicy[];
  denied_columns: string[];
  applied_policy_names: string[];
  operation_denied: boolean;
  operation_message?: string;
}

export interface RewriteResult {
  original_sql: string;
  rewritten_sql: string;
  was_modified: boolean;
  applied_policies: string[];
}
