// ============================================================
// Discovery Rule Engine — bottom-up suggestion pipeline
//
// Reads enabled rows from authz_discovery_rule, matches against
// resources in authz_resource, and writes draft policies (status=
// 'pending_review') with suggested column masks or row filters.
//
// Used by:
//   - POST /api/datasources/:id/discover  (auto-suggest after scan)
//   - POST /api/discover/run-rules        (manual re-run)
//
// Idempotent: a generated policy_name embeds (resource_id, rule_id)
// so re-running never creates duplicates. Admin-edited or rejected
// policies are left alone (ON CONFLICT DO NOTHING).
// ============================================================

import type { Pool, PoolClient } from 'pg';

export type DiscoveryRule = {
  rule_id: string;
  rule_type: 'column_mask' | 'row_filter' | 'classification';
  match_target: 'column_name' | 'table_name' | 'schema_name';
  match_pattern: string;
  suggested_mask_fn: string | null;
  suggested_filter_template: string | null;
  suggested_label: string | null;
  description: string | null;
  priority: number;
};

export type RunResult = {
  resources_scanned: number;
  rules_evaluated: number;
  policies_created: number;
  policies_skipped: number;     // already existed
  classifications_tagged: number;
};

type ResourceRow = {
  resource_id: string;
  resource_type: string;
  display_name: string | null;
  parent_id: string | null;
  attributes: Record<string, unknown>;
};

const RESOURCE_TYPES_TABLE_LIKE = ['table', 'view', 'db_table'];
const RESOURCE_TYPES_COLUMN_LIKE = ['column'];

// One generated policy per (resource, rule). Stable name = idempotency key.
function policyNameFor(resourceId: string, rule: DiscoveryRule): string {
  const prefix = rule.rule_type === 'column_mask' ? 'auto_mask'
               : rule.rule_type === 'row_filter'  ? 'auto_filter'
               : 'auto_class';
  // policy_name has no length cap in V003 (TEXT), but keep it short-ish.
  return `${prefix}:${resourceId}:${rule.rule_id.slice(0, 8)}`;
}

// Resource IDs follow `<type>:<schema>.<table>[.<column>]` or `<type>:<table>.<column>`.
// Split on '.' and pick the last segment for column-level, second-to-last for table-level.
function lastSegment(resourceId: string): string {
  const colonIdx = resourceId.indexOf(':');
  const tail = colonIdx >= 0 ? resourceId.slice(colonIdx + 1) : resourceId;
  const parts = tail.split('.');
  return parts[parts.length - 1] ?? '';
}

function tableSegment(resourceId: string): string {
  const colonIdx = resourceId.indexOf(':');
  const tail = colonIdx >= 0 ? resourceId.slice(colonIdx + 1) : resourceId;
  const parts = tail.split('.');
  return parts.length >= 2 ? parts[parts.length - 1] : (parts[0] ?? '');
}

function nameForMatch(target: DiscoveryRule['match_target'], r: ResourceRow): string | null {
  if (target === 'column_name' && RESOURCE_TYPES_COLUMN_LIKE.includes(r.resource_type)) {
    // Prefer explicit attribute, then last segment of resource_id, then display_name as last resort.
    return (r.attributes.column_name as string | undefined)
        ?? lastSegment(r.resource_id)
        ?? r.display_name;
  }
  if (target === 'table_name' && RESOURCE_TYPES_TABLE_LIKE.includes(r.resource_type)) {
    return (r.attributes.table_name as string | undefined)
        ?? tableSegment(r.resource_id)
        ?? r.display_name;
  }
  if (target === 'schema_name') {
    if (r.attributes.table_schema) return r.attributes.table_schema as string;
    // resource_id second-to-last when shape is `<type>:<schema>.<table>(.<col>)`.
    const colonIdx = r.resource_id.indexOf(':');
    const tail = colonIdx >= 0 ? r.resource_id.slice(colonIdx + 1) : r.resource_id;
    const parts = tail.split('.');
    if (r.resource_type === 'column' && parts.length >= 3) return parts[0];
    if (r.resource_type !== 'column' && parts.length >= 2) return parts[0];
    return null;
  }
  return null;
}

// JS regex from the rule's POSIX-ish pattern. Rules use (?i) for case insensitive.
// JS doesn't support (?i) inline; strip it and use the 'i' flag instead.
function compileRulePattern(pattern: string): RegExp {
  let p = pattern;
  let flags = '';
  if (/^\(\?i\)/.test(p)) {
    flags = 'i';
    p = p.replace(/^\(\?i\)/, '');
  }
  return new RegExp(p, flags);
}

// Substitute {column} in the filter template with the actual column name.
// Keeps it simple — no other placeholders for now.
function renderFilterTemplate(template: string, columnName: string): string {
  // Quote the identifier safely (PG identifier quoting).
  const safeIdent = `"${columnName.replace(/"/g, '""')}"`;
  return template.replace(/\{column\}/g, safeIdent);
}

// Find the parent column's column_name → table mapping for row_filter rules.
// row_filter is meant to apply at the table level using a specific column.
async function findTableForColumn(client: PoolClient, columnResourceId: string): Promise<{
  table_resource_id: string;
  column_name: string;
} | null> {
  const r = await client.query<{
    parent_id: string | null;
    column_name: string | null;
  }>(
    `SELECT parent_id, attributes->>'column_name' AS column_name
       FROM authz_resource
      WHERE resource_id = $1`,
    [columnResourceId],
  );
  const row = r.rows[0];
  if (!row?.parent_id || !row.column_name) return null;
  return { table_resource_id: row.parent_id, column_name: row.column_name };
}

export async function runDiscoveryRules(opts: {
  pool: Pool;
  dataSourceId?: string;            // limit scan to a single source
  resourceIds?: string[];           // OR limit to specific resources (e.g. just-created)
  scanId?: string;                  // optional UUID for lineage
  createdBy?: string;               // user_id stamped on generated policies
}): Promise<RunResult> {
  const { pool, dataSourceId, resourceIds, createdBy = 'discover-engine' } = opts;
  const result: RunResult = {
    resources_scanned: 0,
    rules_evaluated: 0,
    policies_created: 0,
    policies_skipped: 0,
    classifications_tagged: 0,
  };

  const client = await pool.connect();
  try {
    // Load enabled rules, highest priority first.
    const rulesResult = await client.query<DiscoveryRule>(
      `SELECT rule_id, rule_type, match_target, match_pattern,
              suggested_mask_fn, suggested_filter_template, suggested_label,
              description, priority
         FROM authz_discovery_rule
        WHERE enabled = TRUE
        ORDER BY priority DESC, rule_id`,
    );
    const rules = rulesResult.rows;
    result.rules_evaluated = rules.length;
    if (rules.length === 0) return result;

    // Load candidate resources.
    const params: unknown[] = [];
    let where = `is_active = TRUE
                 AND resource_type IN ('column','table','view','db_table')`;
    if (resourceIds && resourceIds.length > 0) {
      params.push(resourceIds);
      where += ` AND resource_id = ANY($${params.length}::text[])`;
    } else if (dataSourceId) {
      params.push(dataSourceId);
      where += ` AND attributes->>'data_source_id' = $${params.length}`;
    }
    const resourcesResult = await client.query<ResourceRow>(
      `SELECT resource_id, resource_type, display_name, parent_id, attributes
         FROM authz_resource
        WHERE ${where}`,
      params,
    );
    const resources = resourcesResult.rows;
    result.resources_scanned = resources.length;
    if (resources.length === 0) return result;

    // Compile patterns once.
    const compiled = rules.map(r => ({ rule: r, re: compileRulePattern(r.match_pattern) }));

    await client.query('BEGIN');

    for (const r of resources) {
      for (const { rule, re } of compiled) {
        const subject = nameForMatch(rule.match_target, r);
        if (!subject) continue;
        if (!re.test(subject)) continue;

        const policyName = policyNameFor(r.resource_id, rule);
        const reason = `${rule.suggested_label ?? rule.rule_type}: matched "${subject}" against /${rule.match_pattern}/`;

        if (rule.rule_type === 'column_mask') {
          if (!rule.suggested_mask_fn) continue;
          // column_mask_rules JSONB shape: { "<column_name>": "<mask_fn_name>" }
          const columnName = (r.attributes.column_name as string) ?? r.display_name ?? subject;
          const maskRules = JSON.stringify({ [columnName]: rule.suggested_mask_fn });
          // Resource the policy targets is the parent table (mask is table-scoped, column-keyed).
          const targetTable = r.parent_id ?? r.resource_id;
          const resourceCondition = JSON.stringify({ resource_ids: [targetTable] });

          const ins = await client.query(
            `INSERT INTO authz_policy
               (policy_name, description, granularity, priority, effect, status,
                applicable_paths, subject_condition, resource_condition,
                action_condition, environment_condition,
                column_mask_rules, created_by,
                suggested_by_rule, suggested_at, suggested_reason)
             VALUES ($1, $2, 'L2_row_column', 100, 'allow', 'pending_review',
                     '{A,B,C}', '{}'::jsonb, $3::jsonb,
                     '{}'::jsonb, '{}'::jsonb,
                     $4::jsonb, $5,
                     $6, now(), $7)
             ON CONFLICT (policy_name) DO NOTHING
             RETURNING policy_id`,
            [policyName, rule.description ?? `Auto-suggested mask for ${columnName}`,
             resourceCondition, maskRules, createdBy, rule.rule_id, reason],
          );
          if (ins.rowCount && ins.rowCount > 0) result.policies_created++;
          else result.policies_skipped++;

        } else if (rule.rule_type === 'row_filter') {
          if (!rule.suggested_filter_template) continue;
          // Row filter is table-scoped using a column predicate. If we matched a column,
          // resolve to its parent table; if we matched a table, skip (no column to bind).
          let tableId: string;
          let columnName: string;
          if (r.resource_type === 'column') {
            const t = await findTableForColumn(client, r.resource_id);
            if (!t) continue;
            tableId = t.table_resource_id;
            columnName = t.column_name;
          } else {
            // For now, table-name patterns can't synthesize row filters.
            continue;
          }
          const rlsExpression = renderFilterTemplate(rule.suggested_filter_template, columnName);
          const resourceCondition = JSON.stringify({ resource_ids: [tableId] });

          const ins = await client.query(
            `INSERT INTO authz_policy
               (policy_name, description, granularity, priority, effect, status,
                applicable_paths, subject_condition, resource_condition,
                action_condition, environment_condition,
                rls_expression, created_by,
                suggested_by_rule, suggested_at, suggested_reason)
             VALUES ($1, $2, 'L2_row_column', 100, 'allow', 'pending_review',
                     '{A,B,C}', '{}'::jsonb, $3::jsonb,
                     '{}'::jsonb, '{}'::jsonb,
                     $4, $5,
                     $6, now(), $7)
             ON CONFLICT (policy_name) DO NOTHING
             RETURNING policy_id`,
            [policyName, rule.description ?? `Auto-suggested row filter for ${columnName}`,
             resourceCondition, rlsExpression, createdBy, rule.rule_id, reason],
          );
          if (ins.rowCount && ins.rowCount > 0) result.policies_created++;
          else result.policies_skipped++;

        } else if (rule.rule_type === 'classification') {
          if (!rule.suggested_label) continue;
          // Tag the resource's attributes JSONB with the suggested label (idempotent).
          // attributes.classifications = ["PII:email", "sensitive:cost", ...]
          const upd = await client.query(
            `UPDATE authz_resource
                SET attributes = jsonb_set(
                      attributes,
                      '{classifications}',
                      COALESCE(attributes->'classifications', '[]'::jsonb)
                       || to_jsonb($2::text),
                      TRUE
                    ),
                    updated_at = now()
              WHERE resource_id = $1
                AND NOT (COALESCE(attributes->'classifications', '[]'::jsonb) ? $2)`,
            [r.resource_id, rule.suggested_label],
          );
          if (upd.rowCount && upd.rowCount > 0) result.classifications_tagged++;
        }
      }
    }

    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
