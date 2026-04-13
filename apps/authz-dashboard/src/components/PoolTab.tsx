import React, { useState, useEffect, useCallback } from 'react';
import { api, PoolProfile, PoolAssignment, PoolCredential, DataSource, SyncAction, DriftItem, LifecycleResponse, LifecycleSummary, PhaseStatus } from '../api';
import { Server, Key, RefreshCw, Play, ChevronRight, ChevronDown, Plus, Pencil, Trash2, X, RotateCw, Database, Zap, Search, AlertTriangle, Undo2, Check, ArrowLeft, FolderSearch } from 'lucide-react';

/* ── Danger Confirm Modal ── */

type ConfirmState = { title: string; message: string; impact: string; onConfirm: () => void } | null;

function DangerConfirmModal({ state, onClose }: { state: ConfirmState; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  if (!state) return null;
  const keyword = 'CONFIRM';
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-red-200 bg-red-50 rounded-t-xl flex gap-3">
          <AlertTriangle size={24} className="text-red-600 shrink-0 mt-0.5" />
          <div>
            <h3 className="font-bold text-red-900">{state.title}</h3>
            <p className="text-sm text-red-700 mt-1">{state.message}</p>
          </div>
        </div>
        <div className="p-5 space-y-4">
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <div className="text-xs font-semibold text-amber-800 mb-1">Impact</div>
            <div className="text-sm text-amber-900">{state.impact}</div>
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600">
              Type <span className="font-mono font-bold text-red-600">{keyword}</span> to proceed
            </label>
            <input className="input mt-1 font-mono" value={typed} onChange={e => setTyped(e.target.value)}
              placeholder={keyword} autoFocus />
          </div>
          <div className="flex gap-2 justify-end">
            <button onClick={onClose} className="btn btn-sm bg-white text-slate-600 border border-slate-300 hover:bg-slate-50">
              Cancel
            </button>
            <button
              onClick={() => { state.onConfirm(); onClose(); setTyped(''); }}
              disabled={typed !== keyword}
              className="btn btn-sm bg-red-600 text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed">
              Execute
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Reusable: Chip multi-select ── */
function ChipSelect({ label, items, selected, onToggle, renderItem }: {
  label: string; items: { id: string; label: string }[]; selected: string[];
  onToggle: (id: string) => void; renderItem?: (item: { id: string; label: string }) => React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">{label}</label>
      <div className="flex flex-wrap gap-1.5 p-2 bg-white border border-slate-200 rounded-lg min-h-[38px]">
        {items.length === 0 && <span className="text-xs text-slate-400 italic">Loading...</span>}
        {items.map(item => {
          const on = selected.includes(item.id);
          return (
            <button key={item.id} type="button" onClick={() => onToggle(item.id)}
              className={`px-2 py-0.5 rounded-full text-xs font-mono transition-colors ${
                on ? 'bg-blue-100 text-blue-800 ring-1 ring-blue-300' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
              }`}>
              {renderItem ? renderItem(item) : item.label}
              {on && <span className="ml-1 font-bold">&times;</span>}
            </button>
          );
        })}
      </div>
      {selected.length > 0 && <div className="text-[10px] text-slate-400 mt-0.5">{selected.length} selected</div>}
    </div>
  );
}

/* ── Lifecycle Dots (overview card) ── */
function LifecycleDots({ phases }: { phases: LifecycleResponse['phases'] }) {
  const order: (keyof LifecycleResponse['phases'])[] = ['connection', 'discovery', 'organization', 'profiles', 'credentials', 'deployment'];
  return (
    <div className="lifecycle-bar">
      {order.map(k => {
        const s = phases[k].status;
        return <div key={k} className={`lifecycle-dot ${
          s === 'done' ? 'lifecycle-dot-done' : s === 'action_needed' ? 'lifecycle-dot-action' : 'lifecycle-dot-pending'
        }`} title={`${k}: ${s}`} />;
      })}
    </div>
  );
}

/* ── Lifecycle Stepper (detail view) ── */
const phaseLabels: { key: string; label: string; icon: React.ReactNode }[] = [
  { key: 'connection',   label: 'Connection',   icon: <Zap size={14} /> },
  { key: 'discovery',    label: 'Discovery',    icon: <FolderSearch size={14} /> },
  { key: 'organization', label: 'Organization', icon: <Database size={14} /> },
  { key: 'profiles',     label: 'Profiles',     icon: <Server size={14} /> },
  { key: 'credentials',  label: 'Credentials',  icon: <Key size={14} /> },
  { key: 'deployment',   label: 'Deployment',   icon: <Play size={14} /> },
];

function LifecycleStepper({ phases }: { phases: LifecycleResponse['phases'] }) {
  const keys = phaseLabels.map(p => p.key) as (keyof LifecycleResponse['phases'])[];
  return (
    <div className="stepper">
      {phaseLabels.map((p, i) => {
        const status = phases[keys[i]].status;
        const isDone = status === 'done';
        const isAction = status === 'action_needed';
        return (
          <React.Fragment key={p.key}>
            {i > 0 && <div className={`step-line ${
              phases[keys[i - 1]].status === 'done' ? 'step-line-done' : ''
            }`} />}
            <div className="step">
              <div className={`step-circle ${
                isDone ? 'step-circle-done' : isAction ? 'step-circle-active' : 'step-circle-pending'
              }`}>
                {isDone ? <Check size={14} /> : p.icon}
              </div>
              <span className={`step-label ${
                isDone ? 'step-label-done' : isAction ? 'step-label-active' : ''
              }`}>{p.label}</span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

/* ── Phase Card (expandable wrapper) ── */
function PhaseCard({ phase, index, status, title, summary, expanded, onToggle, children }: {
  phase: string; index: number; status: PhaseStatus; title: string;
  summary: string; expanded: boolean; onToggle: () => void;
  children: React.ReactNode;
}) {
  const badgeClass = status === 'done' ? 'badge-green' : status === 'action_needed' ? 'badge-amber' : 'badge-slate';
  const badgeText = status === 'done' ? 'Done' : status === 'action_needed' ? 'Action Needed' : 'Not Started';
  const Icon = expanded ? ChevronDown : ChevronRight;

  return (
    <div className="phase-card">
      <div className="phase-card-header" onClick={onToggle}>
        <div className="w-7 h-7 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center text-xs font-bold shrink-0">
          {index}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-900">{title}</span>
            <span className={`badge text-[10px] ${badgeClass}`}>{badgeText}</span>
          </div>
          <div className="text-xs text-slate-500 mt-0.5 truncate">{summary}</div>
        </div>
        <Icon size={16} className="text-slate-400 shrink-0" />
      </div>
      {expanded && <div className="phase-card-body">{children}</div>}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   PoolTab root — two-level navigation
   ══════════════════════════════════════════════════════════ */

export function PoolTab() {
  const [selectedDs, setSelectedDs] = useState<string | null>(null);

  return selectedDs
    ? <DataSourceLifecycle dsId={selectedDs} onBack={() => setSelectedDs(null)} />
    : <DataSourceOverview onSelect={setSelectedDs} />;
}

/* ══════════════════════════════════════════════════════════
   Level 1 — Data Source Overview
   ══════════════════════════════════════════════════════════ */

function DataSourceOverview({ onSelect }: { onSelect: (dsId: string) => void }) {
  const [summaries, setSummaries] = useState<LifecycleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showOnboard, setShowOnboard] = useState(false);

  const load = useCallback(async () => {
    try { setSummaries(await api.datasourceLifecycleSummary()); }
    catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="text-center py-20 text-slate-400">Loading data sources...</div>;

  return (
    <div className="space-y-6">
      <div className="page-header flex items-start justify-between">
        <div>
          <h1 className="page-title">Connection Pool Management</h1>
          <p className="page-desc">Manage database onboarding lifecycle — each data source progresses through 6 phases</p>
        </div>
        <button onClick={() => setShowOnboard(!showOnboard)}
          className="btn-primary btn-sm gap-1 shrink-0">
          <Plus size={14} /> Onboard New Database
        </button>
      </div>

      {showOnboard && (
        <OnboardForm onCreated={(dsId) => { setShowOnboard(false); load(); onSelect(dsId); }} onCancel={() => setShowOnboard(false)} />
      )}

      {summaries.length === 0 && !showOnboard && (
        <div className="card p-12 text-center">
          <Database size={40} className="text-slate-300 mx-auto mb-3" />
          <div className="text-slate-500 text-sm mb-4">No data sources registered yet</div>
          <button onClick={() => setShowOnboard(true)} className="btn-primary btn-sm gap-1">
            <Plus size={14} /> Onboard Your First Database
          </button>
        </div>
      )}

      <div className="grid gap-3">
        {summaries.map(ds => (
          <div key={ds.source_id}
            className="card hover:shadow-md transition-shadow cursor-pointer"
            onClick={() => onSelect(ds.source_id)}>
            <div className="px-5 py-4 flex items-center gap-4">
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                ds.is_active ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-400'
              }`}>
                <Database size={20} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-slate-900">{ds.display_name}</span>
                  <span className="badge badge-blue text-[10px]">{ds.db_type}</span>
                  {!ds.is_active && <span className="badge badge-red text-[10px]">Inactive</span>}
                </div>
                <div className="text-xs text-slate-500 font-mono mt-0.5">
                  {ds.host}:{ds.port}/{ds.database_name}
                </div>
              </div>
              <div className="text-right shrink-0 flex items-center gap-4">
                <div>
                  <div className="text-xs text-slate-500 mb-1">{ds.phases_done}/{ds.phases_total} phases</div>
                  <LifecycleSummaryDots done={ds.phases_done} total={ds.phases_total} />
                </div>
                <div className="text-right">
                  <div className={`text-xs font-medium ${ds.phases_done === ds.phases_total ? 'text-emerald-600' : 'text-amber-600'}`}>
                    {ds.next_action}
                  </div>
                </div>
                <ChevronRight size={16} className="text-slate-300" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LifecycleSummaryDots({ done, total }: { done: number; total: number }) {
  return (
    <div className="lifecycle-bar">
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className={`lifecycle-dot ${i < done ? 'lifecycle-dot-done' : 'lifecycle-dot-pending'}`} />
      ))}
    </div>
  );
}

/* ── Onboard Form (inline, for new DS registration) ── */

function OnboardForm({ onCreated, onCancel }: { onCreated: (dsId: string) => void; onCancel: () => void }) {
  const [form, setForm] = useState({ source_id: '', display_name: '', db_type: 'postgresql', host: '', port: '5432', database_name: '', schemas: 'public', connector_user: '', connector_password: '', owner_subject: '' });
  const [sourceIdManual, setSourceIdManual] = useState(false);
  const [subjectList, setSubjectList] = useState<{ subject_id: string; display_name: string }[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.subjects().then((s: any[]) => setSubjectList(s.map(x => ({ subject_id: x.subject_id, display_name: x.display_name })))).catch(() => {});
  }, []);

  const suggestSourceId = (name: string) => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    return slug ? `ds:${slug}` : '';
  };

  const dbTypePortDefaults: Record<string, string> = { postgresql: '5432', greenplum: '5432' };

  const handleCreate = async () => {
    setCreating(true);
    try {
      await api.datasourceCreate({
        source_id: form.source_id, display_name: form.display_name,
        db_type: form.db_type,
        host: form.host, port: parseInt(form.port), database_name: form.database_name,
        schemas: form.schemas.split(',').map(s => s.trim()),
        connector_user: form.connector_user, connector_password: form.connector_password,
        owner_subject: form.owner_subject || undefined,
      });
      onCreated(form.source_id);
    } catch (err) { alert(String(err)); }
    finally { setCreating(false); }
  };

  return (
    <div className="card border-blue-200">
      <div className="card-header">
        <h3 className="text-sm font-semibold text-slate-900">Register New Data Source</h3>
        <button onClick={onCancel} className="btn-ghost btn-sm"><X size={14} /></button>
      </div>
      <div className="p-4 space-y-3">
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <div>
            <label className="label">Display Name</label>
            <input className="input" placeholder="Manufacturing Database" value={form.display_name} onChange={e => {
              const v = e.target.value;
              setForm(f => ({ ...f, display_name: v }));
              if (!sourceIdManual) setForm(f => ({ ...f, display_name: v, source_id: suggestSourceId(v) }));
            }} />
          </div>
          <div>
            <label className="label flex items-center gap-1">
              Source ID
              {form.source_id === suggestSourceId(form.display_name) && form.source_id && (
                <span className="text-green-500 text-[10px] font-normal">(auto)</span>
              )}
            </label>
            <input className="input font-mono" placeholder="ds:manufacturing" value={form.source_id}
              onChange={e => { setForm(f => ({ ...f, source_id: e.target.value })); setSourceIdManual(true); }} />
          </div>
          <div>
            <label className="label">DB Type</label>
            <select className="select" value={form.db_type} onChange={e => {
              const t = e.target.value;
              setForm(f => ({ ...f, db_type: t, port: dbTypePortDefaults[t] ?? f.port }));
            }}>
              <option value="postgresql">PostgreSQL</option>
              <option value="greenplum">Greenplum</option>
            </select>
          </div>
          <div>
            <label className="label">Host</label>
            <input className="input" placeholder="192.168.1.100" value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))} />
          </div>
          <div>
            <label className="label flex items-center gap-1">
              Port <span className="text-slate-400 text-[10px] font-normal">({form.db_type})</span>
            </label>
            <input className="input" type="number" value={form.port} onChange={e => setForm(f => ({ ...f, port: e.target.value }))} />
          </div>
          <div>
            <label className="label">Database Name</label>
            <input className="input" placeholder="nexus_data" value={form.database_name} onChange={e => setForm(f => ({ ...f, database_name: e.target.value }))} />
          </div>
          <div>
            <label className="label">Schemas (comma-separated)</label>
            <input className="input" value={form.schemas} onChange={e => setForm(f => ({ ...f, schemas: e.target.value }))} />
          </div>
          <div>
            <label className="label">Connector User</label>
            <input className="input font-mono" placeholder="gpadmin" value={form.connector_user} onChange={e => setForm(f => ({ ...f, connector_user: e.target.value }))} />
          </div>
          <div>
            <label className="label">Connector Password</label>
            <input className="input" type="password" value={form.connector_password} onChange={e => setForm(f => ({ ...f, connector_password: e.target.value }))} />
          </div>
          <div>
            <label className="label">Owner (subject)</label>
            <select className="select" value={form.owner_subject} onChange={e => setForm(f => ({ ...f, owner_subject: e.target.value }))}>
              <option value="">-- none --</option>
              {subjectList.map(s => (
                <option key={s.subject_id} value={s.subject_id}>{s.display_name} ({s.subject_id})</option>
              ))}
            </select>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={handleCreate} disabled={creating || !form.source_id || !form.host || !form.database_name || !form.connector_user || !form.connector_password}
            className="btn btn-sm bg-green-600 text-white hover:bg-green-700 disabled:opacity-40">
            {creating ? 'Creating...' : 'Register & Test Connection'}
          </button>
          <button onClick={onCancel} className="btn btn-sm bg-white text-slate-600 border border-slate-300 hover:bg-slate-50">Cancel</button>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   Level 2 — Data Source Lifecycle Detail
   ══════════════════════════════════════════════════════════ */

function DataSourceLifecycle({ dsId, onBack }: { dsId: string; onBack: () => void }) {
  const [lifecycle, setLifecycle] = useState<LifecycleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const lc = await api.datasourceLifecycle(dsId);
      setLifecycle(lc);
      // Auto-expand first non-done phase
      if (!expanded) {
        const keys = ['connection', 'discovery', 'organization', 'profiles', 'credentials', 'deployment'] as const;
        const firstIncomplete = keys.find(k => lc.phases[k].status !== 'done');
        setExpanded(firstIncomplete || null);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [dsId]);

  useEffect(() => { load(); }, [load]);

  const onMutate = () => { load(); };

  if (loading || !lifecycle) {
    return <div className="text-center py-20 text-slate-400">Loading lifecycle...</div>;
  }

  const phaseDone = Object.values(lifecycle.phases).filter(p => p.status === 'done').length;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="btn-ghost btn-sm p-1.5"><ArrowLeft size={18} /></button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="page-title truncate">{lifecycle.display_name}</h1>
            <span className="badge badge-blue text-[10px]">{lifecycle.db_type}</span>
            {!lifecycle.is_active && <span className="badge badge-red text-[10px]">Inactive</span>}
          </div>
          <div className="text-xs text-slate-500 font-mono">{lifecycle.host}:{lifecycle.port}/{lifecycle.database_name}</div>
        </div>
        <div className="text-sm text-slate-500">{phaseDone}/6 phases</div>
      </div>

      {/* Progress stepper */}
      <div className="card p-4 sm:p-5">
        <LifecycleStepper phases={lifecycle.phases} />
      </div>

      {/* Phase cards */}
      <div className="space-y-3">
        {phaseLabels.map((p, i) => {
          const key = p.key as keyof LifecycleResponse['phases'];
          const phase = lifecycle.phases[key];
          const summaryText = phaseSummary(key, lifecycle.phases);
          return (
            <PhaseCard
              key={p.key}
              phase={p.key}
              index={i + 1}
              status={phase.status}
              title={p.label}
              summary={summaryText}
              expanded={expanded === p.key}
              onToggle={() => setExpanded(expanded === p.key ? null : p.key)}
            >
              {p.key === 'connection'   && <ConnectionPhase dsId={dsId} lifecycle={lifecycle} onMutate={onMutate} onPurged={onBack} />}
              {p.key === 'discovery'    && <DiscoveryPhase dsId={dsId} lifecycle={lifecycle} onMutate={onMutate} />}
              {p.key === 'organization' && <OrganizationPhase dsId={dsId} lifecycle={lifecycle} onMutate={onMutate} />}
              {p.key === 'profiles'     && <ProfilesPhase dsId={dsId} lifecycle={lifecycle} onMutate={onMutate} />}
              {p.key === 'credentials'  && <CredentialsPhase dsId={dsId} onMutate={onMutate} />}
              {p.key === 'deployment'   && <DeploymentPhase dsId={dsId} onMutate={onMutate} />}
            </PhaseCard>
          );
        })}
      </div>
    </div>
  );
}

function phaseSummary(key: string, phases: LifecycleResponse['phases']): string {
  switch (key) {
    case 'connection':
      return phases.connection.status === 'done' ? 'Connection active' : 'Not connected';
    case 'discovery':
      return phases.discovery.status === 'done'
        ? `${phases.discovery.tables} tables, ${phases.discovery.columns} columns`
        : phases.discovery.status === 'not_started' ? 'Run discovery to scan schema' : '';
    case 'organization':
      return phases.organization.status === 'done'
        ? `All ${phases.organization.mapped} tables mapped`
        : phases.organization.unmapped > 0
          ? `${phases.organization.unmapped} unmapped / ${phases.organization.mapped} mapped`
          : 'No tables to map';
    case 'profiles':
      return phases.profiles.status === 'done'
        ? `${phases.profiles.count} profile${phases.profiles.count !== 1 ? 's' : ''} configured`
        : 'No profiles created';
    case 'credentials':
      return phases.credentials.status === 'done'
        ? `${phases.credentials.credentialed} credential${phases.credentials.credentialed !== 1 ? 's' : ''} active`
        : phases.credentials.uncredentialed > 0
          ? `${phases.credentials.uncredentialed} role${phases.credentials.uncredentialed !== 1 ? 's' : ''} need credentials`
          : 'Create profiles first';
    case 'deployment':
      return phases.deployment.last_sync
        ? `Last sync: ${new Date(phases.deployment.last_sync).toLocaleString()}`
        : 'Never synced';
    default: return '';
  }
}

/* ══════════════════════════════════════════════════════════
   Phase 1: Connection
   ══════════════════════════════════════════════════════════ */

function ConnectionPhase({ dsId, lifecycle, onMutate, onPurged }: { dsId: string; lifecycle: LifecycleResponse; onMutate: () => void; onPurged: () => void }) {
  const [testResult, setTestResult] = useState<{ status: string; version?: string; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ display_name: '', host: '', port: '', database_name: '', schemas: '', connector_user: '', connector_password: '' });
  const [dangerConfirm, setDangerConfirm] = useState<ConfirmState>(null);

  const handleTest = async () => {
    setTesting(true);
    try { setTestResult(await api.datasourceTest(dsId)); }
    catch (err) { setTestResult({ status: 'failed', error: String(err) }); }
    finally { setTesting(false); }
  };

  const startEdit = async () => {
    try {
      const ds = await api.datasource(dsId);
      setForm({ display_name: ds.display_name, host: ds.host, port: String(ds.port), database_name: ds.database_name, schemas: ds.schemas.join(', '), connector_user: ds.connector_user, connector_password: '' });
      setEditing(true);
    } catch (err) { alert(String(err)); }
  };

  const handleSave = () => {
    setDangerConfirm({
      title: `Update Data Source "${dsId}"`,
      message: 'Changing connection settings will immediately affect all pool profiles linked to this data source.',
      impact: 'Active database connections may be interrupted. Downstream queries and PgBouncer routing could fail until the new settings are verified.',
      onConfirm: async () => {
        try {
          await api.datasourceUpdate(dsId, {
            display_name: form.display_name, host: form.host, port: parseInt(form.port),
            database_name: form.database_name,
            schemas: form.schemas.split(',').map(s => s.trim()),
            connector_user: form.connector_user,
            ...(form.connector_password ? { connector_password: form.connector_password } : {}),
          });
          setEditing(false);
          onMutate();
        } catch (err) { alert(String(err)); }
      },
    });
  };

  const handleDeactivate = () => {
    setDangerConfirm({
      title: `Deactivate Data Source "${dsId}"`,
      message: 'This will soft-delete the data source. Associated pool profiles will lose their data source reference.',
      impact: 'Pool profiles linked to this source will no longer be able to establish new connections.',
      onConfirm: async () => {
        try { await api.datasourceDelete(dsId); onMutate(); }
        catch (err) { alert(String(err)); }
      },
    });
  };

  const handleReactivate = async () => {
    try { await api.datasourceUpdate(dsId, { is_active: true } as Partial<DataSource>); onMutate(); }
    catch (err) { alert(String(err)); }
  };

  const handlePurge = () => {
    setDangerConfirm({
      title: `Permanently Delete "${dsId}"`,
      message: 'This will permanently remove the data source, all discovered resources (tables/columns), linked pool profiles, and their assignments. This action cannot be undone.',
      impact: 'All configuration for this data source will be lost. Credentials for linked PG roles will remain but become orphaned.',
      onConfirm: async () => {
        try {
          const result = await api.datasourcePurge(dsId);
          alert(`Purged "${dsId}": ${result.tables_deleted} tables, ${result.columns_deleted} columns, ${result.profiles_deleted} profiles deleted.`);
          onPurged();
        } catch (err) { alert(String(err)); }
      },
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div><span className="text-xs text-slate-500 block">Host</span><span className="font-mono">{lifecycle.host}</span></div>
        <div><span className="text-xs text-slate-500 block">Port</span><span className="font-mono">{lifecycle.port}</span></div>
        <div><span className="text-xs text-slate-500 block">Database</span><span className="font-mono">{lifecycle.database_name}</span></div>
        <div><span className="text-xs text-slate-500 block">Type</span><span>{lifecycle.db_type}</span></div>
      </div>

      {testResult && (
        <div className={`rounded-lg px-4 py-3 text-sm ${testResult.status === 'ok' ? 'bg-emerald-50 border border-emerald-200 text-emerald-800' : 'bg-red-50 border border-red-200 text-red-800'}`}>
          {testResult.status === 'ok' ? `Connected — ${testResult.version}` : `Failed — ${testResult.error}`}
        </div>
      )}

      {editing && (
        <div className="bg-slate-50 rounded-lg p-4 space-y-3 border border-slate-200">
          <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
            <div>
              <label className="label">Display Name</label>
              <input className="input" value={form.display_name} onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))} />
            </div>
            <div>
              <label className="label">Host</label>
              <input className="input" value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))} />
            </div>
            <div>
              <label className="label">Port</label>
              <input className="input" type="number" value={form.port} onChange={e => setForm(f => ({ ...f, port: e.target.value }))} />
            </div>
            <div>
              <label className="label">Database</label>
              <input className="input" value={form.database_name} onChange={e => setForm(f => ({ ...f, database_name: e.target.value }))} />
            </div>
            <div>
              <label className="label">Schemas</label>
              <input className="input" value={form.schemas} onChange={e => setForm(f => ({ ...f, schemas: e.target.value }))} />
            </div>
            <div>
              <label className="label">Connector User</label>
              <input className="input font-mono" value={form.connector_user} onChange={e => setForm(f => ({ ...f, connector_user: e.target.value }))} />
            </div>
            <div>
              <label className="label">Connector Password</label>
              <input className="input" type="password" placeholder="(unchanged)" value={form.connector_password}
                onChange={e => setForm(f => ({ ...f, connector_password: e.target.value }))} />
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleSave} className="btn btn-sm bg-green-600 text-white hover:bg-green-700">Save Changes</button>
            <button onClick={() => setEditing(false)} className="btn-secondary btn-sm">Cancel</button>
          </div>
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        <button onClick={handleTest} disabled={testing} className="btn-secondary btn-sm gap-1">
          {testing ? <RefreshCw size={12} className="animate-spin" /> : <Zap size={12} />}
          {testing ? 'Testing...' : 'Test Connection'}
        </button>
        {lifecycle.is_active ? (
          <>
            <button onClick={startEdit} className="btn-secondary btn-sm gap-1"><Pencil size={12} /> Edit</button>
            <button onClick={handleDeactivate} className="btn btn-sm bg-white border border-red-300 hover:bg-red-50 text-red-600 gap-1"><Trash2 size={12} /> Deactivate</button>
          </>
        ) : (
          <>
            <button onClick={handleReactivate} className="btn btn-sm bg-white border border-green-400 hover:bg-green-50 text-green-700 gap-1"><Undo2 size={12} /> Reactivate</button>
            <button onClick={handlePurge} className="btn-danger btn-sm gap-1"><Trash2 size={12} /> Delete Permanently</button>
          </>
        )}
      </div>
      <DangerConfirmModal state={dangerConfirm} onClose={() => setDangerConfirm(null)} />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   Phase 2: Discovery
   ══════════════════════════════════════════════════════════ */

function DiscoveryPhase({ dsId, lifecycle, onMutate }: { dsId: string; lifecycle: LifecycleResponse; onMutate: () => void }) {
  const [discovering, setDiscovering] = useState(false);
  const [discoverResult, setDiscoverResult] = useState<{ tables_found: number; resources_created: number } | null>(null);
  const [tablesData, setTablesData] = useState<{ table_schema: string; table_name: string; column_count: string }[] | null>(null);
  const [loadingTables, setLoadingTables] = useState(false);

  const handleDiscover = async () => {
    setDiscovering(true);
    try {
      const result = await api.datasourceDiscover(dsId);
      setDiscoverResult({ tables_found: result.tables_found, resources_created: result.resources_created });
      onMutate();
    } catch (err) { alert(String(err)); }
    finally { setDiscovering(false); }
  };

  const handleViewTables = async () => {
    if (tablesData) { setTablesData(null); return; }
    setLoadingTables(true);
    try {
      const result = await api.datasourceTables(dsId);
      setTablesData(result.tables);
    } catch (err) { alert(String(err)); }
    finally { setLoadingTables(false); }
  };

  const disc = lifecycle.phases.discovery;

  return (
    <div className="space-y-4">
      {disc.status === 'done' && (
        <div className="grid grid-cols-3 gap-4 text-center">
          <div className="bg-slate-50 rounded-lg p-3">
            <div className="text-xl font-bold text-slate-900">{disc.tables}</div>
            <div className="text-xs text-slate-500">Tables</div>
          </div>
          <div className="bg-slate-50 rounded-lg p-3">
            <div className="text-xl font-bold text-slate-900">{disc.columns}</div>
            <div className="text-xs text-slate-500">Columns</div>
          </div>
          <div className="bg-slate-50 rounded-lg p-3">
            <div className="text-xs text-slate-500">Last Discovered</div>
            <div className="text-sm font-medium text-slate-700 mt-1">
              {disc.last_discovered ? new Date(disc.last_discovered).toLocaleString() : 'Never'}
            </div>
          </div>
        </div>
      )}

      {discoverResult && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 text-sm text-emerald-800">
          Found {discoverResult.tables_found} tables, created {discoverResult.resources_created} new resources
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        <button onClick={handleDiscover} disabled={discovering} className="btn-primary btn-sm gap-1">
          {discovering ? <RefreshCw size={12} className="animate-spin" /> : <Search size={12} />}
          {discovering ? 'Discovering...' : disc.status === 'done' ? 'Re-discover' : 'Discover Schema'}
        </button>
        {disc.status === 'done' && (
          <button onClick={handleViewTables} disabled={loadingTables} className="btn-secondary btn-sm gap-1">
            {loadingTables ? <RefreshCw size={12} className="animate-spin" /> : <Database size={12} />}
            {tablesData ? 'Hide Tables' : 'View Tables'}
          </button>
        )}
      </div>

      {tablesData && (
        <div className="grid grid-cols-3 gap-1 mt-2">
          {tablesData.map(t => (
            <div key={`${t.table_schema}.${t.table_name}`} className="font-mono text-xs text-slate-700">
              {t.table_schema}.<span className="font-bold">{t.table_name}</span>
              <span className="text-slate-400 ml-1">({t.column_count} cols)</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   Phase 3: Organization (Table → Module Mapping)
   ══════════════════════════════════════════════════════════ */

function OrganizationPhase({ dsId, lifecycle, onMutate }: { dsId: string; lifecycle: LifecycleResponse; onMutate: () => void }) {
  const [unmappedTables, setUnmappedTables] = useState<{ resource_id: string; display_name: string; attributes: Record<string, unknown> }[]>([]);
  const [mappedTables, setMappedTables] = useState<{ resource_id: string; display_name: string; parent_id: string | null; module_name: string | null }[]>([]);
  const [modules, setModules] = useState<{ resource_id: string; display_name: string; parent_id: string | null }[]>([]);
  const [pendingMappings, setPendingMappings] = useState<Record<string, string>>({});
  const [newModuleName, setNewModuleName] = useState('');
  const [newModuleDisplay, setNewModuleDisplay] = useState('');
  const [savingMapping, setSavingMapping] = useState(false);
  const [loaded, setLoaded] = useState(false);

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
      setPendingMappings({});
    } catch (err) { alert(String(err)); }
    finally { setLoaded(true); }
  }, [dsId]);

  useEffect(() => { loadMapping(); }, [loadMapping]);

  const groupByPrefix = (tables: typeof unmappedTables) => {
    const groups: Record<string, typeof unmappedTables> = {};
    for (const t of tables) {
      const prefix = (t.attributes?.table_prefix as string) || t.resource_id.replace(/^table:/, '').match(/^([a-z]+)/i)?.[1]?.toLowerCase() || 'other';
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
    } catch (err) { alert(String(err)); }
  };

  const handleSaveMappings = async () => {
    const entries = Object.entries(pendingMappings).filter(([, v]) => v);
    if (entries.length === 0) return;
    setSavingMapping(true);
    try {
      await api.resourcesBulkParent(entries.map(([resource_id, parent_id]) => ({ resource_id, parent_id })));
      await loadMapping();
      onMutate();
    } catch (err) { alert(String(err)); }
    finally { setSavingMapping(false); }
  };

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
          <div className="text-xs font-semibold text-slate-700 mb-2">Unmapped Tables (grouped by prefix)</div>
          {Object.entries(groupByPrefix(unmappedTables)).map(([prefix, tables]) => (
            <div key={prefix} className="mb-3 bg-white rounded-lg border border-purple-200 p-3">
              <div className="flex items-center gap-2 mb-2">
                <span className="font-mono text-xs font-bold text-purple-800 bg-purple-100 px-2 py-0.5 rounded">{prefix}_*</span>
                <span className="text-xs text-slate-500">{tables.length} table{tables.length > 1 ? 's' : ''}</span>
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
              <div className="grid grid-cols-2 gap-1">
                {tables.map(t => {
                  const tName = t.resource_id.replace(/^table:/, '');
                  return (
                    <div key={t.resource_id} className="flex items-center gap-2">
                      <span className="font-mono text-xs text-slate-700 flex-1">{tName}</span>
                      <select className="input input-sm text-xs w-44"
                        value={pendingMappings[t.resource_id] || ''}
                        onChange={e => setPendingMappings(prev => ({ ...prev, [t.resource_id]: e.target.value }))}>
                        <option value="">-- no module --</option>
                        {modules.map(m => (
                          <option key={m.resource_id} value={m.resource_id}>{m.display_name}</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          <button onClick={handleSaveMappings}
            disabled={savingMapping || Object.values(pendingMappings).filter(Boolean).length === 0}
            className="btn btn-sm bg-purple-600 text-white hover:bg-purple-700 gap-1 mt-2">
            {savingMapping ? <RefreshCw size={14} className="animate-spin" /> : <Play size={14} />}
            Save Mappings ({Object.values(pendingMappings).filter(Boolean).length} tables)
          </button>
        </div>
      )}

      {/* Already mapped tables */}
      {mappedTables.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-slate-700 mb-2">Already Mapped</div>
          <div className="grid grid-cols-2 gap-1">
            {mappedTables.map(t => (
              <div key={t.resource_id} className="font-mono text-xs text-slate-600 flex items-center gap-1">
                <span>{t.resource_id.replace(/^table:/, '')}</span>
                <span className="text-slate-400">&rarr;</span>
                <span className="text-purple-600 font-semibold">{t.module_name || t.parent_id}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {unmappedTables.length === 0 && mappedTables.length === 0 && (
        <div className="text-xs text-slate-400 text-center py-4">No table resources found. Run Discover first.</div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   Phase 4: Profiles
   ══════════════════════════════════════════════════════════ */

/* Profile form helpers (kept from original) */
type ProfileFormData = {
  profile_id: string;
  pg_role: string;
  connection_mode: 'readonly' | 'readwrite' | 'admin';
  max_connections: number;
  allowed_schemas: string;
  allowed_tables: string;
  allowed_modules: string;
  rls_applies: boolean;
  description: string;
  is_active: boolean;
  data_source_id: string;
};

const emptyForm: ProfileFormData = {
  profile_id: '', pg_role: '', connection_mode: 'readonly',
  max_connections: 5, allowed_schemas: '', allowed_tables: '',
  allowed_modules: '',
  rls_applies: true, description: '', is_active: true,
  data_source_id: '',
};

function profileToForm(p: PoolProfile): ProfileFormData {
  return {
    profile_id: p.profile_id, pg_role: p.pg_role, connection_mode: p.connection_mode,
    max_connections: p.max_connections,
    allowed_schemas: p.allowed_schemas?.join(', ') ?? '',
    allowed_tables: p.allowed_tables?.join(', ') ?? '',
    rls_applies: p.rls_applies, description: p.description ?? '', is_active: p.is_active,
    data_source_id: p.data_source_id ?? '',
    allowed_modules: p.allowed_modules?.join(', ') ?? '',
  };
}

function formToPayload(f: ProfileFormData, isCreate: boolean) {
  const base: Record<string, unknown> = {
    connection_mode: f.connection_mode, max_connections: f.max_connections,
    allowed_schemas: f.allowed_schemas ? f.allowed_schemas.split(',').map(s => s.trim()).filter(Boolean) : [],
    allowed_tables: f.allowed_tables ? f.allowed_tables.split(',').map(s => s.trim()).filter(Boolean) : null,
    rls_applies: f.rls_applies, description: f.description || null,
    data_source_id: f.data_source_id || null,
    allowed_modules: f.allowed_modules ? f.allowed_modules.split(',').map(s => s.trim()).filter(Boolean) : null,
  };
  if (isCreate) { base.profile_id = f.profile_id; base.pg_role = f.pg_role; }
  else { base.is_active = f.is_active; }
  return base;
}

function ProfileForm({ initial, isCreate, onSave, onCancel, saving, error, lockedDsId }: {
  initial: ProfileFormData; isCreate: boolean;
  onSave: (data: ProfileFormData) => void; onCancel: () => void;
  saving: boolean; error: string; lockedDsId?: string;
}) {
  const [form, setForm] = useState(initial);
  const set = (k: keyof ProfileFormData, v: unknown) => setForm(prev => ({ ...prev, [k]: v }));
  const [dsList, setDsList] = useState<DataSource[]>([]);
  const [dsSchemas, setDsSchemas] = useState<string[]>([]);
  const [moduleList, setModuleList] = useState<{ resource_id: string; display_name: string }[]>([]);
  const [schemasLoading, setSchemasLoading] = useState(false);

  useEffect(() => {
    if (lockedDsId) {
      set('data_source_id', lockedDsId);
    }
    api.datasources().then(ds => setDsList(ds.filter(d => d.is_active))).catch(() => {});
  }, []);
  useEffect(() => { api.resourceModules().then(setModuleList).catch(() => {}); }, []);
  useEffect(() => {
    const dsId = lockedDsId || form.data_source_id;
    if (dsId) {
      setSchemasLoading(true);
      api.datasourceSchemas(dsId).then(s => setDsSchemas(s)).catch(() => setDsSchemas([])).finally(() => setSchemasLoading(false));
    } else { setDsSchemas(['public']); }
  }, [form.data_source_id, lockedDsId]);

  const suggestPgRole = (profileId: string) => {
    const suffix = profileId.replace(/^pool:/, '');
    return suffix ? `nexus_${suffix}` : '';
  };

  const modeDefaults: Record<string, number> = { readonly: 20, readwrite: 10, admin: 5 };

  const selectedSchemas = form.allowed_schemas ? form.allowed_schemas.split(',').map(s => s.trim()).filter(Boolean) : [];
  const toggleSchema = (s: string) => {
    const next = selectedSchemas.includes(s) ? selectedSchemas.filter(x => x !== s) : [...selectedSchemas, s];
    set('allowed_schemas', next.join(', '));
  };

  const selectedModules = form.allowed_modules ? form.allowed_modules.split(',').map(s => s.trim()).filter(Boolean) : [];
  const toggleModule = (m: string) => {
    const next = selectedModules.includes(m) ? selectedModules.filter(x => x !== m) : [...selectedModules, m];
    set('allowed_modules', next.join(', '));
  };

  return (
    <div className="card border-blue-200 bg-blue-50/30">
      <div className="card-header">
        <h3 className="text-sm font-semibold text-slate-900">
          {isCreate ? 'Create New Profile' : `Edit: ${form.profile_id}`}
        </h3>
        <button onClick={onCancel} className="btn-ghost btn-sm"><X size={14} /></button>
      </div>
      <div className="card-body space-y-4">
        {error && <div className="bg-red-50 text-red-700 border border-red-200 rounded-lg p-3 text-sm">{error}</div>}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {isCreate && (
            <>
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Profile ID</label>
                <input value={form.profile_id} onChange={e => {
                  const v = e.target.value; set('profile_id', v);
                  if (!form.pg_role || form.pg_role === suggestPgRole(form.profile_id)) set('pg_role', suggestPgRole(v));
                }} placeholder="pool:pe_readonly" className="input font-mono" />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                  PG Role
                  {form.pg_role === suggestPgRole(form.profile_id) && form.pg_role && (
                    <span className="text-green-500 normal-case font-normal ml-1">(auto)</span>
                  )}
                </label>
                <input value={form.pg_role} onChange={e => set('pg_role', e.target.value)} placeholder="nexus_pe_ro" className="input font-mono" />
              </div>
            </>
          )}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Connection Mode</label>
            <select value={form.connection_mode} onChange={e => {
              const mode = e.target.value; set('connection_mode', mode);
              if (Object.values(modeDefaults).includes(form.max_connections)) set('max_connections', modeDefaults[mode] ?? 5);
            }} className="select">
              <option value="readonly">readonly (suggest: 20 conn)</option>
              <option value="readwrite">readwrite (suggest: 10 conn)</option>
              <option value="admin">admin (suggest: 5 conn)</option>
            </select>
          </div>
          {!lockedDsId && (
            <div>
              <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Data Source</label>
              <select value={form.data_source_id} onChange={e => {
                const dsId = e.target.value; set('data_source_id', dsId);
                const ds = dsList.find(d => d.source_id === dsId);
                if (ds) set('allowed_schemas', ds.schemas.join(', '));
              }} className="select">
                <option value="">Local (authz DB)</option>
                {dsList.map(ds => (
                  <option key={ds.source_id} value={ds.source_id}>
                    {ds.display_name} ({ds.host}:{ds.port}/{ds.database_name})
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
              Max Connections <span className="text-slate-400 normal-case font-normal ml-1">(suggested: {modeDefaults[form.connection_mode] ?? 5})</span>
            </label>
            <input type="number" value={form.max_connections} onChange={e => set('max_connections', Number(e.target.value))}
              min={1} max={100} className="input" />
          </div>
          <ChipSelect
            label={`Allowed Schemas${schemasLoading ? ' (loading...)' : form.data_source_id || lockedDsId ? ' (from data source)' : ''}`}
            items={dsSchemas.map(s => ({ id: s, label: s }))}
            selected={selectedSchemas} onToggle={toggleSchema}
          />
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
              Allowed Tables (comma-sep, empty=ALL)
              {selectedModules.length > 0 && <span className="text-purple-500 normal-case font-normal ml-1">(+ tables from modules)</span>}
            </label>
            <input value={form.allowed_tables} onChange={e => set('allowed_tables', e.target.value)}
              placeholder="leave empty to use modules or ALL" className="input font-mono text-xs" />
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <ChipSelect
              label="Allowed Modules (tables auto-resolved at sync time)"
              items={moduleList.map(m => ({ id: m.resource_id, label: `${m.display_name} (${m.resource_id})` }))}
              selected={selectedModules} onToggle={toggleModule}
              renderItem={item => {
                const mod = moduleList.find(m => m.resource_id === item.id);
                return <>{mod?.display_name ?? item.id}</>;
              }}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Description</label>
            <input value={form.description} onChange={e => set('description', e.target.value)} className="input" />
          </div>
          <div className="flex items-center gap-4 pt-5">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.rls_applies} onChange={e => set('rls_applies', e.target.checked)} className="rounded border-slate-300" />
              RLS Applies
            </label>
            {!isCreate && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.is_active} onChange={e => set('is_active', e.target.checked)} className="rounded border-slate-300" />
                Active
              </label>
            )}
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="btn-secondary btn-sm">Cancel</button>
          <button onClick={() => onSave(form)} disabled={saving} className="btn-primary btn-sm">
            {saving ? 'Saving...' : isCreate ? 'Create' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProfilesPhase({ dsId, lifecycle, onMutate }: { dsId: string; lifecycle: LifecycleResponse; onMutate: () => void }) {
  const [profiles, setProfiles] = useState<PoolProfile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<PoolAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingProfile, setEditingProfile] = useState<PoolProfile | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [showAssignForm, setShowAssignForm] = useState(false);
  const [newSubjectId, setNewSubjectId] = useState('');
  const [subjectOptions, setSubjectOptions] = useState<{ subject_id: string; display_name: string }[]>([]);
  const [dangerConfirm, setDangerConfirm] = useState<ConfirmState>(null);

  const loadProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const all = await api.poolProfiles();
      setProfiles(all.filter(p => p.data_source_id === dsId));
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [dsId]);

  useEffect(() => { loadProfiles(); }, [loadProfiles]);
  useEffect(() => {
    api.subjects().then((s: any[]) => setSubjectOptions(s.map(x => ({ subject_id: x.subject_id, display_name: x.display_name })))).catch(() => {});
  }, []);

  const loadAssignments = async (profileId: string) => {
    setSelected(profileId);
    try { setAssignments(await api.poolAssignments(profileId)); } catch { setAssignments([]); }
  };

  const handleSave = async (form: ProfileFormData) => {
    setSaving(true); setFormError('');
    try {
      if (!editingProfile) {
        await api.poolProfileCreate(formToPayload(form, true) as Partial<PoolProfile>);
      } else {
        await api.poolProfileUpdate(editingProfile.profile_id, formToPayload(form, false) as Partial<PoolProfile>);
      }
      setShowForm(false); setEditingProfile(null);
      await loadProfiles();
      onMutate();
    } catch (e) { setFormError(e instanceof Error ? e.message : 'Save failed'); }
    finally { setSaving(false); }
  };

  const handleDelete = (profileId: string) => {
    setDangerConfirm({
      title: `Delete Pool Profile "${profileId}"`,
      message: 'This will deactivate the pool profile and all its subject assignments.',
      impact: 'Users assigned to this profile will immediately lose their Path C database access.',
      onConfirm: async () => {
        try {
          await api.poolProfileDelete(profileId);
          if (selected === profileId) { setSelected(null); setAssignments([]); }
          await loadProfiles(); onMutate();
        } catch (e) { alert(e instanceof Error ? e.message : 'Delete failed'); }
      },
    });
  };

  const handleReactivate = async (profileId: string) => {
    try { await api.poolProfileUpdate(profileId, { is_active: true } as Partial<PoolProfile>); await loadProfiles(); onMutate(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Reactivate failed'); }
  };

  const handleAssign = async () => {
    if (!newSubjectId.trim() || !selected) return;
    try {
      await api.poolAssignmentCreate({ subject_id: newSubjectId.trim(), profile_id: selected });
      setNewSubjectId(''); setShowAssignForm(false);
      await loadAssignments(selected);
    } catch (e) { alert(e instanceof Error ? e.message : 'Assign failed'); }
  };

  const handleRemoveAssignment = async (assignmentId: number) => {
    if (!confirm('Remove this assignment?')) return;
    try { await api.poolAssignmentDelete(assignmentId); if (selected) await loadAssignments(selected); }
    catch (e) { alert(e instanceof Error ? e.message : 'Remove failed'); }
  };

  const handleReactivateAssignment = async (assignmentId: number) => {
    try { await api.poolAssignmentReactivate(assignmentId); if (selected) await loadAssignments(selected); }
    catch (e) { alert(e instanceof Error ? e.message : 'Reactivate failed'); }
  };

  const modeStyle: Record<string, string> = { readonly: 'badge-green', readwrite: 'badge-amber', admin: 'badge-red' };

  if (loading) return <div className="text-slate-400 text-sm">Loading profiles...</div>;

  return (
    <div className="space-y-4">
      {showForm && (
        <ProfileForm
          initial={editingProfile ? profileToForm(editingProfile) : { ...emptyForm, data_source_id: dsId }}
          isCreate={!editingProfile}
          onSave={handleSave}
          onCancel={() => { setShowForm(false); setEditingProfile(null); }}
          saving={saving} error={formError} lockedDsId={dsId}
        />
      )}

      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500">{profiles.length} profile{profiles.length !== 1 ? 's' : ''} for this data source</div>
        {!showForm && (
          <button onClick={() => { setEditingProfile(null); setShowForm(true); setFormError(''); }}
            className="btn-primary btn-sm gap-1"><Plus size={12} /> Create Profile</button>
        )}
      </div>

      {profiles.length > 0 && (
        <div className="table-container">
          <table className="table">
            <thead>
              <tr><th>Profile ID</th><th>PG Role</th><th>Mode</th><th>Max Conn</th><th>RLS</th><th>Schemas</th><th>Modules</th><th>Assigned</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {profiles.map(p => (
                <tr key={p.profile_id}
                  className={`cursor-pointer ${selected === p.profile_id ? '!bg-blue-50' : ''} ${!p.is_active ? 'opacity-50' : ''}`}
                  onClick={() => loadAssignments(p.profile_id)}>
                  <td className="font-mono text-xs font-bold text-slate-900">{p.profile_id}</td>
                  <td className="font-mono text-xs">{p.pg_role}</td>
                  <td><span className={`badge ${modeStyle[p.connection_mode]}`}>{p.connection_mode}</span></td>
                  <td className="text-center">{p.max_connections}</td>
                  <td className="text-center">
                    {p.rls_applies ? <span className="badge badge-green text-[10px]">YES</span> : <span className="text-slate-300">NO</span>}
                  </td>
                  <td className="text-xs">{p.allowed_schemas?.join(', ')}</td>
                  <td className="text-xs max-w-[150px] truncate">
                    {p.allowed_modules && p.allowed_modules.length > 0
                      ? p.allowed_modules.map(m => m.replace(/^module:/, '')).join(', ')
                      : <span className="text-slate-300">--</span>}
                  </td>
                  <td className="text-center font-medium">{p.assignment_count ?? '-'}</td>
                  <td className="text-center" onClick={e => e.stopPropagation()}>
                    <div className="flex gap-1 justify-center">
                      {p.is_active ? (
                        <>
                          <button onClick={() => { setEditingProfile(p); setShowForm(true); setFormError(''); }} className="btn-ghost btn-sm p-1" title="Edit">
                            <Pencil size={13} className="text-slate-500 hover:text-blue-600" />
                          </button>
                          <button onClick={() => handleDelete(p.profile_id)} className="btn-ghost btn-sm p-1" title="Delete">
                            <Trash2 size={13} className="text-slate-500 hover:text-red-600" />
                          </button>
                        </>
                      ) : (
                        <button onClick={() => handleReactivate(p.profile_id)} className="btn btn-xs bg-white border border-green-400 hover:bg-green-50 text-green-700 gap-1" title="Reactivate">
                          <Undo2 size={12} /> Reactivate
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Assignments for selected profile */}
      {selected && (
        <div className="card">
          <div className="card-header">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
              Assignments <ChevronRight size={14} className="text-slate-400" /> <span className="code">{selected}</span>
            </h3>
            <button onClick={() => { setShowAssignForm(v => !v); setNewSubjectId(''); }} className="btn-primary btn-sm gap-1">
              <Plus size={12} /> Assign Subject
            </button>
          </div>
          <div className="card-body">
            {showAssignForm && (
              <div className="flex gap-2 items-end mb-4 pb-4 border-b border-slate-100">
                <div className="flex-1">
                  <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Subject</label>
                  <select value={newSubjectId} onChange={e => setNewSubjectId(e.target.value)} className="select font-mono text-xs">
                    <option value="">-- Select subject --</option>
                    {subjectOptions.map(s => (
                      <option key={s.subject_id} value={s.subject_id}>{s.subject_id} — {s.display_name}</option>
                    ))}
                  </select>
                </div>
                <button onClick={handleAssign} disabled={!newSubjectId.trim()} className="btn-primary btn-sm">Assign</button>
                <button onClick={() => setShowAssignForm(false)} className="btn-secondary btn-sm">Cancel</button>
              </div>
            )}
            {assignments.length === 0 ? (
              <p className="text-slate-400 text-sm text-center py-4">No assignments</p>
            ) : (
              <div className="table-container">
                <table className="table">
                  <thead><tr><th>Subject ID</th><th>Name</th><th>Granted By</th><th>Status</th><th>Actions</th></tr></thead>
                  <tbody>
                    {assignments.map(a => (
                      <tr key={a.id}>
                        <td className="font-mono text-xs">{a.subject_id}</td>
                        <td className="font-medium">{a.subject_name}</td>
                        <td className="text-xs text-slate-500">{a.granted_by}</td>
                        <td><span className={`badge ${a.is_active ? 'badge-green' : 'badge-red'}`}>{a.is_active ? 'Active' : 'Inactive'}</span></td>
                        <td className="text-center">
                          {a.is_active ? (
                            <button onClick={() => handleRemoveAssignment(a.id)} className="btn-ghost btn-sm p-1" title="Remove">
                              <Trash2 size={13} className="text-slate-500 hover:text-red-600" />
                            </button>
                          ) : (
                            <button onClick={() => handleReactivateAssignment(a.id)}
                              className="btn btn-xs bg-white border border-green-400 hover:bg-green-50 text-green-700 gap-1" title="Reactivate">
                              <Undo2 size={12} /> Reactivate
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
      <DangerConfirmModal state={dangerConfirm} onClose={() => setDangerConfirm(null)} />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   Phase 5: Credentials
   ══════════════════════════════════════════════════════════ */

function CredentialsPhase({ dsId, onMutate }: { dsId: string; onMutate: () => void }) {
  const [creds, setCreds] = useState<PoolCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [rotatingRole, setRotatingRole] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [rotating, setRotating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createForm, setCreateForm] = useState({ pg_role: '', password: '', rotate_interval: '90 days' });
  const [creating, setCreating] = useState(false);
  const [dangerConfirm, setDangerConfirm] = useState<ConfirmState>(null);
  const [uncredRoles, setUncredRoles] = useState<{ profile_id: string; pg_role: string }[]>([]);
  const [manualPgRole, setManualPgRole] = useState(false);

  // Load credentials + filter to those linked to this DS's profiles
  const loadCreds = useCallback(async () => {
    setLoading(true);
    try {
      const [allCreds, allProfiles] = await Promise.all([
        api.poolCredentials(),
        api.poolProfiles(),
      ]);
      const dsRoles = new Set(allProfiles.filter(p => p.data_source_id === dsId).map(p => p.pg_role));
      setCreds(allCreds.filter(c => dsRoles.has(c.pg_role)));
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, [dsId]);

  useEffect(() => { loadCreds(); }, [loadCreds]);

  useEffect(() => {
    if (showCreateForm) {
      api.poolUncredentialedRoles()
        .then((r: any[]) => setUncredRoles(r.filter((x: any) => x.data_source_id === dsId)))
        .catch(() => setUncredRoles([]));
      setManualPgRole(false);
    }
  }, [showCreateForm, dsId]);

  const doRotate = async (pg_role: string, password: string) => {
    setRotating(true);
    try { await api.poolCredentialRotate(pg_role, password); setRotatingRole(null); setNewPassword(''); await loadCreds(); onMutate(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Rotate failed'); }
    finally { setRotating(false); }
  };

  const handleRotate = (pg_role: string) => {
    if (!newPassword.trim()) return;
    const pw = newPassword;
    setDangerConfirm({
      title: `Rotate Password for "${pg_role}"`,
      message: 'The current password will be invalidated immediately.',
      impact: 'All active connections using this PG role will fail on next authentication.',
      onConfirm: () => doRotate(pg_role, pw),
    });
  };

  const handleCreateCred = async () => {
    if (!createForm.pg_role.trim() || !createForm.password.trim()) return;
    setCreating(true);
    try {
      await api.poolCredentialCreate(createForm.pg_role, createForm.password, createForm.rotate_interval);
      setShowCreateForm(false);
      setCreateForm({ pg_role: '', password: '', rotate_interval: '90 days' });
      await loadCreds(); onMutate();
    } catch (e) { alert(e instanceof Error ? e.message : 'Create failed'); }
    finally { setCreating(false); }
  };

  const handleReactivateCred = async (pg_role: string) => {
    try { await api.poolCredentialReactivate(pg_role); await loadCreds(); onMutate(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Reactivate failed'); }
  };

  const handleDeleteCred = (pg_role: string) => {
    setDangerConfirm({
      title: `Deactivate Credential "${pg_role}"`,
      message: 'This will mark the credential as inactive.',
      impact: 'Any pool profile using this PG role will lose connectivity.',
      onConfirm: async () => {
        try { await api.poolCredentialDelete(pg_role); await loadCreds(); onMutate(); }
        catch (e) { alert(e instanceof Error ? e.message : 'Delete failed'); }
      },
    });
  };

  if (loading) return <div className="text-slate-400 text-sm">Loading credentials...</div>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500">{creds.length} credential{creds.length !== 1 ? 's' : ''} for this data source</div>
        <button onClick={() => setShowCreateForm(!showCreateForm)} className="btn btn-sm bg-blue-600 text-white hover:bg-blue-700 gap-1">
          <Plus size={14} /> Create Credential
        </button>
      </div>

      {showCreateForm && (
        <div className="bg-slate-50 rounded-lg p-4 border border-slate-200 space-y-3">
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="label flex items-center gap-2">
                PG Role
                {!manualPgRole && uncredRoles.length > 0 && (
                  <span className="text-green-500 text-[10px] font-normal">(from profiles)</span>
                )}
                <button type="button" onClick={() => { setManualPgRole(!manualPgRole); setCreateForm(f => ({ ...f, pg_role: '' })); }}
                  className="text-[10px] text-blue-500 hover:text-blue-700 font-normal ml-auto">
                  {manualPgRole ? 'select from list' : 'enter manually'}
                </button>
              </label>
              {manualPgRole ? (
                <input className="input font-mono" placeholder="nexus_custom_role" value={createForm.pg_role}
                  onChange={e => setCreateForm(f => ({ ...f, pg_role: e.target.value }))} />
              ) : (
                <select className="select font-mono" value={createForm.pg_role}
                  onChange={e => setCreateForm(f => ({ ...f, pg_role: e.target.value }))}>
                  <option value="">-- select pg_role --</option>
                  {uncredRoles.length === 0 && <option disabled>All roles have credentials</option>}
                  {uncredRoles.map(r => (
                    <option key={r.pg_role} value={r.pg_role}>{r.pg_role} ({r.profile_id})</option>
                  ))}
                </select>
              )}
            </div>
            <div>
              <label className="label">Password</label>
              <input className="input" type="password" placeholder="Initial password" value={createForm.password}
                onChange={e => setCreateForm(f => ({ ...f, password: e.target.value }))} />
            </div>
            <div>
              <label className="label">Rotate Interval</label>
              <select className="select" value={createForm.rotate_interval}
                onChange={e => setCreateForm(f => ({ ...f, rotate_interval: e.target.value }))}>
                <option value="30 days">30 days</option>
                <option value="60 days">60 days</option>
                <option value="90 days">90 days (default)</option>
                <option value="180 days">180 days</option>
                <option value="365 days">365 days</option>
                <option value="never">Never</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={handleCreateCred} disabled={creating || !createForm.pg_role.trim() || !createForm.password.trim()}
              className="btn btn-sm bg-green-600 text-white hover:bg-green-700">
              {creating ? 'Creating...' : 'Create'}
            </button>
            <button onClick={() => setShowCreateForm(false)} className="btn btn-sm bg-white text-slate-600 border border-slate-300 hover:bg-slate-50">Cancel</button>
          </div>
        </div>
      )}

      {creds.length > 0 && (
        <div className="table-container">
          <table className="table">
            <thead><tr><th>PG Role</th><th>Status</th><th>Last Rotated</th><th>Rotate Interval</th><th>Actions</th></tr></thead>
            <tbody>
              {creds.map(c => (
                <tr key={c.pg_role}>
                  <td className="font-mono text-xs font-bold">{c.pg_role}</td>
                  <td><span className={`badge ${c.is_active ? 'badge-green' : 'badge-red'}`}>{c.is_active ? 'Active' : 'Inactive'}</span></td>
                  <td className="text-xs text-slate-500">{new Date(c.last_rotated).toLocaleString()}</td>
                  <td className="text-xs">
                    {typeof c.rotate_interval === 'object' && c.rotate_interval
                      ? `${(c.rotate_interval as Record<string, number>).days ?? 0} days`
                      : String(c.rotate_interval)}
                  </td>
                  <td>
                    {!c.is_active ? (
                      <button onClick={() => handleReactivateCred(c.pg_role)}
                        className="btn btn-xs bg-white border border-green-400 hover:bg-green-50 text-green-700 gap-1" title="Reactivate">
                        <Undo2 size={12} /> Reactivate
                      </button>
                    ) : rotatingRole === c.pg_role ? (
                      <div className="flex gap-2 items-center">
                        <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
                          placeholder="New password" className="input text-xs w-36"
                          onKeyDown={e => e.key === 'Enter' && handleRotate(c.pg_role)} />
                        <button onClick={() => handleRotate(c.pg_role)} disabled={rotating || !newPassword.trim()} className="btn-primary btn-sm">
                          {rotating ? '...' : 'Confirm'}
                        </button>
                        <button onClick={() => { setRotatingRole(null); setNewPassword(''); }} className="btn-ghost btn-sm"><X size={14} /></button>
                      </div>
                    ) : (
                      <div className="flex gap-1">
                        <button onClick={() => { setRotatingRole(c.pg_role); setNewPassword(''); }} className="btn-secondary btn-sm gap-1">
                          <RotateCw size={12} /> Rotate
                        </button>
                        <button onClick={() => handleDeleteCred(c.pg_role)}
                          className="btn btn-sm bg-white border border-red-300 hover:bg-red-50 text-red-600" title="Deactivate">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creds.length === 0 && !showCreateForm && (
        <div className="text-sm text-slate-400 text-center py-4">No credentials found for this data source's profiles</div>
      )}

      <DangerConfirmModal state={dangerConfirm} onClose={() => setDangerConfirm(null)} />
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   Phase 6: Deployment (Sync)
   ══════════════════════════════════════════════════════════ */

function DeploymentPhase({ dsId, onMutate }: { dsId: string; onMutate: () => void }) {
  const [loading, setLoading] = useState<string | null>(null);
  const [extActions, setExtActions] = useState<SyncAction[] | null>(null);
  const [driftItems, setDriftItems] = useState<DriftItem[] | null>(null);
  const [grantResult, setGrantResult] = useState<{ action: string; detail: string }[] | null>(null);
  const [pgbouncerConfig, setPgbouncerConfig] = useState<string | null>(null);
  const [dangerConfirm, setDangerConfirm] = useState<ConfirmState>(null);

  const handleExternalSync = () => {
    setDangerConfirm({
      title: 'Sync External DB Grants',
      message: `This will sync roles and grants to the data source "${dsId}".`,
      impact: 'Roles will be created, passwords set, and GRANT/REVOKE executed on the remote database.',
      onConfirm: async () => {
        setLoading('ext-sync');
        try {
          const result = await api.poolSyncExternalGrants(dsId);
          setExtActions(result.actions);
          onMutate();
        } catch (e) {
          setExtActions([{ action: 'ERROR', detail: String(e), data_source_id: dsId, profile_id: '', status: 'error', error: String(e) }]);
        }
        setLoading(null);
      },
    });
  };

  const handleCheckDrift = async () => {
    setLoading('ext-drift');
    try {
      const report = await api.poolSyncExternalDrift(dsId);
      setDriftItems(report.items);
    } catch (e) {
      setDriftItems([{ pg_role: '-', type: 'role_missing', detail: `Error: ${String(e)}` }]);
    }
    setLoading(null);
  };

  const handleSyncGrants = () => {
    setDangerConfirm({
      title: 'Sync DB Grants',
      message: 'This will execute authz_sync_db_grants() to create/modify PG roles and GRANT/REVOKE permissions.',
      impact: 'Active database sessions may experience permission changes mid-query.',
      onConfirm: async () => {
        setLoading('grants');
        try { setGrantResult((await api.poolSyncGrants()).actions); onMutate(); } catch { /* ignore */ }
        setLoading(null);
      },
    });
  };

  const handleApplyReload = () => {
    setDangerConfirm({
      title: 'Apply PgBouncer Config & Reload',
      message: 'This will overwrite pgbouncer.ini and send a HUP signal to reload.',
      impact: 'PgBouncer will close idle connections and re-read the config.',
      onConfirm: async () => {
        setLoading('pgbouncer-apply');
        try {
          const result = await api.poolSyncPgbouncerApply();
          setPgbouncerConfig(`Applied: ${result.config_path}\nReload: ${result.reload}`);
        } catch (e) { setPgbouncerConfig(`Error: ${String(e)}`); }
        setLoading(null);
      },
    });
  };

  return (
    <div className="space-y-4">
      {/* External DB Sync (primary action) */}
      <div className="flex gap-2 flex-wrap">
        <button onClick={handleExternalSync} disabled={loading === 'ext-sync'} className="btn-primary btn-sm gap-1">
          <Play size={12} /> {loading === 'ext-sync' ? 'Syncing...' : 'Sync to Remote DB'}
        </button>
        <button onClick={handleCheckDrift} disabled={loading === 'ext-drift'}
          className="btn btn-sm bg-amber-600 text-white hover:bg-amber-700 gap-1">
          <Search size={12} /> {loading === 'ext-drift' ? 'Checking...' : 'Check Drift'}
        </button>
        <button onClick={handleSyncGrants} disabled={loading === 'grants'} className="btn-secondary btn-sm gap-1">
          <Play size={12} /> {loading === 'grants' ? 'Syncing...' : 'Sync Local Grants'}
        </button>
        <button onClick={async () => {
          setLoading('pgbouncer');
          try { setPgbouncerConfig((await api.poolSyncPgbouncer()).config); } catch { /* ignore */ }
          setLoading(null);
        }} disabled={loading === 'pgbouncer'} className="btn-secondary btn-sm gap-1">
          <Play size={12} /> {loading === 'pgbouncer' ? 'Generating...' : 'PgBouncer Preview'}
        </button>
        <button onClick={handleApplyReload} disabled={loading === 'pgbouncer-apply'}
          className="btn btn-sm bg-emerald-600 text-white hover:bg-emerald-700 gap-1">
          <Play size={12} /> {loading === 'pgbouncer-apply' ? 'Applying...' : 'Apply & Reload PgBouncer'}
        </button>
      </div>

      {/* External sync results */}
      {extActions && (
        extActions.length === 0 ? (
          <div className="text-sm text-slate-400">No external profiles to sync</div>
        ) : (
          <div className="table-container">
            <table className="table">
              <thead><tr><th>Action</th><th>Detail</th><th>Profile</th><th>Status</th></tr></thead>
              <tbody>
                {extActions.map((a, i) => (
                  <tr key={i}>
                    <td className="font-mono text-xs">{a.action}</td>
                    <td className="text-xs text-slate-600 max-w-xs truncate">{a.detail}</td>
                    <td className="text-xs">{a.profile_id}</td>
                    <td>
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                        a.status === 'ok' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'
                      }`}>{a.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Drift results */}
      {driftItems && (
        driftItems.length === 0 ? (
          <div className="text-sm text-emerald-600 font-medium">No drift detected — remote DB matches SSOT</div>
        ) : (
          <div className="table-container">
            <div className="text-xs font-semibold text-amber-700 mb-1">Drift Report ({driftItems.length} items)</div>
            <table className="table">
              <thead><tr><th>Role</th><th>Type</th><th>Detail</th></tr></thead>
              <tbody>
                {driftItems.map((d, i) => (
                  <tr key={i}>
                    <td className="font-mono text-xs">{d.pg_role}</td>
                    <td>
                      <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                        d.type === 'role_missing' ? 'bg-red-100 text-red-700' :
                        d.type === 'grant_missing' ? 'bg-amber-100 text-amber-700' :
                        'bg-blue-100 text-blue-700'
                      }`}>{d.type}</span>
                    </td>
                    <td className="text-xs text-slate-600">{d.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Local grant sync results */}
      {grantResult && (
        grantResult.length === 0 ? (
          <div className="text-sm text-slate-400">Already in sync</div>
        ) : (
          <div className="table-container">
            <div className="text-xs font-semibold text-slate-700 mb-1">Local Grant Sync</div>
            <table className="table">
              <thead><tr><th>Action</th><th>Detail</th></tr></thead>
              <tbody>
                {grantResult.map((r, i) => (
                  <tr key={i}><td className="font-mono text-xs">{r.action}</td><td className="text-xs text-slate-600">{r.detail}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* PgBouncer config */}
      {pgbouncerConfig && (
        <pre className="bg-slate-900 text-emerald-400 p-4 rounded-lg text-xs overflow-auto max-h-64 leading-relaxed">
          {pgbouncerConfig}
        </pre>
      )}

      <DangerConfirmModal state={dangerConfirm} onClose={() => setDangerConfirm(null)} />
    </div>
  );
}
