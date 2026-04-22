import { useState, useEffect, useCallback } from 'react';
import { api, LifecycleSummary } from '../../api';
import { useToast } from '../Toast';
import { autoId } from '../../utils/slugify';
import { Plus, X, Database, ChevronRight, Search } from 'lucide-react';
import { LifecycleSummaryDots } from './shared';

export function DataSourceOverview({ onSelect }: { onSelect: (dsId: string) => void }) {
  const toast = useToast();
  const [summaries, setSummaries] = useState<LifecycleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showOnboard, setShowOnboard] = useState(false);
  const [dsSearch, setDsSearch] = useState('');

  const load = useCallback(async () => {
    try { setSummaries(await api.datasourceLifecycleSummary()); }
    catch (err) { toast.error('Failed to load data sources'); console.warn(err); }
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

      {summaries.length > 1 && (
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input className="input pl-9 text-sm" placeholder="Search data sources by name, host, database..."
            value={dsSearch} onChange={e => setDsSearch(e.target.value)} />
        </div>
      )}

      <div className="grid gap-3">
        {summaries.filter(ds => {
          if (!dsSearch.trim()) return true;
          const q = dsSearch.toLowerCase();
          return (ds.display_name?.toLowerCase().includes(q))
            || ds.source_id.toLowerCase().includes(q)
            || ds.host.toLowerCase().includes(q)
            || ds.database_name.toLowerCase().includes(q);
        }).map(ds => (
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
                  {ds.db_type === 'oracle' ? `Oracle CDC \u2192 ${ds.database_name}` : `${ds.host}:${ds.port}/${ds.database_name}`}
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

function OnboardForm({ onCreated, onCancel }: { onCreated: (dsId: string) => void; onCancel: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    source_id: '', display_name: '', db_type: 'postgresql',
    host: '', port: '5432', database_name: '', schemas: 'public',
    connector_user: '', connector_password: '', owner_subject: '',
    // Oracle-specific
    oracle_host: '', oracle_port: '1521', oracle_service_name: '',
    oracle_user: '', oracle_password: '', cdc_target_schema: '',
  });
  const [sourceIdManual, setSourceIdManual] = useState(false);
  const [subjectList, setSubjectList] = useState<{ subject_id: string; display_name: string }[]>([]);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.subjects().then((s: any[]) => setSubjectList(s.map(x => ({ subject_id: x.subject_id, display_name: x.display_name })))).catch(e => console.warn('Failed to load subjects:', e));
  }, []);

  const suggestSourceId = autoId.dataSource;
  const isOracle = form.db_type === 'oracle';

  const dbTypePortDefaults: Record<string, string> = { postgresql: '5432', greenplum: '5432', oracle: '1521' };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const payload: any = {
        source_id: form.source_id, display_name: form.display_name,
        db_type: form.db_type,
        owner_subject: form.owner_subject || undefined,
      };
      if (isOracle) {
        payload.oracle_host = form.oracle_host;
        payload.oracle_port = parseInt(form.oracle_port);
        payload.oracle_service_name = form.oracle_service_name;
        payload.oracle_user = form.oracle_user;
        payload.oracle_password = form.oracle_password || undefined;
        payload.cdc_target_schema = form.cdc_target_schema;
      } else {
        payload.host = form.host;
        payload.port = parseInt(form.port);
        payload.database_name = form.database_name;
        payload.schemas = form.schemas.split(',').map((s: string) => s.trim());
        payload.connector_user = form.connector_user;
        payload.connector_password = form.connector_password || undefined;
      }
      await api.datasourceCreate(payload);
      onCreated(form.source_id);
    } catch (err) { toast.error(String(err)); }
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
              setForm(f => ({ ...f, db_type: t, port: dbTypePortDefaults[t] ?? f.port, oracle_port: t === 'oracle' ? '1521' : f.oracle_port }));
            }}>
              <option value="postgresql">PostgreSQL</option>
              <option value="greenplum">Greenplum</option>
              <option value="oracle">Oracle (CDC to PG)</option>
            </select>
          </div>
          {isOracle && (
          <div className="col-span-2 lg:col-span-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800">
            <strong>Oracle CDC Mode</strong> — Oracle data is replicated to PostgreSQL via CDC (external infrastructure).
            Fill in the Oracle connection for function calls, and specify the PG schema where CDC writes replica tables.
            PG-side connection details are auto-configured by the system.
          </div>
          )}
          {isOracle ? (<>
          {/* Oracle-specific fields */}
          <div>
            <label className="label">Oracle Host</label>
            <input className="input" placeholder="192.168.1.200" value={form.oracle_host} onChange={e => setForm(f => ({ ...f, oracle_host: e.target.value }))} />
          </div>
          <div>
            <label className="label">Oracle Port</label>
            <input className="input" type="number" value={form.oracle_port} onChange={e => setForm(f => ({ ...f, oracle_port: e.target.value }))} />
          </div>
          <div>
            <label className="label">Service Name</label>
            <input className="input font-mono" placeholder="ORCL" value={form.oracle_service_name} onChange={e => setForm(f => ({ ...f, oracle_service_name: e.target.value }))} />
          </div>
          <div>
            <label className="label">Oracle User</label>
            <input className="input font-mono" placeholder="PHISON_ERP" value={form.oracle_user} onChange={e => setForm(f => ({ ...f, oracle_user: e.target.value }))} />
          </div>
          <div>
            <label className="label">Oracle Password</label>
            <input className="input" type="password" value={form.oracle_password} onChange={e => setForm(f => ({ ...f, oracle_password: e.target.value }))} />
          </div>
          <div>
            <label className="label">CDC Target Schema <span className="text-slate-400 font-normal text-[10px]">(PG schema in nexus_data)</span></label>
            <input className="input font-mono" placeholder="oracle_erp" value={form.cdc_target_schema} onChange={e => setForm(f => ({ ...f, cdc_target_schema: e.target.value }))} />
            {!form.cdc_target_schema.trim() && form.oracle_host && (
              <div className="text-xs text-red-500 mt-0.5">Required — PG schema where CDC writes Oracle tables</div>
            )}
          </div>
          </>) : (<>
          {/* PG/Greenplum fields */}
          <div>
            <label className="label">Host</label>
            <input className="input" placeholder="192.168.1.100" value={form.host} onChange={e => setForm(f => ({ ...f, host: e.target.value }))} />
          </div>
          <div>
            <label className="label flex items-center gap-1">
              Port <span className="text-slate-400 text-[10px] font-normal">({form.db_type})</span>
            </label>
            <input className="input" type="number" value={form.port} onChange={e => setForm(f => ({ ...f, port: e.target.value }))} />
            {form.port && (isNaN(parseInt(form.port)) || parseInt(form.port) < 1 || parseInt(form.port) > 65535) && (
              <div className="text-xs text-red-500 mt-0.5">Port must be 1-65535</div>
            )}
          </div>
          <div>
            <label className="label">Database Name</label>
            <input className="input" placeholder="nexus_data" value={form.database_name} onChange={e => setForm(f => ({ ...f, database_name: e.target.value }))} />
          </div>
          <div>
            <label className="label">Schemas (comma-separated)</label>
            <input className="input" value={form.schemas} onChange={e => setForm(f => ({ ...f, schemas: e.target.value }))} />
            {!form.schemas.trim() && <div className="text-xs text-red-500 mt-0.5">At least one schema is required</div>}
          </div>
          <div>
            <label className="label">Connector User</label>
            <input className="input font-mono" placeholder="gpadmin" value={form.connector_user} onChange={e => setForm(f => ({ ...f, connector_user: e.target.value }))} />
          </div>
          <div>
            <label className="label">Connector Password <span className="text-slate-400 font-normal text-[10px]">(optional)</span></label>
            <input className="input" type="password" placeholder="Leave blank for trust/cert auth" value={form.connector_password} onChange={e => setForm(f => ({ ...f, connector_password: e.target.value }))} />
          </div>
          </>)}
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
          <button onClick={handleCreate} disabled={creating || !form.source_id || (isOracle
              ? (!form.oracle_host || !form.oracle_service_name || !form.oracle_user || !form.cdc_target_schema.trim())
              : (!form.host || !form.database_name || !form.connector_user || !form.schemas.trim()
                  || isNaN(parseInt(form.port)) || parseInt(form.port) < 1 || parseInt(form.port) > 65535))}
            className="btn btn-sm bg-green-600 text-white hover:bg-green-700 disabled:opacity-40">
            {creating ? 'Creating...' : 'Register & Test Connection'}
          </button>
          <button onClick={onCancel} className="btn btn-sm bg-white text-slate-600 border border-slate-300 hover:bg-slate-50">Cancel</button>
        </div>
      </div>
    </div>
  );
}
