import { useState, useEffect, useMemo } from 'react';
import { api } from '../api';
import { useToast } from './Toast';
import { PageHeader } from './shared/atoms/PageHeader';
import { EmptyState } from './shared/atoms/EmptyState';
import { StatCard } from './shared/atoms/StatCard';
import {
  Search, Table2, Eye, Code2, Database, CheckCircle2, AlertCircle, Loader2, Sparkles, X, Move, Unlink,
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
  const [promoteRow, setPromoteRow] = useState<DiscoverRow | null>(null);
  const [promoteMode, setPromoteMode] = useState<'create' | 'attach'>('create');
  const [promoteName, setPromoteName] = useState('');
  const [promoteTargetModuleId, setPromoteTargetModuleId] = useState('');
  const [promoteModuleSearch, setPromoteModuleSearch] = useState('');
  const [modules, setModules] = useState<{ resource_id: string; display_name: string; parent_id: string | null }[]>([]);
  const [modulesLoading, setModulesLoading] = useState(false);
  const [promoting, setPromoting] = useState(false);

  // Reparent (detach / move) state — only applies to currently-mapped rows
  const [reparentRow, setReparentRow] = useState<DiscoverRow | null>(null);
  const [reparentMode, setReparentMode] = useState<'move' | 'detach'>('move');
  const [reparentTargetModuleId, setReparentTargetModuleId] = useState('');
  const [reparentModuleSearch, setReparentModuleSearch] = useState('');
  const [reparenting, setReparenting] = useState(false);

  const ensureModulesLoaded = async () => {
    if (modules.length > 0 || modulesLoading) return;
    setModulesLoading(true);
    try {
      const tree = await api.moduleTree();
      setModules(tree.map(m => ({
        resource_id: m.resource_id,
        display_name: m.display_name,
        parent_id: m.parent_id,
      })));
    } catch (err) {
      console.warn('failed to load modules', err);
    } finally {
      setModulesLoading(false);
    }
  };

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
                  <th className="px-4 py-2 font-medium text-right">Actions</th>
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
                    <td className="px-4 py-2 text-right">
                      {!row.mapped_to_module ? (
                        <button
                          data-testid={`promote-${row.resource_id}`}
                          onClick={async () => {
                            setPromoteRow(row);
                            setPromoteMode('create');
                            setPromoteName(row.display_name);
                            setPromoteTargetModuleId('');
                            setPromoteModuleSearch('');
                            await ensureModulesLoaded();
                          }}
                          className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded"
                          title="Create a Module that wraps this resource"
                        >
                          <Sparkles size={12} />
                          Promote
                        </button>
                      ) : (
                        <button
                          data-testid={`reparent-${row.resource_id}`}
                          onClick={async () => {
                            setReparentRow(row);
                            setReparentMode('move');
                            setReparentTargetModuleId('');
                            setReparentModuleSearch('');
                            await ensureModulesLoaded();
                          }}
                          className="inline-flex items-center gap-1 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 px-2 py-1 rounded"
                          title="Move to another Module or detach back to unmapped"
                        >
                          <Move size={12} />
                          Move
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Promote modal */}
      {promoteRow && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={() => !promoting && setPromoteRow(null)}
          data-testid="promote-modal"
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-md w-full p-5"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="flex items-center gap-2 text-slate-900 font-semibold">
                  <Sparkles size={16} className="text-blue-600" />
                  Promote to Module
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  Wrap <span className="font-mono text-slate-700">{promoteRow.resource_id}</span> in a new permission-controlled Module.
                </div>
              </div>
              <button
                onClick={() => !promoting && setPromoteRow(null)}
                className="text-slate-400 hover:text-slate-600 p-1"
                disabled={promoting}
              >
                <X size={16} />
              </button>
            </div>

            {/* Mode toggle */}
            <div className="flex gap-1 bg-slate-100 rounded-md p-0.5 mb-3">
              <button
                data-testid="promote-mode-create"
                onClick={() => setPromoteMode('create')}
                disabled={promoting}
                className={`flex-1 px-3 py-1 rounded text-xs font-medium transition-colors ${
                  promoteMode === 'create' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Create new module
              </button>
              <button
                data-testid="promote-mode-attach"
                onClick={() => setPromoteMode('attach')}
                disabled={promoting}
                className={`flex-1 px-3 py-1 rounded text-xs font-medium transition-colors ${
                  promoteMode === 'attach' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Add to existing
              </button>
            </div>

            {promoteMode === 'create' ? (
              <>
                <label className="block text-xs font-medium text-slate-700 mb-1">Module name</label>
                <input
                  type="text"
                  data-testid="promote-name"
                  value={promoteName}
                  onChange={e => setPromoteName(e.target.value)}
                  placeholder="e.g. Material Catalog"
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                  autoFocus
                  disabled={promoting}
                />
                <p className="text-[11px] text-slate-400 mt-1">
                  A new Module is created at the root level. The resource inherits permissions from this Module.
                </p>
              </>
            ) : (
              <>
                <label className="block text-xs font-medium text-slate-700 mb-1">Existing module</label>
                <input
                  type="text"
                  data-testid="promote-module-search"
                  value={promoteModuleSearch}
                  onChange={e => setPromoteModuleSearch(e.target.value)}
                  placeholder="Filter by name or id…"
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none mb-2"
                  disabled={promoting || modulesLoading}
                />
                <div className="border border-slate-200 rounded max-h-48 overflow-y-auto" data-testid="promote-module-list">
                  {modulesLoading ? (
                    <div className="px-3 py-4 text-xs text-slate-400 flex items-center gap-2">
                      <Loader2 size={12} className="animate-spin" /> Loading modules…
                    </div>
                  ) : modules.length === 0 ? (
                    <div className="px-3 py-4 text-xs text-slate-400">No modules available.</div>
                  ) : (
                    modules
                      .filter(m => {
                        const s = promoteModuleSearch.trim().toLowerCase();
                        return !s || m.display_name.toLowerCase().includes(s) || m.resource_id.toLowerCase().includes(s);
                      })
                      .slice(0, 100)
                      .map(m => (
                        <button
                          key={m.resource_id}
                          data-testid={`promote-module-${m.resource_id}`}
                          onClick={() => setPromoteTargetModuleId(m.resource_id)}
                          disabled={promoting}
                          className={`w-full text-left px-3 py-1.5 text-xs border-b border-slate-100 last:border-b-0 hover:bg-slate-50 ${
                            promoteTargetModuleId === m.resource_id ? 'bg-blue-50 text-blue-900' : 'text-slate-700'
                          }`}
                        >
                          <div className="font-medium">{m.display_name}</div>
                          <div className="text-[10px] text-slate-400 font-mono">{m.resource_id}</div>
                        </button>
                      ))
                  )}
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  Resource is reparented directly under the selected Module. No new Module is created.
                </p>
              </>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setPromoteRow(null)}
                className="px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
                disabled={promoting}
              >
                Cancel
              </button>
              <button
                data-testid="promote-confirm"
                onClick={async () => {
                  setPromoting(true);
                  try {
                    let result;
                    if (promoteMode === 'create') {
                      const name = promoteName.trim();
                      if (!name) { toast.error('Module name is required'); setPromoting(false); return; }
                      result = await api.discoverPromote({
                        resource_id: promoteRow.resource_id,
                        module_display_name: name,
                      });
                    } else {
                      if (!promoteTargetModuleId) { toast.error('Pick a module'); setPromoting(false); return; }
                      result = await api.discoverPromote({
                        resource_id: promoteRow.resource_id,
                        target_module_id: promoteTargetModuleId,
                      });
                    }
                    toast.success(
                      result.mode === 'attach'
                        ? `Attached to ${result.display_name}`
                        : `Promoted to ${result.module_id}`,
                    );
                    setPromoteRow(null);
                    await load();
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : 'Promote failed';
                    toast.error(msg);
                  } finally {
                    setPromoting(false);
                  }
                }}
                className="px-3 py-1.5 text-xs font-medium bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-1"
                disabled={promoting || !promoteName.trim()}
              >
                {promoting ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                {promoting ? 'Promoting…' : 'Create Module'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reparent modal — detach or move a mapped resource */}
      {reparentRow && reparentRow.mapped_to_module && (
        <div
          className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
          onClick={() => !reparenting && setReparentRow(null)}
          data-testid="reparent-modal"
        >
          <div
            className="bg-white rounded-lg shadow-xl max-w-md w-full p-5"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="flex items-center gap-2 text-slate-900 font-semibold">
                  <Move size={16} className="text-slate-700" />
                  Move or Detach
                </div>
                <div className="text-xs text-slate-500 mt-1">
                  <span className="font-mono text-slate-700">{reparentRow.resource_id}</span>
                  <br />
                  Currently under <span className="font-medium text-emerald-700">{reparentRow.mapped_to_module.display_name}</span>
                </div>
              </div>
              <button
                onClick={() => !reparenting && setReparentRow(null)}
                className="text-slate-400 hover:text-slate-600 p-1"
                disabled={reparenting}
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex gap-1 bg-slate-100 rounded-md p-0.5 mb-3">
              <button
                data-testid="reparent-mode-move"
                onClick={() => setReparentMode('move')}
                disabled={reparenting}
                className={`flex-1 px-3 py-1 rounded text-xs font-medium transition-colors ${
                  reparentMode === 'move' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Move to another Module
              </button>
              <button
                data-testid="reparent-mode-detach"
                onClick={() => setReparentMode('detach')}
                disabled={reparenting}
                className={`flex-1 px-3 py-1 rounded text-xs font-medium transition-colors ${
                  reparentMode === 'detach' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'
                }`}
              >
                Detach
              </button>
            </div>

            {reparentMode === 'move' ? (
              <>
                <label className="block text-xs font-medium text-slate-700 mb-1">Target module</label>
                <input
                  type="text"
                  data-testid="reparent-module-search"
                  value={reparentModuleSearch}
                  onChange={e => setReparentModuleSearch(e.target.value)}
                  placeholder="Filter by name or id…"
                  className="w-full border border-slate-300 rounded px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none mb-2"
                  disabled={reparenting || modulesLoading}
                />
                <div className="border border-slate-200 rounded max-h-48 overflow-y-auto" data-testid="reparent-module-list">
                  {modulesLoading ? (
                    <div className="px-3 py-4 text-xs text-slate-400 flex items-center gap-2">
                      <Loader2 size={12} className="animate-spin" /> Loading modules…
                    </div>
                  ) : modules.length === 0 ? (
                    <div className="px-3 py-4 text-xs text-slate-400">No modules available.</div>
                  ) : (
                    modules
                      .filter(m => m.resource_id !== reparentRow.mapped_to_module?.resource_id)
                      .filter(m => {
                        const s = reparentModuleSearch.trim().toLowerCase();
                        return !s || m.display_name.toLowerCase().includes(s) || m.resource_id.toLowerCase().includes(s);
                      })
                      .slice(0, 100)
                      .map(m => (
                        <button
                          key={m.resource_id}
                          data-testid={`reparent-module-${m.resource_id}`}
                          onClick={() => setReparentTargetModuleId(m.resource_id)}
                          disabled={reparenting}
                          className={`w-full text-left px-3 py-1.5 text-xs border-b border-slate-100 last:border-b-0 hover:bg-slate-50 ${
                            reparentTargetModuleId === m.resource_id ? 'bg-blue-50 text-blue-900' : 'text-slate-700'
                          }`}
                        >
                          <div className="font-medium">{m.display_name}</div>
                          <div className="text-[10px] text-slate-400 font-mono">{m.resource_id}</div>
                        </button>
                      ))
                  )}
                </div>
                <p className="text-[11px] text-slate-400 mt-1">
                  Resource will be reparented under the selected Module.
                </p>
              </>
            ) : (
              <div className="bg-amber-50 border border-amber-200 rounded p-3 text-xs text-amber-900">
                <div className="flex items-center gap-1.5 font-medium mb-1">
                  <Unlink size={12} /> Detach from Module
                </div>
                The resource returns to the unmapped pool. No data is deleted; permissions inherited from the current Module are removed and the resource appears under "Unmapped" in Discover.
              </div>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setReparentRow(null)}
                className="px-3 py-1.5 text-xs font-medium text-slate-600 hover:text-slate-900"
                disabled={reparenting}
              >
                Cancel
              </button>
              <button
                data-testid="reparent-confirm"
                onClick={async () => {
                  setReparenting(true);
                  try {
                    if (reparentMode === 'move' && !reparentTargetModuleId) {
                      toast.error('Pick a target module');
                      setReparenting(false);
                      return;
                    }
                    const result = await api.discoverReparent({
                      resource_id: reparentRow.resource_id,
                      target_module_id: reparentMode === 'move' ? reparentTargetModuleId : null,
                    });
                    toast.success(
                      result.mode === 'move'
                        ? `Moved to ${result.new_display_name}`
                        : `Detached from ${result.previous_display_name}`,
                    );
                    setReparentRow(null);
                    await load();
                  } catch (err) {
                    const msg = err instanceof Error ? err.message : 'Reparent failed';
                    toast.error(msg);
                  } finally {
                    setReparenting(false);
                  }
                }}
                className={`px-3 py-1.5 text-xs font-medium text-white rounded disabled:opacity-50 inline-flex items-center gap-1 ${
                  reparentMode === 'detach' ? 'bg-amber-600 hover:bg-amber-700' : 'bg-blue-600 hover:bg-blue-700'
                }`}
                disabled={reparenting || (reparentMode === 'move' && !reparentTargetModuleId)}
              >
                {reparenting ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : reparentMode === 'detach' ? (
                  <Unlink size={12} />
                ) : (
                  <Move size={12} />
                )}
                {reparenting
                  ? (reparentMode === 'detach' ? 'Detaching…' : 'Moving…')
                  : (reparentMode === 'detach' ? 'Detach' : 'Move')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
