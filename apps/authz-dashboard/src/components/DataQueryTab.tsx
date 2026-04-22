import { useState, useEffect, useMemo } from 'react';
import { api, DataSource } from '../api';
import { useToast } from './Toast';
import { EmptyState } from './shared/atoms/EmptyState';
import { PageHeader } from './shared/atoms/PageHeader';
import { Code2, Play, Loader2, Database, AlertCircle, Clock, Hash, AlertTriangle, FileText, Calculator, Zap, Pencil, Sparkles, CheckCircle2, UploadCloud, Table2 } from 'lucide-react';

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
  const [dataSources, setDataSources] = useState<DataSource[]>([]);
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

  useEffect(() => {
    api.datasources().then(ds => {
      const pgDs = ds.filter(d => d.db_type !== 'oracle' && d.is_active);
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
    reloadFunctions();
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
                {fns.map(fn => (
                  <button
                    key={fn.resource_id}
                    onClick={() => handleSelectFn(fn)}
                    className={`block w-full text-left px-3 py-2 text-xs border-b border-slate-100 hover:bg-blue-50 ${selectedFn?.resource_id === fn.resource_id ? 'bg-blue-50 border-l-2 border-l-blue-500' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-slate-800 truncate">{fn.function_name}</span>
                      <SubtypeBadge subtype={fn.subtype} />
                    </div>
                    <div className="text-[10px] text-slate-500 truncate mt-0.5">{fn.arguments || 'no args'}</div>
                  </button>
                ))}
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

  useEffect(() => {
    if (!dsId) return;
    setLoadingTables(true);
    setSelectedTable(null);
    api.dataQueryTables(dsId)
      .then(setTables)
      .catch(err => toast.error(err.message || 'Failed to load tables'))
      .finally(() => setLoadingTables(false));
  }, [dsId]); // eslint-disable-line react-hooks/exhaustive-deps

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

        <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
          <div className="px-3 py-2 border-b border-slate-200 bg-slate-50 flex items-center gap-2">
            <Code2 size={14} className="text-slate-500" />
            <span className="text-xs font-medium text-slate-600">SQL — CREATE [OR REPLACE] FUNCTION</span>
            <button
              disabled
              title="Coming in W5 — LLM integration"
              className="ml-auto px-2 py-0.5 text-[11px] rounded bg-violet-50 text-violet-500 border border-violet-200 cursor-not-allowed flex items-center gap-1"
            >
              <Sparkles size={11} /> Ask AI to draft
            </button>
          </div>
          <textarea
            value={sql}
            onChange={e => { setSql(e.target.value); setValidateResult(null); }}
            rows={14}
            spellCheck={false}
            placeholder={selectedTable ? undefined : 'Pick a table on the left, or paste your CREATE FUNCTION SQL here.'}
            className="w-full p-3 font-mono text-xs text-slate-800 bg-white focus:outline-none resize-y"
          />
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
