import { useState, useEffect, useCallback, ReactNode, useMemo, ComponentType, FormEvent } from 'react';
import { useAuthz } from '../AuthzContext';
import { useRenderTokens, RenderTokens } from '../RenderTokensContext';
import { api, SavedViewConfig } from '../api';
import {
  Home, ChevronRight, ArrowLeft, Loader2, AlertTriangle,
  Package, ShoppingCart, ShieldCheck, FlaskConical, Undo2,
  DollarSign, ClipboardCheck, Layers, Database, Boxes,
  HelpCircle,
  LucideIcon,
} from 'lucide-react';
import { ModulesTab } from './modules/ModulesTab';
import { AuditTab } from './AuditTab';
import { NpiGateConsoleTab } from './NpiGateConsoleTab';
import { useSavedView } from '../hooks/useSavedView';
import { SavedViewBar } from './SavedViewBar';
import { FeedbackButton } from './FeedbackButton';

// ============================================================
// Types — all derived from API response, never hardcoded
// ============================================================

type ColumnDef = {
  key: string;
  label: string;
  data_type: string;
  render?: string;
  sortable?: boolean;
  align?: string;
  help_text?: string;
};

type FilterDef = {
  field: string;
  type: string;
  options: string[];
  default: string;
  help_text?: string;
};

type DrilldownDef = {
  page_id: string;
  param_mapping: Record<string, string>;
};

type CardComponent = {
  type: string;
  page_id: string;
  label: string;
  description?: string;
  icon?: string;
  drilldown?: { page_id: string };
};

type PageConfig = {
  page_id: string;
  title: string;
  subtitle?: string;
  layout: string;
  resource_id?: string;
  data_table?: string;
  columns?: ColumnDef[];
  filters?: FilterDef[];
  row_drilldown?: DrilldownDef;
  components?: CardComponent[];
  icon?: string;
  description?: string;
  /** L4: optional handler name. When set, the named handler owns the page
   *  (header + body); ConfigEngine skips built-in layout rendering.
   *  Mapped to a React component via HANDLER_REGISTRY. */
  handler_name?: string;
  // DAG-PUBLISH-V01: published-DAG live page. When `published_dag_id` is set,
  // the page renders a form derived from `form_schema` instead of a static
  // grid; submit re-calls /api/config-exec with the form values to live-run
  // the snapshotted DAG under the caller's authz.
  published_dag_id?: string;
  form_schema?: PublishedFormField[];
};

type PublishedFormField = {
  name: string;
  type: string;          // 'text' | 'number' | 'bool' | 'date' | 'datetime' | 'array' | 'json' | 'unknown'
  pg_type?: string;
  required: boolean;
  default: unknown;
  help_text?: string;
  source_node_id: string;
};

// DAG-PUBLISH-V01-FU: per-node output block surfaced on the published page.
// One per exposed_node_ids entry; shape mirrors dag-exec.DagExecOutput.
type PublishedDagOutput = {
  columns: Array<{ name: string; semantic_type?: string; dataTypeID?: number }>;
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
};

type PageMeta = {
  filteredCount?: number;
  totalCount?: number;
  columnMasks?: Record<string, string>;
  resolvedRoles?: string[];
  filterClause?: string;
  // DAG-PUBLISH-V01 — present on published_dag pages
  published_dag?: boolean;
  stage?: 'form_load' | 'exec';
  form_schema?: PublishedFormField[];
  output_node_id?: string;
  row_count?: number;
  truncated?: boolean;
  elapsed_ms?: number;
  lineage?: Array<{ node_id: string; detail: string }>;
  // DAG-PUBLISH-V01-FU — multi-output map (leaf + admin-flagged intermediates).
  // Absent on V086-era pages (re-published under FU populates it).
  outputs?: Record<string, PublishedDagOutput>;
  primary_output_node_id?: string;
};

type StackEntry = {
  pageId: string;
  params: Record<string, unknown>;          // widened for published_dag form values (text[], number, bool…)
  config: PageConfig;
  data: Record<string, unknown>[];
  meta?: PageMeta;
};

// ============================================================
// Icon catalog (Tier A platform)
//
// Maps the PascalCase lucide name (stored in authz_ui_render_token.value
// for category='icon') to the actual React component import. Curator-side
// kebab-case → PascalCase mapping lives in the DB (V053). To add a brand-
// new lucide icon, add a one-line import above + a row to this catalog +
// a row to authz_ui_render_token.
// ============================================================

const LUCIDE_ICON_CATALOG: Record<string, LucideIcon> = {
  Package, ShoppingCart, ShieldCheck, FlaskConical, Undo2,
  DollarSign, ClipboardCheck, Layers, Database, Boxes,
};

function resolveIcon(iconKey: string | undefined, tokens: RenderTokens, size = 24): ReactNode {
  if (!iconKey) return <Database size={size} />;
  const lucideName = tokens.icon[iconKey];
  const Component = lucideName ? LUCIDE_ICON_CATALOG[lucideName] : undefined;
  return Component ? <Component size={size} /> : <Database size={size} />;
}

// ============================================================
// Handler registry — L4 Config-SM dispatch
// Maps handler_name (from authz_ui_page.handler_name) to a React
// component. Admin assigns handlers to pages via SQL — no code change
// needed to reuse an existing handler on a new page. Handlers own
// their own header + layout; ConfigEngine just routes.
// ============================================================
export type HandlerProps = {
  config: PageConfig;
};

const HANDLER_REGISTRY: Record<string, ComponentType<HandlerProps>> = {
  // Handler names are identifiers, not page_ids. Multiple pages can
  // share a handler (e.g. different module roots all using modules_home_handler).
  'modules_home_handler': ModulesTab,
  'audit_home_handler': AuditTab,
  'npi_gate_console_handler': NpiGateConsoleTab,
};

// ============================================================
// Cell Renderers — SSOT: render type comes from config.
// Color tokens come from authz_ui_render_token (V053) via RenderTokensContext.
// ============================================================

function renderCell(value: unknown, render: string | undefined, tokens: RenderTokens): ReactNode {
  if (value === null || value === undefined) return <span className="text-slate-300">—</span>;
  const str = String(value);

  if (str === '[DENIED]') {
    return <span className="text-red-400 font-mono text-xs" title="Access denied by policy">[DENIED]</span>;
  }

  if (!render) return str;

  switch (render) {
    case 'status_badge': {
      const color = tokens.status_color[str] || 'bg-slate-100 text-slate-600';
      return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>{str}</span>;
    }
    case 'phase_tag': {
      const color = tokens.phase_color[str] || 'bg-blue-100 text-blue-700';
      return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${color}`}>{str}</span>;
    }
    case 'gate_badge': {
      const color = tokens.gate_color[str] || 'bg-slate-100 text-slate-700';
      const label = str.replace(/_/g, ' ').replace(/^G(\d)/, 'G$1:');
      return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${color}`}>{label}</span>;
    }
    case 'yield_bar': {
      const pct = parseFloat(str);
      if (isNaN(pct)) return str;
      const barColor = pct >= 95 ? 'bg-emerald-500' : pct >= 90 ? 'bg-amber-500' : 'bg-red-500';
      return (
        <div className="flex items-center gap-2">
          <div className="w-16 h-2 bg-slate-200 rounded-full overflow-hidden">
            <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
          <span className="text-xs font-mono whitespace-nowrap">{pct.toFixed(1)}%</span>
        </div>
      );
    }
    default:
      return str;
  }
}

// ============================================================
// resolveParams — $row.xxx → actual value
// ============================================================

function resolveParams(
  paramMapping: Record<string, string>,
  row: Record<string, unknown>,
): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [paramName, source] of Object.entries(paramMapping)) {
    if (typeof source === 'string' && source.startsWith('$row.')) {
      params[paramName] = String(row[source.slice(5)] ?? '');
    } else {
      params[paramName] = String(source);
    }
  }
  return params;
}

// ============================================================
// HelpIcon — inline ? icon + native title tooltip (Tier A primitive)
// ============================================================

function HelpIcon({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <span
      title={text}
      className="inline-flex items-center text-slate-400 hover:text-slate-600 cursor-help align-middle ml-1"
      aria-label={text}
      onClick={(e) => e.stopPropagation()}
    >
      <HelpCircle className="w-3.5 h-3.5" />
    </span>
  );
}

// ============================================================
// FilterBar — renders from config.filters (options from DISTINCT)
// ============================================================

function FilterBar({
  filters,
  values,
  onChange,
}: {
  filters: FilterDef[];
  values: Record<string, string>;
  onChange: (field: string, value: string) => void;
}) {
  if (filters.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-3 mb-4">
      {filters.map((f) => (
        <div key={f.field} className="flex items-center gap-1.5">
          <label className="text-xs font-medium text-slate-500 capitalize inline-flex items-center">
            {f.field.replace(/_/g, ' ')}
            <HelpIcon text={f.help_text} />
          </label>
          <select
            value={values[f.field] || f.default}
            onChange={(e) => onChange(f.field, e.target.value)}
            className="text-xs border border-slate-200 rounded-md px-2 py-1.5 bg-white
                       focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          >
            {f.options.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// DataTable — table layout with sort + filter + drilldown
// ============================================================

function DataTable({
  columns,
  data,
  filters,
  drilldown,
  columnMasks,
  meta,
  onRowClick,
  initialSort,
  initialFilters,
  initialHiddenCols,
  onStateChange,
}: {
  columns: ColumnDef[];
  data: Record<string, unknown>[];
  filters: FilterDef[];
  drilldown?: DrilldownDef;
  columnMasks: Record<string, string>;
  meta?: PageMeta;
  onRowClick?: (row: Record<string, unknown>) => void;
  initialSort?: { col: string; dir: 'asc' | 'desc' };
  initialFilters?: Record<string, string>;
  initialHiddenCols?: string[];
  onStateChange?: (s: {
    sortKey: string;
    sortDir: 'asc' | 'desc';
    filterValues: Record<string, string>;
    hiddenCols: string[];
  }) => void;
}) {
  const tokens = useRenderTokens();
  const [sortKey, setSortKey] = useState<string>(initialSort?.col || '');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(initialSort?.dir || 'asc');
  const [filterValues, setFilterValues] = useState<Record<string, string>>(initialFilters || {});
  const [hiddenCols, setHiddenCols] = useState<string[]>(initialHiddenCols || []);

  // Sync internal state when a saved view is applied/cleared from above.
  // String identity of the JSON form is used so re-renders with the same
  // values don't trigger churn.
  const initialKey = useMemo(
    () => JSON.stringify({ initialSort, initialFilters, initialHiddenCols }),
    [initialSort, initialFilters, initialHiddenCols]
  );
  useEffect(() => {
    setSortKey(initialSort?.col || '');
    setSortDir(initialSort?.dir || 'asc');
    setFilterValues(initialFilters || {});
    setHiddenCols(initialHiddenCols || []);
  }, [initialKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Report state up so the parent can persist via "save as" / "update"
  useEffect(() => {
    onStateChange?.({ sortKey, sortDir, filterValues, hiddenCols });
  }, [sortKey, sortDir, filterValues, hiddenCols, onStateChange]);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const handleFilterChange = (field: string, value: string) => {
    setFilterValues(prev => ({ ...prev, [field]: value }));
  };

  const visibleColumns = useMemo(
    () => columns.filter(c => !hiddenCols.includes(c.key)),
    [columns, hiddenCols]
  );

  // Client-side filter + sort
  const processedData = useMemo(() => {
    let result = [...data];

    // Apply filters
    for (const [field, value] of Object.entries(filterValues)) {
      if (value && value !== 'All') {
        result = result.filter(row => String(row[field]) === value);
      }
    }

    // Apply sort
    if (sortKey) {
      result.sort((a, b) => {
        const va = a[sortKey];
        const vb = b[sortKey];
        if (va === null || va === undefined) return 1;
        if (vb === null || vb === undefined) return -1;
        const cmp = String(va).localeCompare(String(vb), undefined, { numeric: true });
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }

    return result;
  }, [data, filterValues, sortKey, sortDir]);

  return (
    <div>
      <FilterBar filters={filters} values={filterValues} onChange={handleFilterChange} />

      {/* Stats bar */}
      {meta && (
        <div className="flex items-center gap-4 mb-3 text-xs text-slate-500">
          <span>Showing <strong>{processedData.length}</strong> of {meta.filteredCount} filtered ({meta.totalCount} total)</span>
          {Object.keys(columnMasks).length > 0 && (
            <span className="text-amber-600">
              {Object.keys(columnMasks).length} column(s) masked/denied
            </span>
          )}
        </div>
      )}

      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {visibleColumns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => col.sortable && handleSort(col.key)}
                  className={`px-3 py-2.5 text-left font-medium text-slate-600 whitespace-nowrap
                    ${col.sortable ? 'cursor-pointer hover:bg-slate-100 select-none' : ''}
                    ${col.align === 'right' ? 'text-right' : ''}
                    ${columnMasks[col.key] ? 'text-amber-600' : ''}`}
                  title={columnMasks[col.key] || undefined}
                >
                  {col.label}
                  <HelpIcon text={col.help_text} />
                  {col.sortable && sortKey === col.key && (
                    <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {processedData.length === 0 ? (
              <tr>
                <td colSpan={visibleColumns.length} className="px-3 py-8 text-center text-slate-400">
                  No data available
                </td>
              </tr>
            ) : (
              processedData.map((row, i) => (
                <tr
                  key={i}
                  onClick={() => drilldown && onRowClick?.(row)}
                  className={`border-b border-slate-100 hover:bg-blue-50/50 transition-colors
                    ${drilldown ? 'cursor-pointer' : ''}`}
                >
                  {visibleColumns.map((col) => (
                    <td
                      key={col.key}
                      className={`px-3 py-2 ${col.align === 'right' ? 'text-right' : ''}`}
                    >
                      {renderCell(row[col.key], col.render, tokens)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// CardGrid — card_grid layout for root/navigation pages
// ============================================================

function CardGrid({
  components,
  onCardClick,
}: {
  components: CardComponent[];
  onCardClick: (pageId: string) => void;
}) {
  const tokens = useRenderTokens();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {components.map((card) => (
        <button
          key={card.page_id}
          onClick={() => card.drilldown && onCardClick(card.drilldown.page_id)}
          className="bg-white border border-slate-200 rounded-xl p-5 text-left
                     hover:border-blue-300 hover:shadow-md transition-all group"
        >
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center shrink-0
                            group-hover:bg-blue-100 transition-colors">
              {resolveIcon(card.icon, tokens)}
            </div>
            <div className="min-w-0">
              <div className="font-semibold text-slate-900 text-sm">{card.label}</div>
              {card.description && (
                <div className="text-xs text-slate-500 mt-1 line-clamp-2">{card.description}</div>
              )}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

// ============================================================
// NavigationBar — breadcrumb + back + home
// ============================================================

function NavigationBar({
  stack,
  onBack,
  onHome,
  onBreadcrumb,
}: {
  stack: StackEntry[];
  onBack: () => void;
  onHome: () => void;
  onBreadcrumb: (index: number) => void;
}) {
  if (stack.length <= 1) return null;

  return (
    <div className="flex items-center gap-2 mb-4 text-sm">
      <button
        onClick={onHome}
        className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors"
        title="Home"
      >
        <Home size={16} />
      </button>
      <button
        onClick={onBack}
        className="p-1.5 rounded-md hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors"
        title="Back"
      >
        <ArrowLeft size={16} />
      </button>
      <div className="flex items-center gap-1 text-slate-500 overflow-x-auto">
        {stack.map((entry, i) => (
          <span key={i} className="flex items-center gap-1 whitespace-nowrap">
            {i > 0 && <ChevronRight size={14} className="text-slate-300 shrink-0" />}
            {i < stack.length - 1 ? (
              <button
                onClick={() => onBreadcrumb(i)}
                className="text-blue-600 hover:text-blue-800 hover:underline"
              >
                {entry.config.title}
              </button>
            ) : (
              <span className="text-slate-900 font-medium">{entry.config.title}</span>
            )}
          </span>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// TablePageWithSavedView — bridges DataTable internal state with
// the per-user saved view primitive (Tier A #2).
// ============================================================

function TablePageWithSavedView(props: {
  pageId: string;
  columns: ColumnDef[];
  data: Record<string, unknown>[];
  filters: FilterDef[];
  drilldown?: DrilldownDef;
  columnMasks: Record<string, string>;
  meta?: PageMeta;
  onRowClick?: (row: Record<string, unknown>) => void;
}) {
  // Read ?view=<id> once at mount; subsequent applyView updates the URL
  // via history.replaceState so no router dep is needed.
  const initialViewId = useMemo(() => {
    if (typeof window === 'undefined') return undefined;
    return new URLSearchParams(window.location.search).get('view') || undefined;
  }, []);

  const sv = useSavedView({ pageId: props.pageId, initialViewId });

  // Mirror live ConfigEngine state up so SavedViewBar can persist via
  // saveAsView / updateActiveView.
  const [liveState, setLiveState] = useState<{
    sortKey: string;
    sortDir: 'asc' | 'desc';
    filterValues: Record<string, string>;
    hiddenCols: string[];
  }>({ sortKey: '', sortDir: 'asc', filterValues: {}, hiddenCols: [] });

  const liveConfig: SavedViewConfig = useMemo(() => ({
    filters: Object.entries(liveState.filterValues)
      .filter(([, v]) => v && v !== 'All')
      .map(([field, value]) => ({ field, op: 'eq', value })),
    sort: liveState.sortKey
      ? { col: liveState.sortKey, dir: liveState.sortDir }
      : undefined,
    hidden_cols: liveState.hiddenCols.length ? liveState.hiddenCols : undefined,
  }), [liveState]);

  // Mirror activeView ↔ URL
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (sv.activeView) url.searchParams.set('view', sv.activeView.view_id);
    else url.searchParams.delete('view');
    window.history.replaceState({}, '', url.toString());
  }, [sv.activeView]);

  // Materialize active view config → DataTable initial props
  const initialFromView = useMemo(() => {
    const cfg = sv.activeView?.config_json;
    if (!cfg) return { sort: undefined, filters: undefined, hidden: undefined };
    const filterValues: Record<string, string> = {};
    for (const f of cfg.filters || []) {
      if (f.op === 'eq') filterValues[f.field] = f.value;
    }
    return {
      sort: cfg.sort,
      filters: filterValues,
      hidden: cfg.hidden_cols || [],
    };
  }, [sv.activeView]);

  return (
    <>
      <SavedViewBar
        views={sv.views}
        active={sv.activeView}
        loading={sv.loading}
        currentConfig={liveConfig}
        onApply={sv.applyView}
        onClear={sv.clearActive}
        onSaveAs={(name, cfg, isDefault) => sv.saveAsView(name, cfg, isDefault).then(() => undefined)}
        onUpdateActive={sv.updateActiveView}
        onRename={sv.renameView}
        onSetDefault={sv.setDefault}
        onDelete={sv.deleteView}
      />
      <DataTable
        key={sv.activeView?.view_id || 'no-view'}
        columns={props.columns}
        data={props.data}
        filters={props.filters}
        drilldown={props.drilldown}
        columnMasks={props.columnMasks}
        meta={props.meta}
        onRowClick={props.onRowClick}
        initialSort={initialFromView.sort}
        initialFilters={initialFromView.filters}
        initialHiddenCols={initialFromView.hidden}
        onStateChange={setLiveState}
      />
      <FeedbackButton pageId={props.pageId} />
    </>
  );
}

// ============================================================
// PublishedDagPage — DAG-PUBLISH-V01 live page renderer.
// Renders form_schema as inputs, submits via configExecPage which
// re-runs the snapshotted DAG live under the caller's authz, then
// renders the result rows below the form when meta.stage === 'exec'.
// ============================================================

function fieldInitialValue(field: PublishedFormField): unknown {
  // Convert API-side default (typed JSON) into a UI-side string for text-y
  // inputs. For arrays we join with ", " so the user can edit comma-sep.
  if (field.default !== null && field.default !== undefined) {
    if (field.type === 'array' && Array.isArray(field.default)) {
      return (field.default as unknown[]).map(String).join(', ');
    }
    if (field.type === 'bool') return Boolean(field.default);
    if (field.type === 'json') return JSON.stringify(field.default, null, 2);
    return String(field.default);
  }
  // No default → empty for text/number/array, false for bool
  if (field.type === 'bool') return false;
  return '';
}

function coerceFormValue(field: PublishedFormField, raw: unknown): unknown {
  // Translate UI-side string → API-side typed value matching pg_type.
  if (raw === '' || raw === null || raw === undefined) {
    return field.required ? raw : null;
  }
  switch (field.type) {
    case 'array': {
      const s = String(raw).trim();
      if (!s) return [];
      return s.split(',').map(t => t.trim()).filter(Boolean);
    }
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case 'bool':
      return Boolean(raw);
    case 'json': {
      const s = String(raw).trim();
      if (!s) return null;
      try { return JSON.parse(s); } catch { return s; }
    }
    default:
      return raw;
  }
}

function PublishedDagPage({
  entry,
  onSubmit,
}: {
  entry: StackEntry;
  onSubmit: (formValues: Record<string, unknown>) => void | Promise<void>;
}) {
  // Form schema lives on either config (form_load stage) or meta (after exec)
  const schema: PublishedFormField[] = useMemo(
    () => entry.config.form_schema || entry.meta?.form_schema || [],
    [entry.config.form_schema, entry.meta?.form_schema],
  );

  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const f of schema) init[f.name] = fieldInitialValue(f);
    // Preserve previously submitted params on re-render
    for (const [k, v] of Object.entries(entry.params || {})) {
      if (Array.isArray(v)) init[k] = (v as unknown[]).map(String).join(', ');
      else if (v !== null && v !== undefined) init[k] = typeof v === 'object' ? JSON.stringify(v, null, 2) : v;
    }
    return init;
  });

  const handleChange = (name: string, raw: unknown) => {
    setValues(prev => ({ ...prev, [name]: raw }));
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const coerced: Record<string, unknown> = {};
    for (const f of schema) {
      coerced[f.name] = coerceFormValue(f, values[f.name]);
    }
    void onSubmit(coerced);
  };

  const stage = entry.meta?.stage;
  const rows = entry.data || [];
  const lineage = entry.meta?.lineage || [];
  const elapsedMs = entry.meta?.elapsed_ms;
  const truncated = entry.meta?.truncated;
  const rowCount = entry.meta?.row_count;

  // Build column list for result table dynamically from the first row's keys.
  // Published exec doesn't return a column_def array (we don't have masks yet).
  const resultColumns: string[] = useMemo(() => {
    if (rows.length === 0) return [];
    return Object.keys(rows[0]);
  }, [rows]);

  // DAG-PUBLISH-V01-FU: ordered list of (nodeId, frame) tuples — primary
  // first, intermediates after, sorted for stability. When meta.outputs is
  // absent (V086 page that wasn't re-published), `orderedOutputs` is empty
  // and we fall back to the single-table render against `rows`.
  const orderedOutputs = useMemo(() => {
    const map = entry.meta?.outputs;
    if (!map) return [] as Array<[string, PublishedDagOutput]>;
    const primary = entry.meta?.primary_output_node_id ?? entry.meta?.output_node_id;
    const ids = Object.keys(map);
    const others = ids.filter((id) => id !== primary).sort();
    const ordered = [primary && map[primary] ? primary : null, ...others].filter(
      (id): id is string => id !== null && Object.prototype.hasOwnProperty.call(map, id),
    );
    return ordered.map((id) => [id, map[id]] as [string, PublishedDagOutput]);
  }, [entry.meta?.outputs, entry.meta?.primary_output_node_id, entry.meta?.output_node_id]);

  const primaryNodeId = entry.meta?.primary_output_node_id ?? entry.meta?.output_node_id;

  return (
    <div>
      {/* Form */}
      <form
        onSubmit={handleSubmit}
        className="mb-6 p-4 bg-white border border-slate-200 rounded-lg"
      >
        <div className="text-sm font-medium text-slate-700 mb-3 flex items-center gap-2">
          <span>Parameters</span>
          {entry.meta?.output_node_id && (
            <span className="text-xs font-mono text-slate-400">
              → {entry.meta.output_node_id}
            </span>
          )}
        </div>

        {schema.length === 0 ? (
          <div className="text-xs text-slate-500 italic mb-3">
            No exposed parameters — DAG will run with snapshot-bound inputs.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            {schema.map((field) => (
              <div key={field.name} className="flex flex-col">
                <label className="text-xs font-medium text-slate-600 mb-1 flex items-center gap-1">
                  <span className="font-mono">{field.name}</span>
                  {field.required && <span className="text-red-500">*</span>}
                  {field.pg_type && (
                    <span className="text-slate-400 font-normal">({field.pg_type})</span>
                  )}
                  <HelpIcon text={field.help_text} />
                </label>
                {field.type === 'bool' ? (
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={Boolean(values[field.name])}
                      onChange={(e) => handleChange(field.name, e.target.checked)}
                      className="w-4 h-4"
                    />
                    <span className="text-slate-600 text-xs">{String(Boolean(values[field.name]))}</span>
                  </label>
                ) : field.type === 'json' ? (
                  <textarea
                    value={String(values[field.name] ?? '')}
                    onChange={(e) => handleChange(field.name, e.target.value)}
                    placeholder={field.required ? 'required' : 'optional'}
                    rows={4}
                    className="border border-slate-300 rounded px-2 py-1 text-sm font-mono"
                  />
                ) : (
                  <input
                    type={field.type === 'number' ? 'number' : 'text'}
                    value={String(values[field.name] ?? '')}
                    onChange={(e) => handleChange(field.name, e.target.value)}
                    placeholder={
                      field.type === 'array'
                        ? 'comma,separated,values'
                        : field.required ? 'required' : 'optional'
                    }
                    className="border border-slate-300 rounded px-2 py-1 text-sm"
                  />
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded font-medium"
          >
            Run DAG
          </button>
          {stage === 'exec' && (
            <span className="text-xs text-slate-500">
              {typeof rowCount === 'number' && <>Returned <strong>{rowCount}</strong> row(s)</>}
              {truncated && <span className="ml-2 text-amber-600">(truncated)</span>}
              {typeof elapsedMs === 'number' && <span className="ml-2">in {elapsedMs} ms</span>}
            </span>
          )}
        </div>
      </form>

      {/* Result */}
      {stage === 'exec' && (
        orderedOutputs.length > 0 ? (
          // DAG-PUBLISH-V01-FU: multi-output render. Primary first, then
          // admin-flagged intermediates. Each block has its own header
          // (node id + primary badge) and meta line (row_count / truncated).
          <div className="space-y-4">
            {orderedOutputs.map(([nodeId, block]) => {
              const isPrimary = nodeId === primaryNodeId;
              const cols = block.columns?.length
                ? block.columns.map((c) => c.name)
                : (block.rows[0] ? Object.keys(block.rows[0]) : []);
              return (
                <div key={nodeId}>
                  <div className="flex items-baseline gap-2 mb-1.5">
                    <span className="text-xs font-mono text-slate-700">{nodeId}</span>
                    {isPrimary ? (
                      <span className="text-[10px] uppercase tracking-wide bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                        primary
                      </span>
                    ) : (
                      <span className="text-[10px] uppercase tracking-wide bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                        intermediate
                      </span>
                    )}
                    <span className="text-xs text-slate-500">
                      {block.row_count} row{block.row_count === 1 ? '' : 's'}
                      {block.truncated && <span className="ml-1 text-amber-600">(truncated)</span>}
                    </span>
                  </div>
                  {block.rows.length === 0 ? (
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded text-xs text-slate-500">
                      No rows returned.
                    </div>
                  ) : (
                    <div className="overflow-x-auto border border-slate-200 rounded-lg">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200">
                            {cols.map((c) => (
                              <th key={c} className="px-3 py-2 text-left font-medium text-slate-600 font-mono text-xs">
                                {c}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {block.rows.map((row, i) => (
                            <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                              {cols.map((c) => {
                                const v = row[c];
                                return (
                                  <td key={c} className="px-3 py-2 text-slate-700">
                                    {v === null || v === undefined
                                      ? <span className="text-slate-300">—</span>
                                      : typeof v === 'object'
                                        ? <code className="font-mono text-xs">{JSON.stringify(v)}</code>
                                        : String(v)}
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : rows.length === 0 ? (
          // Back-compat: V086 page (no meta.outputs) with no rows.
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-500">
            No rows returned.
          </div>
        ) : (
          // Back-compat: V086 page (no meta.outputs) — single-table render
          // against the top-level `data` payload.
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  {resultColumns.map((c) => (
                    <th key={c} className="px-3 py-2 text-left font-medium text-slate-600 font-mono text-xs">
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                    {resultColumns.map((c) => {
                      const v = row[c];
                      return (
                        <td key={c} className="px-3 py-2 text-slate-700">
                          {v === null || v === undefined
                            ? <span className="text-slate-300">—</span>
                            : typeof v === 'object'
                              ? <code className="font-mono text-xs">{JSON.stringify(v)}</code>
                              : String(v)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Lineage (debug aid for curators) */}
      {stage === 'exec' && lineage.length > 0 && (
        <details className="mt-3 text-xs text-slate-500">
          <summary className="cursor-pointer hover:text-slate-700">Execution lineage ({lineage.length} step{lineage.length === 1 ? '' : 's'})</summary>
          <div className="mt-2 p-2 bg-slate-50 border border-slate-200 rounded font-mono space-y-1">
            {lineage.map((step, i) => (
              <div key={i}>
                <span className="text-slate-400">{i + 1}.</span>{' '}
                <span className="text-slate-700">{step.node_id}</span>{' '}
                <span className="text-slate-500">— {step.detail}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      <FeedbackButton pageId={entry.pageId} />
    </div>
  );
}

// ============================================================
// ConfigDrilldownEngine — main component
// ============================================================

export function ConfigEngine({ initialPageId }: { initialPageId?: string } = {}) {
  const { user } = useAuthz();
  const [stack, setStack] = useState<StackEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load the initial page (root card grid, or a specific page if initialPageId given)
  const loadRoot = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      if (initialPageId) {
        // Direct page load — modules_home and other entry points
        const result = await api.configExecPage(initialPageId);
        setStack([{
          pageId: initialPageId,
          params: {},
          config: result.config as unknown as PageConfig,
          data: result.data || [],
          meta: result.meta as unknown as PageMeta,
        }]);
      } else {
        // Root card grid — default Data Explorer behavior
        const result = await api.configExecRoot();
        setStack([{
          pageId: 'root',
          params: {},
          config: result.config as unknown as PageConfig,
          data: [],
        }]);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [user, initialPageId]);

  useEffect(() => { loadRoot(); }, [loadRoot]);

  // Navigate to a page
  const navigateTo = useCallback(async (pageId: string, params: Record<string, unknown> = {}) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.configExecPage(pageId, params);
      const entry: StackEntry = {
        pageId,
        params,
        config: result.config as unknown as PageConfig,
        data: result.data || [],
        meta: result.meta as unknown as PageMeta,
      };
      setStack(prev => [...prev, entry]);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Navigation handlers
  const goBack = () => setStack(s => s.length > 1 ? s.slice(0, -1) : s);
  const goHome = () => setStack(s => s.length > 1 ? s.slice(0, 1) : s);
  const goTo = (index: number) => setStack(s => s.slice(0, index + 1));

  // Row click → drill down
  const handleRowClick = useCallback((row: Record<string, unknown>, drilldown: DrilldownDef) => {
    const params = resolveParams(drilldown.param_mapping, row);
    navigateTo(drilldown.page_id, params);
  }, [navigateTo]);

  // Card click → drill down
  const handleCardClick = useCallback((pageId: string) => {
    navigateTo(pageId);
  }, [navigateTo]);

  // Current page
  const current = stack[stack.length - 1];

  if (!user) {
    return (
      <div className="text-center py-16 text-slate-400">
        <Database size={48} className="mx-auto mb-4 opacity-50" />
        <p className="text-lg font-medium">Config Explorer</p>
        <p className="text-sm mt-1">Select a user to explore permitted data</p>
      </div>
    );
  }

  if (loading && stack.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-400">
        <Loader2 size={24} className="animate-spin mr-2" />
        Loading...
      </div>
    );
  }

  if (error && stack.length === 0) {
    return (
      <div className="text-center py-16">
        <AlertTriangle size={48} className="mx-auto mb-4 text-red-400" />
        <p className="text-red-600 text-sm">{error}</p>
        <button onClick={loadRoot} className="mt-4 text-blue-600 hover:underline text-sm">Retry</button>
      </div>
    );
  }

  if (!current) return null;

  // Handler-driven pages render their own header + layout — ConfigEngine just routes.
  // handler_name in authz_ui_page is the SSOT for dispatch (works across any layout).
  const hasHandler = !!current.config.handler_name;

  return (
    <div>
      {/* Page header — suppressed when a handler owns the page */}
      {!hasHandler && (
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">{current.config.title}</h1>
          {current.config.subtitle && (
            <p className="text-sm text-slate-500 mt-1">{current.config.subtitle}</p>
          )}
        </div>
      )}

      {/* Navigation */}
      <NavigationBar stack={stack} onBack={goBack} onHome={goHome} onBreadcrumb={goTo} />

      {/* Loading overlay for navigation */}
      {loading && stack.length > 0 && (
        <div className="flex items-center gap-2 mb-4 text-sm text-blue-600">
          <Loader2 size={16} className="animate-spin" />
          Loading page...
        </div>
      )}

      {/* Error for navigation */}
      {error && stack.length > 0 && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-start gap-2">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <div>{error}</div>
        </div>
      )}

      {/* Handler-driven pages → dispatch via DB-driven handler_name (L4).
          When a handler is set it owns the entire page body — built-in
          layouts (card_grid/table) are skipped. */}
      {hasHandler ? (() => {
        const handlerName = current.config.handler_name!;
        const Handler = HANDLER_REGISTRY[handlerName];
        if (!Handler) {
          return (
            <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700 flex items-start gap-2">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <div>
                Unknown handler <code className="font-mono">{handlerName}</code> for page <code className="font-mono">{current.pageId}</code>. Registered handlers: {Object.keys(HANDLER_REGISTRY).join(', ')}.
              </div>
            </div>
          );
        }
        return <Handler config={current.config} />;
      })() : current.config.published_dag_id ? (
        // DAG-PUBLISH-V01: live published-DAG page. Form on top, results
        // (when present) below. Submit re-calls configExecPage with form
        // values, replacing the current stack entry so back-button still
        // returns to the parent module.
        <PublishedDagPage
          key={current.pageId}
          entry={current}
          onSubmit={async (formValues) => {
            setLoading(true);
            setError(null);
            try {
              const result = await api.configExecPage(current.pageId, formValues);
              setStack(prev => [
                ...prev.slice(0, -1),
                {
                  pageId: current.pageId,
                  params: formValues,
                  config: result.config as unknown as PageConfig,
                  data: result.data || [],
                  meta: result.meta as unknown as PageMeta,
                },
              ]);
            } catch (err) {
              setError(String(err));
            } finally {
              setLoading(false);
            }
          }}
        />
      ) : (
        <>
          {/* Built-in layout router (no handler) */}
          {current.config.layout === 'card_grid' && current.config.components && (
            <CardGrid
              components={current.config.components}
              onCardClick={handleCardClick}
            />
          )}

          {current.config.layout === 'table' && current.config.columns && (
            <TablePageWithSavedView
              pageId={current.pageId}
              columns={current.config.columns}
              data={current.data}
              filters={current.config.filters || []}
              drilldown={current.config.row_drilldown}
              columnMasks={current.meta?.columnMasks || {}}
              meta={current.meta}
              onRowClick={current.config.row_drilldown
                ? (row) => handleRowClick(row, current.config.row_drilldown!)
                : undefined}
            />
          )}
        </>
      )}

      {/* Drill-down params display (when navigated with params, only on
          non-published pages — published pages already render the form). */}
      {!current.config.published_dag_id && Object.keys(current.params).length > 0 && (
        <div className="mt-4 p-3 bg-slate-50 border border-slate-200 rounded-lg">
          <div className="text-xs font-medium text-slate-500 mb-1">Drill-down Parameters</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(current.params).map(([k, v]) => (
              <span key={k} className="text-xs bg-white border border-slate-200 rounded px-2 py-1">
                <span className="text-slate-500">{k}:</span>{' '}
                <span className="font-medium text-slate-700">{Array.isArray(v) ? v.join(', ') : String(v ?? '')}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
