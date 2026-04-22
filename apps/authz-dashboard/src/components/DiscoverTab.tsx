import { useState, useEffect, useMemo } from 'react';
import { api } from '../api';
import { useToast } from './Toast';
import { PageHeader } from './shared/atoms/PageHeader';
import { EmptyState } from './shared/atoms/EmptyState';
import { StatCard } from './shared/atoms/StatCard';
import {
  Search, Table2, Eye, Code2, Database, CheckCircle2, AlertCircle, Loader2,
} from 'lucide-react';

type DiscoverRow = {
  resource_id: string;
  resource_type: 'table' | 'view' | 'function';
  display_name: string;
  data_source_id: string | null;
  ds_display_name: string | null;
  ds_db_type: string | null;
  schema: string | null;
  mapped_to_module: { resource_id: string; display_name: string } | null;
  created_at: string;
};

type Stats = {
  table: { total: number; mapped: number; unmapped: number };
  view: { total: number; mapped: number; unmapped: number };
  function: { total: number; mapped: number; unmapped: number };
  ds_count: number;
};

type TypeFilter = 'all' | 'table' | 'view' | 'function';

const TYPE_ICONS = {
  table: <Table2 size={14} className="text-emerald-600" />,
  view: <Eye size={14} className="text-violet-600" />,
  function: <Code2 size={14} className="text-amber-600" />,
};

export function DiscoverTab() {
  const toast = useToast();
  const [rows, setRows] = useState<DiscoverRow[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [type, setType] = useState<TypeFilter>('all');
  const [unmappedOnly, setUnmappedOnly] = useState(false);
  const [q, setQ] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const [list, summary] = await Promise.all([
        api.discover({ type, unmapped_only: unmappedOnly, q: q || undefined }),
        api.discoverStats(),
      ]);
      setRows(list.rows);
      setStats(summary);
      if (list.truncated) toast.info('Showing first 5,000 rows — narrow your filter for more');
    } catch (err) {
      toast.error('Failed to load discovery results');
      console.warn(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [type, unmappedOnly]);

  const handleSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') load();
  };

  const totalAll = useMemo(() => {
    if (!stats) return 0;
    return stats.table.total + stats.view.total + stats.function.total;
  }, [stats]);

  const unmappedAll = useMemo(() => {
    if (!stats) return 0;
    return stats.table.unmapped + stats.view.unmapped + stats.function.unmapped;
  }, [stats]);

  return (
    <div className="space-y-5" data-testid="discover-tab">
      <PageHeader
        title="Discover"
        subtitle="Cross-source view of every table, view, and function in the catalog. Spot what's been registered and what's still unmapped to a Module."
      />

      {/* Stat strip */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard
            icon={<Database size={18} className="text-blue-500" />}
            iconBg="bg-blue-50"
            value={stats.ds_count}
            label="Data Sources"
          />
          <StatCard
            icon={<Table2 size={18} className="text-slate-500" />}
            iconBg="bg-slate-100"
            value={totalAll}
            label="Total Resources"
            sub={`${stats.table.total} tables, ${stats.view.total} views, ${stats.function.total} fns`}
          />
          <StatCard
            icon={<CheckCircle2 size={18} className="text-emerald-500" />}
            iconBg="bg-emerald-50"
            value={totalAll - unmappedAll}
            label="Mapped to Module"
          />
          <StatCard
            icon={<AlertCircle size={18} className="text-amber-500" />}
            iconBg="bg-amber-50"
            value={unmappedAll}
            label="Unmapped"
            sub="not in any Module"
          />
        </div>
      )}

      {/* Filter bar */}
      <div className="bg-white border border-slate-200 rounded-lg p-3 flex flex-wrap items-center gap-3">
        <div className="flex gap-1 bg-slate-100 rounded-md p-0.5">
          {(['all', 'table', 'view', 'function'] as TypeFilter[]).map(t => (
            <button
              key={t}
              data-testid={`type-${t}`}
              onClick={() => setType(t)}
              className={`px-3 py-1 rounded text-xs font-medium capitalize transition-colors ${
                type === t ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {t === 'function' ? 'Functions' : t === 'all' ? 'All' : `${t}s`}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
          <input
            type="checkbox"
            data-testid="unmapped-only"
            checked={unmappedOnly}
            onChange={e => setUnmappedOnly(e.target.checked)}
            className="rounded border-slate-300"
          />
          Unmapped only
        </label>

        <div className="flex-1 min-w-[200px] relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            data-testid="search"
            placeholder="Search by name or ID (Enter to apply)"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={handleSearchKey}
            className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-200 rounded focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          />
        </div>

        <button
          onClick={load}
          className="px-3 py-1.5 text-xs font-medium bg-slate-900 text-white rounded hover:bg-slate-800"
        >
          Refresh
        </button>
      </div>

      {/* Results table */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-400 text-sm">
          <Loader2 size={16} className="animate-spin mr-2" /> Loading...
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Search size={32} />}
          message="No resources match these filters"
          hint={unmappedOnly ? 'Try clearing the unmapped filter, or run discovery on a data source first.' : 'Try a different search or type.'}
          size="lg"
        />
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-2 border-b border-slate-200 bg-slate-50 text-xs text-slate-500">
            Showing {rows.length} resources
          </div>
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 sticky top-0">
                <tr className="text-left text-xs text-slate-500 uppercase">
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Data Source</th>
                  <th className="px-4 py-2 font-medium">Schema</th>
                  <th className="px-4 py-2 font-medium">Mapped to Module</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(row => (
                  <tr
                    key={row.resource_id}
                    data-testid={`row-${row.resource_id}`}
                    className="hover:bg-slate-50 transition-colors"
                  >
                    <td className="px-4 py-2 whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        {TYPE_ICONS[row.resource_type]}
                        <span className="text-xs text-slate-600 capitalize">{row.resource_type}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2">
                      <div className="font-medium text-slate-900 text-xs">{row.display_name}</div>
                      <div className="text-[10px] text-slate-400 font-mono">{row.resource_id}</div>
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600">
                      {row.ds_display_name || <span className="text-slate-400">—</span>}
                      {row.ds_db_type && (
                        <span className="ml-1 text-[10px] text-slate-400">({row.ds_db_type})</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600 font-mono">
                      {row.schema || <span className="text-slate-400">—</span>}
                    </td>
                    <td className="px-4 py-2">
                      {row.mapped_to_module ? (
                        <span className="inline-flex items-center gap-1 text-xs text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded">
                          <CheckCircle2 size={12} />
                          {row.mapped_to_module.display_name}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
                          <AlertCircle size={12} />
                          Unmapped
                        </span>
                      )}
                    </td>
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
