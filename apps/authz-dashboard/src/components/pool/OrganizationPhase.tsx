import { useState, useEffect, useCallback } from 'react';
import { api, LifecycleResponse } from '../../api';
import { useToast } from '../Toast';
import { Plus, Pencil, X, Check, RefreshCw, Play, Search } from 'lucide-react';

export function OrganizationPhase({ dsId, lifecycle, onMutate }: { dsId: string; lifecycle: LifecycleResponse; onMutate: () => void }) {
  const toast = useToast();
  const [unmappedTables, setUnmappedTables] = useState<{ resource_id: string; resource_type: string; display_name: string; attributes: Record<string, unknown> }[]>([]);
  const [mappedTables, setMappedTables] = useState<{ resource_id: string; resource_type: string; display_name: string; parent_id: string | null; module_name: string | null; attributes: Record<string, unknown> }[]>([]);
  const [modules, setModules] = useState<{ resource_id: string; display_name: string; parent_id: string | null }[]>([]);
  const [pendingMappings, setPendingMappings] = useState<Record<string, string>>({});
  const [initialMappings, setInitialMappings] = useState<Record<string, string>>({});
  const [newModuleName, setNewModuleName] = useState('');
  const [newModuleDisplay, setNewModuleDisplay] = useState('');
  const [savingMapping, setSavingMapping] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [tableSearch, setTableSearch] = useState('');

  const loadMapping = useCallback(async () => {
    try {
      const [unmapped, mapped, mods] = await Promise.all([
        api.resourcesUnmapped(dsId),
        api.resourcesMapped(dsId),
        api.resourceModules(),
      ]);
      setUnmappedTables(unmapped);
      setMappedTables(mapped);
      setModules(mods);
      // Initialize both "initial" (source of truth for diff) and "pending" (what dropdown shows)
      // Unmapped → '' (no parent). Mapped → current parent_id.
      const init: Record<string, string> = {};
      for (const t of unmapped) init[t.resource_id] = '';
      for (const t of mapped) init[t.resource_id] = t.parent_id ?? '';
      setInitialMappings(init);
      setPendingMappings(init);
    } catch (err) { toast.error(String(err)); }
    finally { setLoaded(true); }
  }, [dsId]);

  useEffect(() => { loadMapping(); }, [loadMapping]);

  const groupByPrefix = (tables: typeof unmappedTables) => {
    const groups: Record<string, typeof unmappedTables> = {};
    for (const t of tables) {
      const prefix = (t.attributes?.table_prefix as string) || t.resource_id.replace(/^(table|view):/, '').match(/^([a-z]+)/i)?.[1]?.toLowerCase() || 'other';
      (groups[prefix] = groups[prefix] || []).push(t);
    }
    return groups;
  };

  const handleSelectPrefix = (prefix: string, moduleId: string) => {
    const groups = groupByPrefix(unmappedTables);
    const tables = groups[prefix] || [];
    setPendingMappings(prev => {
      const next = { ...prev };
      for (const t of tables) next[t.resource_id] = moduleId;
      return next;
    });
  };

  const handleCreateModule = async () => {
    if (!newModuleName) return;
    try {
      await api.resourceCreate({
        resource_id: newModuleName.startsWith('module:') ? newModuleName : `module:${newModuleName}`,
        resource_type: 'module',
        display_name: newModuleDisplay || newModuleName,
      });
      const mods = await api.resourceModules();
      setModules(mods);
      setNewModuleName('');
      setNewModuleDisplay('');
    } catch (err) { toast.error(String(err)); }
  };

  // Entries that differ from initial state are the ones we need to persist.
  // '' value against a currently-mapped row means "unmap" (parent_id = null).
  const changedEntries = Object.entries(pendingMappings).filter(
    ([id, v]) => v !== (initialMappings[id] ?? '')
  );

  const handleSaveMappings = async () => {
    if (changedEntries.length === 0) return;
    setSavingMapping(true);
    try {
      await api.resourcesBulkParent(changedEntries.map(([resource_id, parent_id]) => ({
        resource_id,
        parent_id: parent_id || null,
      })));
      await loadMapping();
      onMutate();
    } catch (err) { toast.error(String(err)); }
    finally { setSavingMapping(false); }
  };

  const handleSaveDisplayName = async (resourceId: string) => {
    try {
      await api.resourceUpdate(resourceId, { display_name: editValue });
      setUnmappedTables(prev => prev.map(t => t.resource_id === resourceId ? { ...t, display_name: editValue } : t));
      setMappedTables(prev => prev.map(t => t.resource_id === resourceId ? { ...t, display_name: editValue } : t));
      setEditingId(null);
    } catch (err) { toast.error(String(err)); }
  };

  const stripPrefix = (id: string) => id.replace(/^(table|view):/, '');

  if (!loaded) return <div className="text-slate-400 text-sm">Loading mappings...</div>;

  const org = lifecycle.phases.organization;
  if (org.status === 'not_started') {
    return <div className="text-sm text-slate-500">Run Discovery first to populate table resources.</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-4 text-sm">
        <div><span className="font-bold text-emerald-600">{org.mapped}</span> <span className="text-slate-500">mapped</span></div>
        <div><span className="font-bold text-amber-600">{org.unmapped}</span> <span className="text-slate-500">unmapped</span></div>
      </div>

      {/* Create module inline */}
      <div className="flex gap-2 items-end">
        <div>
          <label className="text-xs font-medium text-slate-600">New Module ID</label>
          <input className="input input-sm text-xs" placeholder="module:tiptop_reports" value={newModuleName} onChange={e => setNewModuleName(e.target.value)} />
        </div>
        <div>
          <label className="text-xs font-medium text-slate-600">Display Name</label>
          <input className="input input-sm text-xs" placeholder="Custom Reports" value={newModuleDisplay} onChange={e => setNewModuleDisplay(e.target.value)} />
        </div>
        <button onClick={handleCreateModule} disabled={!newModuleName} className="btn btn-xs bg-purple-600 text-white hover:bg-purple-700 gap-1 h-8">
          <Plus size={12} /> Create Module
        </button>
      </div>

      {/* Unmapped tables by prefix */}
      {unmappedTables.length > 0 && (
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="text-xs font-semibold text-slate-700">Unmapped Tables &amp; Views (grouped by prefix)</div>
            {unmappedTables.length > 10 && (
              <div className="relative flex-1 max-w-xs">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input className="input input-sm text-xs pl-7" placeholder="Filter tables..." value={tableSearch} onChange={e => setTableSearch(e.target.value)} />
              </div>
            )}
          </div>
          {(() => {
            const filtered = tableSearch.trim()
              ? unmappedTables.filter(t => {
                  const q = tableSearch.toLowerCase();
                  return t.resource_id.toLowerCase().includes(q) || (t.display_name || '').toLowerCase().includes(q);
                })
              : unmappedTables;
            if (filtered.length === 0 && tableSearch.trim()) {
              return <div className="text-xs text-slate-400 text-center py-3">No tables match "{tableSearch}"</div>;
            }
            return Object.entries(groupByPrefix(filtered)).map(([prefix, tables]) => (
            <div key={prefix} className="mb-3 bg-white rounded-lg border border-purple-200 p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-mono text-xs font-bold text-purple-800 bg-purple-100 px-2 py-0.5 rounded">{prefix}_*</span>
                <span className="text-xs text-slate-500">{tables.length} resource{tables.length > 1 ? 's' : ''}</span>
                <span className="text-xs text-slate-400">|</span>
                <label className="text-xs text-slate-600">Assign all to:</label>
                <select className="input input-sm text-xs w-48" value=""
                  onChange={e => { if (e.target.value) handleSelectPrefix(prefix, e.target.value); }}>
                  <option value="">-- select module --</option>
                  {modules.map(m => (
                    <option key={m.resource_id} value={m.resource_id}>{m.display_name} ({m.resource_id})</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-1 gap-1">
                {tables.map(t => {
                  const tName = stripPrefix(t.resource_id);
                  const isView = t.resource_type === 'view';
                  const comment = (t.attributes?.table_comment as string) || '';
                  const hasCustomName = t.display_name && t.display_name !== tName && t.display_name !== t.resource_id;
                  const desc = hasCustomName ? t.display_name : comment;
                  const isEditing = editingId === t.resource_id;
                  return (
                    <div key={t.resource_id} className="flex items-center gap-2 py-0.5">
                      <span className={`text-[10px] px-1 py-0.5 rounded font-semibold leading-none ${isView ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                        {isView ? 'VIEW' : 'TABLE'}
                      </span>
                      <span className="font-mono text-xs text-slate-700 whitespace-nowrap">{tName}</span>
                      {isEditing ? (
                        <span className="flex items-center gap-1 flex-1 min-w-0">
                          <input className="input input-sm text-xs flex-1 min-w-0" value={editValue}
                            onChange={e => setEditValue(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleSaveDisplayName(t.resource_id); if (e.key === 'Escape') setEditingId(null); }}
                            autoFocus />
                          <button onClick={() => handleSaveDisplayName(t.resource_id)} className="text-emerald-600 hover:text-emerald-800"><Check size={12} /></button>
                          <button onClick={() => setEditingId(null)} className="text-slate-400 hover:text-slate-600"><X size={12} /></button>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 flex-1 min-w-0">
                          {desc && <span className="text-xs text-slate-400 truncate" title={desc}>{desc}</span>}
                          <button onClick={() => { setEditingId(t.resource_id); setEditValue(t.display_name || tName); }}
                            className="text-slate-300 hover:text-purple-600 flex-shrink-0" title="Edit display name">
                            <Pencil size={11} />
                          </button>
                        </span>
                      )}
                      <select className="input input-sm text-xs w-72 flex-shrink-0"
                        value={pendingMappings[t.resource_id] ?? ''}
                        onChange={e => setPendingMappings(prev => ({ ...prev, [t.resource_id]: e.target.value }))}>
                        <option value="">-- no module --</option>
                        {modules.map(m => (
                          <option key={m.resource_id} value={m.resource_id}>{m.display_name} ({m.resource_id})</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          ));
          })()}
        </div>
      )}

      {/* Already mapped tables & views — with inline re-map dropdown */}
      {mappedTables.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-slate-700 mb-2">Already Mapped</div>
          <div className="grid grid-cols-1 gap-1">
            {mappedTables.map(t => {
              const isView = t.resource_type === 'view';
              const tName = stripPrefix(t.resource_id);
              const comment = (t.attributes?.table_comment as string) || '';
              const hasCustomName = t.display_name && t.display_name !== tName && t.display_name !== t.resource_id;
              const desc = hasCustomName ? t.display_name : comment;
              const originalParent = initialMappings[t.resource_id] ?? '';
              const pendingParent = pendingMappings[t.resource_id] ?? '';
              const isDirty = pendingParent !== originalParent;
              return (
                <div key={t.resource_id} className="flex items-center gap-2 py-0.5">
                  <span className={`text-[10px] px-1 py-0.5 rounded font-semibold leading-none ${isView ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-500'}`}>
                    {isView ? 'VIEW' : 'TABLE'}
                  </span>
                  <span className="font-mono text-xs text-slate-700 whitespace-nowrap">{tName}</span>
                  {desc && <span className="text-xs text-slate-400 truncate flex-1 min-w-0" title={desc}>{desc}</span>}
                  {!desc && <span className="flex-1" />}
                  {isDirty && <span className="text-[10px] text-amber-600 font-semibold flex-shrink-0">● changed</span>}
                  <select
                    className={`input input-sm text-xs w-72 flex-shrink-0 ${isDirty ? 'ring-2 ring-amber-400' : ''}`}
                    value={pendingParent}
                    onChange={e => setPendingMappings(prev => ({ ...prev, [t.resource_id]: e.target.value }))}
                  >
                    <option value="">-- unmap (no module) --</option>
                    {modules.map(m => (
                      <option key={m.resource_id} value={m.resource_id}>{m.display_name} ({m.resource_id})</option>
                    ))}
                  </select>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Unified Save button — covers both unmapped → map and mapped → re-map/unmap */}
      {(unmappedTables.length > 0 || mappedTables.length > 0) && (
        <div className="pt-2 border-t border-slate-200">
          <button onClick={handleSaveMappings}
            disabled={savingMapping || changedEntries.length === 0}
            className="btn btn-sm bg-purple-600 text-white hover:bg-purple-700 gap-1">
            {savingMapping ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}
            Save Mappings ({changedEntries.length} change{changedEntries.length !== 1 ? 's' : ''})
          </button>
        </div>
      )}

      {unmappedTables.length === 0 && mappedTables.length === 0 && (
        <div className="text-xs text-slate-400 text-center py-4">No table or view resources found. Run Discover first.</div>
      )}
    </div>
  );
}
