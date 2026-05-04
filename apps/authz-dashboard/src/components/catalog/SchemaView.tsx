// Catalog SchemaView — table-schema frame renderer.
// Logic copied from components/TablesTab.tsx and parameterised on
// frame.table (no in-frame table picker; the picker lives in TableGridFrame).

import { useEffect, useState } from 'react';
import { api, DataExplorerColumn, DataExplorerResult } from '../../api';
import { useAuthz } from '../../AuthzContext';
import { useDataSource } from '../../DataSourceContext';
import { ChevronRight, CheckCircle2, XCircle, Lock, Eye, EyeOff, Filter, Code2, Database } from 'lucide-react';
import type { CatalogStackAPI, TableSchemaFrame } from './types';

type SchemaViewProps = {
  frame: TableSchemaFrame;
  api?: CatalogStackAPI;  // unused in Phase 1 schema view (no internal navigation yet)
};

export function SchemaView({ frame }: SchemaViewProps) {
  const { user } = useAuthz();
  const { activeDataSourceId } = useDataSource();
  const [result, setResult] = useState<DataExplorerResult | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (!activeDataSourceId) {
      setResult(null);
      setDetailLoading(false);
      return;
    }
    let cancelled = false;
    setDetailLoading(true);
    setResult(null);

    const load = async () => {
      try {
        if (user) {
          const r = await api.dataExplorer(user.id, user.groups, user.attrs, frame.table, activeDataSourceId);
          if (!cancelled) setResult(r);
        } else {
          const r = await api.tableSchema(frame.table, activeDataSourceId);
          if (!cancelled) {
            setResult({
              table: frame.table,
              columns: r.columns.map((c) => ({
                ...c,
                access: 'visible' as const,
                mask_type: null,
                mask_function: null,
              })),
              rls_filter: 'TRUE',
              sample_data: r.sample_data,
              total_count: r.sample_data.length,
              filtered_count: r.sample_data.length,
              mask_functions: [],
            });
          }
        }
      } catch {
        if (!cancelled) setResult(null);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [frame.table, user, activeDataSourceId]);

  if (!activeDataSourceId) {
    return (
      <div className="space-y-6">
        <div className="page-header">
          <h1 className="page-title font-mono">{frame.table}</h1>
        </div>
        <div className="card">
          <div className="card-body text-center py-16 text-slate-500">
            <Database className="mx-auto mb-3 text-slate-300" size={36} />
            <div className="text-sm font-medium text-slate-700">No data source selected</div>
            <div className="text-xs mt-1">Pick one from the sidebar picker (bottom-left) to view schema and data.</div>
          </div>
        </div>
      </div>
    );
  }

  const accessIcon = (access: string) => {
    if (access === 'denied') return <XCircle size={14} className="text-red-500" />;
    if (access === 'masked') return <EyeOff size={14} className="text-amber-500" />;
    return <CheckCircle2 size={14} className="text-emerald-500" />;
  };

  const accessBadge = (col: DataExplorerColumn) => {
    if (col.access === 'denied') return <span className="badge badge-red text-[10px]">DENIED</span>;
    if (col.access === 'masked')
      return (
        <span className="badge badge-amber text-[10px]">
          MASKED ({col.mask_type})
        </span>
      );
    return <span className="badge badge-green text-[10px]">VISIBLE</span>;
  };

  const typeColor = (dt: string) => {
    if (dt.includes('int') || dt === 'numeric') return 'badge-blue';
    if (dt.includes('char') || dt === 'text') return 'badge-green';
    if (dt.includes('timestamp') || dt === 'date') return 'badge-purple';
    if (dt === 'boolean') return 'badge-amber';
    if (dt === 'jsonb' || dt === 'json') return 'badge-indigo';
    return 'badge-slate';
  };

  const stats = result
    ? {
      visible: result.columns.filter((c) => c.access === 'visible').length,
      masked: result.columns.filter((c) => c.access === 'masked').length,
      denied: result.columns.filter((c) => c.access === 'denied').length,
    }
    : null;

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title font-mono">{frame.table}</h1>
        <p className="page-desc">
          Schema with permission-aware access — visible / masked / denied per column for the current user.
        </p>
      </div>

      {detailLoading && (
        <div className="card">
          <div className="card-body text-center py-12 text-slate-400">Loading table details...</div>
        </div>
      )}

      {result && !detailLoading && (
        <>
          {/* Access Summary */}
          {user && stats && (
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div className="rounded-lg border border-slate-200 p-3 flex items-center gap-3">
                <Filter size={16} className="text-blue-500" />
                <div>
                  <div className="text-xs text-slate-500">RLS Filter</div>
                  <div className="text-xs font-mono text-slate-700 truncate max-w-[200px]">
                    {result.rls_filter === 'TRUE' ? 'No filter (full access)' : result.rls_filter}
                  </div>
                </div>
              </div>
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/50 p-3 flex items-center gap-3">
                <Eye size={16} className="text-emerald-500" />
                <div>
                  <div className="text-[10px] text-emerald-600 font-medium">VISIBLE</div>
                  <div className="text-xl font-bold text-emerald-700">{stats.visible}</div>
                </div>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 flex items-center gap-3">
                <Lock size={16} className="text-amber-500" />
                <div>
                  <div className="text-[10px] text-amber-600 font-medium">MASKED</div>
                  <div className="text-xl font-bold text-amber-700">{stats.masked}</div>
                </div>
              </div>
              <div className="rounded-lg border border-red-200 bg-red-50/50 p-3 flex items-center gap-3">
                <XCircle size={16} className="text-red-500" />
                <div>
                  <div className="text-[10px] text-red-600 font-medium">DENIED</div>
                  <div className="text-xl font-bold text-red-700">{stats.denied}</div>
                </div>
              </div>
            </div>
          )}

          {/* Column Schema */}
          <div className="card">
            <div className="card-header">
              <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                Columns
                <ChevronRight size={14} className="text-slate-400" />
                <span className="code">{result.table}</span>
              </h3>
            </div>
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr>
                    <th>Column</th><th>Type</th><th>Nullable</th>
                    {user && <th>Your Access</th>}
                    {user && <th>Mask Function</th>}
                  </tr>
                </thead>
                <tbody>
                  {result.columns.map((c) => (
                    <tr
                      key={c.column_name}
                      className={
                        c.access === 'denied' ? 'bg-red-50/50' :
                          c.access === 'masked' ? 'bg-amber-50/50' : ''
                      }
                    >
                      <td className="font-mono text-xs font-bold text-slate-900 flex items-center gap-2">
                        {user && accessIcon(c.access)}
                        {c.column_name}
                      </td>
                      <td>
                        <span className={`badge text-[10px] ${typeColor(c.data_type)}`}>
                          {c.data_type}
                          {c.character_maximum_length ? `(${c.character_maximum_length})` : ''}
                        </span>
                      </td>
                      <td className="text-xs">
                        {c.is_nullable === 'YES'
                          ? <span className="text-slate-400">NULL</span>
                          : <span className="font-semibold text-slate-700">NOT NULL</span>}
                      </td>
                      {user && <td>{accessBadge(c)}</td>}
                      {user && (
                        <td className="font-mono text-xs text-slate-500">
                          {c.mask_function ? (
                            <span className="badge badge-amber text-[10px]">{c.mask_function}</span>
                          ) : c.access === 'denied' ? (
                            <span className="text-red-400 text-xs">N/A</span>
                          ) : '-'}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Sample Data */}
          {result.sample_data.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h3 className="text-sm font-semibold text-slate-900">
                  {user ? 'Your Data View' : 'Sample Data'}
                </h3>
                {user && (
                  <span className="text-xs text-slate-500">
                    {result.filtered_count} of {result.total_count} rows
                    {result.filtered_count < result.total_count && (
                      <span className="text-amber-600 ml-1">
                        ({result.total_count - result.filtered_count} filtered by RLS)
                      </span>
                    )}
                  </span>
                )}
              </div>
              <div className="table-container max-h-[50vh]">
                <table className="table">
                  <thead>
                    <tr>
                      {result.columns.map((c) => (
                        <th
                          key={c.column_name}
                          className={`font-mono text-[10px] ${
                            c.access === 'denied' ? 'text-red-400' :
                              c.access === 'masked' ? 'text-amber-600' : ''
                          }`}
                        >
                          {c.column_name}
                          {c.access === 'masked' && ' [M]'}
                          {c.access === 'denied' && ' [X]'}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.sample_data.map((row, i) => (
                      <tr key={i}>
                        {result.columns.map((c) => {
                          const v = row[c.column_name];
                          const isDenied = v === '[DENIED]';
                          const isMasked = c.access === 'masked';
                          return (
                            <td
                              key={c.column_name}
                              className={`text-xs max-w-[180px] truncate ${
                                isDenied ? 'text-red-400 italic' :
                                  isMasked ? 'text-amber-600' :
                                    'text-slate-600'
                              }`}
                            >
                              {v === null ? <span className="text-slate-300 italic">null</span>
                                : typeof v === 'object' ? JSON.stringify(v)
                                  : String(v)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Mask Functions Legend */}
          {result.mask_functions.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                  <Code2 size={16} className="text-amber-500" />
                  Applied Mask Functions
                </h3>
              </div>
              <div className="card-body">
                <div className="space-y-3">
                  {result.mask_functions.map((fn, i) => (
                    <div key={i} className="flex items-start gap-3 p-2 rounded-lg bg-amber-50 border border-amber-200">
                      <span className="badge badge-amber text-[10px] shrink-0 mt-0.5">{fn.function_name}</span>
                      <div>
                        <div className="text-xs text-slate-700">{fn.description || 'Column masking function'}</div>
                        {fn.example && (
                          <div className="text-[10px] text-slate-500 mt-0.5 font-mono">Example: {fn.example}</div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
