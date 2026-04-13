// ============================================================
// Policy Evaluator
// Ported from EdgePolicy core/policy/evaluator.py
//
// Evaluates ABAC policies against user identity and data context.
// Supports 6 assignment types: role, department, security_level,
//   user, job_level_below, group
// Plus is_exception for exemptions.
//
// Dual-source: checks both authz_policy_assignment table (EdgePolicy-style)
//   AND authz_policy.subject_condition JSONB (Data Nexus existing).
// ============================================================

import { Pool } from 'pg';
import type {
  PolicyEvalResult,
  RewritePolicy,
  PolicyAssignment,
  UserContext,
  MaskFunction,
} from './rewriter/types';

const CLEARANCE_LEVELS: Record<string, number> = {
  PUBLIC: 1,
  INTERNAL: 2,
  CONFIDENTIAL: 3,
  RESTRICTED: 4,
};

function sensitivityLevel(user: UserContext): number {
  return CLEARANCE_LEVELS[(user.security_clearance || 'PUBLIC').toUpperCase()] || 1;
}

// ── Assignment matching (ported from EdgePolicy evaluator.py) ──

function checkAssignment(user: UserContext, assignment: PolicyAssignment): boolean {
  const val = assignment.assignment_value;
  switch (assignment.assignment_type) {
    case 'role':
      return user.roles.some(r => r.toLowerCase() === val.toLowerCase());
    case 'department':
      return (user.department || '').toLowerCase() === val.toLowerCase();
    case 'security_level': {
      const required = CLEARANCE_LEVELS[val.toUpperCase()] || 0;
      return sensitivityLevel(user) < required;
    }
    case 'user':
      return user.user_id.toLowerCase() === val.toLowerCase();
    case 'job_level_below': {
      const threshold = parseInt(val, 10);
      return !isNaN(threshold) && (user.job_level ?? 0) < threshold;
    }
    case 'group':
      return user.groups.some(g => g.toLowerCase() === val.toLowerCase());
    default:
      return false;
  }
}

function userMatchesAssignments(user: UserContext, assignments: PolicyAssignment[]): boolean {
  const applies = assignments.filter(a => !a.is_exception);
  if (applies.length === 0) return true; // no assignments = applies to everyone
  return applies.some(a => checkAssignment(user, a));
}

function userIsExempt(user: UserContext, assignments: PolicyAssignment[]): boolean {
  const exceptions = assignments.filter(a => a.is_exception);
  return exceptions.some(a => checkAssignment(user, a));
}

// ── Subject condition matching (Data Nexus existing format) ──

function matchesSubjectCondition(user: UserContext, condition: Record<string, unknown>): boolean {
  if (!condition || Object.keys(condition).length === 0) return true;

  // Check role match
  if (condition.role) {
    const requiredRoles = condition.role as string[];
    const hasRole = requiredRoles.some(r => user.roles.some(ur => ur.toLowerCase() === r.toLowerCase()));
    if (!hasRole) return false;
  }

  // Check attribute matches (department, product_line, region, etc.)
  for (const [key, values] of Object.entries(condition)) {
    if (key === 'role') continue;
    const attrVal = user.attributes[key];
    if (attrVal !== undefined && Array.isArray(values)) {
      if (!(values as string[]).some(v => String(v).toLowerCase() === String(attrVal).toLowerCase())) {
        return false;
      }
    }
  }

  return true;
}

// ── Target matching (supports wildcard via glob-like patterns) ──

function matchesTarget(targetTable: string, table: string): boolean {
  if (targetTable === '*') return true;
  // Support comma-separated lists
  const targets = targetTable.split(',').map(t => t.trim().toLowerCase());
  return targets.some(t => {
    if (t === '*') return true;
    if (t.includes('*')) {
      // Simple wildcard: convert to regex
      const pattern = new RegExp('^' + t.replace(/\*/g, '.*') + '$');
      return pattern.test(table.toLowerCase());
    }
    return t === table.toLowerCase();
  });
}

// ── Policy loading from DB ──

interface DbPolicy {
  policy_id: number;
  policy_name: string;
  granularity: string;
  priority: number;
  effect: string;
  subject_condition: Record<string, unknown>;
  resource_condition: Record<string, unknown>;
  rls_expression: string | null;
  column_mask_rules: Record<string, { function: string; mask_type: string }> | null;
  assignments: PolicyAssignment[];
}

async function loadPoliciesForTable(authzPool: Pool, table: string): Promise<DbPolicy[]> {
  const result = await authzPool.query(`
    SELECT p.policy_id, p.policy_name, p.granularity::TEXT, p.priority,
           p.effect::TEXT, p.subject_condition, p.resource_condition,
           p.rls_expression, p.column_mask_rules,
           COALESCE(
             json_agg(json_build_object(
               'assignment_type', pa.assignment_type,
               'assignment_value', pa.assignment_value,
               'is_exception', pa.is_exception
             )) FILTER (WHERE pa.id IS NOT NULL),
             '[]'
           ) AS assignments
    FROM authz_policy p
    LEFT JOIN authz_policy_assignment pa ON pa.policy_id = p.policy_id
    WHERE p.status = 'active'
      AND (p.effective_until IS NULL OR p.effective_until > now())
    GROUP BY p.policy_id
    ORDER BY p.priority ASC
  `);

  return result.rows as DbPolicy[];
}

// ── Main evaluator ──

export class PolicyEvaluator {
  /**
   * Evaluate all active policies for a given user and table context.
   * Checks both authz_policy_assignment (EdgePolicy-style) AND
   * authz_policy.subject_condition (Data Nexus-style).
   */
  async evaluate(
    authzPool: Pool,
    user: UserContext,
    table: string,
  ): Promise<PolicyEvalResult> {
    const policies = await loadPoliciesForTable(authzPool, table);
    const result: PolicyEvalResult = {
      action: 'ALLOW',
      mask_policies: [],
      filter_policies: [],
      denied_columns: [],
      applied_policy_names: [],
      operation_denied: false,
    };

    for (const policy of policies) {
      // Check resource_condition target match
      const targetTable = (policy.resource_condition?.table as string) || '*';
      if (!matchesTarget(targetTable, table)) continue;

      // Check user match — dual source
      const matchesAssignment = userMatchesAssignments(user, policy.assignments);
      const matchesCondition = matchesSubjectCondition(user, policy.subject_condition);

      // If policy has assignments, use assignment logic. Otherwise fall back to subject_condition.
      const userMatches = policy.assignments.length > 0
        ? matchesAssignment
        : matchesCondition;

      if (!userMatches) continue;

      // Check exemptions
      if (policy.assignments.length > 0 && userIsExempt(user, policy.assignments)) continue;

      // Apply policy based on granularity
      if (policy.column_mask_rules && Object.keys(policy.column_mask_rules).length > 0) {
        // L2 column mask policy — convert to RewritePolicy format
        for (const [colKey, maskDef] of Object.entries(policy.column_mask_rules)) {
          const [maskTable, col] = colKey.split('.');
          if (maskTable.toLowerCase() !== table.toLowerCase() || !col) continue;

          result.mask_policies.push({
            name: policy.policy_name,
            policy_type: 'column_mask',
            target_schema: 'public',
            target_table: table,
            target_columns: [col],
            rule_definition: { mask_function: mapMaskFnName(maskDef.function) },
            priority: policy.priority,
          });
        }
        result.applied_policy_names.push(policy.policy_name);
        if (result.action === 'ALLOW') result.action = 'MASK';
      }

      if (policy.rls_expression) {
        // L1 RLS policy
        result.filter_policies.push({
          name: policy.policy_name,
          policy_type: 'row_filter',
          target_schema: 'public',
          target_table: table,
          target_columns: [],
          rule_definition: { condition: policy.rls_expression },
          priority: policy.priority,
        });
        result.applied_policy_names.push(policy.policy_name);
        if (result.action === 'ALLOW') result.action = 'FILTER';
      }
    }

    return result;
  }
}

function mapMaskFnName(fnName: string): MaskFunction {
  const mapping: Record<string, MaskFunction> = {
    fn_mask_full:    'full_mask',
    fn_mask_partial: 'partial_mask',
    fn_mask_hash:    'hash',
    fn_mask_range:   'full_mask',
    fn_mask_null:    'nullify',
    fn_mask_nullify: 'nullify',
    fn_mask_email:   'email_mask',
    fn_mask_redact:  'redact',
  };
  return mapping[fnName] || 'full_mask';
}
