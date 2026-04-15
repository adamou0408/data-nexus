import { useState } from 'react';
import { api, DataSource, LifecycleResponse } from '../../api';
import { useToast } from '../Toast';
import { ConfirmState, DangerConfirmModal } from './shared';
import { RefreshCw, Zap, Pencil, Trash2, Undo2 } from 'lucide-react';

export function ConnectionPhase({ dsId, lifecycle, onMutate, onPurged }: { dsId: string; lifecycle: LifecycleResponse; onMutate: () => void; onPurged: () => void }) {
  const toast = useToast();
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
    } catch (err) { toast.error(String(err)); }
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
        } catch (err) { toast.error(String(err)); }
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
        catch (err) { toast.error(String(err)); }
      },
    });
  };

  const handleReactivate = () => {
    setDangerConfirm({
      title: `Reactivate Data Source "${dsId}"`,
      message: 'This will restore the data source and make it available for pool profiles again.',
      impact: 'Pool profiles linked to this source will be able to re-establish connections.',
      onConfirm: async () => {
        try { await api.datasourceUpdate(dsId, { is_active: true } as Partial<DataSource>); onMutate(); }
        catch (err) { toast.error(String(err)); }
      },
    });
  };

  const handlePurge = () => {
    setDangerConfirm({
      title: `Permanently Delete "${dsId}"`,
      message: 'This will permanently remove the data source, all discovered resources (tables/columns), linked pool profiles, and their assignments. This action cannot be undone.',
      impact: 'All configuration for this data source will be lost. Credentials for linked PG roles will remain but become orphaned.',
      onConfirm: async () => {
        try {
          const result = await api.datasourcePurge(dsId);
          toast.success(`Purged "${dsId}": ${result.tables_deleted} tables, ${result.columns_deleted} columns, ${result.profiles_deleted} profiles deleted.`);
          onPurged();
        } catch (err) { toast.error(String(err)); }
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
