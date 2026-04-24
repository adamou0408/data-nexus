import { useState, useEffect, useMemo, useCallback } from 'react';
import { api } from '../../api';
import { useSearch } from '../../hooks/useSearch';
import { useSort } from '../../hooks/useSort';
import { useToast } from '../Toast';
import { SortableHeader } from '../SortableHeader';
import { autoId, uniqueId } from '../../utils/slugify';
import {
  Plus, Pencil, Trash2, X, Check, Search, Copy,
  ShieldCheck, FileCode, Users, SlidersHorizontal, ArrowLeft,
} from 'lucide-react';
import { DangerConfirmModal, ConfirmState } from '../shared/DangerConfirmModal';
import { Combobox } from '../shared/Combobox';

type DetailTab = 'condition' | 'assignments' | 'settings';

type PolicyForm = {
  policy_name: string;
  description: string;
  granularity: string;
  priority: string;
  effect: string;
  applicable_paths: string;
  rls_expression: string;
  subject_condition: string;
  resource_condition: string;
};

const EMPTY_FORM: PolicyForm = {
  policy_name: '', description: '', granularity: 'L1', priority: '100', effect: 'allow',
  applicable_paths: 'A,B,C', rls_expression: '',
  subject_condition: '{}', resource_condition: '{}',
};

export function PoliciesSection({ data, onReload }: { data: Record<string, unknown>[]; onReload: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<PolicyForm>(EMPTY_FORM);
  const [editId, setEditId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detailTab, setDetailTab] = useState<DetailTab>('condition');
  const { query, setQuery, filtered } = useSearch(data, ['policy_name', 'description', 'granularity', 'effect', 'status', 'rls_expression']);
  const { sorted, sortKey, sortDir, toggleSort } = useSort(filtered, 'policy_name');
  const toast = useToast();
  const [dangerConfirm, setDangerConfirm] = useState<ConfirmState>(null);
  const existingIds = useMemo(() => data.map(d => String(d.policy_name)), [data]);
  const suggestedId = uniqueId(autoId.policy(form.description), existingIds);

  const selected = useMemo(
    () => data.find(p => Number(p.policy_id) === selectedId) || null,
    [data, selectedId]
  );

  const save = async () => {
    try {
      const payload = {
        policy_name: form.policy_name, description: form.description,
        granularity: form.granularity, priority: Number(form.priority), effect: form.effect,
        applicable_paths: form.applicable_paths.split(',').map(s => s.trim()).filter(Boolean),
        rls_expression: form.rls_expression || null,
        subject_condition: JSON.parse(form.subject_condition || '{}'),
        resource_condition: JSON.parse(form.resource_condition || '{}'),
        created_by: 'admin_ui',
      };
      if (editId) {
        await api.policyUpdate(editId, payload);
        toast.success('Policy updated');
      } else {
        await api.policyCreate(payload);
        toast.success(`Policy "${form.policy_name}" created`);
      }
      setShowForm(false); setEditId(null); onReload();
    } catch (e) { toast.error(String(e)); }
  };

  const clone = (p: Record<string, unknown>) => {
    setForm({
      policy_name: String(p.policy_name) + '_copy', description: String(p.description || ''),
      granularity: String(p.granularity), priority: String(p.priority), effect: String(p.effect),
      applicable_paths: (p.applicable_paths as string[])?.join(',') || 'A,B,C',
      rls_expression: String(p.rls_expression || ''),
      subject_condition: JSON.stringify(p.subject_condition || {}, null, 2),
      resource_condition: JSON.stringify(p.resource_condition || {}, null, 2),
    });
    setEditId(null); setShowForm(true);
  };

  const startEdit = (p: Record<string, unknown>) => {
    setForm({
      policy_name: String(p.policy_name), description: String(p.description || ''),
      granularity: String(p.granularity), priority: String(p.priority), effect: String(p.effect),
      applicable_paths: (p.applicable_paths as string[])?.join(',') || 'A,B,C',
      rls_expression: String(p.rls_expression || ''),
      subject_condition: JSON.stringify(p.subject_condition || {}, null, 2),
      resource_condition: JSON.stringify(p.resource_condition || {}, null, 2),
    });
    setEditId(Number(p.policy_id)); setShowForm(true);
  };

  return (
    <div className="flex flex-col lg:flex-row gap-4 h-[calc(100vh-240px)] min-h-[560px]">
      <div className={`flex flex-col border border-slate-200 rounded-lg bg-white overflow-hidden ${selectedId !== null ? 'lg:w-[50%] hidden lg:flex' : 'w-full'}`}>
        <div className="card-header">
          <div className="flex items-center gap-3 flex-1">
            <span className="text-sm font-semibold">Policies ({filtered.length}/{data.length})</span>
            <div className="relative flex-1 max-w-xs">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name / RLS..." className="input pl-8 py-1.5 text-xs" />
            </div>
          </div>
          <button onClick={() => { setShowForm(true); setEditId(null); setForm(EMPTY_FORM); }}
            className="btn-primary btn-sm"><Plus size={12} /> Add</button>
        </div>

        {showForm && (
          <div className="card-body border-b bg-slate-50 max-h-[50vh] overflow-auto">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">
                  Policy Name
                  {!editId && form.policy_name === suggestedId && form.policy_name !== '' && (
                    <span className="text-emerald-500 text-[10px] ml-1">(auto)</span>
                  )}
                </label>
                <input value={form.policy_name} onChange={e => setForm(f => ({ ...f, policy_name: e.target.value }))}
                  disabled={!!editId} className="input font-mono" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1" title="L1 = row scope, L2 = column mask, L3 = composite">Granularity</label>
                <select value={form.granularity} onChange={e => setForm(f => ({ ...f, granularity: e.target.value }))} className="select">
                  <option value="L1">L1 (Data Scope)</option>
                  <option value="L2">L2 (Column Mask)</option>
                  <option value="L3">L3 (Composite)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">Effect</label>
                <select value={form.effect} onChange={e => setForm(f => ({ ...f, effect: e.target.value }))} className="select">
                  <option value="allow">allow</option><option value="deny">deny</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1" title="Lower number = evaluated first">Priority</label>
                <input type="number" value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))} className="input" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1" title="A=Config-SM UI, B=Web API, C=Direct DB">Applicable Paths</label>
                <input value={form.applicable_paths} onChange={e => setForm(f => ({ ...f, applicable_paths: e.target.value }))} className="input" placeholder="A,B,C" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">Description</label>
                <input value={form.description} onChange={e => {
                  const newDesc = e.target.value;
                  setForm(f => {
                    const oldSuggested = uniqueId(autoId.policy(f.description), existingIds);
                    const updated = { ...f, description: newDesc };
                    if (f.policy_name === '' || f.policy_name === oldSuggested) {
                      updated.policy_name = uniqueId(autoId.policy(newDesc), existingIds);
                    }
                    return updated;
                  });
                }} className="input" />
              </div>
              <div className="sm:col-span-3">
                <label className="block text-xs font-semibold text-slate-500 mb-1">RLS Expression</label>
                <input value={form.rls_expression} onChange={e => setForm(f => ({ ...f, rls_expression: e.target.value }))}
                  className="input font-mono text-xs" placeholder="e.g. product_line = ANY(attr_product_lines)" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 mb-1">Subject Condition (JSON)</label>
                <textarea value={form.subject_condition} onChange={e => setForm(f => ({ ...f, subject_condition: e.target.value }))}
                  className="input font-mono text-xs" rows={2} />
              </div>
              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-slate-500 mb-1">Resource Condition (JSON)</label>
                <textarea value={form.resource_condition} onChange={e => setForm(f => ({ ...f, resource_condition: e.target.value }))}
                  className="input font-mono text-xs" rows={2} />
              </div>
            </div>
            <div className="flex gap-2 mt-3">
              <button onClick={save} className="btn-primary btn-sm"><Check size={12} /> {editId ? 'Update' : 'Create'}</button>
              <button onClick={() => { setShowForm(false); setEditId(null); }} className="btn-secondary btn-sm"><X size={12} /> Cancel</button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-auto">
          <table className="table">
            <thead className="sticky top-0 bg-white z-10"><tr>
              <SortableHeader label="Name" sortKey="policy_name" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              <SortableHeader label="Gran" sortKey="granularity" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              <SortableHeader label="Effect" sortKey="effect" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              <SortableHeader label="Status" sortKey="status" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              <th>Paths</th>
              <th className="w-24">Actions</th>
            </tr></thead>
            <tbody>
              {sorted.map((p) => {
                const pid = Number(p.policy_id);
                const active = pid === selectedId;
                const paths = (p.applicable_paths as string[]) || [];
                return (
                  <tr key={pid}
                    onClick={() => { setSelectedId(pid); setDetailTab('condition'); }}
                    className={`cursor-pointer ${active ? 'bg-blue-50 hover:bg-blue-50' : 'hover:bg-slate-50'}`}>
                    <td className="font-medium text-slate-900 truncate max-w-[200px]" title={String(p.description || p.policy_name)}>{String(p.policy_name)}</td>
                    <td><span className="badge badge-slate text-[10px]" title={p.granularity === 'L1' ? 'Row-level scope' : p.granularity === 'L2' ? 'Column mask' : 'Composite'}>{String(p.granularity)}</span></td>
                    <td><span className={`badge ${p.effect === 'allow' ? 'badge-green' : 'badge-red'}`}>{String(p.effect)}</span></td>
                    <td><span className={`badge ${p.status === 'active' ? 'badge-green' : 'badge-slate'}`}>{String(p.status)}</span></td>
                    <td>
                      <div className="flex gap-0.5 flex-wrap">
                        {paths.map(path => (
                          <span key={path} className="badge badge-slate text-[9px]" title={path === 'A' ? 'Config-SM UI' : path === 'B' ? 'Web API' : 'Direct DB'}>{path}</span>
                        ))}
                      </div>
                    </td>
                    <td onClick={e => e.stopPropagation()}>
                      <div className="flex gap-1">
                        <button onClick={() => startEdit(p)} className="btn-secondary btn-sm p-1" title="Edit"><Pencil size={12} /></button>
                        <button onClick={() => clone(p)} className="btn-secondary btn-sm p-1" title="Clone"><Copy size={12} /></button>
                        <button onClick={() => setDangerConfirm({
                          title: 'Deactivate Policy',
                          message: `This will deactivate policy "${p.policy_name}".`,
                          impact: 'This policy will stop being evaluated during authorization checks.',
                          onConfirm: async () => {
                            try {
                              await api.policyDelete(pid);
                              toast.success('Policy deactivated');
                              if (pid === selectedId) setSelectedId(null);
                              onReload();
                            } catch (e) { toast.error(String(e)); }
                          },
                        })} className="btn-secondary btn-sm p-1 text-red-500" title="Deactivate"><Trash2 size={12} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {sorted.length === 0 && (
                <tr><td colSpan={6} className="text-center text-slate-400 py-8 text-sm">No policies match.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className={`flex flex-col border border-slate-200 rounded-lg bg-white overflow-hidden ${selectedId !== null ? 'lg:w-[50%] w-full flex' : 'hidden lg:flex lg:w-[50%]'}`}>
        {selected ? (
          <PolicyDetailPanel
            policy={selected}
            activeTab={detailTab}
            onTabChange={setDetailTab}
            onClose={() => setSelectedId(null)}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-slate-400 p-8 text-center">
            <div>
              <ShieldCheck size={32} className="mx-auto mb-3 text-slate-300" />
              <p className="text-sm">Select a policy to view condition, assignments, and settings</p>
            </div>
          </div>
        )}
      </div>

      <DangerConfirmModal state={dangerConfirm} onClose={() => setDangerConfirm(null)} />
    </div>
  );
}

function PolicyDetailPanel({ policy, activeTab, onTabChange, onClose }: {
  policy: Record<string, unknown>;
  activeTab: DetailTab;
  onTabChange: (t: DetailTab) => void;
  onClose: () => void;
}) {
  const pid = Number(policy.policy_id);

  const tabs: { id: DetailTab; label: string; icon: JSX.Element }[] = [
    { id: 'condition',   label: 'Condition',   icon: <FileCode size={13} /> },
    { id: 'assignments', label: 'Assignments', icon: <Users size={13} /> },
    { id: 'settings',    label: 'Settings',    icon: <SlidersHorizontal size={13} /> },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-slate-200 flex items-start gap-2">
        <button onClick={onClose} className="lg:hidden text-slate-400 hover:text-slate-700 mt-0.5" title="Back">
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <code className="font-mono text-xs font-bold text-slate-900 truncate">{String(policy.policy_name)}</code>
            <span className={`badge text-[9px] ${policy.effect === 'allow' ? 'badge-green' : 'badge-red'}`}>{String(policy.effect)}</span>
            <span className="badge badge-slate text-[9px]">{String(policy.granularity)}</span>
          </div>
          {policy.description ? <div className="text-xs text-slate-600 mt-0.5 truncate" title={String(policy.description)}>{String(policy.description)}</div> : null}
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
        {activeTab === 'condition'   && <ConditionTab policy={policy} />}
        {activeTab === 'assignments' && <AssignmentsTab policyId={pid} />}
        {activeTab === 'settings'    && <SettingsTab policy={policy} />}
      </div>
    </div>
  );
}

function ConditionTab({ policy }: { policy: Record<string, unknown> }) {
  const sc = policy.subject_condition as Record<string, unknown> | null;
  const rc = policy.resource_condition as Record<string, unknown> | null;
  const rls = String(policy.rls_expression || '');
  return (
    <div className="p-4 space-y-4 text-xs">
      <div>
        <div className="text-[11px] font-semibold text-slate-500 uppercase mb-1">RLS Expression</div>
        {rls ? (
          <pre className="bg-slate-900 text-emerald-200 rounded p-3 text-[11px] font-mono overflow-auto max-h-32" title={rls}>{rls}</pre>
        ) : (
          <p className="text-slate-400 text-[11px] italic">No RLS expression — policy uses JSON conditions only.</p>
        )}
      </div>
      <div>
        <div className="text-[11px] font-semibold text-slate-500 uppercase mb-1">Subject Condition</div>
        <pre className="bg-slate-50 border border-slate-200 rounded p-2 text-[11px] font-mono overflow-auto max-h-48">
          {sc && Object.keys(sc).length > 0 ? JSON.stringify(sc, null, 2) : '{} — matches all'}
        </pre>
      </div>
      <div>
        <div className="text-[11px] font-semibold text-slate-500 uppercase mb-1">Resource Condition</div>
        <pre className="bg-slate-50 border border-slate-200 rounded p-2 text-[11px] font-mono overflow-auto max-h-48">
          {rc && Object.keys(rc).length > 0 ? JSON.stringify(rc, null, 2) : '{} — matches all'}
        </pre>
      </div>
    </div>
  );
}

const ASSIGNMENT_TYPES = ['role', 'department', 'security_level', 'user', 'job_level_below', 'group'];

function AssignmentsTab({ policyId }: { policyId: number }) {
  const [assignments, setAssignments] = useState<Record<string, unknown>[]>([]);
  const [assignType, setAssignType] = useState('role');
  const [assignValue, setAssignValue] = useState('');
  const [isException, setIsException] = useState(false);
  const [roles, setRoles] = useState<Record<string, unknown>[]>([]);
  const [subjects, setSubjects] = useState<Record<string, unknown>[]>([]);
  const toast = useToast();

  const load = useCallback(() => {
    api.policyAssignments(policyId).then(setAssignments).catch(() => setAssignments([]));
  }, [policyId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.roles().then(setRoles).catch(() => {});
    api.subjects().then(setSubjects).catch(() => {});
  }, []);

  const valueOptions = useMemo(() => {
    if (assignType === 'role') return roles.map(r => ({ value: String(r.role_id), label: String(r.role_id), hint: String(r.display_name || '') }));
    if (assignType === 'user') return subjects.filter(s => s.subject_type === 'user').map(s => ({ value: String(s.subject_id), label: String(s.subject_id), hint: String(s.display_name || '') }));
    if (assignType === 'group') return subjects.filter(s => s.subject_type === 'ldap_group').map(s => ({ value: String(s.subject_id), label: String(s.subject_id), hint: String(s.display_name || '') }));
    return [];
  }, [assignType, roles, subjects]);

  const needsFreeText = !['role', 'user', 'group'].includes(assignType);

  const add = async () => {
    if (!assignValue) { toast.error('Value is required'); return; }
    try {
      await api.policyAssignmentCreate(policyId, { assignment_type: assignType, assignment_value: assignValue, is_exception: isException });
      toast.success('Assignment added');
      setAssignValue(''); setIsException(false);
      load();
    } catch (e) { toast.error(String(e)); }
  };

  const remove = async (id: number) => {
    try {
      await api.policyAssignmentDelete(id);
      toast.success('Assignment removed');
      load();
    } catch (e) { toast.error(String(e)); }
  };

  return (
    <div className="p-4 space-y-4">
      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
        <div className="text-[11px] font-semibold uppercase text-slate-500 mb-2">Add assignment</div>
        <div className="grid grid-cols-12 gap-2">
          <select value={assignType} onChange={e => { setAssignType(e.target.value); setAssignValue(''); }}
            className="select text-xs col-span-3">
            {ASSIGNMENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <div className="col-span-6">
            {needsFreeText ? (
              <input value={assignValue} onChange={e => setAssignValue(e.target.value)}
                placeholder={assignType === 'security_level' ? 'PUBLIC / INTERNAL / ...' : assignType === 'job_level_below' ? '5' : 'Value...'}
                className="input text-xs w-full" />
            ) : (
              <Combobox value={assignValue} onChange={setAssignValue} options={valueOptions} placeholder={`${assignType}...`} />
            )}
          </div>
          <label className="flex items-center gap-1 text-xs text-slate-600 col-span-2 px-1" title="Mark this assignment as an exclusion">
            <input type="checkbox" checked={isException} onChange={e => setIsException(e.target.checked)} />
            Except
          </label>
          <button onClick={add} className="btn-primary btn-sm p-1.5 col-span-1" title="Add"><Plus size={14} /></button>
        </div>
      </div>

      {assignments.length === 0 ? (
        <div className="text-center py-8 text-slate-400">
          <Users size={22} className="mx-auto mb-2 text-slate-300" />
          <p className="text-xs">No assignments — policy uses subject_condition JSON matching only.</p>
        </div>
      ) : (
        <div className="space-y-1">
          <div className="text-[11px] text-slate-500 px-1">{assignments.length} assignment{assignments.length === 1 ? '' : 's'}</div>
          {assignments.map(a => (
            <div key={String(a.id)} className="flex items-center gap-2 px-3 py-1.5 rounded border border-slate-200 text-xs hover:bg-slate-50 group">
              <span className={`badge text-[10px] ${a.is_exception ? 'badge-red' : 'badge-green'}`}>
                {a.is_exception ? 'EXCEPT' : 'INCLUDE'}
              </span>
              <span className="badge badge-slate text-[10px]">{String(a.assignment_type)}</span>
              <span className="font-mono text-slate-700 flex-1 truncate" title={String(a.assignment_value)}>{String(a.assignment_value)}</span>
              <button onClick={() => remove(Number(a.id))} className="text-slate-300 hover:text-red-600 opacity-0 group-hover:opacity-100" title="Remove"><X size={12} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SettingsTab({ policy }: { policy: Record<string, unknown> }) {
  const paths = (policy.applicable_paths as string[]) || [];
  return (
    <div className="p-4 space-y-3 text-xs">
      <DetailRow label="Policy ID" value={<code className="font-mono">{String(policy.policy_id)}</code>} />
      <DetailRow label="Priority" value={<span title="Lower number = evaluated first">{String(policy.priority)}</span>} />
      <DetailRow label="Granularity" value={
        <span className="badge badge-slate text-[10px]" title={policy.granularity === 'L1' ? 'Row-level scope' : policy.granularity === 'L2' ? 'Column mask' : 'Composite action'}>
          {String(policy.granularity)}
        </span>
      } />
      <DetailRow label="Effect" value={
        <span className={`badge ${policy.effect === 'allow' ? 'badge-green' : 'badge-red'}`}>{String(policy.effect)}</span>
      } />
      <DetailRow label="Status" value={
        <span className={`badge ${policy.status === 'active' ? 'badge-green' : 'badge-slate'}`}>{String(policy.status)}</span>
      } />
      <DetailRow label="Paths" value={
        <div className="flex gap-1 flex-wrap">
          {paths.map(p => (
            <span key={p} className="badge badge-slate text-[10px]" title={p === 'A' ? 'Config-SM UI' : p === 'B' ? 'Web API' : 'Direct DB'}>{p}</span>
          ))}
          {paths.length === 0 && <span className="text-slate-400">—</span>}
        </div>
      } />
      <DetailRow label="Description" value={
        policy.description ? <span className="text-slate-700">{String(policy.description)}</span> : <span className="text-slate-400">—</span>
      } />
      <DetailRow label="Created" value={policy.created_at ? <span className="text-slate-600">{new Date(String(policy.created_at)).toLocaleString()}</span> : <span className="text-slate-400">—</span>} />
      <DetailRow label="Created By" value={<span className="text-slate-600">{String(policy.created_by || '—')}</span>} />
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="w-28 text-[11px] font-semibold text-slate-500 uppercase shrink-0">{label}</div>
      <div className="flex-1 min-w-0 text-slate-800">{value}</div>
    </div>
  );
}
