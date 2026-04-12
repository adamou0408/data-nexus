import { useState, useEffect } from 'react';
import { api } from '../api';

type Section = 'subjects' | 'roles' | 'resources' | 'policies';

export function BrowserTab() {
  const [section, setSection] = useState<Section>('subjects');
  const [data, setData] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const fetchers = { subjects: api.subjects, roles: api.roles, resources: api.resources, policies: api.policies };
      const d = await fetchers[section]();
      setData(d);
    } catch { /* ignore */ }
    setLoading(false);
  };

  useEffect(() => { load(); }, [section]);

  const sections: { id: Section; label: string; icon: string }[] = [
    { id: 'subjects', label: 'Subjects', icon: 'U' },
    { id: 'roles', label: 'Roles', icon: 'R' },
    { id: 'resources', label: 'Resources', icon: 'S' },
    { id: 'policies', label: 'Policies', icon: 'P' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {sections.map(s => (
          <button key={s.id} onClick={() => setSection(s.id)}
            className={`px-4 py-2 rounded-md text-sm font-medium ${
              section === s.id ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 border hover:bg-gray-50'
            }`}>
            {s.label}
          </button>
        ))}
      </div>

      <div className="bg-white rounded-lg shadow">
        {loading ? (
          <div className="p-8 text-center text-gray-400">Loading...</div>
        ) : section === 'subjects' ? (
          <SubjectsTable data={data} />
        ) : section === 'roles' ? (
          <RolesTable data={data} />
        ) : section === 'resources' ? (
          <ResourcesTable data={data} />
        ) : (
          <PoliciesTable data={data} />
        )}
      </div>
    </div>
  );
}

function SubjectsTable({ data }: { data: Record<string, unknown>[] }) {
  return (
    <table className="w-full text-sm">
      <thead><tr className="bg-gray-50 border-b text-left">
        <th className="p-3">Subject ID</th><th className="p-3">Type</th><th className="p-3">Display Name</th>
        <th className="p-3">Roles</th><th className="p-3">Attributes</th>
      </tr></thead>
      <tbody>
        {data.map((s) => (
          <tr key={String(s.subject_id)} className="border-t hover:bg-gray-50">
            <td className="p-3 font-mono text-xs">{String(s.subject_id)}</td>
            <td className="p-3">
              <span className={`px-2 py-0.5 rounded text-xs ${
                s.subject_type === 'user' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
              }`}>{String(s.subject_type)}</span>
            </td>
            <td className="p-3">{String(s.display_name)}</td>
            <td className="p-3">
              <div className="flex gap-1 flex-wrap">
                {(s.roles as string[] || []).map((r: string) => (
                  <span key={r} className="bg-gray-100 text-gray-700 px-2 py-0.5 rounded text-xs">{r}</span>
                ))}
              </div>
            </td>
            <td className="p-3 font-mono text-xs text-gray-500 max-w-xs truncate">{JSON.stringify(s.attributes)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RolesTable({ data }: { data: Record<string, unknown>[] }) {
  return (
    <table className="w-full text-sm">
      <thead><tr className="bg-gray-50 border-b text-left">
        <th className="p-3">Role ID</th><th className="p-3">Display Name</th><th className="p-3">System?</th>
        <th className="p-3">Assignments</th><th className="p-3">Permissions</th>
      </tr></thead>
      <tbody>
        {data.map((r) => (
          <tr key={String(r.role_id)} className="border-t hover:bg-gray-50">
            <td className="p-3 font-mono text-xs font-bold">{String(r.role_id)}</td>
            <td className="p-3">{String(r.display_name)}</td>
            <td className="p-3">{r.is_system ? <span className="text-amber-600 text-xs font-bold">SYSTEM</span> : '-'}</td>
            <td className="p-3 text-center">{String(r.assignment_count)}</td>
            <td className="p-3 text-center">{String(r.permission_count)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ResourcesTable({ data }: { data: Record<string, unknown>[] }) {
  return (
    <table className="w-full text-sm">
      <thead><tr className="bg-gray-50 border-b text-left">
        <th className="p-3">Resource ID</th><th className="p-3">Type</th><th className="p-3">Display Name</th><th className="p-3">Parent</th>
      </tr></thead>
      <tbody>
        {data.map((r) => (
          <tr key={String(r.resource_id)} className="border-t hover:bg-gray-50">
            <td className="p-3 font-mono text-xs">{String(r.resource_id)}</td>
            <td className="p-3">
              <span className={`px-2 py-0.5 rounded text-xs ${
                r.resource_type === 'module' ? 'bg-indigo-100 text-indigo-700' :
                r.resource_type === 'table' ? 'bg-emerald-100 text-emerald-700' :
                r.resource_type === 'column' ? 'bg-amber-100 text-amber-700' :
                'bg-gray-100 text-gray-700'
              }`}>{String(r.resource_type)}</span>
            </td>
            <td className="p-3">{String(r.display_name)}</td>
            <td className="p-3 font-mono text-xs text-gray-400">{r.parent_id ? String(r.parent_id) : '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PoliciesTable({ data }: { data: Record<string, unknown>[] }) {
  return (
    <table className="w-full text-sm">
      <thead><tr className="bg-gray-50 border-b text-left">
        <th className="p-3">Name</th><th className="p-3">Granularity</th><th className="p-3">Effect</th>
        <th className="p-3">Status</th><th className="p-3">RLS Expression</th><th className="p-3">Paths</th>
      </tr></thead>
      <tbody>
        {data.map((p) => (
          <tr key={String(p.policy_id)} className="border-t hover:bg-gray-50">
            <td className="p-3 font-medium">{String(p.policy_name)}</td>
            <td className="p-3 text-xs">{String(p.granularity)}</td>
            <td className="p-3">
              <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                p.effect === 'allow' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
              }`}>{String(p.effect)}</span>
            </td>
            <td className="p-3">
              <span className={`px-2 py-0.5 rounded text-xs ${
                p.status === 'active' ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-500'
              }`}>{String(p.status)}</span>
            </td>
            <td className="p-3 font-mono text-xs max-w-xs truncate">{p.rls_expression ? String(p.rls_expression) : '-'}</td>
            <td className="p-3 text-xs">{JSON.stringify(p.applicable_paths)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
