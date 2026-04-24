import { useState, useEffect, useMemo, useCallback, Fragment } from 'react';
import { api } from '../../api';
import { useSearch } from '../../hooks/useSearch';
import { useSort } from '../../hooks/useSort';
import { useToast } from '../Toast';
import { SortableHeader } from '../SortableHeader';
import { autoId, uniqueId } from '../../utils/slugify';
import {
  Plus, Pencil, Trash2, X, Check, Search, Copy,
  ChevronDown, ChevronRight, KeyRound, HelpCircle,
  AlertTriangle, FileCode, Undo2, Sparkles,
  UserCircle, ArrowDown, LayoutDashboard, Globe, Database, Shield, Box,
  Eye, PencilLine, CheckCircle2, Download, Pause, Play, Zap, Plug,
} from 'lucide-react';

// Icon + tint per action verb class. Falls back to generic Zap for custom ids.
const VERB_META: Record<string, { icon: React.ReactNode; tint: string }> = {
  read:    { icon: <Eye size={12} />,          tint: 'text-sky-600' },
  write:   { icon: <PencilLine size={12} />,   tint: 'text-amber-600' },
  delete:  { icon: <Trash2 size={12} />,       tint: 'text-red-600' },
  approve: { icon: <CheckCircle2 size={12} />, tint: 'text-emerald-600' },
  export:  { icon: <Download size={12} />,     tint: 'text-violet-600' },
  hold:    { icon: <Pause size={12} />,        tint: 'text-orange-600' },
  release: { icon: <Play size={12} />,         tint: 'text-teal-600' },
  execute: { icon: <Zap size={12} />,          tint: 'text-yellow-600' },
  connect: { icon: <Plug size={12} />,         tint: 'text-indigo-600' },
};
const verbMeta = (aid: string) => VERB_META[aid] ?? { icon: <Zap size={12} />, tint: 'text-slate-400' };

type ActionRow = {
  action_id: string;
  display_name: string;
  description: string;
  paths: Set<string>;
  is_active: boolean;
};

type PendingOp =
  | { kind: 'create'; row: ActionRow }
  | { kind: 'update'; aid: string; row: ActionRow }
  | { kind: 'delete'; aid: string };

type RowStatus = 'clean' | 'new' | 'modified' | 'deleted';

const ALL_PATHS = ['A', 'B', 'C'] as const;
const PATH_LABEL: Record<string, string> = {
  A: 'Config-SM UI',
  B: 'Web API',
  C: 'Direct DB',
};

const toRow = (a: Record<string, unknown>): ActionRow => ({
  action_id: String(a.action_id),
  display_name: String(a.display_name || ''),
  description: String(a.description || ''),
  paths: new Set<string>((a.applicable_paths as string[]) || []),
  is_active: a.is_active !== false,
});

const rowsEqual = (a: ActionRow, b: ActionRow) =>
  a.display_name === b.display_name &&
  a.description === b.description &&
  a.is_active === b.is_active &&
  a.paths.size === b.paths.size &&
  Array.from(a.paths).every(p => b.paths.has(p));

export function ActionsSection({ data, onReload }: { data: Record<string, unknown>[]; onReload: () => void }) {
  const [pending, setPending] = useState<Map<string, PendingOp>>(new Map());
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState<ActionRow>({ action_id: '', display_name: '', description: '', paths: new Set(['A', 'B', 'C']), is_active: true });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<ActionRow | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showApply, setShowApply] = useState(false);
  const [showSql, setShowSql] = useState(false);
  const [applying, setApplying] = useState(false);
  const { query, setQuery, filtered } = useSearch(data, ['action_id', 'display_name', 'description']);
  const { sorted, sortKey, sortDir, toggleSort } = useSort(filtered, 'action_id');
  const toast = useToast();
  const existingIds = useMemo(() => data.map(d => String(d.action_id)), [data]);
  const pendingNewIds = useMemo(
    () => Array.from(pending.values()).filter(op => op.kind === 'create').map(op => (op as { kind: 'create'; row: ActionRow }).row.action_id),
    [pending]
  );
  const allKnownIds = useMemo(() => [...existingIds, ...pendingNewIds], [existingIds, pendingNewIds]);
  const suggestedAddId = uniqueId(autoId.action(addForm.display_name), allKnownIds);

  const baseMap = useMemo(() => {
    const m = new Map<string, ActionRow>();
    for (const a of data) m.set(String(a.action_id), toRow(a));
    return m;
  }, [data]);

  const effectiveOf = useCallback((aid: string): { row: ActionRow; status: RowStatus; original?: ActionRow } => {
    const original = baseMap.get(aid);
    const op = pending.get(aid);
    if (!op && original) return { row: original, status: 'clean' };
    if (op?.kind === 'delete' && original) return { row: original, status: 'deleted', original };
    if (op?.kind === 'update' && original) return { row: op.row, status: 'modified', original };
    if (op?.kind === 'create') return { row: op.row, status: 'new' };
    return { row: original ?? toRow({ action_id: aid }), status: 'clean' };
  }, [baseMap, pending]);

  const visibleRows = useMemo(() => {
    const rows: { row: ActionRow; status: RowStatus; original?: ActionRow }[] = [];
    for (const op of pending.values()) {
      if (op.kind === 'create') rows.push({ row: op.row, status: 'new' });
    }
    for (const a of sorted) {
      const r = effectiveOf(String(a.action_id));
      rows.push(r);
    }
    return rows;
  }, [sorted, pending, effectiveOf]);

  const counts = useMemo(() => {
    let c = 0, u = 0, d = 0;
    for (const op of pending.values()) {
      if (op.kind === 'create') c++;
      else if (op.kind === 'update') u++;
      else if (op.kind === 'delete') d++;
    }
    return { create: c, update: u, delete: d, total: c + u + d };
  }, [pending]);

  const stageUpdate = (aid: string, mutate: (r: ActionRow) => ActionRow) => {
    setPending(prev => {
      const next = new Map(prev);
      const op = next.get(aid);
      if (op?.kind === 'create') {
        next.set(aid, { kind: 'create', row: mutate(op.row) });
        return next;
      }
      if (op?.kind === 'delete') return prev;
      const base = op?.kind === 'update' ? op.row : baseMap.get(aid);
      if (!base) return prev;
      const updated = mutate(base);
      const original = baseMap.get(aid);
      if (original && rowsEqual(updated, original)) {
        next.delete(aid);
      } else {
        next.set(aid, { kind: 'update', aid, row: updated });
      }
      return next;
    });
  };

  const startEdit = (aid: string) => {
    const eff = effectiveOf(aid);
    setEditingId(aid);
    setEditDraft({ ...eff.row, paths: new Set(eff.row.paths) });
    setExpandedId(null);
  };

  const cancelEdit = () => { setEditingId(null); setEditDraft(null); };

  const commitEdit = (aid: string) => {
    if (!editDraft) return;
    stageUpdate(aid, () => ({ ...editDraft, action_id: aid, paths: new Set(editDraft.paths) }));
    cancelEdit();
  };

  const stageDelete = (aid: string) => {
    setPending(prev => {
      const next = new Map(prev);
      const op = next.get(aid);
      if (op?.kind === 'create') {
        next.delete(aid);
      } else {
        next.set(aid, { kind: 'delete', aid });
      }
      return next;
    });
  };

  const undoRow = (aid: string) => {
    setPending(prev => {
      const next = new Map(prev);
      next.delete(aid);
      return next;
    });
    if (editingId === aid) cancelEdit();
  };

  const stageCreate = () => {
    if (!addForm.action_id || !addForm.display_name) { toast.error('Action ID 和 Display Name 必填'); return; }
    if (allKnownIds.includes(addForm.action_id)) { toast.error(`Action "${addForm.action_id}" 已存在或重複`); return; }
    setPending(prev => {
      const next = new Map(prev);
      next.set(addForm.action_id, { kind: 'create', row: { ...addForm, paths: new Set(addForm.paths) } });
      return next;
    });
    setShowAdd(false);
    setAddForm({ action_id: '', display_name: '', description: '', paths: new Set(['A', 'B', 'C']), is_active: true });
  };

  const cloneAsCreate = (a: Record<string, unknown>) => {
    const newId = uniqueId(String(a.action_id) + '_copy', allKnownIds);
    setShowAdd(true);
    setAddForm({
      action_id: newId,
      display_name: String(a.display_name) + ' (copy)',
      description: String(a.description || ''),
      paths: new Set<string>((a.applicable_paths as string[]) || ['A', 'B', 'C']),
      is_active: true,
    });
  };

  const toggleAddPath = (p: string) => {
    setAddForm(f => {
      const next = new Set(f.paths);
      if (next.has(p)) next.delete(p); else next.add(p);
      return { ...f, paths: next };
    });
  };

  const discardAll = () => {
    setPending(new Map());
    cancelEdit();
    setShowAdd(false);
    toast.info('All pending changes discarded');
  };

  const applyAll = async () => {
    setApplying(true);
    let ok = 0, fail = 0;
    const errors: string[] = [];
    const ops = Array.from(pending.values());
    const orderedOps = [
      ...ops.filter(o => o.kind === 'create'),
      ...ops.filter(o => o.kind === 'update'),
      ...ops.filter(o => o.kind === 'delete'),
    ];
    const failedKeys: string[] = [];
    for (const op of orderedOps) {
      try {
        if (op.kind === 'create') {
          await api.actionCreate({
            action_id: op.row.action_id,
            display_name: op.row.display_name,
            description: op.row.description,
            applicable_paths: Array.from(op.row.paths).sort(),
          });
          ok++;
        } else if (op.kind === 'update') {
          await api.actionUpdate(op.aid, {
            display_name: op.row.display_name,
            description: op.row.description,
            applicable_paths: Array.from(op.row.paths).sort(),
          });
          ok++;
        } else {
          await api.actionDelete(op.aid);
          ok++;
        }
      } catch (e) {
        fail++;
        const key = op.kind === 'create' ? op.row.action_id : op.aid;
        failedKeys.push(key);
        errors.push(`${op.kind} ${key}: ${String(e)}`);
      }
    }
    if (ok) toast.success(`Applied ${ok} change${ok === 1 ? '' : 's'}${fail ? ` (${fail} failed)` : ''}`);
    if (fail) {
      toast.error(`${fail} change${fail === 1 ? '' : 's'} failed — keeping in draft`);
      // eslint-disable-next-line no-console
      console.error('Apply failures:', errors);
    }
    setPending(prev => {
      const next = new Map(prev);
      for (const op of orderedOps) {
        const key = op.kind === 'create' ? op.row.action_id : op.aid;
        if (!failedKeys.includes(key)) next.delete(key);
      }
      return next;
    });
    setShowApply(false);
    setApplying(false);
    onReload();
  };

  return (
    <div className="flex flex-col">
      <div className="card-header">
        <div className="flex items-center gap-3 flex-1">
          <span className="text-sm font-semibold">Actions ({filtered.length}/{data.length})</span>
          <div className="relative flex-1 max-w-xs">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search..." className="input pl-8 py-1.5 text-xs" />
          </div>
          <button onClick={() => setShowHelp(s => !s)} className="text-slate-400 hover:text-blue-600 flex items-center gap-1 text-[11px]" title="Path A/B/C 是什麼？">
            <HelpCircle size={12} /> {showHelp ? 'Hide' : 'About paths'}
          </button>
        </div>
        <button
          onClick={() => { setShowAdd(true); setAddForm({ action_id: '', display_name: '', description: '', paths: new Set(['A', 'B', 'C']), is_active: true }); }}
          className="btn-primary btn-sm"><Plus size={12} /> Add</button>
      </div>

      {showHelp && <PathDiagram />}

      <div className="overflow-auto">
        <table className="table">
          <thead className="sticky top-0 bg-white z-10"><tr>
            <th className="w-6"></th>
            <th className="w-20">Status</th>
            <SortableHeader label="Action ID" sortKey="action_id" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
            <SortableHeader label="Display Name" sortKey="display_name" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
            <th>Description</th>
            <th className="w-28">Paths</th>
            <th className="w-20 text-center">Used by</th>
            <th className="w-28">Actions</th>
          </tr></thead>
          <tbody>
            {showAdd && (
              <tr className="bg-emerald-50/40">
                <td></td>
                <td><span className="badge badge-green text-[9px]">draft</span></td>
                <td>
                  <input
                    value={addForm.action_id}
                    onChange={e => setAddForm(f => ({ ...f, action_id: e.target.value }))}
                    className="input font-mono text-xs py-1"
                    placeholder="new_action"
                  />
                  {addForm.action_id === suggestedAddId && addForm.action_id !== '' && (
                    <span className="text-emerald-500 text-[9px] ml-1">(auto)</span>
                  )}
                </td>
                <td>
                  <input
                    value={addForm.display_name}
                    onChange={e => {
                      const newName = e.target.value;
                      setAddForm(f => {
                        const oldSuggested = uniqueId(autoId.action(f.display_name), allKnownIds);
                        const updated = { ...f, display_name: newName };
                        if (f.action_id === '' || f.action_id === oldSuggested) {
                          updated.action_id = uniqueId(autoId.action(newName), allKnownIds);
                        }
                        return updated;
                      });
                    }}
                    className="input text-xs py-1"
                    placeholder="Display name"
                  />
                </td>
                <td>
                  <input
                    value={addForm.description}
                    onChange={e => setAddForm(f => ({ ...f, description: e.target.value }))}
                    className="input text-xs py-1"
                    placeholder="What does this action do?"
                  />
                </td>
                <td>
                  <PathToggles selected={addForm.paths} onToggle={toggleAddPath} />
                </td>
                <td className="text-center text-slate-300 text-xs">—</td>
                <td>
                  <div className="flex gap-1">
                    <button onClick={stageCreate} className="btn-primary btn-sm p-1" title="Stage creation"><Check size={12} /></button>
                    <button onClick={() => setShowAdd(false)} className="btn-secondary btn-sm p-1" title="Cancel"><X size={12} /></button>
                  </div>
                </td>
              </tr>
            )}

            {visibleRows.map(({ row, status, original }) => {
              const aid = row.action_id;
              const isEditing = editingId === aid;
              const isExpanded = expandedId === aid;
              const isDeleted = status === 'deleted';
              const draft = isEditing && editDraft ? editDraft : row;
              const desc = draft.description;
              const rowKey = status === 'new' ? `NEW:${aid}` : aid;
              const paths = isEditing && editDraft ? editDraft.paths : draft.paths;

              return (
                <Fragment key={rowKey}>
                  <tr className={
                    isDeleted ? 'bg-red-50/60 line-through text-slate-400'
                    : status === 'new' ? 'bg-emerald-50/40'
                    : status === 'modified' ? 'bg-amber-50/40'
                    : isEditing ? 'bg-amber-50/40'
                    : isExpanded ? 'bg-slate-50'
                    : 'hover:bg-slate-50'
                  }>
                    <td>
                      <button
                        onClick={() => setExpandedId(isExpanded ? null : aid)}
                        className="text-slate-400 hover:text-slate-700 p-1"
                        title={isExpanded ? 'Collapse' : 'Show roles using this action'}
                      >
                        {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      </button>
                    </td>
                    <td>
                      <StatusBadge status={status} original={original} current={draft} />
                    </td>
                    <td className="font-mono text-xs font-bold text-slate-900">{aid}</td>
                    <td className="text-slate-700">
                      {isEditing && editDraft && !isDeleted ? (
                        <input value={editDraft.display_name} onChange={e => setEditDraft(s => s ? { ...s, display_name: e.target.value } : s)}
                          className="input text-xs py-1" />
                      ) : (
                        <span className="inline-flex items-center gap-1.5" title={original && original.display_name !== draft.display_name ? `was: ${original.display_name}` : undefined}>
                          <span className={verbMeta(aid).tint}>{verbMeta(aid).icon}</span>
                          {draft.display_name}
                        </span>
                      )}
                    </td>
                    <td className="text-slate-500 text-xs max-w-[320px]">
                      {isEditing && editDraft && !isDeleted ? (
                        <input value={editDraft.description} onChange={e => setEditDraft(s => s ? { ...s, description: e.target.value } : s)}
                          className="input text-xs py-1" />
                      ) : (
                        <div className="truncate" title={original && original.description !== draft.description ? `was: ${original.description || '(empty)'}` : (desc || 'No description')}>
                          {desc || <span className="text-slate-300">—</span>}
                        </div>
                      )}
                    </td>
                    <td>
                      {isDeleted ? (
                        <PathsDisplay paths={draft.paths} dim />
                      ) : isEditing ? (
                        <PathToggles
                          selected={paths}
                          onToggle={(p) => setEditDraft(s => {
                            if (!s) return s;
                            const next = new Set(s.paths);
                            if (next.has(p)) next.delete(p); else next.add(p);
                            return { ...s, paths: next };
                          })}
                        />
                      ) : (
                        <PathsDisplay
                          paths={paths}
                          onTogglePath={(p) => stageUpdate(aid, r => {
                            const next = new Set(r.paths);
                            if (next.has(p)) next.delete(p); else next.add(p);
                            return { ...r, paths: next };
                          })}
                        />
                      )}
                    </td>
                    <td className="text-center">
                      <UsedByBadge actionId={aid} expanded={isExpanded} onClick={() => setExpandedId(isExpanded ? null : aid)} dimmed={status === 'new'} />
                    </td>
                    <td>
                      <div className="flex gap-1">
                        {isDeleted ? (
                          <button onClick={() => undoRow(aid)} className="btn-secondary btn-sm p-1 text-amber-700" title="Undo delete"><Undo2 size={12} /></button>
                        ) : isEditing ? (
                          <>
                            <button onClick={() => commitEdit(aid)} className="btn-primary btn-sm p-1" title="Stage edit"><Check size={12} /></button>
                            <button onClick={cancelEdit} className="btn-secondary btn-sm p-1" title="Cancel edit"><X size={12} /></button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => startEdit(aid)} className="btn-secondary btn-sm p-1" title="Edit"><Pencil size={12} /></button>
                            {status !== 'new' && (
                              <button onClick={() => cloneAsCreate({ action_id: aid, display_name: draft.display_name, description: draft.description, applicable_paths: Array.from(draft.paths) })}
                                className="btn-secondary btn-sm p-1" title="Clone"><Copy size={12} /></button>
                            )}
                            <button onClick={() => stageDelete(aid)} className="btn-secondary btn-sm p-1 text-red-500" title={status === 'new' ? 'Remove from draft' : 'Stage delete'}>
                              <Trash2 size={12} />
                            </button>
                            {status !== 'clean' && (
                              <button onClick={() => undoRow(aid)} className="btn-secondary btn-sm p-1 text-slate-600" title="Undo this row's draft"><Undo2 size={12} /></button>
                            )}
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="bg-slate-50">
                      <td></td>
                      <td colSpan={7} className="py-2">
                        <UsedByExpanded actionId={aid} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {visibleRows.length === 0 && !showAdd && (
              <tr><td colSpan={8} className="text-center text-slate-400 py-8 text-sm">No actions match.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {counts.total > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-40 bg-white border border-amber-300 shadow-2xl rounded-xl px-4 py-2.5 flex items-center gap-3 max-w-[92vw]">
          <AlertTriangle size={16} className="text-amber-600 shrink-0" />
          <div className="text-xs text-slate-800 flex items-center gap-2">
            <b>{counts.total} change{counts.total === 1 ? '' : 's'} pending</b>
            <span className="text-slate-300">·</span>
            {counts.create > 0 && <span className="text-emerald-700">+{counts.create}</span>}
            {counts.update > 0 && <span className="text-amber-700">~{counts.update}</span>}
            {counts.delete > 0 && <span className="text-red-700">−{counts.delete}</span>}
            <span className="text-slate-400 hidden sm:inline">尚未寫入 DB</span>
          </div>
          <div className="h-5 w-px bg-slate-200 mx-1" />
          <button onClick={() => setShowSql(true)} className="btn-secondary btn-sm gap-1" title="Generate migration SQL for these changes">
            <FileCode size={12} /> SQL
          </button>
          <button onClick={discardAll} className="btn-secondary btn-sm gap-1 text-slate-700">
            <X size={12} /> Discard
          </button>
          <button onClick={() => setShowApply(true)} className="btn-primary btn-sm gap-1">
            <Check size={12} /> Apply ({counts.total})
          </button>
        </div>
      )}

      {showApply && (
        <ApplyConfirmModal
          counts={counts}
          pending={pending}
          baseMap={baseMap}
          applying={applying}
          onCancel={() => setShowApply(false)}
          onConfirm={applyAll}
        />
      )}

      {showSql && (
        <SqlPreviewModal pending={pending} baseMap={baseMap} onClose={() => setShowSql(false)} />
      )}
    </div>
  );
}

function PathDiagram() {
  return (
    <div className="px-4 py-4 border-b border-slate-200 bg-gradient-to-b from-blue-50/40 to-white">
      <div className="flex flex-col items-center gap-2 max-w-3xl mx-auto">
        <NodeBox icon={<UserCircle size={13} className="text-blue-500" />} text="Subject — User / Service Account / BI tool" />
        <SplitArrows count={3} />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 w-full">
          <PathCard
            letter="A"
            title="Config-SM UI"
            icon={<LayoutDashboard size={13} />}
            color="blue"
            who="Metadata-driven 配置畫面"
            examples={['Tier 2/3 Wizard', 'Path A 動作頁', 'AI 側欄']}
          />
          <PathCard
            letter="B"
            title="Web API"
            icon={<Globe size={13} />}
            color="violet"
            who="傳統 Web 頁面 / REST"
            examples={['表單頁面', '/api/* 路由', 'Postman 呼叫']}
          />
          <PathCard
            letter="C"
            title="Direct DB"
            icon={<Database size={13} />}
            color="emerald"
            who="直連 Postgres 跑 SQL"
            examples={['Metabase / Tableau', 'psql / DBeaver', 'Python notebook']}
          />
        </div>
        <SplitArrows count={3} reverse />
        <NodeBox
          icon={<Shield size={13} />}
          text="authz_resolve() — 統一 RBAC + ABAC + RLS 判定"
          accent
        />
        <ArrowDown size={12} className="text-slate-400" />
        <NodeBox icon={<Box size={13} className="text-slate-500" />} text="Resource — table / column / page / api endpoint" />
      </div>
      <div className="mt-3 text-[11px] text-slate-600 text-center max-w-2xl mx-auto leading-relaxed">
        勾選 path = 「這個 action 在那條 path 上**有意義**」（純宣告，UI 提示用）。<br />
        實際允/拒由 <b>Roles → Permissions</b> 的 <code className="font-mono bg-slate-100 px-1 rounded">effect</code>（allow/deny）跟 <b>Policies</b> 條件決定。
      </div>
    </div>
  );
}

function NodeBox({ icon, text, accent }: { icon: React.ReactNode; text: string; accent?: boolean }) {
  return (
    <div className={`rounded-lg px-3 py-1.5 text-xs font-medium shadow-sm flex items-center gap-2 ${
      accent ? 'bg-blue-600 text-white border border-blue-700' : 'bg-white text-slate-700 border border-slate-300'
    }`}>
      {icon} {text}
    </div>
  );
}

function SplitArrows({ count, reverse }: { count: number; reverse?: boolean }) {
  return (
    <div className="flex justify-around w-full max-w-md">
      {Array.from({ length: count }).map((_, i) => (
        <ArrowDown key={i} size={12} className={`text-slate-400 ${reverse ? 'rotate-0' : ''}`} />
      ))}
    </div>
  );
}

function PathCard({ letter, title, icon, color, who, examples }: {
  letter: string;
  title: string;
  icon: React.ReactNode;
  color: 'blue' | 'violet' | 'emerald';
  who: string;
  examples: string[];
}) {
  const palette: Record<string, { border: string; badge: string; tint: string }> = {
    blue:    { border: 'border-blue-300',    badge: 'bg-blue-600',    tint: 'bg-blue-50/40' },
    violet:  { border: 'border-violet-300',  badge: 'bg-violet-600',  tint: 'bg-violet-50/40' },
    emerald: { border: 'border-emerald-300', badge: 'bg-emerald-600', tint: 'bg-emerald-50/40' },
  };
  const c = palette[color];
  return (
    <div className={`border-2 ${c.border} ${c.tint} rounded-lg p-2.5`}>
      <div className="flex items-center gap-2 mb-1.5">
        <div className={`w-6 h-6 ${c.badge} text-white font-bold rounded flex items-center justify-center text-xs shrink-0`}>
          {letter}
        </div>
        <div className="text-xs font-bold text-slate-800 flex items-center gap-1 truncate">{icon} {title}</div>
      </div>
      <div className="text-[11px] text-slate-700 mb-1">{who}</div>
      <ul className="text-[10px] text-slate-500 space-y-0.5">
        {examples.map((e, i) => <li key={i}>· {e}</li>)}
      </ul>
    </div>
  );
}

function StatusBadge({ status, original, current }: { status: RowStatus; original?: ActionRow; current: ActionRow }) {
  if (status === 'clean') return <span className="text-[10px] text-slate-300">—</span>;
  if (status === 'new') return <span className="badge badge-green text-[9px]">+ new</span>;
  if (status === 'deleted') return <span className="badge badge-red text-[9px]">− delete</span>;
  // modified — show diff hint
  const changes: string[] = [];
  if (original) {
    if (original.display_name !== current.display_name) changes.push('name');
    if (original.description !== current.description) changes.push('desc');
    const op = Array.from(original.paths).sort().join(',');
    const np = Array.from(current.paths).sort().join(',');
    if (op !== np) changes.push(`paths: ${op || '∅'} → ${np || '∅'}`);
  }
  return (
    <span className="badge badge-amber text-[9px]" title={changes.join('; ')}>
      ~ modify
    </span>
  );
}

// Compact display for non-edit rows.
//   - All 3 paths: single "All A·B·C" chip, NON-interactive (avoid accidental wipe).
//   - Subset: render all 3 slots with ON filled + OFF ghost; clicking toggles inline
//     via onTogglePath (stageUpdate). WYSIWYG signals "this is editable without Edit mode".
//   - `dim` (used on deleted rows): no interaction, muted styling.
function PathsDisplay({ paths, dim, onTogglePath }: {
  paths: Set<string>;
  dim?: boolean;
  onTogglePath?: (p: string) => void;
}) {
  const isAll = paths.size === ALL_PATHS.length;
  if (paths.size === 0 && !onTogglePath) {
    return <span className="text-[10px] text-slate-300">—</span>;
  }
  if (isAll) {
    return (
      <span
        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold ${
          dim ? 'border-slate-200 bg-slate-50 text-slate-400' : 'border-sky-200 bg-sky-50 text-sky-700'
        }`}
        title="This action applies on all three paths — click Edit to narrow scope"
      >
        All <span className="font-mono text-[9px] opacity-70">A·B·C</span>
      </span>
    );
  }
  const interactive = !!onTogglePath && !dim;
  return (
    <div className={`flex gap-1 ${dim ? 'opacity-50' : ''}`}>
      {ALL_PATHS.map(p => {
        const on = paths.has(p);
        if (!interactive && !on) return null; // read-only mode hides OFF pills
        const base = 'inline-flex w-6 h-5 items-center justify-center text-[10px] font-bold rounded border transition';
        const cls = on
          ? 'bg-slate-100 text-slate-700 border-slate-200'
          : 'bg-white text-slate-300 border-dashed border-slate-300';
        const hover = interactive ? (on ? ' hover:border-red-300 hover:text-red-600' : ' hover:border-blue-400 hover:text-blue-600') : '';
        if (!interactive) {
          return (
            <span key={p} title={`Applies on ${PATH_LABEL[p]}`} className={`${base} ${cls}`}>
              {p}
            </span>
          );
        }
        return (
          <button
            key={p}
            type="button"
            onClick={() => onTogglePath!(p)}
            title={on ? `On: ${PATH_LABEL[p]} — click to remove` : `Off: ${PATH_LABEL[p]} — click to add`}
            className={`${base} ${cls}${hover} cursor-pointer`}
          >
            {p}
          </button>
        );
      })}
    </div>
  );
}

function PathToggles({ selected, onToggle, disabled }: { selected: Set<string>; onToggle: (p: string) => void; disabled?: boolean }) {
  return (
    <div className="flex gap-1">
      {ALL_PATHS.map(p => {
        const on = selected.has(p);
        return (
          <button
            key={p}
            disabled={disabled}
            onClick={() => onToggle(p)}
            title={`${PATH_LABEL[p]} — ${on ? '點擊移除' : '點擊加入'}`}
            className={`w-7 h-6 text-[10px] font-bold rounded border transition ${
              on
                ? 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700'
                : 'bg-white text-slate-400 border-slate-300 hover:border-slate-400 hover:text-slate-600'
            } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            {p}
          </button>
        );
      })}
    </div>
  );
}

function UsedByBadge({ actionId, expanded, onClick, dimmed }: { actionId: string; expanded: boolean; onClick: () => void; dimmed?: boolean }) {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    if (dimmed) { setCount(0); return; }
    let cancelled = false;
    (async () => {
      try {
        const roles = await api.roles();
        const counts = await Promise.all(
          roles.map(r => api.rolePermissions(String(r.role_id)).catch(() => []).then(perms =>
            perms.some(p => String(p.action_id) === actionId) ? 1 : 0
          ))
        );
        if (!cancelled) setCount(counts.reduce<number>((a, b) => a + b, 0));
      } catch { if (!cancelled) setCount(0); }
    })();
    return () => { cancelled = true; };
  }, [actionId, dimmed]);

  if (dimmed) return <span className="text-[10px] text-slate-300">—</span>;

  return (
    <button
      onClick={onClick}
      className={`text-xs font-medium px-2 py-0.5 rounded ${count === 0 ? 'text-slate-400' : 'text-blue-700 hover:bg-blue-50'}`}
      title={count === null ? 'Loading...' : count === 0 ? '尚無 role 使用' : `${count} role 使用 — 點擊展開`}
    >
      {count === null ? '…' : count} {expanded ? '▾' : '▸'}
    </button>
  );
}

function UsedByExpanded({ actionId }: { actionId: string }) {
  const [rows, setRows] = useState<{ role_id: string; role_name: string; perms: { resource_id: string; effect: string }[] }[] | null>(null);

  const load = useCallback(async () => {
    try {
      const roles = await api.roles();
      const result = await Promise.all(
        roles.map(async r => {
          const perms = await api.rolePermissions(String(r.role_id)).catch(() => []);
          const matched = perms
            .filter(p => String(p.action_id) === actionId)
            .map(p => ({ resource_id: String(p.resource_id), effect: String(p.effect) }));
          return { role_id: String(r.role_id), role_name: String(r.display_name || ''), perms: matched };
        })
      );
      setRows(result.filter(r => r.perms.length > 0));
    } catch { setRows([]); }
  }, [actionId]);

  useEffect(() => { load(); }, [load]);

  const goToRole = (rid: string) => {
    window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'access-roles', focus: rid } }));
  };

  if (rows === null) return <div className="text-xs text-slate-400 px-3">Loading…</div>;
  if (rows.length === 0) return (
    <div className="text-xs text-slate-400 px-3 flex items-center gap-2">
      <KeyRound size={12} className="text-slate-300" />
      尚無 role 使用此 action — 到 <b>Roles</b> tab 加 permission 即可串起來
    </div>
  );

  return (
    <div className="px-3 space-y-2">
      <div className="text-[11px] text-slate-500">{rows.length} role(s) 使用此 action</div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {rows.map(r => (
          <div key={r.role_id} className="border border-slate-200 rounded bg-white">
            <button onClick={() => goToRole(r.role_id)}
              className="w-full flex items-center gap-2 px-2 py-1.5 hover:bg-blue-50 text-left rounded-t"
              title={`Open role ${r.role_id}`}>
              <KeyRound size={11} className="text-slate-500" />
              <span className="font-mono text-xs font-bold text-slate-800">{r.role_id}</span>
              <span className="text-[11px] text-slate-500 truncate flex-1">{r.role_name}</span>
              <span className="text-[10px] text-slate-400">({r.perms.length})</span>
            </button>
            <div className="divide-y divide-slate-100 max-h-32 overflow-y-auto">
              {r.perms.map((p, i) => (
                <div key={i} className="flex items-center gap-2 px-2 py-1 text-[11px]">
                  <span className={`badge text-[9px] ${p.effect === 'allow' ? 'badge-green' : 'badge-red'}`}>{p.effect}</span>
                  <span className="font-mono text-slate-600 flex-1 truncate" title={p.resource_id}>{p.resource_id}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ApplyConfirmModal({ counts, pending, baseMap, applying, onCancel, onConfirm }: {
  counts: { create: number; update: number; delete: number; total: number };
  pending: Map<string, PendingOp>;
  baseMap: Map<string, ActionRow>;
  applying: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const ops = Array.from(pending.values());
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onCancel}>
      <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-amber-200 bg-amber-50 rounded-t-xl flex gap-3">
          <AlertTriangle size={22} className="text-amber-700 shrink-0 mt-0.5" />
          <div className="flex-1">
            <h3 className="font-bold text-slate-900">Apply {counts.total} change{counts.total === 1 ? '' : 's'}?</h3>
            <p className="text-xs text-slate-700 mt-1">
              <span className="text-emerald-700">+{counts.create} create</span>
              <span className="mx-2 text-slate-400">·</span>
              <span className="text-amber-700">~{counts.update} modify</span>
              <span className="mx-2 text-slate-400">·</span>
              <span className="text-red-700">−{counts.delete} delete</span>
            </p>
          </div>
        </div>
        <div className="p-5 overflow-auto flex-1 space-y-2">
          {ops.map((op, i) => {
            if (op.kind === 'create') return (
              <div key={i} className="border border-emerald-200 bg-emerald-50/30 rounded p-2 text-xs">
                <div className="flex items-center gap-2"><span className="badge badge-green text-[9px]">CREATE</span><code className="font-mono font-bold">{op.row.action_id}</code></div>
                <div className="text-slate-600 mt-1">{op.row.display_name} — paths: {Array.from(op.row.paths).sort().join(',') || '∅'}</div>
              </div>
            );
            if (op.kind === 'update') {
              const before = baseMap.get(op.aid);
              const beforePaths = before ? Array.from(before.paths).sort().join(',') : '∅';
              const afterPaths = Array.from(op.row.paths).sort().join(',') || '∅';
              return (
                <div key={i} className="border border-amber-200 bg-amber-50/30 rounded p-2 text-xs">
                  <div className="flex items-center gap-2"><span className="badge badge-amber text-[9px]">UPDATE</span><code className="font-mono font-bold">{op.aid}</code></div>
                  {before && before.display_name !== op.row.display_name && (
                    <div className="text-slate-600 mt-1">name: <s>{before.display_name}</s> → <b>{op.row.display_name}</b></div>
                  )}
                  {before && before.description !== op.row.description && (
                    <div className="text-slate-600 mt-1">desc: <s>{before.description || '(empty)'}</s> → <b>{op.row.description || '(empty)'}</b></div>
                  )}
                  {beforePaths !== afterPaths && (
                    <div className="text-slate-600 mt-1">paths: <s>{beforePaths}</s> → <b>{afterPaths}</b></div>
                  )}
                </div>
              );
            }
            return (
              <div key={i} className="border border-red-200 bg-red-50/30 rounded p-2 text-xs">
                <div className="flex items-center gap-2"><span className="badge badge-red text-[9px]">DELETE</span><code className="font-mono font-bold">{op.aid}</code></div>
                <div className="text-slate-600 mt-1">將會 deactivate（is_active = FALSE）</div>
              </div>
            );
          })}
        </div>
        <div className="p-4 border-t border-slate-200 flex gap-2 justify-end">
          <button onClick={onCancel} disabled={applying} className="btn-secondary btn-sm">Cancel</button>
          <button onClick={onConfirm} disabled={applying} className="btn-primary btn-sm gap-1">
            <Check size={12} /> {applying ? 'Applying…' : `Apply ${counts.total}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function SqlPreviewModal({ pending, baseMap, onClose }: {
  pending: Map<string, PendingOp>;
  baseMap: Map<string, ActionRow>;
  onClose: () => void;
}) {
  const sql = useMemo(() => buildSql(pending, baseMap), [pending, baseMap]);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(sql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b border-slate-200 flex items-center gap-3">
          <FileCode size={18} className="text-blue-600" />
          <div className="flex-1">
            <h3 className="font-semibold text-slate-900 text-sm">Migration SQL preview</h3>
            <p className="text-[11px] text-slate-500">把這段存成 <code>database/migrations/Vxxx__add_actions.sql</code> 即可在其他環境同步</p>
          </div>
          <button onClick={copy} className="btn-secondary btn-sm gap-1"><Copy size={12} /> {copied ? 'Copied!' : 'Copy'}</button>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-700"><X size={16} /></button>
        </div>
        <pre className="flex-1 overflow-auto p-4 bg-slate-900 text-emerald-300 text-xs font-mono whitespace-pre-wrap">{sql}</pre>
        <div className="p-3 border-t border-slate-200 bg-amber-50/40 text-[11px] text-amber-900 flex items-start gap-2">
          <Sparkles size={12} className="text-amber-600 mt-0.5 shrink-0" />
          <div>
            <b>提醒</b>：SQL 是 idempotent（用 ON CONFLICT），可重複執行。Vxxx 編號要接續最新的 migration（目前 V050），且 commit 前請依 <code>docs/standards/</code> 中的 migration 規範命名。
          </div>
        </div>
      </div>
    </div>
  );
}

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

function pathArray(paths: Set<string>): string {
  return `ARRAY[${Array.from(paths).sort().map(p => `'${p}'`).join(',')}]::TEXT[]`;
}

function buildSql(pending: Map<string, PendingOp>, baseMap: Map<string, ActionRow>): string {
  const now = new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    `-- Generated by Govern → Actions on ${now}`,
    `-- Run inside a new migration: database/migrations/Vxxx__authz_actions_update.sql`,
    `BEGIN;`,
    ``,
  ];
  const ops = Array.from(pending.values());
  const creates = ops.filter(o => o.kind === 'create') as Extract<PendingOp, { kind: 'create' }>[];
  const updates = ops.filter(o => o.kind === 'update') as Extract<PendingOp, { kind: 'update' }>[];
  const deletes = ops.filter(o => o.kind === 'delete') as Extract<PendingOp, { kind: 'delete' }>[];

  if (creates.length > 0) {
    lines.push(`-- ${creates.length} new action(s)`);
    lines.push(`INSERT INTO authz_action (action_id, display_name, description, applicable_paths) VALUES`);
    creates.forEach((op, i) => {
      const r = op.row;
      const sep = i === creates.length - 1 ? '' : ',';
      lines.push(`    ('${sqlEscape(r.action_id)}', '${sqlEscape(r.display_name)}', '${sqlEscape(r.description)}', ${pathArray(r.paths)})${sep}`);
    });
    lines.push(`ON CONFLICT (action_id) DO NOTHING;`);
    lines.push(``);
  }

  if (updates.length > 0) {
    lines.push(`-- ${updates.length} updated action(s)`);
    for (const op of updates) {
      const before = baseMap.get(op.aid);
      const r = op.row;
      const setParts: string[] = [];
      if (!before || before.display_name !== r.display_name) setParts.push(`display_name = '${sqlEscape(r.display_name)}'`);
      if (!before || before.description !== r.description) setParts.push(`description = '${sqlEscape(r.description)}'`);
      const beforePaths = before ? Array.from(before.paths).sort().join(',') : '';
      const afterPaths = Array.from(r.paths).sort().join(',');
      if (beforePaths !== afterPaths) setParts.push(`applicable_paths = ${pathArray(r.paths)}`);
      if (setParts.length === 0) continue;
      lines.push(`UPDATE authz_action SET ${setParts.join(', ')} WHERE action_id = '${sqlEscape(op.aid)}';`);
    }
    lines.push(``);
  }

  if (deletes.length > 0) {
    lines.push(`-- ${deletes.length} deactivated action(s)`);
    for (const op of deletes) {
      lines.push(`UPDATE authz_action SET is_active = FALSE WHERE action_id = '${sqlEscape(op.aid)}';`);
    }
    lines.push(``);
  }

  if (creates.length === 0 && updates.length === 0 && deletes.length === 0) {
    lines.push(`-- No pending changes`);
  }

  lines.push(`COMMIT;`);
  return lines.join('\n');
}
