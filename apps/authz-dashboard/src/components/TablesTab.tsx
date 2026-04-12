import { useState, useEffect } from 'react';
import { api, TableColumn } from '../api';
import { Table2, ChevronRight } from 'lucide-react';

export function TablesTab() {
  const [tables, setTables] = useState<{ table_name: string; column_count: string }[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [columns, setColumns] = useState<TableColumn[]>([]);
  const [sampleData, setSampleData] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.tables().then(setTables).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const loadSchema = async (table: string) => {
    setSelectedTable(table);
    setDetailLoading(true);
    try {
      const result = await api.tableSchema(table);
      setColumns(result.columns);
      setSampleData(result.sample_data);
    } catch { setColumns([]); setSampleData([]); }
    finally { setDetailLoading(false); }
  };

  const typeColor = (dt: string) => {
    if (dt.includes('int') || dt === 'numeric') return 'badge-blue';
    if (dt.includes('char') || dt === 'text') return 'badge-green';
    if (dt.includes('timestamp') || dt === 'date') return 'badge-purple';
    if (dt === 'boolean') return 'badge-amber';
    if (dt === 'jsonb' || dt === 'json') return 'badge-indigo';
    return 'badge-slate';
  };

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title">Tables & Schema</h1>
        <p className="page-desc">Browse business data tables, column definitions, and sample data</p>
      </div>

      <div className="card">
        <div className="card-header">
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <Table2 size={16} className="text-blue-600" />
            Business Data Tables
          </h3>
          <span className="text-xs text-slate-400">{tables.length} tables</span>
        </div>
        {loading ? (
          <div className="card-body text-center py-8 text-slate-400">Loading...</div>
        ) : (
          <div className="card-body">
            <div className="flex gap-2 flex-wrap">
              {tables.map(t => (
                <button key={t.table_name} onClick={() => loadSchema(t.table_name)}
                  className={`btn btn-sm font-mono text-xs gap-1 ${
                    selectedTable === t.table_name
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'bg-white text-slate-600 border border-slate-300 hover:bg-slate-50'
                  }`}>
                  {t.table_name}
                  <span className={`text-[10px] ${selectedTable === t.table_name ? 'text-blue-200' : 'text-slate-400'}`}>
                    ({t.column_count})
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {selectedTable && (
        <div className="card">
          <div className="card-header">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              Columns
              <ChevronRight size={14} className="text-slate-400" />
              <span className="code">{selectedTable}</span>
            </h3>
          </div>
          {detailLoading ? (
            <div className="card-body text-center py-8 text-slate-400">Loading schema...</div>
          ) : (
            <div className="table-container">
              <table className="table">
                <thead>
                  <tr><th>Column</th><th>Type</th><th>Nullable</th><th>Default</th></tr>
                </thead>
                <tbody>
                  {columns.map(c => (
                    <tr key={c.column_name}>
                      <td className="font-mono text-xs font-bold text-slate-900">{c.column_name}</td>
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
                      <td className="font-mono text-xs text-slate-400 max-w-[200px] truncate">
                        {c.column_default ?? '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {selectedTable && sampleData.length > 0 && !detailLoading && (
        <div className="card">
          <div className="card-header">
            <h3 className="text-sm font-semibold text-slate-900">
              Sample Data <span className="text-slate-400 font-normal text-xs">({sampleData.length} rows)</span>
            </h3>
          </div>
          <div className="table-container max-h-[50vh]">
            <table className="table">
              <thead>
                <tr>
                  {Object.keys(sampleData[0]).map(k => (
                    <th key={k} className="font-mono text-[10px]">{k}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sampleData.map((row, i) => (
                  <tr key={i}>
                    {Object.values(row).map((v, j) => (
                      <td key={j} className="text-xs text-slate-600 max-w-[180px] truncate">
                        {v === null ? <span className="text-slate-300 italic">null</span>
                          : typeof v === 'object' ? JSON.stringify(v)
                          : String(v)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
