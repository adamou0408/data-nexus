import { useState, useEffect, useCallback } from 'react';
import { useAuthz } from '../AuthzContext';
import { api } from '../api';
import { Table2, RefreshCw, Eye, EyeOff, Info, CheckCircle2, XCircle } from 'lucide-react';

const COLUMN_PERMISSIONS: Record<string, { action: string; resource: string; label: string }> = {
  unit_price: { action: 'read', resource: 'column:lot_status.unit_price', label: 'Unit Price' },
  cost:       { action: 'read', resource: 'column:lot_status.cost',       label: 'Cost' },
  customer:   { action: 'read', resource: 'column:lot_status.customer',   label: 'Customer' },
};

type LotRow = Record<string, unknown>;
type ColumnAccess = Record<string, boolean>;

export function WorkbenchTab() {
  const { user, config } = useAuthz();
  const [rows, setRows] = useState<LotRow[]>([]);
  const [columnAccess, setColumnAccess] = useState<ColumnAccess>({});
  const [allColumns, setAllColumns] = useState<string[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [filteredCount, setFilteredCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadData = useCallback(async () => {
    if (!user || !config) return;
    setLoading(true);
    setError('');
    try {
      const checks = Object.entries(COLUMN_PERMISSIONS).map(([_col, perm]) => ({
        action: perm.action, resource: perm.resource,
      }));
      const permResults = await api.checkBatch(user.id, user.groups, checks);
      const access: ColumnAccess = {};
      Object.keys(COLUMN_PERMISSIONS).forEach((col, i) => {
        access[col] = permResults[i].allowed;
      });
      setColumnAccess(access);

      const simResult = await api.rlsSimulate(user.id, user.groups, user.attrs, 'lot_status');
      setRows(simResult.filtered_rows);
      setTotalCount(simResult.total_count);
      setFilteredCount(simResult.filtered_count);
      if (simResult.filtered_rows.length > 0) {
        setAllColumns(Object.keys(simResult.filtered_rows[0]).filter(k => k !== 'created_at'));
      }
    } catch (err) {
      setError(String(err));
    }
    setLoading(false);
  }, [user, config]);

  useEffect(() => {
    if (user && config) loadData();
  }, [user, config, loadData]);

  if (!user || !config) {
    return (
      <div className="space-y-6">
        <div className="page-header">
          <h1 className="page-title">Data Workbench</h1>
          <p className="page-desc">Meta-driven data view with live column masking</p>
        </div>
        <div className="card">
          <div className="card-body text-center py-16">
            <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
              <Table2 size={24} className="text-slate-400" />
            </div>
            <p className="text-slate-500 text-sm">Select a user from the sidebar to view lot data</p>
          </div>
        </div>
      </div>
    );
  }

  const visibleColumns = allColumns.filter(col => {
    if (col in COLUMN_PERMISSIONS) return columnAccess[col] !== false;
    return true;
  });

  const deniedColumns = allColumns.filter(col =>
    col in COLUMN_PERMISSIONS && columnAccess[col] === false
  );

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title">Data Workbench</h1>
        <p className="page-desc">
          Meta-driven page using <span className="code">visible_when</span> pattern &mdash;
          columns controlled by <span className="code">authz_check()</span>, rows by <span className="code">authz_filter()</span>
        </p>
      </div>

      {/* Access summary */}
      <div className="card">
        <div className="card-header">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold text-xs">
              {user.label.charAt(0)}
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-900">{user.label}</div>
              <div className="flex gap-1 mt-0.5">
                {config.resolved_roles.map(r => (
                  <span key={r} className="badge badge-blue text-[10px]">{r}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
        <div className="card-body">
          <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">
            Column Access (visible_when evaluation)
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {Object.entries(COLUMN_PERMISSIONS).map(([col, perm]) => {
              const allowed = columnAccess[col];
              return (
                <div key={col} className={`rounded-lg border p-3 ${
                  allowed
                    ? 'border-emerald-200 bg-emerald-50/50'
                    : 'border-red-200 bg-red-50/50'
                }`}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-semibold text-slate-900">{perm.label}</span>
                    {allowed
                      ? <CheckCircle2 size={16} className="text-emerald-500" />
                      : <XCircle size={16} className="text-red-500" />
                    }
                  </div>
                  <div className="flex items-center gap-1.5">
                    {allowed
                      ? <><Eye size={12} className="text-emerald-600" /><span className="text-xs text-emerald-600 font-medium">Visible</span></>
                      : <><EyeOff size={12} className="text-red-600" /><span className="text-xs text-red-600 font-medium" title="依授權政策隱藏 — 聯絡 IT Admin 申請存取">Hidden</span></>
                    }
                  </div>
                  <div className="text-[10px] text-slate-400 mt-1.5 font-mono">{perm.resource}</div>
                </div>
              );
            })}
          </div>

          {deniedColumns.length > 0 && (
            <div className="mt-4 rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 flex items-start gap-2">
              <Info size={14} className="text-amber-600 mt-0.5 shrink-0" />
              <div className="text-sm text-amber-800">
                <strong>{deniedColumns.length}</strong> column(s) hidden by authorization:
                <span className="font-semibold ml-1">{deniedColumns.join(', ')}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="card border-red-200 bg-red-50">
          <div className="card-body text-red-700 text-sm">{error}</div>
        </div>
      )}

      {/* Data table */}
      <div className="card">
        <div className="card-header">
          <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
            <Table2 size={16} className="text-blue-600" />
            Lot Status Data
            <span className="badge badge-slate ml-1">{filteredCount} / {totalCount} rows</span>
          </h3>
          <button onClick={loadData} disabled={loading} className="btn-secondary btn-sm">
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        {loading ? (
          <div className="card-body text-center py-12 text-slate-400">Loading lot data...</div>
        ) : rows.length === 0 ? (
          <div className="card-body text-center py-12 text-slate-400">No rows visible for current user</div>
        ) : (
          <div className="table-container max-h-[60vh]">
            <table className="table">
              <thead>
                <tr>
                  {visibleColumns.map(col => (
                    <th key={col}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i}>
                    {visibleColumns.map(col => {
                      const val = row[col];
                      const isPrice = typeof val === 'number' && (col.includes('price') || col.includes('cost') || col.includes('amount'));
                      return (
                        <td key={col}>
                          {col === 'status' ? (
                            <StatusBadge value={String(val)} />
                          ) : isPrice ? (
                            <span className="font-mono">${Number(val).toLocaleString()}</span>
                          ) : (
                            String(val ?? '')
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {rows.length > 0 && totalCount > filteredCount && (
          <div className="px-5 py-3 border-t border-slate-100 text-xs text-slate-500 flex items-center gap-1.5">
            <Info size={12} className="text-amber-500" />
            顯示 {filteredCount} 筆（共 {totalCount} 筆，{totalCount - filteredCount} 筆依 RLS 篩選排除）
          </div>
        )}
      </div>

      {/* How it works */}
      <div className="card border-slate-200 bg-slate-50/50">
        <div className="card-body">
          <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
            <Info size={14} />
            How visible_when Works
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-xs text-slate-600">
            <div className="space-y-1">
              <div className="font-semibold text-slate-800">1. Column Visibility</div>
              <p>Each sensitive column has a <span className="code">visible_when</span> rule calling <span className="code">authz_check()</span> on page load. Denied columns are removed from the DOM.</p>
            </div>
            <div className="space-y-1">
              <div className="font-semibold text-slate-800">2. Row Filtering</div>
              <p>Server applies <span className="code">authz_filter()</span> RLS. Client only receives authorized rows.</p>
            </div>
            <div className="space-y-1">
              <div className="font-semibold text-slate-800">3. SSOT</div>
              <p>Both column visibility and row filters derive from the same <span className="code">authz_role_permission</span> + <span className="code">authz_policy</span> tables.</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ value }: { value: string }) {
  const colors: Record<string, string> = {
    active: 'badge-green', confirmed: 'badge-green',
    hold: 'badge-amber', pending: 'badge-amber',
    shipped: 'badge-blue', closed: 'badge-blue',
  };
  return <span className={`badge ${colors[value] || 'badge-slate'} text-[10px]`}>{value}</span>;
}
