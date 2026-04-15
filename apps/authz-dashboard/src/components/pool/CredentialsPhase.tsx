import { useState, useEffect, useCallback } from 'react';
import { api, PoolCredential } from '../../api';
import { useToast } from '../Toast';
import { ConfirmState, DangerConfirmModal } from './shared';
import { Plus, X, RotateCw, Trash2, Undo2, Key } from 'lucide-react';

function getPasswordStrength(pw: string) {
  if (!pw) return null;
  if (pw.length < 8) return { label: 'Too short (min 8)', color: 'bg-red-500', pct: 20 };
  let score = 0;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { label: 'Weak', color: 'bg-orange-500', pct: 40 };
  if (score === 2) return { label: 'Fair', color: 'bg-yellow-500', pct: 60 };
  if (score === 3) return { label: 'Good', color: 'bg-blue-500', pct: 80 };
  return { label: 'Strong', color: 'bg-green-500', pct: 100 };
}

export function CredentialsPhase({ dsId, onMutate }: { dsId: string; onMutate: () => void }) {
  const toast = useToast();
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
  const [passwordConfirm, setPasswordConfirm] = useState('');

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
    } catch (err) { toast.error('Failed to load credentials'); console.warn(err); }
    finally { setLoading(false); }
  }, [dsId]);

  useEffect(() => { loadCreds(); }, [loadCreds]);

  const refreshUncredRoles = useCallback(() => {
    api.poolUncredentialedRoles()
      .then((r: any[]) => setUncredRoles(r.filter((x: any) => x.data_source_id === dsId)))
      .catch(e => { console.warn('Failed to load uncredentialed roles:', e); setUncredRoles([]); });
  }, [dsId]);

  useEffect(() => {
    if (showCreateForm) {
      refreshUncredRoles();
      setManualPgRole(false);
      setPasswordConfirm('');
    }
  }, [showCreateForm, dsId, refreshUncredRoles]);

  const doRotate = async (pg_role: string, password: string) => {
    setRotating(true);
    try { await api.poolCredentialRotate(pg_role, password); setRotatingRole(null); setNewPassword(''); await loadCreds(); onMutate(); }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Rotate failed'); }
    finally { setRotating(false); }
  };

  const handleRotate = (pg_role: string) => {
    if (newPassword.length < 8) return;
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
      setPasswordConfirm('');
      await loadCreds(); refreshUncredRoles(); onMutate();
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Create failed'); }
    finally { setCreating(false); }
  };

  const handleReactivateCred = (pg_role: string) => {
    setDangerConfirm({
      title: `Reactivate Credential "${pg_role}"`,
      message: 'This will restore the credential and allow connections using this PG role.',
      impact: 'Pool profiles using this role will be able to authenticate again.',
      onConfirm: async () => {
        try { await api.poolCredentialReactivate(pg_role); await loadCreds(); onMutate(); }
        catch (e) { toast.error(e instanceof Error ? e.message : 'Reactivate failed'); }
      },
    });
  };

  const handleDeleteCred = (pg_role: string) => {
    setDangerConfirm({
      title: `Deactivate Credential "${pg_role}"`,
      message: 'This will mark the credential as inactive.',
      impact: 'Any pool profile using this PG role will lose connectivity.',
      onConfirm: async () => {
        try { await api.poolCredentialDelete(pg_role); await loadCreds(); refreshUncredRoles(); onMutate(); }
        catch (e) { toast.error(e instanceof Error ? e.message : 'Delete failed'); }
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
              <input className="input" type="password" placeholder="Min 8 characters" value={createForm.password}
                onChange={e => setCreateForm(f => ({ ...f, password: e.target.value }))} />
              {(() => {
                const s = getPasswordStrength(createForm.password);
                if (!s) return null;
                return (
                  <div className="mt-1.5">
                    <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden">
                      <div className={`h-full ${s.color} rounded-full transition-all`} style={{ width: `${s.pct}%` }} />
                    </div>
                    <div className={`text-[10px] mt-0.5 ${s.pct <= 20 ? 'text-red-500' : s.pct <= 60 ? 'text-amber-600' : 'text-slate-500'}`}>{s.label}</div>
                  </div>
                );
              })()}
            </div>
            <div>
              <label className="label">Confirm Password</label>
              <input className="input" type="password" placeholder="Re-enter password" value={passwordConfirm}
                onChange={e => setPasswordConfirm(e.target.value)} />
              {passwordConfirm && passwordConfirm !== createForm.password && (
                <div className="text-xs text-red-500 mt-0.5">Passwords do not match</div>
              )}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
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
            <button onClick={handleCreateCred} disabled={creating || !createForm.pg_role.trim() || createForm.password.length < 8 || createForm.password !== passwordConfirm}
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
                      <div className="space-y-1">
                        <div className="flex gap-2 items-center">
                          <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
                            placeholder="Min 8 characters" className="input text-xs w-40"
                            onKeyDown={e => e.key === 'Enter' && newPassword.length >= 8 && handleRotate(c.pg_role)} />
                          <button onClick={() => handleRotate(c.pg_role)} disabled={rotating || newPassword.length < 8} className="btn-primary btn-sm">
                            {rotating ? '...' : 'Confirm'}
                          </button>
                          <button onClick={() => { setRotatingRole(null); setNewPassword(''); }} className="btn-ghost btn-sm"><X size={14} /></button>
                        </div>
                        {(() => {
                          const s = getPasswordStrength(newPassword);
                          if (!s) return null;
                          return (
                            <div className="w-40">
                              <div className="h-1 bg-slate-200 rounded-full overflow-hidden">
                                <div className={`h-full ${s.color} rounded-full transition-all`} style={{ width: `${s.pct}%` }} />
                              </div>
                              <div className={`text-[10px] ${s.pct <= 20 ? 'text-red-500' : 'text-slate-400'}`}>{s.label}</div>
                            </div>
                          );
                        })()}
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
        <div className="text-center py-6 bg-slate-50 rounded-lg border border-dashed border-slate-300">
          <Key size={28} className="mx-auto text-slate-400 mb-2" />
          <div className="text-sm font-medium text-slate-600">No credentials configured</div>
          <div className="text-xs text-slate-400 mt-1">Create pool profiles first (Phase 4), then add PG role credentials here for database access.</div>
        </div>
      )}

      <DangerConfirmModal state={dangerConfirm} onClose={() => setDangerConfirm(null)} />
    </div>
  );
}
