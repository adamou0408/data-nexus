import { useState, useMemo } from 'react';
import { api } from '../../api';
import { useSearch } from '../../hooks/useSearch';
import { useSort } from '../../hooks/useSort';
import { useToast } from '../Toast';
import { SortableHeader } from '../SortableHeader';
import { autoId, uniqueId } from '../../utils/slugify';
import { Plus, Pencil, Trash2, X, Check, ChevronDown, ChevronRight, Search, Copy } from 'lucide-react';

export function PoliciesSection({ data, onReload }: { data: Record<string, unknown>[]; onReload: () => void }) {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    policy_name: '', description: '', granularity: 'L1', priority: '100', effect: 'allow',
    applicable_paths: 'A,B,C', rls_expression: '',
    subject_condition: '{}', resource_condition: '{}',
  });
  const [editId, setEditId] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [assignments, setAssignments] = useState<Record<string, unknown>[]>([]);
  const [assignForm, setAssignForm] = useState({ assignment_type: 'role', assignment_value: '', is_exception: false });
  const { query, setQuery, filtered } = useSearch(data, ['policy_name', 'description', 'granularity', 'effect', 'status']);
  const { sorted, sortKey, sortDir, toggleSort } = useSort(filtered, 'policy_name');
  const toast = useToast();
  const existingIds = useMemo(() => data.map(d => String(d.policy_name)), [data]);
  const suggestedId = uniqueId(autoId.policy(form.description), existingIds);

  const save = async () => {
    try {
      const payload = {
        policy_name: form.policy_name, description: form.description,
        granularity: form.granularity, priority: Number(form.priority), effect: form.effect,
        applicable_paths: form.applicable_paths.split(',').map(s => s.trim()),
        rls_expression: form.rls_expression || null,
        subject_condition: JSON.parse(form.subject_condition),
        resource_condition: JSON.parse(form.resource_condition),
        created_by: 'admin_ui',
      };
      if (editId) {
        await api.policyUpdate(editId, payload);
        toast.success(`Policy updated`);
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

  const expandPolicy = async (policyId: number) => {
    if (expandedId === policyId) { setExpandedId(null); return; }
    setExpandedId(policyId);
    try {
      const a = await api.policyAssignments(policyId);
      setAssignments(a);
    } catch { setAssignments([]); }
  };

  const addAssignment = async (policyId: number) => {
    if (!assignForm.assignment_value) return;
    try {
      await api.policyAssignmentCreate(policyId, assignForm);
      toast.success('Assignment added');
      setAssignForm({ assignment_type: 'role', assignment_value: '', is_exception: false });
      const a = await api.policyAssignments(policyId);
      setAssignments(a);
    } catch (e) { toast.error(String(e)); }
  };

  const removeAssignment = async (policyId: number, assignmentId: number) => {
    try {
      await api.policyAssignmentDelete(assignmentId);
      toast.success('Assignment removed');
      const a = await api.policyAssignments(policyId);
      setAssignments(a);
    } catch (e) { toast.error(String(e)); }
  };

  return (
    <div>
      <div className="card-header">
        <div className="flex items-center gap-3 flex-1">
          <span className="text-sm font-semibold">Policies ({filtered.length}/{data.length})</span>
          <div className="relative flex-1 max-w-xs">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search..." className="input pl-8 py-1.5 text-xs" />
          </div>
        </div>
        <button onClick={() => { setShowForm(true); setEditId(null);
          setForm({ policy_name: '', description: '', granularity: 'L1', priority: '100', effect: 'allow', applicable_paths: 'A,B,C', rls_expression: '', subject_condition: '{}', resource_condition: '{}' }); }}
          className="btn-primary btn-sm"><Plus size={12} /> Add</button>
      </div>

      {showForm && (
        <div className="card-body border-b bg-slate-50">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
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
              <label className="block text-xs font-semibold text-slate-500 mb-1">Granularity</label>
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
              <label className="block text-xs font-semibold text-slate-500 mb-1">Priority</label>
              <input type="number" value={form.priority} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))} className="input" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1">Applicable Paths</label>
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
            <div>
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

      <div className="table-container max-h-[60vh]">
        <table className="table">
          <thead>
            <tr>
              <th></th>
              <SortableHeader label="Name" sortKey="policy_name" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              <SortableHeader label="Granularity" sortKey="granularity" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              <SortableHeader label="Effect" sortKey="effect" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              <SortableHeader label="Status" sortKey="status" currentSortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} />
              <th>RLS Expression</th>
              <th>Paths</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => {
              const pid = Number(p.policy_id);
              const expanded = expandedId === pid;
              return (<>
                <tr key={pid}>
                  <td className="w-8">
                    <button onClick={() => expandPolicy(pid)} className="text-slate-400 hover:text-slate-700">
                      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                  </td>
                  <td className="font-medium text-slate-900">{String(p.policy_name)}</td>
                  <td><span className="badge badge-slate text-[10px]">{String(p.granularity)}</span></td>
                  <td><span className={`badge ${p.effect === 'allow' ? 'badge-green' : 'badge-red'}`}>{String(p.effect)}</span></td>
                  <td><span className={`badge ${p.status === 'active' ? 'badge-green' : 'badge-slate'}`}>{String(p.status)}</span></td>
                  <td className="font-mono text-xs text-slate-500 max-w-[200px] truncate">{p.rls_expression ? String(p.rls_expression) : '-'}</td>
                  <td>
                    <div className="flex gap-1">
                      {(p.applicable_paths as string[] || []).map((path: string) => (
                        <span key={path} className="badge badge-slate text-[10px]">{path}</span>
                      ))}
                    </div>
                  </td>
                  <td>
                    <div className="flex gap-1">
                      <button onClick={() => {
                        setForm({
                          policy_name: String(p.policy_name), description: String(p.description || ''),
                          granularity: String(p.granularity), priority: String(p.priority), effect: String(p.effect),
                          applicable_paths: (p.applicable_paths as string[])?.join(',') || 'A,B,C',
                          rls_expression: String(p.rls_expression || ''),
                          subject_condition: JSON.stringify(p.subject_condition || {}, null, 2),
                          resource_condition: JSON.stringify(p.resource_condition || {}, null, 2),
                        });
                        setEditId(pid); setShowForm(true);
                      }} className="btn-secondary btn-sm p-1" title="Edit"><Pencil size={12} /></button>
                      <button onClick={() => clone(p)} className="btn-secondary btn-sm p-1" title="Clone"><Copy size={12} /></button>
                      <button onClick={async () => { if (confirm(`Deactivate policy?`)) { try { await api.policyDelete(pid); toast.success('Policy deactivated'); onReload(); } catch (e) { toast.error(String(e)); } }}}
                        className="btn-secondary btn-sm p-1 text-red-500"><Trash2 size={12} /></button>
                    </div>
                  </td>
                </tr>
                {expanded && (
                  <tr key={`${pid}-assign`}>
                    <td colSpan={8} className="bg-slate-50 p-4">
                      <h4 className="text-xs font-semibold text-slate-500 uppercase mb-2">Policy Assignments</h4>
                      <div className="flex gap-2 items-end mb-3 flex-wrap">
                        <select value={assignForm.assignment_type} onChange={e => setAssignForm(f => ({ ...f, assignment_type: e.target.value }))}
                          className="select text-xs w-36">
                          {['role', 'department', 'security_level', 'user', 'job_level_below', 'group'].map(t => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                        <input value={assignForm.assignment_value} onChange={e => setAssignForm(f => ({ ...f, assignment_value: e.target.value }))}
                          placeholder="Value..." className="input text-xs w-40" />
                        <label className="flex items-center gap-1 text-xs text-slate-600">
                          <input type="checkbox" checked={assignForm.is_exception}
                            onChange={e => setAssignForm(f => ({ ...f, is_exception: e.target.checked }))} />
                          Exception
                        </label>
                        <button onClick={() => addAssignment(pid)} className="btn-primary btn-sm"><Plus size={12} /></button>
                      </div>
                      <div className="space-y-1 max-h-48 overflow-y-auto">
                        {assignments.map((a) => (
                          <div key={String(a.id)} className="flex items-center gap-2 text-xs bg-white rounded-lg border px-3 py-1.5">
                            <span className={`badge text-[10px] ${a.is_exception ? 'badge-red' : 'badge-green'}`}>
                              {a.is_exception ? 'EXCEPTION' : 'INCLUDE'}
                            </span>
                            <span className="badge badge-slate text-[10px]">{String(a.assignment_type)}</span>
                            <span className="font-mono text-slate-700 flex-1">{String(a.assignment_value)}</span>
                            <button onClick={() => removeAssignment(pid, Number(a.id))} className="text-red-400 hover:text-red-600"><X size={12} /></button>
                          </div>
                        ))}
                        {assignments.length === 0 && <p className="text-xs text-slate-400">No assignments — policy uses subject_condition JSONB matching only</p>}
                      </div>
                    </td>
                  </tr>
                )}
              </>);
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
