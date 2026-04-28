// ============================================================
// Schema Context Builder for AI-assisted SQL authoring
//
// Builds a flat, authz-filtered list of tables/columns for a single data
// source so the LLM can name real columns when drafting / refining functions.
//
// Constitution refs:
//   §9.2 — read scope follows authz_check(userId, 'read', resource_id);
//          tables the user cannot read are stripped before the prompt is
//          assembled, so the LLM never learns of them.
//   §9.6 — only schema metadata is sent (no row data, no row counts);
//          PII column values are out of scope by construction.
// ============================================================

import { pool as authzPool } from '../db';

const MAX_TABLES = 50;
const MAX_COLUMNS_PER_TABLE = 30;

interface RawColumn {
  parent_id: string;
  column_name: string;
  data_type: string;
  semantic_type: string | null;
}

interface RawTable {
  resource_id: string;
  display_name: string;
  table_schema: string;
  table_name: string;
}

export interface SchemaContext {
  text: string;
  table_count: number;
  truncated: boolean;
}

function bareName(resourceId: string): { schema: string; name: string } {
  const tail = resourceId.includes(':') ? resourceId.split(':').slice(1).join(':') : resourceId;
  const dot = tail.lastIndexOf('.');
  return dot >= 0
    ? { schema: tail.slice(0, dot), name: tail.slice(dot + 1) }
    : { schema: 'public', name: tail };
}

/**
 * Pull tables for the data source, filter by authz_check(read), then attach
 * the most useful columns. Returned text is formatted for the system prompt.
 */
export async function buildSchemaContext(opts: {
  userId: string;
  groups?: string[];
  dataSourceId: string;
  maxTables?: number;
}): Promise<SchemaContext> {
  const max = Math.max(1, Math.min(opts.maxTables ?? MAX_TABLES, MAX_TABLES));
  const groups = opts.groups ?? [];

  const tablesRes = await authzPool.query<RawTable & { schema_attr: string | null; name_attr: string | null }>(
    `SELECT resource_id, display_name,
            attributes->>'table_schema' AS schema_attr,
            attributes->>'table_name'   AS name_attr
     FROM authz_resource
     WHERE resource_type IN ('table','view')
       AND is_active = TRUE
       AND attributes->>'data_source_id' = $1
     ORDER BY resource_id
     LIMIT 200`,
    [opts.dataSourceId],
  );

  const visible: RawTable[] = [];
  for (const row of tablesRes.rows) {
    const allowed = await authzPool.query<{ allowed: boolean }>(
      'SELECT authz_check($1, $2, $3, $4) AS allowed',
      [opts.userId, groups, 'read', row.resource_id],
    );
    if (!allowed.rows[0]?.allowed) continue;
    const fallback = bareName(row.resource_id);
    visible.push({
      resource_id: row.resource_id,
      display_name: row.display_name,
      table_schema: row.schema_attr ?? fallback.schema,
      table_name: row.name_attr ?? fallback.name,
    });
    if (visible.length >= max) break;
  }

  const truncated = tablesRes.rows.length > visible.length && tablesRes.rows.length > max;
  if (visible.length === 0) {
    return {
      text: `No readable tables found on data source \`${opts.dataSourceId}\` for this user. Ask the admin to grant 'read' on the relevant table resources.`,
      table_count: 0,
      truncated: false,
    };
  }

  const colsRes = await authzPool.query<RawColumn>(
    `SELECT parent_id,
            COALESCE(attributes->>'column_name', regexp_replace(resource_id, '^column:[^.]+\\.', '')) AS column_name,
            COALESCE(attributes->>'data_type', attributes->>'pgType', 'unknown') AS data_type,
            attributes->>'semantic_type' AS semantic_type
     FROM authz_resource
     WHERE resource_type = 'column'
       AND is_active = TRUE
       AND attributes->>'data_source_id' = $1
       AND parent_id = ANY($2::text[])
     ORDER BY parent_id, resource_id`,
    [opts.dataSourceId, visible.map((t) => t.resource_id)],
  );

  const colsByTable = new Map<string, RawColumn[]>();
  for (const c of colsRes.rows) {
    const list = colsByTable.get(c.parent_id) ?? [];
    if (list.length < MAX_COLUMNS_PER_TABLE) list.push(c);
    colsByTable.set(c.parent_id, list);
  }

  const lines: string[] = [];
  lines.push(`Data source: ${opts.dataSourceId}`);
  lines.push(`Authz-filtered tables for user '${opts.userId}' (showing ${visible.length}${truncated ? `, ${tablesRes.rows.length - visible.length} more hidden — refine your prompt with a schema name` : ''}):`);
  lines.push('');
  for (const t of visible) {
    const cols = colsByTable.get(t.resource_id) ?? [];
    const colDescs = cols.map((c) => {
      const sem = c.semantic_type && c.semantic_type !== 'unknown' ? ` [semantic: ${c.semantic_type}]` : '';
      return `${c.column_name} ${c.data_type}${sem}`;
    });
    if (colDescs.length === 0) {
      lines.push(`- ${t.table_schema}.${t.table_name}  (no column metadata)`);
    } else {
      lines.push(`- ${t.table_schema}.${t.table_name} (${colDescs.join(', ')})`);
    }
  }
  lines.push('');
  lines.push('Conventions you must follow when drafting functions:');
  lines.push('- Top-level statement: CREATE OR REPLACE FUNCTION <schema>.<name>(...) RETURNS TABLE(...) LANGUAGE sql STABLE AS $$ ... $$;');
  lines.push('- Name in snake_case; prefix with intent (search_, get_, fn_, list_).');
  lines.push("- Parameters: p_<name> with explicit PostgreSQL types (e.g. p_material_no text).");
  lines.push('- Use SECURITY INVOKER (default); never SECURITY DEFINER.');
  lines.push('- Reference only tables/columns from the list above — do not invent identifiers.');
  lines.push('- Output ONLY the SQL inside a single ```sql fenced block. No prose, no commentary outside the fence.');

  return {
    text: lines.join('\n'),
    table_count: visible.length,
    truncated,
  };
}
