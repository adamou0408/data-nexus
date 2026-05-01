import { useState, useEffect, useMemo } from 'react';
import { api } from '../api';

type DataSourceLite = { source_id: string; display_name: string; db_type: string };
import { useToast } from './Toast';
import { EmptyState } from './shared/atoms/EmptyState';
import { PageHeader } from './shared/atoms/PageHeader';
import { AuthorPanelAIAssist } from './AuthorPanelAIAssist';
import { Code2, Play, Loader2, Database, AlertCircle, Clock, Hash, AlertTriangle, FileText, Calculator, Zap, Pencil, CheckCircle2, UploadCloud, Table2 } from 'lucide-react';

type ParsedArg = { name: string; pgType: string; hasDefault: boolean; kind?: string };
type OutputColumn = { name: string; pgType: string; kind?: string };
type ReturnShape =
  | { shape: 'table'; columns: OutputColumn[] }
  | { shape: 'setof'; pgType: string; kind?: string }
  | { shape: 'scalar'; pgType: string; kind?: string }
  | { shape: 'void' }
  | { shape: 'unknown'; raw: string };
type Subtype = 'query' | 'calculation' | 'action' | 'report';
type FunctionMeta = {
  resource_id: string;
  schema: string;
  function_name: string;
  display_name: string;
  arguments: string;
  parsed_args: ParsedArg[];
  return_type: string;
  return_shape?: ReturnShape;
  volatility: string;
  subtype?: Subtype;
  idempotent?: boolean;
  side_effects?: boolean;
};
type ExecResult = {
  columns: { name: string; dataTypeID: number }[];
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
  max_rows: number;
  elapsed_ms: number;
};

function classifyType(pgType: string): 'text' | 'number' | 'date' | 'datetime' | 'bool' | 'array' | 'json' {
  const t = pgType.toLowerCase();
  if (t.endsWith('[]')) return 'array';
  if (/\b(int|bigint|smallint|serial|bigserial)\b/.test(t)) return 'number';
  if (/\b(numeric|decimal|real|double|float)\b/.test(t)) return 'number';
  if (/\bboolean\b|\bbool\b/.test(t)) return 'bool';
  if (/\btimestamp\b/.test(t)) return 'datetime';
  if (/\bdate\b/.test(t)) return 'date';
  if (/\bjson\b|\bjsonb\b/.test(t)) return 'json';
  return 'text';
}

function coerceParam(raw: string | boolean, pgType: string): unknown {
  const kind = classifyType(pgType);
  if (kind === 'bool') return raw === true || raw === 'true';
  if (raw === '' || raw === null || raw === undefined) return null;
  const s = String(raw);
  if (kind === 'number') {
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  if (kind === 'array') {
    return s.split(',').map(p => p.trim()).filter(Boolean);
  }
  if (kind === 'json') {
    try { return JSON.parse(s); } catch { return s; }
  }
  return s;
}

function ParamInput({ arg, value, onChange }: {
  arg: ParsedArg;
  value: string | boolean;
  onChange: (v: string | boolean) => void;
}) {
  const kind = classifyType(arg.pgType);
  const base = 'input text-sm w-full';
  if (kind === 'bool') {
    return (
      <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)}
        className="w-4 h-4 accent-blue-600" />
    );
  }
  if (kind === 'number') {
    return <input type="number" step="any" value={value as string} onChange={e => onChange(e.target.value)} className={base} />;
  }
  if (kind === 'date') {
    return <input type="date" value={value as string} onChange={e => onChange(e.target.value)} className={base} />;
  }
  if (kind === 'datetime') {
    return <input type="datetime-local" value={value as string} onChange={e => onChange(e.target.value)} className={base} />;
  }
  if (kind === 'json') {
    return <textarea rows={3} value={value as string} onChange={e => onChange(e.target.value)} className={`${base} font-mono text-xs`} placeholder='{"key": "value"}' />;
  }
  if (kind === 'array') {
    return <input type="text" value={value as string} onChange={e => onChange(e.target.value)} className={base} placeholder="value1, value2, value3" />;
  }
  return <input type="text" value={value as string} onChange={e => onChange(e.target.value)} className={base} />;
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const SUBTYPE_META: Record<Subtype, { label: string; color: string; icon: typeof Code2 }> = {
  query:       { label: 'Query',       color: 'bg-blue-100 text-blue-700',     icon: Database },
  calculation: { label: 'Calculation', color: 'bg-emerald-100 text-emerald-700', icon: Calculator },
  action:      { label: 'Action',      color: 'bg-amber-100 text-amber-800',   icon: Zap },
  report:      { label: 'Report',      color: 'bg-violet-100 text-violet-700', icon: FileText },
};

function SubtypeBadge({ subtype }: { subtype?: Subtype }) {
  if (!subtype) return null;
  const m = SUBTYPE_META[subtype];
  const Icon = m.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${m.color}`}>
      <Icon size={10} /> {m.label}
    </span>
  );
}

export function DataQueryTab() {
  const toast = useToast();
  const [dataSources, setDataSources] = useState<DataSourceLite[]>([]);
  const [dsId, setDsId] = useState<string>('');
  const [functions, setFunctions] = useState<FunctionMeta[]>([]);
  const [selectedFn, setSelectedFn] = useState<FunctionMeta | null>(null);
  const [paramValues, setParamValues] = useState<Record<string, string | boolean>>({});
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ExecResult | null>(null);
  const [error, setError] = useState<string>('');
  const [loadingFns, setLoadingFns] = useState(false);
  const [subtypeFilter, setSubtypeFilter] = useState<Subtype | 'all'>('all');
  const [mode, setMode] = useState<'run' | 'author'>('run');
  // FN-QUALITY-LINT-V02: per-fn quality summary, indexed by resource_id.
  // Empty map ≡ not loaded yet ≡ no badge (better than mis-labelling fns
  // as clean before lint-all returns).
  const [fnLint, setFnLint] = useState<Record<string, { warn_count: number; info_count: number; codes: string[]; issues: LintIssue[] }>>({});

  useEffect(() => {
    api.datasourcesLite().then(ds => {
      const pgDs = ds.filter(d => d.db_type !== 'oracle');
      setDataSources(pgDs);
      if (pgDs.length > 0 && !dsId) setDsId(pgDs[0].source_id);
    }).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadFunctions = async (selectResourceId?: string) => {
    if (!dsId) return;
    setLoadingFns(true);
    try {
      const fns = await api.dataQueryFunctions(dsId);
      setFunctions(fns);
      if (selectResourceId) {
        const match = fns.find(f => f.resource_id === selectResourceId);
        if (match) {
          setSelectedFn(match);
          const initial: Record<string, string | boolean> = {};
          for (const a of match.parsed_args) initial[a.name] = classifyType(a.pgType) === 'bool' ? false : '';
          setParamValues(initial);
          setResult(null);
          setError('');
        }
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to load functions');
    } finally {
      setLoadingFns(false);
    }
  };

  useEffect(() => {
    if (!dsId) return;
    setSelectedFn(null);
    setResult(null);
    setFnLint({});                                                 // clear stale badges across DS switch
    reloadFunctions();
    // Quality badges run independently of fn list — failure to fetch lint
    // results never blocks the runner UI; we just hide the badges.
    api.dataQueryLintAll(dsId)
      .then((r) => setFnLint(r.functions))
      .catch(() => setFnLint({}));
  }, [dsId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectFn = (fn: FunctionMeta) => {
    setSelectedFn(fn);
    setResult(null);
    setError('');
    const initial: Record<string, string | boolean> = {};
    for (const a of fn.parsed_args) {
      initial[a.name] = classifyType(a.pgType) === 'bool' ? false : '';
    }
    setParamValues(initial);
  };

  const handleRun = async () => {
    if (!selectedFn) return;
    if (selectedFn.subtype === 'action' || selectedFn.side_effects) {
      const ok = window.confirm(
        `⚠ "${selectedFn.function_name}" is an Action — it may write data or trigger side effects.\n\nProceed?`
      );
      if (!ok) return;
    }
    const params: Record<string, unknown> = {};
    for (const a of selectedFn.parsed_args) {
      const raw = paramValues[a.name];
      if ((raw === '' || raw === undefined) && a.hasDefault) continue;
      params[a.name] = coerceParam(raw, a.pgType);
    }
    setRunning(true);
    setError('');
    setResult(null);
    try {
      const r = await api.dataQueryExec(dsId, selectedFn.resource_id, params);
      setResult(r);
    } catch (err: any) {
      setError(err.message || 'Execution failed');
    } finally {
      setRunning(false);
    }
  };

  const filtered = useMemo(() => {
    if (subtypeFilter === 'all') return functions;
    return functions.filter(f => (f.subtype || 'query') === subtypeFilter);
  }, [functions, subtypeFilter]);

  const grouped = useMemo(() => {
    const m = new Map<string, FunctionMeta[]>();
    for (const fn of filtered) {
      if (!m.has(fn.schema)) m.set(fn.schema, []);
      m.get(fn.schema)!.push(fn);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const subtypeCounts = useMemo(() => {
    const c: Record<Subtype | 'all', number> = { all: functions.length, query: 0, calculation: 0, action: 0, report: 0 };
    for (const fn of functions) c[(fn.subtype || 'query') as Subtype]++;
    return c;
  }, [functions]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={<span className="flex items-center gap-2"><Code2 size={22} className="text-blue-600" /> Query Tool</span>}
        subtitle="Author and run SQL functions against PG/Greenplum data sources"
      />

      <div className="flex items-center gap-3 flex-wrap">
        <Database size={16} className="text-slate-500" />
        <select value={dsId} onChange={e => setDsId(e.target.value)} className="input text-sm min-w-[280px]">
          <option value="">-- select data source --</option>
          {dataSources.map(d => (
            <option key={d.source_id} value={d.source_id}>{d.display_name} ({d.source_id})</option>
          ))}
        </select>
        {loadingFns && <Loader2 size={14} className="animate-spin text-slate-400" />}
        <div className="ml-auto inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
          <button
            onClick={() => setMode('run')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 ${
              mode === 'run' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Play size={12} /> Run
          </button>
          <button
            onClick={() => setMode('author')}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors flex items-center gap-1.5 ${
              mode === 'author' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            <Pencil size={12} /> Author
          </button>
        </div>
      </div>

      {mode === 'author' ? (
        <AuthorPanel
          dsId={dsId}
          onDeployed={(resourceId) => {
            setMode('run');
            reloadFunctions(resourceId);
          }}
        />
      ) : (
      <div className="grid grid-cols-12 gap-4">
        {/* Function list */}
        <div className="col-span-4 border border-slate-200 rounded-lg bg-white overflow-hidden">
          <div className="px-2 py-1.5 border-b border-slate-200 bg-slate-50 flex flex-wrap gap-1">
            {(['all', 'query', 'calculation', 'action', 'report'] as const).map(k => (
              <button
                key={k}
                onClick={() => setSubtypeFilter(k)}
                className={`px-2 py-0.5 text-[10px] rounded font-medium transition-colors ${
                  subtypeFilter === k ? 'bg-blue-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                }`}
              >
                {k === 'all' ? 'All' : SUBTYPE_META[k].label} <span className="opacity-70">({subtypeCounts[k]})</span>
              </button>
            ))}
          </div>
          <div className="max-h-[600px] overflow-y-auto">
            {grouped.length === 0 && !loadingFns && (
              <div className="p-4"><EmptyState icon={<Code2 size={24} />} message="No functions discovered for this data source" /></div>
            )}
            {grouped.map(([schema, fns]) => (
              <div key={schema}>
                <div className="px-3 py-1.5 text-[10px] font-mono uppercase text-slate-400 bg-slate-50 border-b border-slate-100">
                  {schema}
                </div>
                {fns.map(fn => {
                  const lint = fnLint[fn.resource_id];
                  const dotColor =
                    !lint ? null
                    : lint.warn_count > 0 ? '#f59e0b'           // amber — runtime-impacting
                    : lint.info_count > 0 ? '#94a3b8'           // slate — soft convention only
                    : '#10b981';                                // emerald — clean
                  const dotTitle = lint
                    ? lint.codes.length > 0
                      ? `Quality: ${lint.codes.join(', ')}`
                      : 'Quality: clean'
                    : '';
                  return (
                    <button
                      key={fn.resource_id}
                      onClick={() => handleSelectFn(fn)}
                      className={`block w-full text-left px-3 py-2 text-xs border-b border-slate-100 hover:bg-blue-50 ${selectedFn?.resource_id === fn.resource_id ? 'bg-blue-50 border-l-2 border-l-blue-500' : ''}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5 min-w-0">
                          {dotColor && (
                            <span
                              title={dotTitle}
                              aria-label={dotTitle}
                              style={{ background: dotColor }}
                              className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                            />
                          )}
                          <span className="font-mono text-slate-800 truncate">{fn.function_name}</span>
                        </span>
                        <SubtypeBadge subtype={fn.subtype} />
                      </div>
                      <div className="text-[10px] text-slate-500 truncate mt-0.5">{fn.arguments || 'no args'}</div>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* Detail + run */}
        <div className="col-span-8 space-y-3">
          {!selectedFn ? (
            <div className="border border-slate-200 rounded-lg bg-white p-12">
              <EmptyState icon={<Play size={32} />} message="Select a function from the left to run it" />
            </div>
          ) : (
            <>
              <div className="border border-slate-200 rounded-lg bg-white p-4 space-y-3">
                <div>
                  <div className="font-mono text-sm text-slate-900">{selectedFn.schema}.{selectedFn.function_name}</div>
                  <div className="text-xs text-slate-500 mt-0.5">→ {selectedFn.return_type}</div>
                  <div className="flex gap-1 mt-1 flex-wrap">
                    <SubtypeBadge subtype={selectedFn.subtype} />
                    <span className="badge text-[10px] badge-blue">{selectedFn.volatility}</span>
                    {selectedFn.idempotent && <span className="badge text-[10px] bg-slate-100 text-slate-600">idempotent</span>}
                  </div>
                </div>

                {(selectedFn.subtype === 'action' || selectedFn.side_effects) && (
                  <div className="flex items-start gap-2 p-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <div>
                      <div className="font-medium">Action — may write data or trigger side effects</div>
                      <div className="text-[11px] text-amber-700 mt-0.5">A confirmation will appear when you click Run.</div>
                    </div>
                  </div>
                )}

                {selectedFn.return_shape?.shape === 'table' && selectedFn.return_shape.columns.length > 0 && (
                  <div className="pt-2 border-t border-slate-100">
                    <div className="text-[11px] font-medium text-slate-600 mb-1.5">Output columns ({selectedFn.return_shape.columns.length})</div>
                    <div className="flex flex-wrap gap-1">
                      {selectedFn.return_shape.columns.map(c => (
                        <span key={c.name} className="inline-flex items-baseline gap-1 px-1.5 py-0.5 bg-slate-50 border border-slate-200 rounded text-[10px]">
                          <span className="font-mono text-slate-800">{c.name}</span>
                          <span className="text-slate-400 text-[9px]">{c.pgType}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {selectedFn.parsed_args.length > 0 && (
                  <div className="space-y-2 pt-2 border-t border-slate-100">
                    <div className="text-[11px] font-medium text-slate-600">Parameters</div>
                    {selectedFn.parsed_args.map(arg => (
                      <div key={arg.name} className="grid grid-cols-12 gap-2 items-center">
                        <div className="col-span-4">
                          <div className="text-xs font-mono text-slate-800">{arg.name}</div>
                          <div className="text-[10px] text-slate-500">{arg.pgType}{arg.hasDefault ? ' (optional)' : ''}</div>
                        </div>
                        <div className="col-span-8">
                          <ParamInput arg={arg} value={paramValues[arg.name] ?? ''} onChange={v => setParamValues(prev => ({ ...prev, [arg.name]: v }))} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* FN-QUALITY-LINT-V02-FU: Quality section. Sourced from the same
                    /functions/lint-all payload that drives the list dots — no
                    extra round-trip when the user expands a fn. Empty issues[]
                    renders nothing (clean fns don't need celebratory UI). */}
                {fnLint[selectedFn.resource_id] && fnLint[selectedFn.resource_id].issues.length > 0 && (
                  <div className="space-y-1.5 pt-2 border-t border-slate-100">
                    <div className="text-[11px] font-medium text-slate-600 flex items-center gap-1.5">
                      <AlertTriangle size={11} className="text-amber-600" /> Quality advisor ({fnLint[selectedFn.resource_id].issues.length})
                      <span className="ml-auto text-[9px] text-slate-400 font-normal">non-blocking</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {fnLint[selectedFn.resource_id].issues.map((iss, i) => {
                        const isWarn = iss.severity === 'warn';
                        return (
                          <span
                            key={`${iss.code}-${i}`}
                            title={`${iss.code} — ${iss.hint}`}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] cursor-help border ${
                              isWarn
                                ? 'bg-amber-100 text-amber-900 border-amber-300'
                                : 'bg-slate-100 text-slate-700 border-slate-300'
                            }`}
                          >
                            <span className="font-mono font-semibold">{iss.code}</span>
                            <span>{iss.message}</span>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                  <button
                    onClick={handleRun}
                    disabled={running}
                    className="btn btn-sm bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                    {running ? 'Running...' : 'Run'}
                  </button>
                  {result && (
                    <>
                      <span className="text-xs text-slate-600 flex items-center gap-1"><Clock size={12} /> {result.elapsed_ms} ms</span>
                      <span className="text-xs text-slate-600 flex items-center gap-1"><Hash size={12} /> {result.row_count} row{result.row_count === 1 ? '' : 's'}</span>
                      {result.truncated && (
                        <span className="text-xs text-amber-600 flex items-center gap-1"><AlertCircle size={12} /> truncated at {result.max_rows}</span>
                      )}
                    </>
                  )}
                </div>
              </div>

              {error && (
                <div className="border border-red-200 rounded-lg bg-red-50 p-3 text-xs text-red-700 flex items-start gap-2">
                  <AlertCircle size={14} className="shrink-0 mt-0.5" />
                  <div className="font-mono whitespace-pre-wrap break-all">{error}</div>
                </div>
              )}

              {result && result.rows.length > 0 && (
                <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
                  <div className="overflow-x-auto max-h-[500px]">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-slate-50 border-b border-slate-200">
                        <tr>
                          {result.columns.map(c => (
                            <th key={c.name} className="px-3 py-2 text-left font-medium text-slate-600 whitespace-nowrap">{c.name}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {result.rows.map((row, i) => (
                          <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
                            {result.columns.map(c => (
                              <td key={c.name} className="px-3 py-1.5 font-mono text-slate-800 max-w-[300px] truncate" title={formatCell(row[c.name])}>
                                {formatCell(row[c.name])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {result && result.rows.length === 0 && !error && (
                <div className="border border-slate-200 rounded-lg bg-white p-8">
                  <EmptyState icon={<Database size={24} />} message="Query returned 0 rows" />
                </div>
              )}
            </>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

// ============================================================
// AuthorPanel — author / validate / deploy a new SQL function
// ============================================================

type TableMeta = {
  resource_id: string;
  resource_type: 'table' | 'view';
  table_schema: string;
  table_name: string;
  display_name: string;
  table_comment: string | null;
  outputs: { name: string; pgType: string; kind?: string }[];
  output_count: number;
};

const SQL_TEMPLATE = (schema: string, table: string) =>
  `CREATE OR REPLACE FUNCTION ${schema}.fn_example_by_key(p_key text)
RETURNS TABLE(col1 text, col2 numeric)
LANGUAGE sql STABLE AS $$
  SELECT col1, col2
  FROM ${schema}.${table}
  WHERE /* your filter */ = p_key
$$;`;

// FN-QUALITY-LINT-V02 / F3: skeletons that pre-satisfy every quality rule
// (STABLE, LANGUAGE sql, p_<snake> args, explicit columns, conventional name).
// Each maps to a layer in the bottom-up SQL fn architecture: search → summary
// → aspect → keyword-driven driver. Curators replace <ENTITY> / <ASPECT> /
// table refs with real values; the surrounding shape is correct by default.
const FN_TEMPLATES = [
  {
    key: 'search',
    label: 'Search · fn_search_<entity>',
    description: 'Layer-1 keyword → entity lookup. Returns the canonical key (e.g. material_no).',
    sql: (schema: string) => `CREATE OR REPLACE FUNCTION ${schema}.fn_search_<entity>(p_keyword text)
RETURNS TABLE(<entity>_no text)
LANGUAGE sql STABLE AS $$
  SELECT <entity>_no
  FROM ${schema}.<entity>_master
  WHERE name ILIKE '%' || p_keyword || '%'
     OR description ILIKE '%' || p_keyword || '%'
$$;`,
  },
  {
    key: 'summary',
    label: 'Summary · fn_<entity>_summary',
    description: 'Layer-1 per-entity 360 view. One row per call, fed by an upstream key.',
    sql: (schema: string) => `CREATE OR REPLACE FUNCTION ${schema}.fn_<entity>_summary(p_<entity>_no text)
RETURNS TABLE(
  <entity>_no text,
  inbound_total numeric,
  outbound_total numeric,
  customer_count int
)
LANGUAGE sql STABLE AS $$
  SELECT
    p_<entity>_no AS <entity>_no,
    (SELECT COALESCE(SUM(qty), 0) FROM ${schema}.inbound  WHERE <entity>_no = p_<entity>_no),
    (SELECT COALESCE(SUM(qty), 0) FROM ${schema}.outbound WHERE <entity>_no = p_<entity>_no),
    (SELECT COUNT(DISTINCT customer_id) FROM ${schema}.outbound WHERE <entity>_no = p_<entity>_no)
$$;`,
  },
  {
    key: 'aspect',
    label: 'Aspect · fn_<entity>_<aspect>',
    description: 'Layer-1 narrow slice (one concern). Composes well with other aspects in the DAG.',
    sql: (schema: string) => `CREATE OR REPLACE FUNCTION ${schema}.fn_<entity>_<aspect>(p_<entity>_no text)
RETURNS TABLE(
  <entity>_no text,
  doc_no text,
  doc_date date,
  qty numeric
)
LANGUAGE sql STABLE AS $$
  SELECT <entity>_no, doc_no, doc_date, qty
  FROM ${schema}.<aspect>_table
  WHERE <entity>_no = p_<entity>_no
  ORDER BY doc_date DESC
$$;`,
  },
  {
    key: 'keyword_driver',
    label: 'Driver · fn_keyword_<entity>_<aspect>',
    description: 'Layer-2 fan-out. Plugs the search result into a per-entity fn via CROSS JOIN LATERAL.',
    sql: (schema: string) => `CREATE OR REPLACE FUNCTION ${schema}.fn_keyword_<entity>_<aspect>(p_keyword text)
RETURNS TABLE(
  <entity>_no text,
  doc_no text,
  doc_date date,
  qty numeric
)
LANGUAGE sql STABLE AS $$
  SELECT s.<entity>_no, s.doc_no, s.doc_date, s.qty
  FROM ${schema}.fn_search_<entity>(p_keyword) m
  CROSS JOIN LATERAL ${schema}.fn_<entity>_<aspect>(m.<entity>_no) s
$$;`,
  },
] as const;

type LintIssue = {
  severity: 'warn' | 'info';
  code: 'FQL-01' | 'FQL-02' | 'FQL-03' | 'FQL-04';
  message: string;
  hint: string;
  context?: string;
};

function AuthorPanel({ dsId, onDeployed }: { dsId: string; onDeployed: (resourceId: string) => void }) {
  const toast = useToast();
  const [tables, setTables] = useState<TableMeta[]>([]);
  const [loadingTables, setLoadingTables] = useState(false);
  const [selectedTable, setSelectedTable] = useState<TableMeta | null>(null);
  const [sql, setSql] = useState<string>('');
  const [validating, setValidating] = useState(false);
  const [deploying, setDeploying] = useState(false);
  const [validateResult, setValidateResult] = useState<any>(null);
  const [authorError, setAuthorError] = useState<string>('');
  // FN-QUALITY-LINT-V01: advisory issues (non-blocking). Debounced re-lint
  // on every SQL change keeps the pills in sync without thrashing the API.
  const [lintIssues, setLintIssues] = useState<LintIssue[]>([]);

  useEffect(() => {
    if (!dsId) return;
    setLoadingTables(true);
    setSelectedTable(null);
    api.dataQueryTables(dsId)
      .then(setTables)
      .catch(err => toast.error(err.message || 'Failed to load tables'))
      .finally(() => setLoadingTables(false));
  }, [dsId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced lint pass — runs whenever SQL changes. The endpoint is pure-text
  // (no DB), so 600ms is plenty cheap and gives near-live pill updates without
  // racing the editor. Empty SQL clears issues.
  useEffect(() => {
    if (!sql.trim()) { setLintIssues([]); return; }
    const handle = setTimeout(() => {
      api.dataQueryLint(sql)
        .then((r) => setLintIssues(r.issues as LintIssue[]))
        .catch(() => setLintIssues([]));   // bad header → just hide pills
    }, 600);
    return () => clearTimeout(handle);
  }, [sql]);

  const handlePickTable = (t: TableMeta) => {
    setSelectedTable(t);
    setAuthorError('');
    setValidateResult(null);
    if (!sql.trim()) {
      setSql(SQL_TEMPLATE(t.table_schema, t.table_name));
    }
  };

  const handleValidate = async () => {
    if (!sql.trim()) return;
    // FN-QUALITY-LINT-V01-FU: warn-gate at Validate. We re-lint synchronously
    // here (rather than reading lintIssues state) so a curator who clicks
    // Validate before the 600ms debounce settles still sees fresh advice.
    // info-level issues stay non-blocking — only warns prompt the dialog.
    try {
      const lr = await api.dataQueryLint(sql);
      const next = lr.issues as LintIssue[];
      setLintIssues(next);
      const warns = next.filter((i) => i.severity === 'warn');
      if (warns.length > 0) {
        const list = warns.map((i) => `  • ${i.code} — ${i.message}`).join('\n');
        const proceed = window.confirm(
          `Quality advisor flagged ${warns.length} warning(s):\n\n${list}\n\nValidate anyway?`
        );
        if (!proceed) return;
      }
    } catch {
      /* lint endpoint rejects on bad CREATE FUNCTION header — let the validate
         path return the canonical error so the curator sees only one message. */
    }
    setValidating(true);
    setAuthorError('');
    setValidateResult(null);
    try {
      const r = await api.dataQueryValidate(dsId, sql);
      setValidateResult(r);
    } catch (err: any) {
      setAuthorError(err.message || 'Validation failed');
    } finally {
      setValidating(false);
    }
  };

  const handleDeploy = async () => {
    if (!sql.trim()) return;
    const ok = window.confirm('Deploy this function to the target database and grant ADMIN execute?\n\nThis runs CREATE FUNCTION on the remote DS.');
    if (!ok) return;
    setDeploying(true);
    setAuthorError('');
    try {
      const r = await api.dataQueryDeploy(dsId, sql);
      toast.success(`Deployed ${r.schema}.${r.function_name}`);
      onDeployed(r.resource_id);
    } catch (err: any) {
      setAuthorError(err.message || 'Deploy failed');
    } finally {
      setDeploying(false);
    }
  };

  return (
    <div className="grid grid-cols-12 gap-4">
      {/* Left: table picker */}
      <div className="col-span-4 border border-slate-200 rounded-lg bg-white overflow-hidden">
        <div className="px-3 py-2 border-b border-slate-200 text-xs font-medium text-slate-600 bg-slate-50 flex items-center gap-2">
          <Table2 size={14} /> Tables ({tables.length})
        </div>
        <div className="max-h-[650px] overflow-y-auto">
          {loadingTables && (
            <div className="p-4 text-center"><Loader2 size={16} className="animate-spin inline text-slate-400" /></div>
          )}
          {!loadingTables && tables.length === 0 && (
            <div className="p-4"><EmptyState icon={<Table2 size={24} />} message="No tables discovered for this data source" /></div>
          )}
          {tables.map(t => (
            <button
              key={t.resource_id}
              onClick={() => handlePickTable(t)}
              className={`block w-full text-left px-3 py-2 text-xs border-b border-slate-100 hover:bg-blue-50 ${selectedTable?.resource_id === t.resource_id ? 'bg-blue-50 border-l-2 border-l-blue-500' : ''}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-slate-800 truncate">{t.table_name}</span>
                <span className="text-[10px] text-slate-400 shrink-0">{t.output_count} cols</span>
              </div>
              {t.table_comment && <div className="text-[10px] text-slate-500 truncate mt-0.5">{t.table_comment}</div>}
            </button>
          ))}
        </div>
      </div>

      {/* Right: SQL editor + validate/deploy */}
      <div className="col-span-8 space-y-3">
        {selectedTable && (
          <div className="border border-slate-200 rounded-lg bg-white p-3">
            <div className="text-[11px] font-medium text-slate-600 mb-1.5">
              {selectedTable.table_schema}.{selectedTable.table_name} — columns
            </div>
            <div className="flex flex-wrap gap-1 max-h-28 overflow-y-auto">
              {selectedTable.outputs.map(c => (
                <span key={c.name} className="inline-flex items-baseline gap-1 px-1.5 py-0.5 bg-slate-50 border border-slate-200 rounded text-[10px]">
                  <span className="font-mono text-slate-800">{c.name}</span>
                  <span className="text-slate-400 text-[9px]">{c.pgType}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        <AuthorPanelAIAssist
          dsId={dsId}
          sql={sql}
          onSqlChange={(next) => { setSql(next); setValidateResult(null); setAuthorError(''); }}
        />

        <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-200 bg-slate-50 flex items-center gap-2">
            <Code2 size={14} className="text-slate-500" />
            <span className="text-xs font-medium text-slate-600">SQL — CREATE [OR REPLACE] FUNCTION</span>
            <select
              value=""
              onChange={(e) => {
                const tpl = FN_TEMPLATES.find((t) => t.key === e.target.value);
                if (!tpl) return;
                if (sql.trim() && !window.confirm('Overwrite the current SQL with this template?')) {
                  e.target.value = '';
                  return;
                }
                setSql(tpl.sql(selectedTable?.table_schema || 'public'));
                setValidateResult(null);
                setAuthorError('');
                e.target.value = '';
              }}
              className="ml-auto text-[11px] border border-slate-300 rounded px-1.5 py-0.5 bg-white text-slate-700 hover:bg-slate-50"
              title="Insert a skeleton that already passes the quality rules"
            >
              <option value="">+ New from template…</option>
              {FN_TEMPLATES.map((t) => (
                <option key={t.key} value={t.key} title={t.description}>{t.label}</option>
              ))}
            </select>
          </div>
          <textarea
            value={sql}
            onChange={e => { setSql(e.target.value); setValidateResult(null); }}
            rows={14}
            spellCheck={false}
            placeholder={selectedTable ? undefined : 'Pick a table on the left, or paste your CREATE FUNCTION SQL here.'}
            className="w-full p-3 font-mono text-xs text-slate-800 bg-white focus:outline-none resize-y"
          />
          {lintIssues.length > 0 && (
            <div className="px-3 py-2 border-t border-slate-200 bg-amber-50/50">
              <div className="text-[10px] font-medium text-amber-800 uppercase tracking-wide mb-1.5 flex items-center gap-1">
                <AlertTriangle size={11} /> Quality advisor ({lintIssues.length})
                <span className="ml-auto text-[9px] text-amber-700/70 normal-case font-normal">non-blocking — Deploy stays enabled</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {lintIssues.map((iss, i) => {
                  const isWarn = iss.severity === 'warn';
                  return (
                    <span
                      key={`${iss.code}-${i}`}
                      title={`${iss.code} — ${iss.hint}`}
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] cursor-help border ${
                        isWarn
                          ? 'bg-amber-100 text-amber-900 border-amber-300'
                          : 'bg-slate-100 text-slate-700 border-slate-300'
                      }`}
                    >
                      <span className="font-mono font-semibold">{iss.code}</span>
                      <span>{iss.message}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}
          <div className="px-3 py-2 border-t border-slate-200 bg-slate-50 flex items-center gap-2">
            <button
              onClick={handleValidate}
              disabled={validating || !sql.trim()}
              className="btn btn-sm bg-white border border-slate-300 text-slate-700 hover:bg-slate-100 flex items-center gap-1.5 disabled:opacity-50"
            >
              {validating ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              {validating ? 'Validating…' : 'Validate'}
            </button>
            <button
              onClick={handleDeploy}
              disabled={deploying || !sql.trim()}
              className="btn btn-sm bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1.5 disabled:opacity-50"
            >
              {deploying ? <Loader2 size={14} className="animate-spin" /> : <UploadCloud size={14} />}
              {deploying ? 'Deploying…' : 'Deploy'}
            </button>
            <span className="text-[11px] text-slate-500 ml-2">Target: {dsId || '(no data source)'}</span>
          </div>
        </div>

        {authorError && (
          <div className="border border-red-200 rounded-lg bg-red-50 p-3 text-xs text-red-700 flex items-start gap-2">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <div className="font-mono whitespace-pre-wrap break-all">{authorError}</div>
          </div>
        )}

        {validateResult && (
          <div className="border border-emerald-200 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-900 space-y-2">
            <div className="flex items-center gap-2 font-medium"><CheckCircle2 size={14} /> Validation passed (rolled back)</div>
            <div className="font-mono text-[11px]">
              <div>{validateResult.schema}.{validateResult.function_name}({validateResult.arguments || ''})</div>
              <div className="text-emerald-700 mt-0.5">→ {validateResult.return_type}</div>
              <div className="mt-1"><SubtypeBadge subtype={validateResult.subtype as Subtype} /> <span className="ml-1 text-[10px]">volatility: {validateResult.volatility}</span></div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
