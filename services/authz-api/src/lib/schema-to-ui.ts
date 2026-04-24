// ============================================================
// Schema → UI descriptor introspector (BU-08, schema-driven UI POC)
//
// Reads a base table or view from any registered data source and emits
// a {columns, render_hints} JSON shape compatible with authz_ui_descriptor.
// Feeds POST /api/discover/generate-app — see docs/design-schema-driven-ui.md.
//
// Pure function: no writes. Caller is responsible for upserting the row
// and wiring permissions.
// ============================================================

import type { Pool } from 'pg';
import { createHash } from 'crypto';
import { classifyType, type ParamKind } from './function-metadata';

export interface IntrospectedColumn {
  key: string;            // column_name
  label: string;          // Title Case from column_name
  type: ParamKind;        // semantic kind from classifyType
  pg_type: string;        // raw data_type for debugging / Phase 4 hints
  render_hint: string;    // default render hint (admin can override)
  sortable?: boolean;
  width?: string;
  is_primary_key?: boolean;
  ordinal_position: number;
}

export interface IntrospectedDescriptor {
  columns: IntrospectedColumn[];
  render_hints: {
    grid_type: 'table';
    empty_icon: string;
    empty_message: string;
    actions: never[];
  };
  filters_config: Array<{ field: string; type: 'select' | 'text' | 'date_range' }>;
  derived_from: {
    source_id: string;
    schema: string;
    table_name: string;
    schema_hash: string;     // sha256 of (column_name|data_type) tuples
    column_count: number;
    truncated: boolean;       // true if we capped at MAX_COLUMNS
  };
}

const MAX_COLUMNS = 50; // §10 Q8: cap default display to avoid UI freeze on wide tables

// ── Default render-hint rules (§5 step 1, design doc) ─────────
//
// Single source of truth — Phase 4 override editor will let admins
// flip individual hints without changing this table.
function defaultRenderHint(pgType: string, columnName: string, kind: ParamKind): string {
  const name = columnName.toLowerCase();
  const t = pgType.toLowerCase();

  if (kind === 'text') {
    if (name.includes('email')) return 'email_link';
    if (/(^|_)(id|code|no|sn|uuid)($|_)/.test(name)) return 'mono';
    return 'text';
  }
  if (kind === 'number') return 'mono';
  if (kind === 'datetime') return 'relative_time';
  if (kind === 'date') return 'date';
  if (kind === 'bool') return 'active_badge';
  if (kind === 'json') return 'json_truncate';
  if (kind === 'array') return 'array_pills';
  // unknown / fallback
  if (t.includes('text') || t.includes('char')) return 'text';
  return 'text';
}

// ── Column name → display label (Title Case) ──────────────────
function toLabel(columnName: string): string {
  return columnName
    .split('_')
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ── Suggest filter config based on type and name patterns ────
function suggestFilters(cols: IntrospectedColumn[]): Array<{ field: string; type: 'select' | 'text' | 'date_range' }> {
  const filters: Array<{ field: string; type: 'select' | 'text' | 'date_range' }> = [];
  for (const c of cols) {
    if (c.type === 'datetime' || c.type === 'date') {
      filters.push({ field: c.key, type: 'date_range' });
    } else if (c.type === 'bool' || /(^|_)(status|state|type|kind)($|_)/.test(c.key.toLowerCase())) {
      filters.push({ field: c.key, type: 'select' });
    }
  }
  // Cap at 4 default filters; admin can extend later
  return filters.slice(0, 4);
}

// ── Main entry ────────────────────────────────────────────────
export async function introspectTable(
  dsPool: Pool,
  sourceId: string,
  schema: string,
  tableName: string,
): Promise<IntrospectedDescriptor> {
  // 1. Fetch columns + nullability + ordinal_position
  // information_schema returns data_type='ARRAY' for any array column; the
  // element type lives in udt_name (e.g. '_text' for text[]). classifyType
  // expects either 'foo[]' or '_foo', so we map ARRAY → udt_name here.
  const colsResult = await dsPool.query<{
    column_name: string;
    data_type: string;
    is_nullable: 'YES' | 'NO';
    ordinal_position: number;
  }>(
    `SELECT column_name,
            CASE WHEN data_type = 'ARRAY' THEN udt_name ELSE data_type END AS data_type,
            is_nullable, ordinal_position
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    [schema, tableName],
  );

  if (colsResult.rowCount === 0) {
    // Empty path (§4): table exists but no columns visible (rare — view with 0 cols)
    return {
      columns: [],
      render_hints: {
        grid_type: 'table',
        empty_icon: 'table-2',
        empty_message: '此資料源無可顯示欄位',
        actions: [],
      },
      filters_config: [],
      derived_from: {
        source_id: sourceId,
        schema,
        table_name: tableName,
        schema_hash: 'empty',
        column_count: 0,
        truncated: false,
      },
    };
  }

  // 2. Fetch primary key columns (one round-trip; pg_constraint is fast)
  const pkResult = await dsPool.query<{ column_name: string }>(
    `SELECT a.attname AS column_name
       FROM pg_index i
       JOIN pg_attribute a
         ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = ($1::text || '.' || quote_ident($2))::regclass
        AND i.indisprimary`,
    [schema, tableName],
  );
  const pkSet = new Set(pkResult.rows.map(r => r.column_name));

  // 3. Build columns (cap at MAX_COLUMNS, PK first, rest by ordinal_position)
  const allRows = colsResult.rows;
  const truncated = allRows.length > MAX_COLUMNS;
  const ordered = [
    ...allRows.filter(r => pkSet.has(r.column_name)),
    ...allRows.filter(r => !pkSet.has(r.column_name)),
  ].slice(0, MAX_COLUMNS);

  const columns: IntrospectedColumn[] = ordered.map(r => {
    const kind = classifyType(r.data_type);
    const isPk = pkSet.has(r.column_name);
    return {
      key: r.column_name,
      label: toLabel(r.column_name),
      type: kind,
      pg_type: r.data_type,
      render_hint: defaultRenderHint(r.data_type, r.column_name, kind),
      sortable: isPk || kind === 'datetime' || kind === 'date' || kind === 'number',
      ordinal_position: r.ordinal_position,
      ...(isPk ? { width: 'narrow', is_primary_key: true } : {}),
    };
  });

  // 4. Schema hash — for drift detection in Phase 4 (re-introspect)
  const schemaHash = createHash('sha256')
    .update(allRows.map(r => `${r.column_name}|${r.data_type}|${r.is_nullable}`).join('\n'))
    .digest('hex')
    .slice(0, 16);

  return {
    columns,
    render_hints: {
      grid_type: 'table',
      empty_icon: 'table-2',
      empty_message: `No rows in ${schema}.${tableName}`,
      actions: [],
    },
    filters_config: suggestFilters(columns),
    derived_from: {
      source_id: sourceId,
      schema,
      table_name: tableName,
      schema_hash: schemaHash,
      column_count: allRows.length,
      truncated,
    },
  };
}

// ── Helpers exposed for tests ────────────────────────────────
export const __test__ = { defaultRenderHint, toLabel, suggestFilters };
