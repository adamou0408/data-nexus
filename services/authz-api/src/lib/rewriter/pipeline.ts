// ============================================================
// SQL Rewrite Pipeline
// Ported from EdgePolicy core/rewriter/pipeline.py
//
// Orchestrates three rewriters in sequence:
//   1. Column ACL — remove denied columns
//   2. Column Masking — replace with mask expressions
//   3. Row-Level Security — inject WHERE filters
//
// Order matters: ACL removes first, masking replaces remaining, RLS filters rows.
// ============================================================

import { rewriteColumnAcl } from './column-acl';
import { rewriteMasking } from './masking';
import { rewriteRls } from './rls';
import { detectOperationType } from './operation-detector';
import type { PolicyEvalResult, RewriteResult, UserContext } from './types';

export class RewritePipeline {
  /**
   * Run the complete rewrite pipeline.
   *
   * @param sql       Original SQL query
   * @param evalResult Result from PolicyEvaluator with categorized policies
   * @param user      Authenticated user context
   * @param table     Target table name (for policy matching)
   * @returns RewriteResult with original and rewritten SQL
   */
  rewrite(
    sql: string,
    evalResult: PolicyEvalResult,
    user: UserContext,
    table: string,
  ): RewriteResult {
    // Only rewrite SELECT queries — DML/DDL pass through unmodified
    if (detectOperationType(sql) !== 'SELECT') {
      return {
        original_sql: sql,
        rewritten_sql: sql,
        was_modified: false,
        applied_policies: [],
      };
    }

    const hasModifications =
      evalResult.denied_columns.length > 0 ||
      evalResult.mask_policies.length > 0 ||
      evalResult.filter_policies.length > 0;

    if (!hasModifications) {
      return {
        original_sql: sql,
        rewritten_sql: sql,
        was_modified: false,
        applied_policies: [],
      };
    }

    let current = sql;

    // Step 1: Column ACL — remove denied columns first
    if (evalResult.denied_columns.length > 0) {
      current = rewriteColumnAcl(current, evalResult.denied_columns);
    }

    // Step 2: Column Masking — mask remaining columns
    if (evalResult.mask_policies.length > 0) {
      current = rewriteMasking(current, evalResult.mask_policies, table);
    }

    // Step 3: Row-Level Security — add WHERE filters
    if (evalResult.filter_policies.length > 0) {
      current = rewriteRls(current, evalResult.filter_policies, table, user);
    }

    const wasModified = current.trim() !== sql.trim();

    return {
      original_sql: sql,
      rewritten_sql: current,
      was_modified: wasModified,
      applied_policies: evalResult.applied_policy_names,
    };
  }
}
