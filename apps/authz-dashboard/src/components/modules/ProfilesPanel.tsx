import { Server } from 'lucide-react';
import { EmptyState } from '../shared/atoms/EmptyState';

type ProfileEntry = {
  profile_id: string;
  pg_role: string;
  connection_mode: string;
  data_source_id: string | null;
};

const modeColors: Record<string, string> = {
  readonly: 'badge-blue',
  readwrite: 'badge-green',
  admin: 'badge-red',
};

export function ProfilesPanel({ profiles }: { profiles: ProfileEntry[] }) {
  if (profiles.length === 0) {
    return (
      <EmptyState
        icon={<Server size={32} />}
        message="No pool profiles reference this module"
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500">
            <th className="pb-2 font-medium">Profile</th>
            <th className="pb-2 font-medium">PG Role</th>
            <th className="pb-2 font-medium">Mode</th>
            <th className="pb-2 font-medium">Data Source</th>
          </tr>
        </thead>
        <tbody>
          {profiles.map(p => (
            <tr key={p.profile_id} className="border-b border-slate-100">
              <td className="py-2 pr-3 font-mono text-slate-800">{p.profile_id}</td>
              <td className="py-2 pr-3 font-mono text-slate-600">{p.pg_role}</td>
              <td className="py-2 pr-3">
                <span className={`badge text-[10px] ${modeColors[p.connection_mode] || 'badge-gray'}`}>
                  {p.connection_mode}
                </span>
              </td>
              <td className="py-2 font-mono text-slate-400">{p.data_source_id || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
