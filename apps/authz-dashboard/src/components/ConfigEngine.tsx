import { useState, useEffect, useCallback, ReactNode, useMemo } from 'react';
import { useAuthz } from '../AuthzContext';
import { api } from '../api';
import {
  Home, ChevronRight, ArrowLeft, Loader2, AlertTriangle,
  Package, ShoppingCart, ShieldCheck, FlaskConical, Undo2,
  DollarSign, ClipboardCheck, Layers, Database,
} from 'lucide-react';

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
// Icon registry — maps icon name from DB to lucide component
// ============================================================

const ICON_MAP: Record<string, ReactNode> = {
  'package':         <Package size={24} />,
  'shopping-cart':   <ShoppingCart size={24} />,
  'shield-check':    <ShieldCheck size={24} />,
  'flask-conical':   <FlaskConical size={24} />,
  'undo-2':          <Undo2 size={24} />,
  'dollar-sign':     <DollarSign size={24} />,
  'clipboard-check': <ClipboardCheck size={24} />,
  'layers':          <Layers size={24} />,
  'database':        <Database size={24} />,
};

// ============================================================
// Cell Renderers — SSOT: render type comes from config
// ============================================================

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-700',
  in_progress: 'bg-blue-100 text-blue-700',
  completed: 'bg-emerald-100 text-emerald-700',
  pending: 'bg-amber-100 text-amber-700',
  confirmed: 'bg-blue-100 text-blue-700',
  shipped: 'bg-indigo-100 text-indigo-700',
  closed: 'bg-slate-100 text-slate-600',
  hold: 'bg-amber-100 text-amber-700',
  on_hold: 'bg-amber-100 text-amber-700',
  scrapped: 'bg-red-100 text-red-700',
  failed: 'bg-red-100 text-red-700',
  passed: 'bg-emerald-100 text-emerald-700',
  waived: 'bg-purple-100 text-purple-700',
  open: 'bg-amber-100 text-amber-700',
  analyzing: 'bg-blue-100 text-blue-700',
  resolved: 'bg-emerald-100 text-emerald-700',
  'A+': 'bg-emerald-100 text-emerald-700',
  'A': 'bg-green-100 text-green-700',
  'B': 'bg-amber-100 text-amber-700',
  'C': 'bg-orange-100 text-orange-700',
  'Reject': 'bg-red-100 text-red-700',
  tier1: 'bg-emerald-100 text-emerald-700',
  tier2: 'bg-blue-100 text-blue-700',
  tier3: 'bg-amber-100 text-amber-700',
  distributor: 'bg-purple-100 text-purple-700',
};

const PHASE_COLORS: Record<string, string> = {
  wafer_prep: 'bg-slate-100 text-slate-700',
  die_attach: 'bg-blue-100 text-blue-700',
  wire_bond: 'bg-indigo-100 text-indigo-700',
  molding: 'bg-purple-100 text-purple-700',
  cp_test: 'bg-cyan-100 text-cyan-700',
  ft_test: 'bg-teal-100 text-teal-700',
  packing: 'bg-emerald-100 text-emerald-700',
  CP: 'bg-cyan-100 text-cyan-700',
  FT: 'bg-teal-100 text-teal-700',
  HTOL: 'bg-red-100 text-red-700',
  TC: 'bg-orange-100 text-orange-700',
  UHAST: 'bg-amber-100 text-amber-700',
  ESD: 'bg-yellow-100 text-yellow-700',
  'Latch-up': 'bg-pink-100 text-pink-700',
};

const GATE_COLORS: Record<string, string> = {
  G0_concept: 'bg-slate-100 text-slate-700',
  G1_feasibility: 'bg-blue-100 text-blue-700',
  G2_dev: 'bg-indigo-100 text-indigo-700',
  G3_qualification: 'bg-purple-100 text-purple-700',
  G4_mass_production: 'bg-emerald-100 text-emerald-700',
};

function renderCell(value: unknown, render?: string): ReactNode {
  if (value === null || value === undefined) return <span className="text-slate-300">—</span>;
  const str = String(value);

  if (str === '[DENIED]') {
    return <span className="text-red-400 font-mono text-xs" title="Access denied by policy">[DENIED]</span>;
  }

  if (!render) return str;

  switch (render) {
    case 'status_badge': {
      const color = STATUS_COLORS[str] || 'bg-slate-100 text-slate-600';
      return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>{str}</span>;
    }
    case 'phase_tag': {
      const color = PHASE_COLORS[str] || 'bg-blue-100 text-blue-700';
      return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${color}`}>{str}</span>;
    }
    case 'gate_badge': {
      const color = GATE_COLORS[str] || 'bg-slate-100 text-slate-700';
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
                      {renderCell(row[col.key], col.render)}
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
              {ICON_MAP[card.icon || ''] || <Database size={24} />}
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

export function ConfigEngine() {
  const { user } = useAuthz();
  const [stack, setStack] = useState<StackEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load root page on mount or user change
  const loadRoot = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.configExecRoot();
      setStack([{
        pageId: 'root',
        params: {},
        config: result.config as unknown as PageConfig,
        data: [],
      }]);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [user]);

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

  return (
    <div>
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-900">{current.config.title}</h1>
        {current.config.subtitle && (
          <p className="text-sm text-slate-500 mt-1">{current.config.subtitle}</p>
        )}
      </div>

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

      {/* Layout router */}
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
