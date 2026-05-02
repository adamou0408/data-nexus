// ============================================================
// PERM-SLIM-V01-PATH2 — Permission Packs admin section
//
// A "pack" groups (resource_id, action_id) tuples and is applied to one
// or more roles. Editing the pack auto-resyncs every assigned role; manual
// authz_role_permission rows (pack_source IS NULL) are never touched.
//
// UI layout mirrors RolesSection: master list (left) + detail panel (right).
// Detail panel has three tabs: Members / Assignments / Preview-on-role.
// Apply / Unapply lives inside Preview so the admin always sees the diff
// before mutating role_permission.
// ============================================================

import { useState, useEffect, useMemo, useCallback } from 'react';
import { api, RolePack, RolePackMember, RolePackAssignment, RolePackSummary } from '../../api';
import { useToast } from '../Toast';
import { useSearch } from '../../hooks/useSearch';
import { useSort } from '../../hooks/useSort';
import { SortableHeader } from '../SortableHeader';
import { Combobox, ComboboxOption } from '../shared/Combobox';
import { DangerConfirmModal, ConfirmState } from '../shared/DangerConfirmModal';
import {
  Plus, Trash2, X, Check, Search, Package, ArrowLeft,
  KeySquare, Users, Eye, RefreshCw, AlertTriangle, ShieldCheck, ShieldAlert,
} from 'lucide-react';

type DetailTab = 'members' | 'assignments' | 'preview';

const PACK_ID_RE = /^[a-z][a-z0-9_]{2,63}$/;

export function PacksSection({ data, onReload }: {
  data: Record<string, unknown>[]; onReload: () => void;
}) {
  const toast = useToast();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ pack_id: '', display_name: '', description: '' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('members');
  const [dangerConfirm, setDangerConfirm] = useState<ConfirmState>(null);

  const summaries = data as unknown as RolePackSummary[];
  const { query, setQuery, filtered } = useSearch(data, ['pack_id', 'display_name', 'description']);
  const { sorted, sortKey, sortDir, toggleSort } = useSort(filtered, 'pack_id');

  const selectedPack = useMemo(
    () => summaries.find(p => p.pack_id === selectedId) || null,
    [summaries, selectedId]
  );

  const create = async () => {
    if (!PACK_ID_RE.test(form.pack_id)) {
      toast.error('Pack ID must match ^[a-z][a-z0-9_]{2,63}$');
      return;
    }
    if (form.display_name.trim().length === 0) {
      toast.error('Display name required');
      return;
    }
    try {
      await api.rolePackCreate({
        pack_id: form.pack_id,
        display_name: form.display_name.trim(),
        description: form.description.trim() || undefined,
      });
      toast.success(`Pack "${form.pack_id}" created`);
      setShowForm(false);
      setForm({ pack_id: '', display_name: '', description: '' });
      onReload();
    } catch (e) { toast.error(String(e)); }
  };

  return (
    <div className="flex flex-col lg:flex-row gap-4 h-[calc(100vh-240px)] min-h-[560px]">
      <div className={`flex flex-col border border-slate-200 rounded-lg bg-white overflow-hidden ${selectedId ? 'lg:w-[55%] hidden lg:flex' : 'w-full'}`}>
        <div className="card-header">
          <div className="flex items-center gap-3 flex-1">
            <span className="text-sm font-semibold">Packs ({(filtered as RolePackSummary[]).length}/{summaries.length})</span>
            <div className="relative flex-1 max-w-xs">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search..." className="input pl-8 py-1.5 text-xs" />
            </div>
          </div>
          <button onClick={() => { setShowForm(true); setForm({ pack_id: '', display_name: '', description: '' }); }}
            className="btn-primary btn-sm"><Plus size={12} /> Add</button>
        </div>

        {showForm && (
          <div className="card-body border-b bg-slate-50">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">Pack ID</label>
                <input value={form.pack_id} onChange={e => setForm(f => ({ ...f, pack_id: e.target.value }))}
                  className="input font-mono" placeholder="bi_user_pack" />
                <p className="text-[10px] text-slate-400 mt-0.5">lowercase, starts with letter</p>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">Display Name</label>
                <input value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
                  className="input" placeholder="BI User Pack" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">Description</label>
                <input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  className="input" placeholder="optional" />
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              <button onClick={create} className="btn-primary btn-sm"><Check size={12} /> Create</button>
              <button onClick={() => setShowForm(false)} className="btn-secondary btn-sm"><X size={12} /> Cancel</button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-auto">
          <table className="table">
            <thead className="sticky top-0 bg-white z-10"><tr>
              <SortableHeader label="Pack ID"      sortKey="pack_id"          currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              <SortableHeader label="Display Name" sortKey="display_name"     currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              <SortableHeader label="Members"      sortKey="member_count"     currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              <SortableHeader label="Roles"        sortKey="assignment_count" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              <th className="w-20">Actions</th>
            </tr></thead>
            <tbody>
              {(sorted as unknown as RolePackSummary[]).map(p => {
                const active = p.pack_id === selectedId;
                return (
                  <tr key={p.pack_id}
                    onClick={() => { setSelectedId(p.pack_id); setDetailTab('members'); }}
                    className={`cursor-pointer ${active ? 'bg-blue-50 hover:bg-blue-50' : 'hover:bg-slate-50'}`}>
                    <td className="font-mono text-xs font-bold text-slate-900">
                      <div className="flex items-center gap-1.5">
                        <Package size={11} className="text-slate-400" />
                        {p.pack_id}
                        {p.is_system ? <span className="badge badge-amber text-[9px]">SYS</span> : null}
                      </div>
                    </td>
                    <td className="text-slate-700">{p.display_name}</td>
                    <td className="text-center font-medium text-xs">{p.member_count}</td>
                    <td className="text-center font-medium text-xs">{p.assignment_count}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => {
                          if (p.is_system) {
                            toast.error('System packs cannot be deleted');
                            return;
                          }
                          if (p.assignment_count > 0) {
                            toast.error(`Pack still applied to ${p.assignment_count} role(s) — unapply first`);
                            return;
                          }
                          setDangerConfirm({
                            title: 'Delete Pack',
                            message: `This deletes pack "${p.pack_id}" and its members.`,
                            impact: 'authz_role_permission rows tagged with this pack will have pack_source set to NULL (FK SET NULL) — the rows themselves remain.',
                            onConfirm: async () => {
                              try {
                                await api.rolePackDelete(p.pack_id);
                                toast.success(`Pack "${p.pack_id}" deleted`);
                                if (p.pack_id === selectedId) setSelectedId(null);
                                onReload();
                              } catch (e) { toast.error(String(e)); }
                            },
                          });
                        }}
                        disabled={p.is_system || p.assignment_count > 0}
                        className="btn-secondary btn-sm p-1 text-red-500 disabled:text-slate-300 disabled:cursor-not-allowed"
                        title={p.is_system ? 'System packs cannot be deleted' : p.assignment_count > 0 ? 'Unapply from all roles first' : 'Delete pack'}>
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr><td colSpan={5} className="text-center text-slate-400 py-8 text-sm">No packs match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className={`flex flex-col border border-slate-200 rounded-lg bg-white overflow-hidden ${selectedId ? 'lg:w-[45%] w-full flex' : 'hidden lg:flex lg:w-[45%]'}`}>
        {selectedPack ? (
          <PackDetailPanel
            pack={selectedPack}
            activeTab={detailTab}
            onTabChange={setDetailTab}
            onClose={() => setSelectedId(null)}
            onReload={onReload}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-400 p-8 text-center">
            <div>
              <Package size={32} className="mx-auto mb-3 text-slate-300" />
              <p className="text-sm">Select a pack to manage its members and assignments.</p>
              <p className="text-[11px] mt-1">Packs let you grant the same (resource × action) bundle to multiple roles in one click.</p>
            </div>
          </div>
        )}
      </div>

      <DangerConfirmModal state={dangerConfirm} onClose={() => setDangerConfirm(null)} />
    </div>
  );
}

function PackDetailPanel({ pack, activeTab, onTabChange, onClose, onReload }: {
  pack: RolePack;
  activeTab: DetailTab;
  onTabChange: (t: DetailTab) => void;
  onClose: () => void;
  onReload: () => void;
}) {
  const [detail, setDetail] = useState<{
    pack: RolePack; members: RolePackMember[]; assignments: RolePackAssignment[];
  } | null>(null);
  const [loading, setLoading] = useState(true);

  const loadDetail = useCallback(() => {
    setLoading(true);
    api.rolePackGet(pack.pack_id)
      .then(setDetail)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [pack.pack_id]);

  useEffect(() => { loadDetail(); }, [loadDetail]);

  const tabs: { id: DetailTab; label: string; icon: JSX.Element }[] = [
    { id: 'members',     label: 'Members',     icon: <KeySquare size={13} /> },
    { id: 'assignments', label: 'Roles',       icon: <Users size={13} /> },
    { id: 'preview',     label: 'Preview',     icon: <Eye size={13} /> },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-slate-200 flex items-start gap-2">
        <button onClick={onClose} className="lg:hidden text-slate-400 hover:text-slate-700 mt-0.5" title="Back">
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <Package size={14} className="text-slate-400" />
            <code className="font-mono text-xs font-bold text-slate-900">{pack.pack_id}</code>
            {pack.is_system ? <span className="badge badge-amber text-[9px]">SYSTEM</span> : null}
          </div>
          <div className="text-sm text-slate-700 mt-0.5 truncate">{pack.display_name}</div>
          {pack.description ? <div className="text-xs text-slate-500 mt-0.5 truncate">{pack.description}</div> : null}
        </div>
      </div>

      <div className="flex border-b border-slate-200 bg-slate-50">
        {tabs.map(t => (
          <button key={t.id} onClick={() => onTabChange(t.id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 -mb-px transition-colors ${
              activeTab === t.id
                ? 'border-blue-600 text-blue-700 bg-white'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-8 text-center text-xs text-slate-400">Loading...</div>
        ) : detail ? (
          <>
            {activeTab === 'members' && (
              <MembersTab pack={pack} members={detail.members} onChange={() => { loadDetail(); onReload(); }} />
            )}
            {activeTab === 'assignments' && (
              <AssignmentsTab pack={pack} assignments={detail.assignments} onChange={() => { loadDetail(); onReload(); }} />
            )}
            {activeTab === 'preview' && (
              <PreviewTab pack={pack} onApply={() => { loadDetail(); onReload(); }} />
            )}
          </>
        ) : (
          <div className="p-8 text-center text-sm text-red-500">Failed to load pack detail.</div>
        )}
      </div>
    </div>
  );
}

// ─── Members tab ────────────────────────────────────────────
function MembersTab({ pack, members, onChange }: {
  pack: RolePack; members: RolePackMember[]; onChange: () => void;
}) {
  const toast = useToast();
  const [resources, setResources] = useState<Record<string, unknown>[]>([]);
  const [actions, setActions] = useState<Record<string, unknown>[]>([]);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<{ resource_id: string; action_id: string; effect: 'allow' | 'deny' }>({
    resource_id: '', action_id: '', effect: 'allow',
  });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.resources().then(setResources).catch(() => {});
    api.actions().then(setActions).catch(() => {});
  }, []);

  const resourceOpts: ComboboxOption[] = useMemo(
    () => resources.map(r => ({
      value: String(r.resource_id),
      label: String(r.resource_id),
      hint: String(r.display_name || ''),
    })),
    [resources],
  );
  const actionOpts: ComboboxOption[] = useMemo(
    () => actions.map(a => ({
      value: String(a.action_id),
      label: String(a.action_id),
      hint: String(a.display_name || ''),
    })),
    [actions],
  );

  const add = async () => {
    if (!form.resource_id || !form.action_id) {
      toast.error('Resource and action required');
      return;
    }
    setBusy(true);
    try {
      const r = await api.rolePackAddMember(pack.pack_id, form);
      const synced = r.resync.reduce((a, b) => a + b.inserted + b.deleted, 0);
      toast.success(`Member added · resynced ${r.resync.length} role(s) (${synced} row changes)`);
      setAdding(false);
      setForm({ resource_id: '', action_id: '', effect: 'allow' });
      onChange();
    } catch (e) { toast.error(String(e)); }
    setBusy(false);
  };

  const remove = async (m: RolePackMember) => {
    setBusy(true);
    try {
      const r = await api.rolePackRemoveMember(pack.pack_id, m.resource_id, m.action_id);
      toast.success(`Member removed · resynced ${r.resync.length} role(s)`);
      onChange();
    } catch (e) { toast.error(String(e)); }
    setBusy(false);
  };

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-slate-500">
          {members.length} member{members.length === 1 ? '' : 's'} · changes auto-resync to all assigned roles
        </div>
        {!adding && (
          <button onClick={() => setAdding(true)} className="btn-primary btn-sm">
            <Plus size={12} /> Add member
          </button>
        )}
      </div>

      {adding && (
        <div className="border border-slate-200 rounded-lg p-3 bg-slate-50 space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div>
              <label className="block text-[10px] font-semibold text-slate-500 mb-0.5">Resource</label>
              <Combobox value={form.resource_id} options={resourceOpts}
                onChange={v => setForm(f => ({ ...f, resource_id: v }))} placeholder="resource_id" />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-500 mb-0.5">Action</label>
              <Combobox value={form.action_id} options={actionOpts}
                onChange={v => setForm(f => ({ ...f, action_id: v }))} placeholder="action_id" />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-500 mb-0.5">Effect</label>
              <div className="flex gap-1">
                <button onClick={() => setForm(f => ({ ...f, effect: 'allow' }))}
                  className={`flex-1 text-xs px-2 py-1.5 rounded border ${form.effect === 'allow' ? 'bg-emerald-50 border-emerald-400 text-emerald-700' : 'bg-white border-slate-300 text-slate-600'}`}>
                  <ShieldCheck size={10} className="inline mr-0.5" /> allow
                </button>
                <button onClick={() => setForm(f => ({ ...f, effect: 'deny' }))}
                  className={`flex-1 text-xs px-2 py-1.5 rounded border ${form.effect === 'deny' ? 'bg-red-50 border-red-400 text-red-700' : 'bg-white border-slate-300 text-slate-600'}`}>
                  <ShieldAlert size={10} className="inline mr-0.5" /> deny
                </button>
              </div>
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={add} disabled={busy} className="btn-primary btn-sm">
              <Check size={12} /> {busy ? 'Adding...' : 'Add'}
            </button>
            <button onClick={() => setAdding(false)} className="btn-secondary btn-sm">
              <X size={12} /> Cancel
            </button>
          </div>
        </div>
      )}

      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <table className="table">
          <thead><tr>
            <th>Resource</th><th>Action</th><th className="w-20">Effect</th><th className="w-12"></th>
          </tr></thead>
          <tbody>
            {members.length === 0 ? (
              <tr><td colSpan={4} className="text-center text-slate-400 py-6 text-xs">No members yet — pack expansion will be a no-op until you add some.</td></tr>
            ) : members.map(m => (
              <tr key={`${m.resource_id}|${m.action_id}`}>
                <td className="font-mono text-xs">{m.resource_id}</td>
                <td className="font-mono text-xs">{m.action_id}</td>
                <td>
                  <span className={`badge text-[10px] ${m.effect === 'allow' ? 'badge-green' : 'badge-red'}`}>
                    {m.effect}
                  </span>
                </td>
                <td>
                  <button onClick={() => remove(m)} disabled={busy}
                    className="btn-secondary btn-sm p-1 text-red-500" title="Remove member">
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Assignments tab ────────────────────────────────────────
function AssignmentsTab({ pack, assignments, onChange }: {
  pack: RolePack; assignments: RolePackAssignment[]; onChange: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const unapply = async (roleId: string) => {
    setBusy(true);
    try {
      const r = await api.rolePackUnapply(pack.pack_id, roleId);
      toast.success(`Unapplied from "${roleId}" · ${r.deleted} row(s) removed`);
      onChange();
    } catch (e) { toast.error(String(e)); }
    setBusy(false);
  };

  const goToRole = (rid: string) => {
    window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'access-roles', focus: rid } }));
  };

  const resync = async () => {
    setBusy(true);
    try {
      const r = await api.rolePackResync(pack.pack_id);
      const totalChanges = r.results.reduce((a, b) => a + b.inserted + b.deleted, 0);
      toast.success(`Resynced ${r.results.length} role(s) · ${totalChanges} row change(s)`);
      onChange();
    } catch (e) { toast.error(String(e)); }
    setBusy(false);
  };

  if (assignments.length === 0) {
    return (
      <div className="p-8 text-center text-slate-400">
        <Users size={24} className="mx-auto mb-2 text-slate-300" />
        <p className="text-xs">Pack not applied to any role yet.</p>
        <p className="text-[11px] mt-1">Use the <b>Preview</b> tab to apply this pack to a role.</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-slate-500">{assignments.length} role(s) currently using this pack</div>
        <button onClick={resync} disabled={busy} className="btn-secondary btn-sm" title="Force re-sync — useful after manual DB edits">
          <RefreshCw size={12} /> {busy ? 'Resyncing...' : 'Resync all'}
        </button>
      </div>
      <div className="space-y-1">
        {assignments.map(a => (
          <div key={a.role_id} className="flex items-center gap-2 px-3 py-2 rounded border border-slate-200 hover:border-blue-300 hover:bg-blue-50/30 transition-colors">
            <button onClick={() => goToRole(a.role_id)} className="flex-1 text-left flex items-center gap-2">
              <KeySquare size={12} className="text-slate-400" />
              <code className="font-mono text-xs text-slate-900">{a.role_id}</code>
            </button>
            <span className="text-[10px] text-slate-400">applied by {a.applied_by} · {new Date(a.applied_at).toLocaleDateString()}</span>
            <button onClick={() => unapply(a.role_id)} disabled={busy}
              className="btn-secondary btn-sm p-1 text-red-500" title="Unapply pack from this role">
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Preview-and-apply tab ─────────────────────────────────
function PreviewTab({ pack, onApply }: { pack: RolePack; onApply: () => void }) {
  const toast = useToast();
  const [roles, setRoles] = useState<Record<string, unknown>[]>([]);
  const [roleId, setRoleId] = useState('');
  const [preview, setPreview] = useState<{
    to_insert: RolePackMember[];
    to_delete: RolePackMember[];
    conflicts_with_manual: RolePackMember[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.roles().then(setRoles).catch(() => {}); }, []);

  const roleOpts: ComboboxOption[] = useMemo(
    () => roles.map(r => ({
      value: String(r.role_id),
      label: String(r.role_id),
      hint: String(r.display_name || ''),
    })),
    [roles],
  );

  useEffect(() => {
    if (!roleId) { setPreview(null); return; }
    setLoading(true);
    api.rolePackPreview(pack.pack_id, roleId)
      .then(p => setPreview({
        to_insert: p.to_insert,
        to_delete: p.to_delete,
        conflicts_with_manual: p.conflicts_with_manual,
      }))
      .catch(e => { toast.error(String(e)); setPreview(null); })
      .finally(() => setLoading(false));
  }, [pack.pack_id, roleId, toast]);

  const apply = async () => {
    setBusy(true);
    try {
      const r = await api.rolePackApply(pack.pack_id, roleId);
      toast.success(`Applied · inserted ${r.inserted}, deleted ${r.deleted}, skipped ${r.skipped_due_to_manual}`);
      onApply();
      // refresh preview to show post-apply state
      const p = await api.rolePackPreview(pack.pack_id, roleId);
      setPreview({ to_insert: p.to_insert, to_delete: p.to_delete, conflicts_with_manual: p.conflicts_with_manual });
    } catch (e) { toast.error(String(e)); }
    setBusy(false);
  };

  return (
    <div className="p-4 space-y-4">
      <div>
        <label className="block text-xs font-semibold text-slate-500 mb-1">Target role</label>
        <Combobox value={roleId} options={roleOpts} onChange={setRoleId} placeholder="Pick a role..." clearable />
        <p className="text-[11px] text-slate-400 mt-1">Preview shows what would change in <code>authz_role_permission</code> if you apply this pack to the selected role. Manual rows (no <code>pack_source</code>) are never overwritten.</p>
      </div>

      {loading && <div className="text-center text-xs text-slate-400 py-4">Computing diff...</div>}

      {!loading && roleId && preview && (
        <>
          <DiffBlock title="Will INSERT" tone="green" rows={preview.to_insert}
            empty="Nothing to insert (all members already present, or pack is empty)." />
          <DiffBlock title="Will DELETE (pack-tagged rows no longer in members)" tone="red" rows={preview.to_delete}
            empty="No pack-tagged rows would be removed." />
          <DiffBlock title="Conflicts (manual or other-pack rows block these)" tone="amber" rows={preview.conflicts_with_manual}
            empty="No conflicts.">
            <p className="text-[11px] text-amber-700 px-3 pb-2 flex items-start gap-1">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              These tuples already have a manually-granted row OR a row tagged by a different pack. Applying this pack will <b>skip</b> them — the existing row wins.
            </p>
          </DiffBlock>

          <div className="pt-2 border-t border-slate-200 flex gap-2">
            <button onClick={apply} disabled={busy} className="btn-primary btn-sm">
              <Check size={12} /> {busy ? 'Applying...' : 'Apply pack'}
            </button>
            <span className="text-[11px] text-slate-400 self-center">
              Re-applying is idempotent · safe to click again to converge after pack edits.
            </span>
          </div>
        </>
      )}

      {!loading && !roleId && (
        <div className="text-center text-xs text-slate-400 py-8">Pick a role above to see the diff.</div>
      )}
    </div>
  );
}

function DiffBlock({ title, tone, rows, empty, children }: {
  title: string;
  tone: 'green' | 'red' | 'amber';
  rows: RolePackMember[];
  empty: string;
  children?: React.ReactNode;
}) {
  const headerCls = tone === 'green'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : tone === 'red'
    ? 'bg-red-50 text-red-700 border-red-200'
    : 'bg-amber-50 text-amber-700 border-amber-200';
  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <div className={`px-3 py-1.5 border-b text-[11px] font-semibold ${headerCls}`}>
        {title} <span className="font-normal opacity-75">({rows.length})</span>
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-2 text-[11px] text-slate-400">{empty}</div>
      ) : (
        <>
          <table className="table">
            <tbody>
              {rows.map(r => (
                <tr key={`${r.resource_id}|${r.action_id}|${r.effect}`}>
                  <td className="font-mono text-xs">{r.resource_id}</td>
                  <td className="font-mono text-xs">{r.action_id}</td>
                  <td className="w-16"><span className={`badge text-[10px] ${r.effect === 'allow' ? 'badge-green' : 'badge-red'}`}>{r.effect}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {children}
        </>
      )}
    </div>
  );
}
