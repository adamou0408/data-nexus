import { useState, useEffect } from 'react';
import { api } from '../api';
import { Users, Shield, Database, FileText, Zap } from 'lucide-react';
import { ReactNode } from 'react';

type Section = 'subjects' | 'roles' | 'resources' | 'policies' | 'actions';

const sections: { id: Section; label: string; icon: ReactNode }[] = [
  { id: 'subjects',  label: 'Subjects',  icon: <Users size={14} /> },
  { id: 'roles',     label: 'Roles',     icon: <Shield size={14} /> },
  { id: 'resources', label: 'Resources', icon: <Database size={14} /> },
  { id: 'policies',  label: 'Policies',  icon: <FileText size={14} /> },
  { id: 'actions',   label: 'Actions',   icon: <Zap size={14} /> },
];

export function BrowserTab() {
  const [section, setSection] = useState<Section>('subjects');
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const fetchers = { subjects: api.subjects, roles: api.roles, resources: api.resources, policies: api.policies, actions: api.actions };
    setLoading(true);
    fetchers[section]().then(setData).catch(() => {}).finally(() => setLoading(false));
  }, [section]);

  return (
    <div className="space-y-6">
      <div className="page-header">
        <h1 className="page-title">Entity Browser</h1>
        <p className="page-desc">Browse AuthZ entities — subjects, roles, resources, policies, and actions</p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {sections.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)}
            className={`btn btn-sm gap-1.5 ${
              section === s.id
                ? 'bg-blue-600 text-white hover:bg-blue-700'
                : 'bg-white text-slate-600 border border-slate-300 hover:bg-slate-50'
            }`}>
            {s.icon} {s.label}
          </button>
        ))}
      </div>

      <div className="card">
        {loading ? (
          <div className="card-body text-center py-12 text-slate-400">Loading...</div>
        ) : (
          <div className="table-container max-h-[70vh]">
            {section === 'subjects' && <SubjectsTable data={data} />}
            {section === 'roles' && <RolesTable data={data} />}
            {section === 'resources' && <ResourcesTable data={data} />}
            {section === 'policies' && <PoliciesTable data={data} />}
            {section === 'actions' && <ActionsTable data={data} />}
          </div>
        )}
      </div>
    </div>
  );
}

function SubjectsTable({ data }: { data: Record<string, unknown>[] }) {
  return (
    <table className="table">
      <thead><tr><th>Subject ID</th><th>Type</th><th>Display Name</th><th>Roles</th><th>Attributes</th></tr></thead>
      <tbody>
        {data.map((s) => (
          <tr key={String(s.subject_id)}>
            <td className="font-mono text-xs">{String(s.subject_id)}</td>
            <td>
              <span className={`badge ${s.subject_type === 'user' ? 'badge-blue' : 'badge-purple'}`}>
                {String(s.subject_type)}
              </span>
            </td>
            <td className="text-slate-900 font-medium">{String(s.display_name)}</td>
            <td>
              <div className="flex gap-1 flex-wrap">
                {(s.roles as string[] || []).map((r: string) => (
                  <span key={r} className="badge badge-slate text-[10px]">{r}</span>
                ))}
              </div>
            </td>
            <td className="font-mono text-xs text-slate-400 max-w-[200px] truncate">
              {JSON.stringify(s.attributes)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RolesTable({ data }: { data: Record<string, unknown>[] }) {
  return (
    <table className="table">
      <thead><tr><th>Role ID</th><th>Display Name</th><th>System</th><th>Assignments</th><th>Permissions</th></tr></thead>
      <tbody>
        {data.map((r) => (
          <tr key={String(r.role_id)}>
            <td className="font-mono text-xs font-bold text-slate-900">{String(r.role_id)}</td>
            <td>{String(r.display_name)}</td>
            <td>{r.is_system ? <span className="badge badge-amber">SYSTEM</span> : <span className="text-slate-300">-</span>}</td>
            <td className="text-center font-medium">{String(r.assignment_count)}</td>
            <td className="text-center font-medium">{String(r.permission_count)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ResourcesTable({ data }: { data: Record<string, unknown>[] }) {
  const typeColor: Record<string, string> = {
    module: 'badge-indigo', table: 'badge-green', column: 'badge-amber',
    web_page: 'badge-blue', web_api: 'badge-purple', db_pool: 'badge-red',
  };
  return (
    <table className="table">
      <thead><tr><th>Resource ID</th><th>Type</th><th>Display Name</th><th>Parent</th></tr></thead>
      <tbody>
        {data.map((r) => (
          <tr key={String(r.resource_id)}>
            <td className="font-mono text-xs">{String(r.resource_id)}</td>
            <td>
              <span className={`badge ${typeColor[String(r.resource_type)] || 'badge-slate'}`}>
                {String(r.resource_type)}
              </span>
            </td>
            <td className="text-slate-900 font-medium">{String(r.display_name)}</td>
            <td className="font-mono text-xs text-slate-400">{r.parent_id ? String(r.parent_id) : '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PoliciesTable({ data }: { data: Record<string, unknown>[] }) {
  return (
    <table className="table">
      <thead>
        <tr><th>Name</th><th>Granularity</th><th>Effect</th><th>Status</th><th>RLS Expression</th><th>Paths</th></tr>
      </thead>
      <tbody>
        {data.map((p) => (
          <tr key={String(p.policy_id)}>
            <td className="font-medium text-slate-900">{String(p.policy_name)}</td>
            <td><span className="badge badge-slate text-[10px]">{String(p.granularity)}</span></td>
            <td>
              <span className={`badge ${p.effect === 'allow' ? 'badge-green' : 'badge-red'}`}>
                {String(p.effect)}
              </span>
            </td>
            <td>
              <span className={`badge ${p.status === 'active' ? 'badge-green' : 'badge-slate'}`}>
                {String(p.status)}
              </span>
            </td>
            <td className="font-mono text-xs text-slate-500 max-w-[200px] truncate">
              {p.rls_expression ? String(p.rls_expression) : '-'}
            </td>
            <td>
              <div className="flex gap-1">
                {(p.applicable_paths as string[] || []).map((path: string) => (
                  <span key={path} className="badge badge-slate text-[10px]">{path}</span>
                ))}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ActionsTable({ data }: { data: Record<string, unknown>[] }) {
  const pathColor: Record<string, string> = { A: 'badge-blue', B: 'badge-green', C: 'badge-purple' };
  return (
    <table className="table">
      <thead><tr><th>Action ID</th><th>Display Name</th><th>Description</th><th>Paths</th><th>Active</th></tr></thead>
      <tbody>
        {data.map((a) => (
          <tr key={String(a.action_id)}>
            <td className="font-mono text-xs font-bold text-slate-900">{String(a.action_id)}</td>
            <td className="font-medium">{String(a.display_name)}</td>
            <td className="text-xs text-slate-500">{a.description ? String(a.description) : '-'}</td>
            <td>
              <div className="flex gap-1">
                {(a.applicable_paths as string[] || []).map((p: string) => (
                  <span key={p} className={`badge text-[10px] ${pathColor[p] || 'badge-slate'}`}>Path {p}</span>
                ))}
              </div>
            </td>
            <td>
              {a.is_active
                ? <span className="badge badge-green text-[10px]">YES</span>
                : <span className="badge badge-red text-[10px]">NO</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

