import { useState, useEffect, useCallback, ReactNode, useMemo, ComponentType } from 'react';
import { useAuthz } from '../AuthzContext';
import { useRenderTokens, RenderTokens } from '../RenderTokensContext';
import { api } from '../api';
import {
  Home, ChevronRight, ArrowLeft, Loader2, AlertTriangle,
  Package, ShoppingCart, ShieldCheck, FlaskConical, Undo2,
  DollarSign, ClipboardCheck, Layers, Database, Boxes,
  LucideIcon,
} from 'lucide-react';
import { ModulesTab } from './modules/ModulesTab';
import { AuditTab } from './AuditTab';

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
};

type FilterDef = {
  field: string;
  type: string;
  options: string[];
  default: string;
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
};

type PageMeta = {
  filteredCount: number;
  totalCount: number;
  columnMasks: Record<string, string>;
  resolvedRoles: string[];
  filterClause: string;
};

type StackEntry = {
  pageId: string;
  params: Record<string, string>;
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
          <label className="text-xs font-medium text-slate-500 capitalize">
            {f.field.replace(/_/g, ' ')}
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
}: {
  columns: ColumnDef[];
  data: Record<string, unknown>[];
  filters: FilterDef[];
  drilldown?: DrilldownDef;
  columnMasks: Record<string, string>;
  meta?: PageMeta;
  onRowClick?: (row: Record<string, unknown>) => void;
}) {
  const tokens = useRenderTokens();
  const [sortKey, setSortKey] = useState<string>('');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});

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
              {columns.map((col) => (
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
                <td colSpan={columns.length} className="px-3 py-8 text-center text-slate-400">
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
                  {columns.map((col) => (
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
  const navigateTo = useCallback(async (pageId: string, params: Record<string, string> = {}) => {
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
      })() : (
        <>
          {/* Built-in layout router (no handler) */}
          {current.config.layout === 'card_grid' && current.config.components && (
            <CardGrid
              components={current.config.components}
              onCardClick={handleCardClick}
            />
          )}

          {current.config.layout === 'table' && current.config.columns && (
            <DataTable
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

      {/* Drill-down params display (when navigated with params) */}
      {Object.keys(current.params).length > 0 && (
        <div className="mt-4 p-3 bg-slate-50 border border-slate-200 rounded-lg">
          <div className="text-xs font-medium text-slate-500 mb-1">Drill-down Parameters</div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(current.params).map(([k, v]) => (
              <span key={k} className="text-xs bg-white border border-slate-200 rounded px-2 py-1">
                <span className="text-slate-500">{k}:</span>{' '}
                <span className="font-medium text-slate-700">{v}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
