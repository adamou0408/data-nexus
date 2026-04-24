import { useState, useMemo, Fragment } from 'react';
import { api } from '../../api';
import { useSearch } from '../../hooks/useSearch';
import { useToast } from '../Toast';
import { autoId, uniqueId } from '../../utils/slugify';
import {
  Plus, Pencil, Trash2, X, Check, Search, Copy,
  ChevronDown, ChevronRight, Boxes, Table2, Columns3,
  FunctionSquare, Workflow, Globe, Eye, Server, FileCode2,
} from 'lucide-react';
import { DangerConfirmModal, ConfirmState } from '../shared/DangerConfirmModal';

type Row = Record<string, unknown>;

const TYPE_META: Record<string, { label: string; icon: React.ReactNode; color: string; badge: string }> = {
  module:   { label: 'Modules',    icon: <Boxes size={13} />,          color: 'text-indigo-600', badge: 'badge-indigo' },
  table:    { label: 'Tables',     icon: <Table2 size={13} />,         color: 'text-emerald-700', badge: 'badge-green' },
  view:     { label: 'Views',      icon: <Eye size={13} />,            color: 'text-emerald-700', badge: 'badge-green' },
  column:   { label: 'Columns',    icon: <Columns3 size={13} />,       color: 'text-amber-700',  badge: 'badge-amber' },
  function: { label: 'Functions',  icon: <FunctionSquare size={13} />, color: 'text-slate-700',  badge: 'badge-slate' },
  dag:      { label: 'DAGs',       icon: <Workflow size={13} />,       color: 'text-violet-700', badge: 'badge-purple' },
  web_page: { label: 'Pages',      icon: <FileCode2 size={13} />,      color: 'text-blue-700',   badge: 'badge-blue' },
  web_api:  { label: 'APIs',       icon: <Globe size={13} />,          color: 'text-purple-700', badge: 'badge-purple' },
  db_pool:  { label: 'DB Pools',   icon: <Server size={13} />,         color: 'text-red-700',    badge: 'badge-red' },
  page:     { label: 'Pages',      icon: <FileCode2 size={13} />,      color: 'text-blue-700',   badge: 'badge-blue' },
};
const typeMeta = (t: string) => TYPE_META[t] ?? { label: t, icon: <Boxes size={13} />, color: 'text-slate-500', badge: 'badge-slate' };
const TYPE_ORDER = ['module', 'table', 'view', 'web_page', 'web_api', 'function', 'dag', 'db_pool', 'column'];

const sortByType = (a: string, b: string) => {
  const ia = TYPE_ORDER.indexOf(a); const ib = TYPE_ORDER.indexOf(b);
  return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
};

export function ResourcesSection({ data, onReload }: { data: Row[]; onReload: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ resource_id: '', resource_type: 'module', display_name: '', parent_id: '', attributes: '{}' });
  const [editId, setEditId] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [collapsedTypes, setCollapsedTypes] = useState<Set<string>>(new Set(['column'])); // columns collapsed by default
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set()); // table rows showing columns
  const { query, setQuery, filtered } = useSearch(data, ['resource_id', 'display_name', 'resource_type', 'parent_id']);
  const toast = useToast();
  const [dangerConfirm, setDangerConfirm] = useState<ConfirmState>(null);
  const existingIds = useMemo(() => data.map(d => String(d.resource_id)), [data]);
  const suggestedId = uniqueId(autoId.resource(form.display_name, form.resource_type), existingIds);

  // Build type-grouped index over filtered rows.
  const grouped = useMemo(() => {
    // If searching, expand collapsed types + parents so matches are visible
    const searching = query.trim() !== '';
    const g = new Map<string, Row[]>();
    for (const r of filtered) {
      const t = String(r.resource_type || 'other');
      if (!g.has(t)) g.set(t, []);
      g.get(t)!.push(r);
    }
    const types = Array.from(g.keys()).sort(sortByType);
    return { g, types, searching };
  }, [filtered, query]);

  // Children map: parent_id -> [child rows] (for table → column nesting)
  const childrenMap = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of filtered) {
      const pid = r.parent_id ? String(r.parent_id) : '';
      if (!pid) continue;
      if (!m.has(pid)) m.set(pid, []);
      m.get(pid)!.push(r);
    }
    for (const arr of m.values()) arr.sort((a, b) => String(a.resource_id).localeCompare(String(b.resource_id)));
    return m;
  }, [filtered]);

  // When searching, auto-expand parents that have matching column children
  const autoExpandedParents = useMemo(() => {
    if (!grouped.searching) return expandedParents;
    const next = new Set(expandedParents);
    for (const r of filtered) {
      if (String(r.resource_type) === 'column' && r.parent_id) next.add(String(r.parent_id));
    }
    return next;
  }, [filtered, expandedParents, grouped.searching]);

  // When browsing "All", hide the 'column' group header — 2578 columns belong nested under
  // their parent table. User reaches columns by expanding a table row. If user explicitly
  // filters to 'column', we show them as a flat group.
  const visibleTypes = typeFilter === 'all'
    ? grouped.types.filter(t => !(t === 'column' && grouped.types.includes('table')))
    : grouped.types.filter(t => t === typeFilter);

  const toggleType = (t: string) => {
    setCollapsedTypes(s => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  };
  const toggleParent = (pid: string) => {
    setExpandedParents(s => { const n = new Set(s); if (n.has(pid)) n.delete(pid); else n.add(pid); return n; });
  };

  const save = async () => {
    try {
      const attrs = JSON.parse(form.attributes);
      if (editId) {
        await api.resourceUpdate(editId, { display_name: form.display_name, parent_id: form.parent_id || undefined, attributes: attrs });
        toast.success(`Resource "${editId}" updated`);
      } else {
        await api.resourceCreate({ resource_id: form.resource_id, resource_type: form.resource_type, display_name: form.display_name, parent_id: form.parent_id || undefined, attributes: attrs });
        toast.success(`Resource "${form.resource_id}" created`);
      }
      setShowForm(false); setEditId(null); onReload();
    } catch (e) { toast.error(String(e)); }
  };

  const clone = (r: Row) => {
    setForm({
      resource_id: String(r.resource_id) + '_copy', resource_type: String(r.resource_type),
      display_name: String(r.display_name) + ' (copy)', parent_id: String(r.parent_id || ''),
      attributes: JSON.stringify(r.attributes || {}, null, 2),
    });
    setEditId(null); setShowForm(true);
  };

  const startEdit = (r: Row) => {
    setForm({
      resource_id: String(r.resource_id),
      resource_type: String(r.resource_type),
      display_name: String(r.display_name),
      parent_id: String(r.parent_id || ''),
      attributes: JSON.stringify(r.attributes || {}, null, 2),
    });
    setEditId(String(r.resource_id));
    setShowForm(true);
  };

  const startDelete = (r: Row) => setDangerConfirm({
    title: 'Deactivate Resource',
    message: `This will deactivate resource "${r.resource_id}".`,
    impact: 'Policies referencing this resource will no longer match.',
    onConfirm: async () => {
      try { await api.resourceDelete(String(r.resource_id)); toast.success('Resource deactivated'); onReload(); }
      catch (e) { toast.error(String(e)); }
    },
  });

  // Counts per type (unfiltered, total)
  const totalCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of data) {
      const t = String(r.resource_type || 'other');
      m[t] = (m[t] || 0) + 1;
    }
    return m;
  }, [data]);

  return (
    <div>
      <div className="card-header">
        <div className="flex items-center gap-3 flex-1">
          <span className="text-sm font-semibold">Resources ({filtered.length}/{data.length})</span>
          <div className="relative flex-1 max-w-xs">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search id / name / parent..." className="input pl-8 py-1.5 text-xs" />
          </div>
        </div>
        <button onClick={() => { setShowForm(true); setEditId(null); setForm({ resource_id: '', resource_type: 'module', display_name: '', parent_id: '', attributes: '{}' }); }}
          className="btn-primary btn-sm"><Plus size={12} /> Add</button>
      </div>

      {/* Type filter pills */}
      <div className="px-4 py-2 border-b border-slate-100 flex items-center gap-1.5 flex-wrap">
        <span className="text-[10px] uppercase tracking-wide text-slate-400 mr-1">Filter:</span>
        <TypePill
          active={typeFilter === 'all'}
          onClick={() => setTypeFilter('all')}
          label="All"
          count={data.length}
        />
        {Object.keys(TYPE_META)
          .filter(t => (totalCounts[t] ?? 0) > 0)
          .sort(sortByType)
          .map(t => (
            <TypePill
              key={t}
              active={typeFilter === t}
              onClick={() => setTypeFilter(t)}
              label={typeMeta(t).label}
              count={totalCounts[t] || 0}
              icon={typeMeta(t).icon}
              color={typeMeta(t).color}
            />
          ))
        }
      </div>

      {showForm && (
        <div className="card-body border-b bg-slate-50">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">
                Resource ID
                {!editId && form.resource_id === suggestedId && form.resource_id !== '' && (
                  <span className="text-emerald-500 text-[10px] ml-1">(auto)</span>
                )}
              </label>
              <input value={form.resource_id} onChange={e => setForm(f => ({ ...f, resource_id: e.target.value }))}
                disabled={!!editId} className="input font-mono" placeholder="module:new.module" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Type</label>
              <select value={form.resource_type} onChange={e => {
                const newType = e.target.value;
                setForm(f => {
                  const oldSuggested = uniqueId(autoId.resource(f.display_name, f.resource_type), existingIds);
                  const updated = { ...f, resource_type: newType };
                  if (f.resource_id === '' || f.resource_id === oldSuggested) {
                    updated.resource_id = uniqueId(autoId.resource(f.display_name, newType), existingIds);
                  }
                  return updated;
                });
              }} disabled={!!editId} className="select">
                {['module','table','view','column','web_page','web_api','db_pool','function','page','dag'].map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Display Name</label>
              <input value={form.display_name} onChange={e => {
                const newName = e.target.value;
                setForm(f => {
                  const oldSuggested = uniqueId(autoId.resource(f.display_name, f.resource_type), existingIds);
                  const updated = { ...f, display_name: newName };
                  if (f.resource_id === '' || f.resource_id === oldSuggested) {
                    updated.resource_id = uniqueId(autoId.resource(newName, f.resource_type), existingIds);
                  }
                  return updated;
                });
              }} className="input" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Parent Resource</label>
              <select value={form.parent_id} onChange={e => setForm(f => ({ ...f, parent_id: e.target.value }))} className="select text-xs">
                <option value="">(no parent)</option>
                {data.filter(r => String(r.resource_id) !== editId).map(r => (
                  <option key={String(r.resource_id)} value={String(r.resource_id)}>{String(r.resource_id)} — {String(r.display_name)}</option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-slate-500 mb-1">Attributes (JSON)</label>
              <textarea value={form.attributes} onChange={e => setForm(f => ({ ...f, attributes: e.target.value }))}
                className="input font-mono text-xs" rows={2} />
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <button onClick={save} className="btn-primary btn-sm"><Check size={12} /> {editId ? 'Update' : 'Create'}</button>
            <button onClick={() => { setShowForm(false); setEditId(null); }} className="btn-secondary btn-sm"><X size={12} /> Cancel</button>
          </div>
        </div>
      )}

      <div className="overflow-auto max-h-[68vh]">
        <table className="table">
          <thead className="sticky top-0 bg-white z-10"><tr>
            <th className="w-6"></th>
            <th className="w-28">Type</th>
            <th>Resource ID / Display Name</th>
            <th className="w-56">Parent</th>
            <th className="w-20 text-center">Children</th>
            <th className="w-24">Actions</th>
          </tr></thead>
          <tbody>
            {visibleTypes.length === 0 && (
              <tr><td colSpan={6} className="text-center text-slate-400 py-8 text-sm">No resources match.</td></tr>
            )}
            {visibleTypes.map(t => {
              const rows = grouped.g.get(t) || [];
              const collapsed = collapsedTypes.has(t);
              const meta = typeMeta(t);
              // Root rows for this type: top-level only (no parent) or parent not in this type
              // For 'column' type, we render them nested under their parent table instead, so skip them here.
              const renderedRows = t === 'column' && visibleTypes.includes('table') ? [] : rows;
              return (
                <Fragment key={`group_${t}`}>
                  <tr
                    className="bg-slate-50 hover:bg-slate-100 cursor-pointer border-t-2 border-slate-200"
                    onClick={() => toggleType(t)}
                  >
                    <td>
                      {collapsed ? <ChevronRight size={14} className="text-slate-500" /> : <ChevronDown size={14} className="text-slate-500" />}
                    </td>
                    <td colSpan={5} className="py-2">
                      <div className="flex items-center gap-2">
                        <span className={meta.color}>{meta.icon}</span>
                        <span className="text-xs font-semibold text-slate-800">{meta.label}</span>
                        <span className="text-[11px] text-slate-400">·</span>
                        <span className="text-[11px] text-slate-500">{rows.length.toLocaleString()} {rows.length === 1 ? 'row' : 'rows'}</span>
                      </div>
                    </td>
                  </tr>
                  {!collapsed && renderedRows.map(r => {
                    const rid = String(r.resource_id);
                    const children = childrenMap.get(rid) || [];
                    const hasChildren = children.length > 0;
                    const isExpanded = autoExpandedParents.has(rid);
                    return (
                      <Fragment key={rid}>
                        <ResourceRow
                          r={r}
                          depth={0}
                          hasChildren={hasChildren}
                          childCount={children.length}
                          isExpanded={isExpanded}
                          onToggleExpand={() => toggleParent(rid)}
                          onEdit={startEdit}
                          onClone={clone}
                          onDelete={startDelete}
                        />
                        {hasChildren && isExpanded && children.map(c => (
                          <ResourceRow
                            key={`${rid}>>${String(c.resource_id)}`}
                            r={c}
                            depth={1}
                            hasChildren={false}
                            childCount={0}
                            isExpanded={false}
                            onToggleExpand={() => {}}
                            onEdit={startEdit}
                            onClone={clone}
                            onDelete={startDelete}
                          />
                        ))}
                      </Fragment>
                    );
                  })}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <DangerConfirmModal state={dangerConfirm} onClose={() => setDangerConfirm(null)} />
    </div>
  );
}

function TypePill({ active, onClick, label, count, icon, color }: {
  active: boolean; onClick: () => void; label: string; count: number; icon?: React.ReactNode; color?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border transition ${
        active
          ? 'bg-blue-600 text-white border-blue-600'
          : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300 hover:bg-slate-50'
      }`}
    >
      {icon && <span className={active ? 'text-white' : color}>{icon}</span>}
      {label}
      <span className={`text-[10px] ${active ? 'text-blue-100' : 'text-slate-400'}`}>{count.toLocaleString()}</span>
    </button>
  );
}

function ResourceRow({
  r, depth, hasChildren, childCount, isExpanded, onToggleExpand, onEdit, onClone, onDelete,
}: {
  r: Row;
  depth: number;
  hasChildren: boolean;
  childCount: number;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onEdit: (r: Row) => void;
  onClone: (r: Row) => void;
  onDelete: (r: Row) => void;
}) {
  const meta = typeMeta(String(r.resource_type));
  const indent = depth * 20;
  return (
    <tr className={depth > 0 ? 'bg-slate-50/50 hover:bg-slate-100/50' : 'hover:bg-slate-50'}>
      <td>
        {hasChildren ? (
          <button onClick={onToggleExpand} className="text-slate-400 hover:text-slate-700 p-1" title={isExpanded ? 'Collapse' : 'Expand'}>
            {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : null}
      </td>
      <td>
        <span className={`badge ${meta.badge} inline-flex items-center gap-1`}>
          <span className="opacity-80">{meta.icon}</span>
          {String(r.resource_type)}
        </span>
      </td>
      <td style={{ paddingLeft: indent ? `${indent + 12}px` : undefined }}>
        <div className="flex flex-col">
          <span className="font-mono text-xs text-slate-800">{String(r.resource_id)}</span>
          <span className="text-[11px] text-slate-500 truncate max-w-[420px]" title={String(r.display_name)}>{String(r.display_name)}</span>
        </div>
      </td>
      <td className="font-mono text-[11px] text-slate-400 truncate max-w-[220px]" title={String(r.parent_id || '')}>
        {r.parent_id ? String(r.parent_id) : <span className="text-slate-300">—</span>}
      </td>
      <td className="text-center">
        {hasChildren ? (
          <button onClick={onToggleExpand} className="text-blue-600 hover:underline text-xs font-medium">
            {childCount.toLocaleString()}
          </button>
        ) : (
          <span className="text-slate-300 text-xs">—</span>
        )}
      </td>
      <td>
        <div className="flex gap-1">
          <button onClick={() => onEdit(r)} className="btn-secondary btn-sm p-1" title="Edit"><Pencil size={12} /></button>
          <button onClick={() => onClone(r)} className="btn-secondary btn-sm p-1" title="Clone"><Copy size={12} /></button>
          <button onClick={() => onDelete(r)} className="btn-secondary btn-sm p-1 text-red-500" title="Deactivate"><Trash2 size={12} /></button>
        </div>
      </td>
    </tr>
  );
}
