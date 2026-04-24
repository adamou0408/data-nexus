import { useCallback, useEffect, useMemo, useState, Fragment } from 'react';
import { api } from '../../../api';
import { useToast } from '../../Toast';
import { Combobox } from '../../shared/Combobox';
import {
  Plus, X, Check, Search, ChevronDown, ChevronRight,
  KeySquare, Sparkles, AlertTriangle, FileCode, Copy,
  List, Grid3x3, FlaskConical, History, GitCompare,
  Info, HelpCircle, Zap, ShieldAlert, ShieldCheck,
  Eye, PencilLine, Trash2, CheckCircle2, Download, Pause, Play, Plug,
  Folder, Database, Table2, Columns3, LayoutDashboard, Globe, FileCode2,
  Undo2,
} from 'lucide-react';
import {
  PermRow, PendingOp, Effect, ActionMeta, ResourceMeta,
  RESOURCE_TYPE_ORDER, defaultResourceTypesForAction, schemaOf, prefixCovers, pendingKey,
} from './types';

type ViewMode = 'list' | 'matrix' | 'simulator' | 'audit' | 'compare';

const EFFECT_ICON: Record<Effect, React.ReactNode> = {
  allow: <ShieldCheck size={11} />,
  deny:  <ShieldAlert size={11} />,
};

const ACTION_ICON: Record<string, React.ReactNode> = {
  read:    <Eye size={11} />,
  write:   <PencilLine size={11} />,
  delete:  <Trash2 size={11} />,
  approve: <CheckCircle2 size={11} />,
  export:  <Download size={11} />,
  hold:    <Pause size={11} />,
  release: <Play size={11} />,
  execute: <Zap size={11} />,
  connect: <Plug size={11} />,
};

const TYPE_ICON: Record<string, React.ReactNode> = {
  module:   <Folder size={11} />,
  table:    <Table2 size={11} />,
  view:     <Table2 size={11} />,
  column:   <Columns3 size={11} />,
  function: <FileCode2 size={11} />,
  web_page: <LayoutDashboard size={11} />,
  web_api:  <Globe size={11} />,
  db_pool:  <Database size={11} />,
};

const actionIcon = (aid: string) => ACTION_ICON[aid] ?? <Zap size={11} />;
const typeIcon = (t: string) => TYPE_ICON[t] ?? <Folder size={11} />;

export function PermissionsStudio({ roleId, onReload }: { roleId: string; onReload: () => void }) {
  const toast = useToast();
  const [perms, setPerms] = useState<PermRow[]>([]);
  const [actions, setActions] = useState<ActionMeta[]>([]);
  const [resources, setResources] = useState<ResourceMeta[]>([]);
  const [pending, setPending] = useState<Map<string, PendingOp>>(new Map());
  const [view, setView] = useState<ViewMode>('list');
  const [applying, setApplying] = useState(false);
  const [showApply, setShowApply] = useState(false);
  const [showSql, setShowSql] = useState(false);

  const loadPerms = useCallback(() => {
    api.rolePermissions(roleId).then(rows => {
      setPerms(rows.map(p => ({
        id: Number(p.id),
        action_id: String(p.action_id),
        resource_id: String(p.resource_id),
        effect: (p.effect === 'deny' ? 'deny' : 'allow') as Effect,
        resource_name: p.resource_name ? String(p.resource_name) : undefined,
      })));
    }).catch(() => {});
  }, [roleId]);

  useEffect(() => {
    loadPerms();
    setPending(new Map());
  }, [loadPerms]);

  useEffect(() => {
    api.actions().then(rows => setActions(rows.map(a => ({
      action_id: String(a.action_id),
      display_name: String(a.display_name || ''),
      description: a.description ? String(a.description) : undefined,
      applicable_paths: Array.isArray(a.applicable_paths)
        ? (a.applicable_paths as string[])
        : String(a.applicable_paths || '').split(/[,\s]+/).filter(Boolean),
    })))).catch(() => {});
    api.resources().then(rows => setResources(rows.map(r => ({
      resource_id: String(r.resource_id),
      resource_type: String(r.resource_type || 'other'),
      display_name: String(r.display_name || ''),
      parent_id: r.parent_id ? String(r.parent_id) : null,
    })))).catch(() => {});
  }, []);

  // Effective row list = baseline perms minus pending-deletes plus pending-creates.
  const effective = useMemo<{ row: PermRow; status: 'clean' | 'new' | 'deleted' }[]>(() => {
    const deleteSet = new Set<number>();
    const creates: PermRow[] = [];
    for (const op of pending.values()) {
      if (op.kind === 'delete') deleteSet.add(op.perm_id);
      else creates.push({ id: null, action_id: op.action_id, resource_id: op.resource_id, effect: op.effect });
    }
    const rows: { row: PermRow; status: 'clean' | 'new' | 'deleted' }[] = [];
    for (const p of perms) {
      rows.push({ row: p, status: deleteSet.has(p.id as number) ? 'deleted' : 'clean' });
    }
    for (const c of creates) rows.push({ row: c, status: 'new' });
    return rows;
  }, [perms, pending]);

  const counts = useMemo(() => {
    let c = 0, d = 0;
    for (const op of pending.values()) {
      if (op.kind === 'create') c++;
      else d++;
    }
    return { create: c, delete: d, total: c + d };
  }, [pending]);

  const stageCreate = useCallback((action_id: string, resource_id: string, effect: Effect) => {
    // reject duplicate staged creates or conflicts with an existing row that's not staged for delete
    const op: PendingOp = { kind: 'create', action_id, resource_id, effect };
    const key = pendingKey(op);
    setPending(prev => {
      if (prev.has(key)) return prev;
      // If there's already a live perm matching this exactly, and it's NOT staged for delete,
      // it's a duplicate — skip silently rather than error.
      const existing = perms.find(p => p.action_id === action_id && p.resource_id === resource_id && p.effect === effect);
      if (existing) {
        const delKey = pendingKey({ kind: 'delete', perm_id: existing.id as number, snapshot: existing });
        if (!prev.has(delKey)) return prev; // already live
      }
      const next = new Map(prev);
      next.set(key, op);
      return next;
    });
  }, [perms]);

  const stageDelete = useCallback((perm: PermRow) => {
    if (perm.id == null) {
      // deleting a pending-create: just remove from map
      const createKey = pendingKey({ kind: 'create', action_id: perm.action_id, resource_id: perm.resource_id, effect: perm.effect });
      setPending(prev => {
        if (!prev.has(createKey)) return prev;
        const next = new Map(prev);
        next.delete(createKey);
        return next;
      });
      return;
    }
    const op: PendingOp = { kind: 'delete', perm_id: perm.id, snapshot: perm };
    const key = pendingKey(op);
    setPending(prev => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key); // undo delete
      else next.set(key, op);
      return next;
    });
  }, []);

  const discardAll = () => {
    setPending(new Map());
    toast.info('All pending permission changes discarded');
  };

  const applyAll = async () => {
    setApplying(true);
    let ok = 0, fail = 0;
    const errors: string[] = [];
    const ops = Array.from(pending.values());
    // creates first (safer to add grants before removing), then deletes
    const ordered = [...ops.filter(o => o.kind === 'create'), ...ops.filter(o => o.kind === 'delete')];
    const keepKeys = new Set<string>();
    for (const op of ordered) {
      try {
        if (op.kind === 'create') {
          await api.roleAddPermission(roleId, { action_id: op.action_id, resource_id: op.resource_id, effect: op.effect });
        } else {
          await api.roleRemovePermission(roleId, op.perm_id);
        }
        ok++;
      } catch (e) {
        fail++;
        errors.push(`${op.kind}: ${String(e)}`);
        keepKeys.add(pendingKey(op));
      }
    }
    if (ok) toast.success(`Applied ${ok} permission change${ok === 1 ? '' : 's'}${fail ? ` (${fail} failed)` : ''}`);
    if (fail) { toast.error(`${fail} failed — kept in draft`); console.error('Apply failures:', errors); }
    setPending(prev => {
      const next = new Map<string, PendingOp>();
      for (const [k, v] of prev) if (keepKeys.has(k)) next.set(k, v);
      return next;
    });
    setShowApply(false);
    setApplying(false);
    loadPerms();
    onReload();
  };

  return (
    <div className="flex flex-col h-full">
      <div className="border-b border-slate-200 bg-slate-50 flex items-center flex-wrap gap-1 px-3 py-1.5">
        <ViewTab active={view === 'list'} onClick={() => setView('list')} icon={<List size={12} />} label="Grants" />
        <ViewTab active={view === 'matrix'} onClick={() => setView('matrix')} icon={<Grid3x3 size={12} />} label="Matrix" />
        <ViewTab active={view === 'simulator'} onClick={() => setView('simulator')} icon={<FlaskConical size={12} />} label="Simulator" />
        <ViewTab active={view === 'compare'} onClick={() => setView('compare')} icon={<GitCompare size={12} />} label="Compare" />
        <ViewTab active={view === 'audit'} onClick={() => setView('audit')} icon={<History size={12} />} label="Audit" />
      </div>

      <div className="flex-1 overflow-auto pb-24">
        {view === 'list' && (
          <ListView
            roleId={roleId}
            perms={perms}
            effective={effective}
            pending={pending}
            actions={actions}
            resources={resources}
            onStageCreate={stageCreate}
            onStageDelete={stageDelete}
          />
        )}
        {view === 'matrix' && (
          <MatrixView
            perms={perms}
            effective={effective}
            actions={actions}
            resources={resources}
            onStageCreate={stageCreate}
            onStageDelete={stageDelete}
            pending={pending}
          />
        )}
        {view === 'simulator' && (
          <SimulatorView roleId={roleId} actions={actions} resources={resources} />
        )}
        {view === 'compare' && (
          <CompareView roleId={roleId} />
        )}
        {view === 'audit' && (
          <AuditView roleId={roleId} />
        )}
      </div>

      {counts.total > 0 && (
        <div className="sticky bottom-0 left-0 right-0 bg-white border-t-2 border-amber-300 shadow-2xl px-4 py-2.5 flex items-center gap-3 flex-wrap">
          <AlertTriangle size={15} className="text-amber-600 shrink-0" />
          <div className="text-xs text-slate-800 flex items-center gap-2">
            <b>{counts.total} pending</b>
            <span className="text-slate-300">·</span>
            {counts.create > 0 && <span className="text-emerald-700">+{counts.create}</span>}
            {counts.delete > 0 && <span className="text-red-700">−{counts.delete}</span>}
            <span className="text-slate-400 hidden sm:inline">尚未寫入 DB</span>
          </div>
          <div className="h-5 w-px bg-slate-200" />
          <button onClick={() => setShowSql(true)} className="btn-secondary btn-sm gap-1" title="Preview SQL for these pending changes">
            <FileCode size={11} /> SQL
          </button>
          <button onClick={discardAll} className="btn-secondary btn-sm gap-1 text-slate-700"><X size={11} /> Discard</button>
          <button onClick={() => setShowApply(true)} className="btn-primary btn-sm gap-1"><Check size={11} /> Apply ({counts.total})</button>
        </div>
      )}

      {showApply && (
        <ApplyConfirmModal
          pending={pending}
          applying={applying}
          onCancel={() => setShowApply(false)}
          onConfirm={applyAll}
        />
      )}
      {showSql && (
        <SqlPreviewModal roleId={roleId} pending={pending} onClose={() => setShowSql(false)} />
      )}
    </div>
  );
}

function ViewTab({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded transition ${
        active ? 'bg-white border border-blue-300 text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800 hover:bg-white'
      }`}
    >
      {icon} {label}
    </button>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// VIEW: LIST — grouped grants + author panel (action picker + resource tree + prefix grant)
// ──────────────────────────────────────────────────────────────────────────────
function ListView({
  roleId: _roleId, perms, effective, pending, actions, resources, onStageCreate, onStageDelete,
}: {
  roleId: string;
  perms: PermRow[];
  effective: { row: PermRow; status: 'clean' | 'new' | 'deleted' }[];
  pending: Map<string, PendingOp>;
  actions: ActionMeta[];
  resources: ResourceMeta[];
  onStageCreate: (action_id: string, resource_id: string, effect: Effect) => void;
  onStageDelete: (perm: PermRow) => void;
}) {
  const [actionId, setActionId] = useState('');
  const [effect, setEffect] = useState<Effect>('allow');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [resQuery, setResQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('');
  const [prefixInput, setPrefixInput] = useState('');
  const [showHelp, setShowHelp] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  const selectedAction = useMemo(() => actions.find(a => a.action_id === actionId) || null, [actions, actionId]);

  // Auto-filter resource picker by the action's natural resource types (execute→function, etc.)
  useEffect(() => {
    if (!selectedAction) return;
    const hints = defaultResourceTypesForAction(selectedAction);
    if (hints.length && !typeFilter) setTypeFilter(hints[0]);
  }, [selectedAction]); // eslint-disable-line react-hooks/exhaustive-deps

  const existingForAction = useMemo(() => {
    if (!actionId) return new Set<string>();
    const existing = new Set<string>();
    for (const p of perms) if (p.action_id === actionId) existing.add(p.resource_id);
    for (const op of pending.values()) {
      if (op.kind === 'create' && op.action_id === actionId) existing.add(op.resource_id);
    }
    return existing;
  }, [perms, pending, actionId]);

  // Prefix coverage: shows which selected concrete ids are shadowed by a prefix grant
  const prefixCoverage = useMemo(() => {
    const coveredBy: Map<string, string> = new Map();
    if (!actionId) return coveredBy;
    const prefixRows: string[] = [];
    for (const p of perms) if (p.action_id === actionId && p.resource_id.includes('*')) prefixRows.push(p.resource_id);
    for (const op of pending.values()) {
      if (op.kind === 'create' && op.action_id === actionId && op.resource_id.includes('*')) prefixRows.push(op.resource_id);
    }
    for (const id of selected) {
      for (const g of prefixRows) if (prefixCovers(g, id)) { coveredBy.set(id, g); break; }
    }
    return coveredBy;
  }, [selected, perms, pending, actionId]);

  // Grouped resource tree: type → (schema | 'root') → items
  const tree = useMemo(() => {
    const q = resQuery.trim().toLowerCase();
    const types: Record<string, Record<string, ResourceMeta[]>> = {};
    for (const r of resources) {
      const t = r.resource_type;
      if (typeFilter && t !== typeFilter) continue;
      if (q && !r.resource_id.toLowerCase().includes(q) && !r.display_name.toLowerCase().includes(q)) continue;
      const s = schemaOf(r.resource_id) || '(root)';
      ((types[t] ||= {})[s] ||= []).push(r);
    }
    const orderIdx = (t: string) => {
      const i = (RESOURCE_TYPE_ORDER as readonly string[]).indexOf(t);
      return i === -1 ? 999 : i;
    };
    return Object.entries(types)
      .sort(([a], [b]) => orderIdx(a) - orderIdx(b))
      .map(([type, schemas]) => ({
        type,
        schemas: Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b)),
      }));
  }, [resources, resQuery, typeFilter]);

  const allTypes = useMemo(() => {
    const s = new Set<string>();
    for (const r of resources) s.add(r.resource_type);
    return Array.from(s).sort((a, b) => {
      const orderIdx = (t: string) => {
        const i = (RESOURCE_TYPE_ORDER as readonly string[]).indexOf(t);
        return i === -1 ? 999 : i;
      };
      return orderIdx(a) - orderIdx(b);
    });
  }, [resources]);

  const toggleResource = (id: string) => {
    setSelected(s => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAllInSchema = (items: ResourceMeta[]) => {
    const ids = items.map(r => r.resource_id).filter(id => !existingForAction.has(id));
    if (ids.length === 0) return;
    const all = ids.every(id => selected.has(id));
    setSelected(s => {
      const next = new Set(s);
      if (all) ids.forEach(id => next.delete(id));
      else ids.forEach(id => next.add(id));
      return next;
    });
  };

  const addSelection = () => {
    if (!actionId) return;
    for (const rid of selected) onStageCreate(actionId, rid, effect);
    setSelected(new Set());
  };

  const addPrefix = () => {
    if (!actionId || !prefixInput.trim()) return;
    onStageCreate(actionId, prefixInput.trim(), effect);
    setPrefixInput('');
  };

  const suggest = () => {
    if (!selectedAction) return;
    const hints = defaultResourceTypesForAction(selectedAction);
    if (!hints.length) return;
    const pool = resources.filter(r => hints.includes(r.resource_type) && !existingForAction.has(r.resource_id));
    if (!pool.length) return;
    // prefer same schema as already-selected, if any
    let candidates = pool;
    const picked = Array.from(selected).map(id => schemaOf(id)).filter(Boolean);
    if (picked.length) {
      const match = pool.filter(r => picked.includes(schemaOf(r.resource_id)));
      if (match.length) candidates = match;
    }
    setSelected(prev => {
      const next = new Set(prev);
      candidates.forEach(r => next.add(r.resource_id));
      return next;
    });
  };

  // Grouped display of current perms (live + pending). Detect conflicts (allow+deny on same action/resource).
  const displayGroups = useMemo(() => {
    const groups: Record<string, { row: PermRow; status: 'clean' | 'new' | 'deleted' }[]> = {};
    for (const e of effective) {
      const key = e.row.action_id;
      (groups[key] ||= []).push(e);
    }
    return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
  }, [effective]);

  const conflictIds = useMemo(() => {
    const map = new Map<string, Set<Effect>>();
    for (const e of effective) {
      if (e.status === 'deleted') continue;
      const k = `${e.row.action_id}|${e.row.resource_id}`;
      if (!map.has(k)) map.set(k, new Set());
      map.get(k)!.add(e.row.effect);
    }
    const out = new Set<string>();
    for (const [k, effs] of map) if (effs.size > 1) out.add(k);
    return out;
  }, [effective]);

  return (
    <div className="p-4 space-y-4">
      {/* ── Add panel ─────────────────────────────────────────────────────── */}
      <div className="border border-slate-200 rounded-lg bg-gradient-to-br from-slate-50 to-white">
        <div className="px-3 py-2 border-b border-slate-200 flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase text-slate-600">Grant permissions</span>
          <button onClick={() => setShowHelp(s => !s)} className="ml-auto text-slate-400 hover:text-blue-600 flex items-center gap-1 text-[11px]">
            <HelpCircle size={11} /> {showHelp ? 'Hide help' : 'About L0–L3'}
          </button>
        </div>

        {showHelp && (
          <div className="px-3 py-2 border-b border-slate-200 bg-blue-50/40 text-[11px] text-slate-700 space-y-1">
            <div><b>L0 – Functional</b>：action × resource 粒度，在這裡設。</div>
            <div><b>L1 – Row scope</b>：ABAC/RLS 條件，到 <b>Policies</b> tab 設。</div>
            <div><b>L2 – Column mask</b>：遮罩規則，在 Resources tab 對 column 類設。</div>
            <div><b>L3 – Composite</b>：組合動作（export = read + audit），在 <b>Actions</b> tab 設。</div>
            <div className="text-slate-500 pt-1">Wildcard：<code className="font-mono bg-slate-100 px-1 rounded">function:tiptop.*</code>、<code className="font-mono bg-slate-100 px-1 rounded">module:*</code>、<code className="font-mono bg-slate-100 px-1 rounded">*</code> 都支援（authz_check 自動 walk prefix）。</div>
          </div>
        )}

        <div className="p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setEffect(e => (e === 'allow' ? 'deny' : 'allow'))}
              className={`text-xs px-3 py-1.5 rounded border font-semibold transition flex items-center gap-1 ${
                effect === 'allow' ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-red-50 border-red-300 text-red-700'
              }`}
              title="切換 allow / deny（deny 會覆蓋 allow）"
            >
              {EFFECT_ICON[effect]} {effect}
            </button>
            <div className="flex-1 min-w-[200px]">
              <Combobox
                value={actionId}
                onChange={setActionId}
                placeholder="選 action…"
                clearable
                options={actions.map(a => ({
                  value: a.action_id,
                  label: a.action_id,
                  hint: [a.display_name, a.applicable_paths.length ? `paths:${a.applicable_paths.join(',')}` : ''].filter(Boolean).join(' · '),
                }))}
              />
            </div>
            <button onClick={suggest} disabled={!selectedAction} className="btn-secondary btn-sm gap-1 disabled:opacity-40" title="依 action 類型推薦同類 resource">
              <Sparkles size={11} /> Suggest
            </button>
          </div>

          {selectedAction && (
            <div className="flex items-start gap-2 px-2 py-1.5 bg-blue-50/60 border border-blue-100 rounded text-[11px] text-slate-700">
              <Info size={11} className="text-blue-500 mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0">
                <span className="font-mono font-semibold text-blue-700 inline-flex items-center gap-1">
                  {actionIcon(selectedAction.action_id)} {selectedAction.action_id}
                </span>
                <span className="ml-1 text-slate-600">— {selectedAction.display_name}</span>
                {selectedAction.description && <div className="text-slate-500 mt-0.5">{selectedAction.description}</div>}
                {defaultResourceTypesForAction(selectedAction).length > 0 && (
                  <div className="text-[10px] text-slate-400 mt-0.5">
                    建議 resource types：{defaultResourceTypesForAction(selectedAction).join(', ')}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Prefix / wildcard grant */}
          <div className="flex items-center gap-2 border border-dashed border-indigo-200 bg-indigo-50/40 rounded px-2 py-1.5">
            <span className="text-[10px] font-semibold text-indigo-700 uppercase">Prefix grant</span>
            <input
              value={prefixInput}
              onChange={e => setPrefixInput(e.target.value)}
              placeholder="e.g. function:tiptop.* 或 module:* 或 *"
              className="input py-1 text-xs font-mono flex-1 min-w-[200px]"
            />
            <button onClick={addPrefix} disabled={!actionId || !prefixInput.trim()} className="btn-primary btn-sm gap-1 disabled:opacity-40" title="以 wildcard 寫一條 permission，涵蓋所有符合 prefix 的 resource">
              <Plus size={11} /> Add prefix
            </button>
          </div>

          {/* Resource tree picker */}
          <div className="border border-slate-200 rounded-md bg-white">
            <div className="px-2 py-1.5 border-b border-slate-200 flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[160px]">
                <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  value={resQuery}
                  onChange={e => setResQuery(e.target.value)}
                  placeholder="Search resources…"
                  className="input pl-7 py-1 text-xs w-full"
                />
              </div>
              <div className="flex flex-wrap gap-1">
                <button
                  onClick={() => setTypeFilter('')}
                  className={`text-[10px] px-2 py-0.5 rounded border ${typeFilter === '' ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'}`}
                >all</button>
                {allTypes.map(t => (
                  <button
                    key={t}
                    onClick={() => setTypeFilter(t === typeFilter ? '' : t)}
                    className={`text-[10px] px-2 py-0.5 rounded border inline-flex items-center gap-1 ${typeFilter === t ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-300 text-slate-600 hover:bg-slate-50'}`}
                  >{typeIcon(t)} {t}</button>
                ))}
              </div>
              <span className="text-[10px] text-slate-400 ml-auto">
                已選 <b className="text-slate-700">{selected.size}</b>
              </span>
            </div>

            <div className="max-h-72 overflow-y-auto">
              {tree.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-slate-400">沒有符合的 resource</div>
              ) : tree.map(({ type, schemas }) => (
                <div key={type} className="border-b border-slate-100 last:border-b-0">
                  <div className="flex items-center gap-1 px-2 py-1 bg-slate-50 sticky top-0 z-10">
                    {typeIcon(type)}
                    <span className="text-[11px] font-semibold uppercase text-slate-600">{type}</span>
                    <span className="text-[10px] text-slate-400">({schemas.reduce((n, [, items]) => n + items.length, 0)})</span>
                  </div>
                  {schemas.map(([schema, items]) => {
                    const groupKey = `${type}|${schema}`;
                    const collapsed = collapsedGroups[groupKey];
                    const selectableIds = items.map(r => r.resource_id).filter(id => !existingForAction.has(id));
                    const allSel = selectableIds.length > 0 && selectableIds.every(id => selected.has(id));
                    return (
                      <div key={groupKey} className="border-t border-slate-100">
                        <button
                          onClick={() => setCollapsedGroups(c => ({ ...c, [groupKey]: !c[groupKey] }))}
                          className="w-full flex items-center gap-1.5 px-3 py-1 text-left hover:bg-slate-50"
                        >
                          {collapsed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                          <span className="text-[10px] font-mono text-slate-500">{schema}</span>
                          <span className="text-[10px] text-slate-400">({items.length})</span>
                          <span
                            role="button"
                            onClick={(e) => { e.stopPropagation(); selectAllInSchema(items); }}
                            className="ml-auto text-[10px] text-blue-600 hover:underline cursor-pointer"
                          >
                            {allSel ? 'unselect all' : `select all (${selectableIds.length})`}
                          </span>
                        </button>
                        {!collapsed && items.map(r => {
                          const already = existingForAction.has(r.resource_id);
                          const checked = selected.has(r.resource_id);
                          const covered = prefixCoverage.get(r.resource_id);
                          return (
                            <label
                              key={r.resource_id}
                              className={`flex items-center gap-2 pl-8 pr-3 py-1 text-xs cursor-pointer ${already ? 'opacity-40 cursor-not-allowed' : 'hover:bg-blue-50'} ${checked ? 'bg-blue-50' : ''}`}
                              title={already ? '此 action 已有對該 resource 的 permission' : r.display_name}
                            >
                              <input type="checkbox" checked={checked} disabled={already} onChange={() => !already && toggleResource(r.resource_id)} />
                              <span className="font-mono text-slate-700 truncate">{r.resource_id}</span>
                              {r.display_name && <span className="text-slate-400 text-[10px] truncate">{r.display_name}</span>}
                              {already && <span className="badge badge-slate text-[9px] shrink-0">existing</span>}
                              {covered && <span className="badge badge-amber text-[9px] shrink-0" title={`已被 ${covered} 涵蓋`}>shadowed</span>}
                            </label>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={addSelection}
              disabled={!actionId || selected.size === 0}
              className="btn-primary btn-sm gap-1 disabled:opacity-40"
            >
              <Plus size={11} /> Stage {selected.size || ''} grant{selected.size === 1 ? '' : 's'}
            </button>
            {selected.size > 0 && (
              <button onClick={() => setSelected(new Set())} className="text-[11px] text-slate-500 hover:text-slate-800">Clear selection</button>
            )}
          </div>
        </div>
      </div>

      {/* ── Existing grants ──────────────────────────────────────────────── */}
      {effective.length === 0 ? (
        <div className="text-center py-10 text-slate-400">
          <KeySquare size={24} className="mx-auto mb-2 text-slate-300" />
          <p className="text-xs">No permissions yet. Grant one above.</p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="text-[11px] text-slate-500 px-1">
            {effective.filter(e => e.status !== 'deleted').length} active grant{effective.filter(e => e.status !== 'deleted').length === 1 ? '' : 's'}
            {conflictIds.size > 0 && <span className="ml-2 text-red-600"><AlertTriangle size={10} className="inline" /> {conflictIds.size} conflict(s)</span>}
          </div>
          {displayGroups.map(([act, rows]) => (
            <div key={act} className="border border-slate-200 rounded-lg overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-50">
                {actionIcon(act)}
                <span className="text-xs font-mono font-semibold text-slate-700">{act}</span>
                <span className="text-[10px] text-slate-400">({rows.length})</span>
              </div>
              <div className="divide-y divide-slate-100">
                {rows.map((e, idx) => {
                  const { row, status } = e;
                  const conflictKey = `${row.action_id}|${row.resource_id}`;
                  const conflict = conflictIds.has(conflictKey);
                  const isWildcard = row.resource_id.includes('*');
                  return (
                    <div
                      key={`${row.id ?? 'new'}:${row.resource_id}:${row.effect}:${idx}`}
                      className={`flex items-center gap-2 px-3 py-1.5 text-xs group ${
                        status === 'new' ? 'bg-emerald-50/60'
                        : status === 'deleted' ? 'bg-red-50/50 line-through text-slate-400'
                        : 'hover:bg-slate-50'
                      }`}
                    >
                      <span className={`badge text-[10px] inline-flex items-center gap-0.5 ${row.effect === 'allow' ? 'badge-green' : 'badge-red'}`}>
                        {EFFECT_ICON[row.effect]} {row.effect}
                      </span>
                      <span className={`font-mono text-slate-600 flex-1 truncate ${isWildcard ? 'font-bold text-indigo-700' : ''}`} title={row.resource_id}>
                        {row.resource_id}
                        {isWildcard && <span className="ml-1.5 badge badge-slate text-[9px]">prefix</span>}
                      </span>
                      {row.resource_name && <span className="text-slate-400 text-[10px] truncate max-w-[160px]">{row.resource_name}</span>}
                      {conflict && <span className="badge badge-red text-[9px]" title="allow + deny 同時存在"><AlertTriangle size={9} /> conflict</span>}
                      {status === 'new' && <span className="badge badge-green text-[9px]">+ new</span>}
                      {status === 'deleted' && <span className="badge badge-red text-[9px]">− delete</span>}
                      <button
                        onClick={() => onStageDelete(row)}
                        className="text-slate-300 hover:text-red-600 opacity-0 group-hover:opacity-100 transition"
                        title={status === 'deleted' ? 'Undo delete' : (status === 'new' ? 'Remove from draft' : 'Stage delete')}
                      >
                        {status === 'deleted' ? <Undo2 size={11} /> : <X size={11} />}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// VIEW: MATRIX — action × resource_type grid with direct cell grant toggle
// ──────────────────────────────────────────────────────────────────────────────
function MatrixView({
  effective, actions, resources, onStageCreate, onStageDelete,
}: {
  perms: PermRow[];
  effective: { row: PermRow; status: 'clean' | 'new' | 'deleted' }[];
  pending: Map<string, PendingOp>;
  actions: ActionMeta[];
  resources: ResourceMeta[];
  onStageCreate: (action_id: string, resource_id: string, effect: Effect) => void;
  onStageDelete: (perm: PermRow) => void;
}) {
  const [groupBy, setGroupBy] = useState<'type' | 'schema'>('type');

  // Rows = resource-type buckets (or schema buckets). Each bucket has a summary
  // "grant on all via type:*" cell that creates a wildcard grant.
  const buckets = useMemo(() => {
    if (groupBy === 'type') {
      const typeIds = new Set<string>();
      resources.forEach(r => typeIds.add(r.resource_type));
      return Array.from(typeIds).sort((a, b) => {
        const idx = (t: string) => {
          const i = (RESOURCE_TYPE_ORDER as readonly string[]).indexOf(t);
          return i === -1 ? 999 : i;
        };
        return idx(a) - idx(b);
      }).map(t => ({
        key: t,
        label: t,
        icon: typeIcon(t),
        wildcardGrant: `${t}:*`, // heuristic: type name often matches resource_id prefix
        memberCount: resources.filter(r => r.resource_type === t).length,
      }));
    }
    const schemaIds = new Set<string>();
    resources.forEach(r => { const s = schemaOf(r.resource_id); if (s) schemaIds.add(s); });
    return Array.from(schemaIds).sort().map(s => ({
      key: s,
      label: s,
      icon: <Database size={11} />,
      wildcardGrant: `function:${s}.*`,
      memberCount: resources.filter(r => schemaOf(r.resource_id) === s).length,
    }));
  }, [resources, groupBy]);

  // Cell state: look up whether this role has any grant that covers this bucket
  const cellState = useCallback((bucketKey: string, bucketWild: string, action_id: string): {
    state: 'allow' | 'deny' | 'partial' | 'empty';
    direct?: PermRow;
    pending?: 'new' | 'deleted';
  } => {
    // 1. Exact wildcard grant match?
    const live = effective.filter(e => e.row.action_id === action_id);
    const direct = live.find(e => e.row.resource_id === bucketWild || e.row.resource_id === '*');
    if (direct) {
      return {
        state: direct.row.effect,
        direct: direct.row,
        pending: direct.status === 'new' ? 'new' : direct.status === 'deleted' ? 'deleted' : undefined,
      };
    }
    // 2. Any concrete grant under this bucket?
    const bucketMembers = resources
      .filter(r => groupBy === 'type' ? r.resource_type === bucketKey : schemaOf(r.resource_id) === bucketKey)
      .map(r => r.resource_id);
    const covered = live.some(e => e.status !== 'deleted' && bucketMembers.some(m => prefixCovers(e.row.resource_id, m)));
    return { state: covered ? 'partial' : 'empty' };
  }, [effective, resources, groupBy]);

  const commonActions = useMemo(() => {
    const priority = ['read', 'write', 'delete', 'execute', 'connect', 'approve', 'export', 'hold', 'release'];
    const known = actions.filter(a => priority.includes(a.action_id)).sort(
      (a, b) => priority.indexOf(a.action_id) - priority.indexOf(b.action_id)
    );
    const rest = actions.filter(a => !priority.includes(a.action_id));
    return [...known, ...rest];
  }, [actions]);

  const onCellClick = (bucketWild: string, action_id: string, currentDirect: PermRow | undefined) => {
    // toggle cycle:
    //   empty → allow wildcard
    //   allow direct → delete it
    //   deny direct → delete it
    if (currentDirect) onStageDelete(currentDirect);
    else onStageCreate(action_id, bucketWild, 'allow');
  };

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase text-slate-500">Group by:</span>
        <button onClick={() => setGroupBy('type')} className={`text-[11px] px-2 py-0.5 rounded border ${groupBy === 'type' ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-300'}`}>Resource type</button>
        <button onClick={() => setGroupBy('schema')} className={`text-[11px] px-2 py-0.5 rounded border ${groupBy === 'schema' ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-300'}`}>Schema</button>
        <span className="ml-auto text-[10px] text-slate-400">點 cell → 下 wildcard grant / 取消；再點 × 移除</span>
      </div>

      <div className="border border-slate-200 rounded-lg overflow-auto bg-white">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-50 sticky top-0 z-10">
            <tr>
              <th className="text-left px-3 py-2 font-semibold text-slate-600 sticky left-0 bg-slate-50 z-20 min-w-[160px]">
                {groupBy === 'type' ? 'Resource type' : 'Schema'}
              </th>
              {commonActions.map(a => (
                <th key={a.action_id} className="px-2 py-2 text-center font-semibold text-slate-600 min-w-[68px]" title={a.display_name}>
                  <div className="flex flex-col items-center gap-0.5">
                    {actionIcon(a.action_id)}
                    <span className="font-mono text-[10px]">{a.action_id}</span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {buckets.map(bucket => (
              <tr key={bucket.key} className="border-t border-slate-100">
                <td className="px-3 py-2 sticky left-0 bg-white z-10 border-r border-slate-100">
                  <div className="flex items-center gap-2">
                    {bucket.icon}
                    <span className="font-mono text-xs">{bucket.label}</span>
                    <span className="text-[10px] text-slate-400">({bucket.memberCount})</span>
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono">{bucket.wildcardGrant}</div>
                </td>
                {commonActions.map(a => {
                  const cell = cellState(bucket.key, bucket.wildcardGrant, a.action_id);
                  return (
                    <td key={a.action_id} className="text-center p-0 border-l border-slate-100">
                      <button
                        onClick={() => onCellClick(bucket.wildcardGrant, a.action_id, cell.direct)}
                        className={`w-full h-full px-2 py-2 min-h-[40px] transition relative ${
                          cell.state === 'allow' ? 'bg-emerald-50 hover:bg-emerald-100'
                          : cell.state === 'deny' ? 'bg-red-50 hover:bg-red-100'
                          : cell.state === 'partial' ? 'bg-amber-50 hover:bg-amber-100'
                          : 'hover:bg-slate-50'
                        }`}
                        title={
                          cell.state === 'allow' ? `allow via ${cell.direct?.resource_id} — 點擊移除`
                          : cell.state === 'deny' ? `deny via ${cell.direct?.resource_id} — 點擊移除`
                          : cell.state === 'partial' ? '部分子項有 grant（非 wildcard） — 點擊下 wildcard allow'
                          : '尚未 grant — 點擊新增 wildcard allow'
                        }
                      >
                        {cell.state === 'allow' && <ShieldCheck size={14} className="mx-auto text-emerald-600" />}
                        {cell.state === 'deny' && <ShieldAlert size={14} className="mx-auto text-red-600" />}
                        {cell.state === 'partial' && <span className="text-[10px] font-bold text-amber-700">~</span>}
                        {cell.state === 'empty' && <span className="text-slate-300 text-[10px]">·</span>}
                        {cell.pending === 'new' && <span className="absolute top-0.5 right-0.5 text-[8px] text-emerald-700 font-bold">+</span>}
                        {cell.pending === 'deleted' && <span className="absolute top-0.5 right-0.5 text-[8px] text-red-700 font-bold">−</span>}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex gap-3 text-[10px] text-slate-500">
        <span className="inline-flex items-center gap-1"><ShieldCheck size={10} className="text-emerald-600" /> wildcard allow</span>
        <span className="inline-flex items-center gap-1"><ShieldAlert size={10} className="text-red-600" /> wildcard deny</span>
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 bg-amber-300 rounded-sm" /> partial（子項有 grant，但無 wildcard）</span>
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 bg-white border border-slate-300 rounded-sm" /> empty</span>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// VIEW: SIMULATOR — test authz_check(subject, groups, action, resource)
// ──────────────────────────────────────────────────────────────────────────────
function SimulatorView({ roleId, actions, resources }: { roleId: string; actions: ActionMeta[]; resources: ResourceMeta[] }) {
  const [subjects, setSubjects] = useState<Record<string, unknown>[]>([]);
  const [subjectId, setSubjectId] = useState('');
  const [actionId, setActionId] = useState('');
  const [resourceId, setResourceId] = useState('');
  const [result, setResult] = useState<{ allowed: boolean; detail?: string } | null>(null);
  const [reasoning, setReasoning] = useState<{ roles: string[]; matches: PermRow[] } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.subjects().then(setSubjects).catch(() => {});
    // default subject = first subject holding this role
    api.subjects().then(all => {
      const match = all.find(s => Array.isArray(s.roles) && (s.roles as string[]).includes(roleId));
      if (match) setSubjectId(String(match.subject_id));
    }).catch(() => {});
  }, [roleId]);

  const selectedSubject = useMemo(() => subjects.find(s => String(s.subject_id) === subjectId), [subjects, subjectId]);
  const subjectGroups = useMemo(() => {
    if (!selectedSubject) return [] as string[];
    const g = selectedSubject.groups;
    return Array.isArray(g) ? (g as string[]) : [];
  }, [selectedSubject]);

  const run = async () => {
    if (!subjectId || !actionId || !resourceId) return;
    setBusy(true);
    setResult(null); setReasoning(null);
    try {
      const subjUserId = String(selectedSubject?.subject_id || subjectId);
      const res = await api.check(subjUserId, subjectGroups, actionId, resourceId);
      setResult({ allowed: res.allowed });
      // Build reasoning: list matching perms across user's roles
      const subjectRoles = (selectedSubject?.roles as string[] | undefined) ?? [];
      const matches: PermRow[] = [];
      for (const rid of subjectRoles) {
        try {
          const rows = await api.rolePermissions(rid);
          for (const p of rows) {
            if (String(p.action_id) !== actionId) continue;
            if (!prefixCovers(String(p.resource_id), resourceId)) continue;
            matches.push({
              id: Number(p.id), action_id: String(p.action_id), resource_id: String(p.resource_id),
              effect: (p.effect === 'deny' ? 'deny' : 'allow') as Effect,
              resource_name: p.resource_name ? String(p.resource_name) : undefined,
            });
          }
        } catch { /* ignore */ }
      }
      setReasoning({ roles: subjectRoles, matches });
    } catch (e) {
      setResult({ allowed: false, detail: String(e) });
    }
    setBusy(false);
  };

  return (
    <div className="p-4 space-y-4">
      <div className="text-[11px] text-slate-500">
        Simulate <code className="font-mono bg-slate-100 px-1 rounded">authz_check()</code> for a (subject, action, resource) tuple.
        Shows the live decision plus which perm rows would match. 用來 debug「為什麼 403」。
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <div>
          <label className="block text-[10px] font-semibold uppercase text-slate-500 mb-1">Subject</label>
          <Combobox
            value={subjectId}
            onChange={setSubjectId}
            placeholder="挑 subject…"
            options={subjects.map(s => ({
              value: String(s.subject_id),
              label: String(s.subject_id),
              hint: String(s.display_name || ''),
            }))}
          />
          {selectedSubject && (
            <div className="text-[10px] text-slate-400 mt-1 font-mono truncate" title={subjectGroups.join(', ')}>
              roles: {(selectedSubject.roles as string[] | undefined)?.join(', ') || '—'}
            </div>
          )}
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase text-slate-500 mb-1">Action</label>
          <Combobox
            value={actionId}
            onChange={setActionId}
            placeholder="挑 action…"
            options={actions.map(a => ({ value: a.action_id, label: a.action_id, hint: a.display_name }))}
          />
        </div>
        <div>
          <label className="block text-[10px] font-semibold uppercase text-slate-500 mb-1">Resource ID</label>
          <input
            list="sim-resource-options"
            value={resourceId}
            onChange={e => setResourceId(e.target.value)}
            placeholder="挑或輸入 resource_id…"
            className="input text-xs py-1.5 font-mono w-full"
          />
          <datalist id="sim-resource-options">
            {resources.slice(0, 500).map(r => (
              <option key={r.resource_id} value={r.resource_id}>{r.display_name || ''}</option>
            ))}
          </datalist>
        </div>
      </div>

      <div>
        <button
          onClick={run}
          disabled={busy || !subjectId || !actionId || !resourceId}
          className="btn-primary btn-sm gap-1 disabled:opacity-40"
        >
          <FlaskConical size={12} /> {busy ? 'Checking…' : 'Run authz_check'}
        </button>
      </div>

      {result && (
        <div className={`border rounded-lg p-3 ${result.allowed ? 'border-emerald-300 bg-emerald-50' : 'border-red-300 bg-red-50'}`}>
          <div className="flex items-center gap-2 text-sm font-semibold">
            {result.allowed ? <ShieldCheck size={16} className="text-emerald-700" /> : <ShieldAlert size={16} className="text-red-700" />}
            <span className={result.allowed ? 'text-emerald-800' : 'text-red-800'}>
              {result.allowed ? 'ALLOW' : 'DENY'}
            </span>
            <span className="font-mono text-xs text-slate-600">
              {subjectId} × {actionId} × {resourceId}
            </span>
          </div>
          {result.detail && <div className="text-[11px] text-red-700 mt-1 font-mono">{result.detail}</div>}
        </div>
      )}

      {reasoning && (
        <div className="border border-slate-200 rounded-lg bg-white">
          <div className="px-3 py-1.5 border-b border-slate-200 bg-slate-50 text-[11px] font-semibold text-slate-600">
            Decision path
          </div>
          <div className="px-3 py-2 text-xs space-y-1">
            <div><span className="text-slate-500">User roles:</span> <span className="font-mono">{reasoning.roles.join(', ') || '—'}</span></div>
          </div>
          <div className="border-t border-slate-100 px-3 py-2">
            <div className="text-[11px] font-semibold text-slate-600 mb-1.5">Matching perm rows ({reasoning.matches.length})</div>
            {reasoning.matches.length === 0 ? (
              <div className="text-[11px] text-red-700">No allow rule matched — <b>this is why 403</b>.</div>
            ) : (
              <div className="space-y-1">
                {reasoning.matches.map((m, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <span className={`badge text-[10px] ${m.effect === 'allow' ? 'badge-green' : 'badge-red'}`}>{m.effect}</span>
                    <span className="font-mono text-slate-700 flex-1 truncate">{m.resource_id}</span>
                    {m.resource_id !== resourceId && <span className="text-[10px] text-slate-400">(via prefix)</span>}
                  </div>
                ))}
                {reasoning.matches.some(m => m.effect === 'deny') && result?.allowed === false && (
                  <div className="text-[11px] text-red-700 mt-2"><AlertTriangle size={10} className="inline" /> A deny row overrode any allow — check deny source first.</div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// VIEW: COMPARE — diff current role against another role
// ──────────────────────────────────────────────────────────────────────────────
function CompareView({ roleId }: { roleId: string }) {
  const [otherId, setOtherId] = useState('');
  const [allRoles, setAllRoles] = useState<Record<string, unknown>[]>([]);
  const [mine, setMine] = useState<PermRow[]>([]);
  const [theirs, setTheirs] = useState<PermRow[]>([]);

  useEffect(() => { api.roles().then(setAllRoles).catch(() => {}); }, []);
  useEffect(() => {
    api.rolePermissions(roleId).then(rows => setMine(rows.map(p => ({
      id: Number(p.id), action_id: String(p.action_id), resource_id: String(p.resource_id),
      effect: (p.effect === 'deny' ? 'deny' : 'allow') as Effect,
    })))).catch(() => {});
  }, [roleId]);
  useEffect(() => {
    if (!otherId) { setTheirs([]); return; }
    api.rolePermissions(otherId).then(rows => setTheirs(rows.map(p => ({
      id: Number(p.id), action_id: String(p.action_id), resource_id: String(p.resource_id),
      effect: (p.effect === 'deny' ? 'deny' : 'allow') as Effect,
    })))).catch(() => {});
  }, [otherId]);

  const diff = useMemo(() => {
    const key = (r: PermRow) => `${r.action_id}|${r.resource_id}|${r.effect}`;
    const mySet = new Set(mine.map(key));
    const theirSet = new Set(theirs.map(key));
    const onlyMine = mine.filter(r => !theirSet.has(key(r)));
    const onlyTheirs = theirs.filter(r => !mySet.has(key(r)));
    const both = mine.filter(r => theirSet.has(key(r)));
    return { onlyMine, onlyTheirs, both };
  }, [mine, theirs]);

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-slate-500">Compare <code className="font-mono">{roleId}</code> with:</span>
        <Combobox
          value={otherId}
          onChange={setOtherId}
          placeholder="select role…"
          clearable
          options={allRoles.filter(r => String(r.role_id) !== roleId).map(r => ({
            value: String(r.role_id), label: String(r.role_id), hint: String(r.display_name || ''),
          }))}
        />
      </div>
      {otherId && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <DiffCol title={`Only in ${roleId}`} color="emerald" rows={diff.onlyMine} />
          <DiffCol title="Shared" color="slate" rows={diff.both} />
          <DiffCol title={`Only in ${otherId}`} color="sky" rows={diff.onlyTheirs} />
        </div>
      )}
    </div>
  );
}

function DiffCol({ title, color, rows }: { title: string; color: 'emerald' | 'slate' | 'sky'; rows: PermRow[] }) {
  const palette: Record<string, string> = {
    emerald: 'border-emerald-300 bg-emerald-50/50',
    slate:   'border-slate-300 bg-slate-50/50',
    sky:     'border-sky-300 bg-sky-50/50',
  };
  return (
    <div className={`border rounded-lg ${palette[color]} overflow-hidden`}>
      <div className="px-3 py-1.5 border-b bg-white/60 text-[11px] font-semibold text-slate-700 flex items-center justify-between">
        {title} <span className="text-slate-400">{rows.length}</span>
      </div>
      <div className="max-h-96 overflow-y-auto divide-y divide-slate-100">
        {rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-[11px] text-slate-400">—</div>
        ) : rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-xs">
            <span className={`badge text-[9px] ${r.effect === 'allow' ? 'badge-green' : 'badge-red'}`}>{r.effect}</span>
            <span className="badge badge-slate text-[9px]">{r.action_id}</span>
            <span className="font-mono text-slate-600 flex-1 truncate" title={r.resource_id}>{r.resource_id}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// VIEW: AUDIT — recent admin audit log entries touching this role
// ──────────────────────────────────────────────────────────────────────────────
function AuditView({ roleId }: { roleId: string }) {
  const [logs, setLogs] = useState<Record<string, unknown>[] | null>(null);

  useEffect(() => {
    api.adminAuditLogs({ resource_type: 'role', limit: 100 })
      .then(all => setLogs(all.filter(l => !l.resource_id || String(l.resource_id) === roleId || String(l.resource_id).startsWith(`${roleId}/`))))
      .catch(() => setLogs([]));
  }, [roleId]);

  if (logs === null) return <div className="p-4 text-xs text-slate-400">Loading audit trail…</div>;
  if (logs.length === 0) return (
    <div className="p-8 text-center text-slate-400">
      <History size={24} className="mx-auto mb-2 text-slate-300" />
      <p className="text-xs">No audit log entries for this role yet.</p>
    </div>
  );

  return (
    <div className="p-4 space-y-2">
      <div className="text-[11px] text-slate-500">{logs.length} event(s)</div>
      <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 bg-white">
        {logs.map((l, i) => (
          <div key={i} className="px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="badge badge-slate text-[9px]">{String(l.action || 'op')}</span>
              <span className="font-mono text-slate-700">{String(l.user_id || l.actor || '—')}</span>
              <span className="text-slate-400 ml-auto text-[10px]">{String(l.created_at || l.timestamp || '')}</span>
            </div>
            {!!l.resource_id && <div className="font-mono text-[11px] text-slate-500 mt-0.5">{String(l.resource_id)}</div>}
            {!!l.details && <pre className="mt-1 text-[10px] text-slate-500 font-mono whitespace-pre-wrap">{typeof l.details === 'string' ? l.details : JSON.stringify(l.details, null, 2)}</pre>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// MODALS
// ──────────────────────────────────────────────────────────────────────────────
function ApplyConfirmModal({ pending, applying, onCancel, onConfirm }: {
  pending: Map<string, PendingOp>;
  applying: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ops = Array.from(pending.values());
  const creates = ops.filter(o => o.kind === 'create') as Extract<PendingOp, { kind: 'create' }>[];
  const deletes = ops.filter(o => o.kind === 'delete') as Extract<PendingOp, { kind: 'delete' }>[];
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b border-amber-200 bg-amber-50 rounded-t-xl flex gap-3">
          <AlertTriangle size={20} className="text-amber-700 shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-bold text-slate-900">Apply {ops.length} permission change{ops.length === 1 ? '' : 's'}?</h3>
            <p className="text-xs text-slate-700 mt-1">
              <span className="text-emerald-700">+{creates.length} grant{creates.length === 1 ? '' : 's'}</span>
              <span className="mx-2 text-slate-400">·</span>
              <span className="text-red-700">−{deletes.length} revoke{deletes.length === 1 ? '' : 's'}</span>
            </p>
          </div>
        </div>
        <div className="p-4 overflow-auto flex-1 space-y-2">
          {creates.map((op, i) => (
            <div key={`c${i}`} className="border border-emerald-200 bg-emerald-50/30 rounded p-2 text-xs flex items-center gap-2">
              <span className="badge badge-green text-[9px]">GRANT</span>
              <span className="font-mono font-bold">{op.action_id}</span>
              <span className="text-slate-400">×</span>
              <span className="font-mono text-slate-700 flex-1 truncate">{op.resource_id}</span>
              <span className={`badge text-[9px] ${op.effect === 'allow' ? 'badge-green' : 'badge-red'}`}>{op.effect}</span>
            </div>
          ))}
          {deletes.map((op, i) => (
            <div key={`d${i}`} className="border border-red-200 bg-red-50/30 rounded p-2 text-xs flex items-center gap-2">
              <span className="badge badge-red text-[9px]">REVOKE</span>
              <span className="font-mono font-bold">{op.snapshot.action_id}</span>
              <span className="text-slate-400">×</span>
              <span className="font-mono text-slate-700 flex-1 truncate">{op.snapshot.resource_id}</span>
              <span className={`badge text-[9px] ${op.snapshot.effect === 'allow' ? 'badge-green' : 'badge-red'}`}>{op.snapshot.effect}</span>
            </div>
          ))}
        </div>
        <div className="p-3 border-t border-slate-200 flex gap-2 justify-end">
          <button onClick={onCancel} disabled={applying} className="btn-secondary btn-sm">Cancel</button>
          <button onClick={onConfirm} disabled={applying} className="btn-primary btn-sm gap-1">
            <Check size={12} /> {applying ? 'Applying…' : `Apply ${ops.length}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function SqlPreviewModal({ roleId, pending, onClose }: {
  roleId: string;
  pending: Map<string, PendingOp>;
  onClose: () => void;
}) {
  const sql = useMemo(() => buildSql(roleId, pending), [roleId, pending]);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(sql).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b border-slate-200 flex items-center gap-3">
          <FileCode size={18} className="text-blue-600" />
          <div className="flex-1">
            <h3 className="font-semibold text-slate-900 text-sm">Migration SQL preview</h3>
            <p className="text-[11px] text-slate-500">把這段存成 <code className="font-mono">database/migrations/Vxxx__role_{roleId}_perms.sql</code></p>
          </div>
          <button onClick={copy} className="btn-secondary btn-sm gap-1"><Copy size={12} /> {copied ? 'Copied!' : 'Copy'}</button>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={16} /></button>
        </div>
        <pre className="flex-1 overflow-auto p-4 bg-slate-900 text-emerald-300 text-xs font-mono whitespace-pre-wrap">{sql}</pre>
      </div>
    </div>
  );
}

function sqlEscape(s: string): string { return s.replace(/'/g, "''"); }

function buildSql(roleId: string, pending: Map<string, PendingOp>): string {
  const today = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    `-- Generated by Govern → Roles → ${roleId} → Permissions on ${today}`,
    `BEGIN;`,
    ``,
  ];
  const ops = Array.from(pending.values());
  const creates = ops.filter(o => o.kind === 'create') as Extract<PendingOp, { kind: 'create' }>[];
  const deletes = ops.filter(o => o.kind === 'delete') as Extract<PendingOp, { kind: 'delete' }>[];
  if (creates.length) {
    lines.push(`-- ${creates.length} grant(s)`);
    lines.push(`INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect) VALUES`);
    creates.forEach((op, i) => {
      const sep = i === creates.length - 1 ? '' : ',';
      lines.push(`    ('${sqlEscape(roleId)}', '${sqlEscape(op.action_id)}', '${sqlEscape(op.resource_id)}', '${op.effect}')${sep}`);
    });
    lines.push(`ON CONFLICT DO NOTHING;`);
    lines.push(``);
  }
  if (deletes.length) {
    lines.push(`-- ${deletes.length} revoke(s)`);
    for (const op of deletes) {
      lines.push(`DELETE FROM authz_role_permission WHERE id = ${op.perm_id};  -- ${op.snapshot.action_id} × ${op.snapshot.resource_id}`);
    }
    lines.push(``);
  }
  if (!creates.length && !deletes.length) lines.push(`-- (no pending changes)`);
  lines.push(`COMMIT;`);
  return lines.join('\n');
}
