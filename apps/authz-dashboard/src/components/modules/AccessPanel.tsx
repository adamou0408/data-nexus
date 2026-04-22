import { useMemo } from 'react';
import { ShieldCheck, ShieldX, Minus } from 'lucide-react';
import { EmptyState } from '../shared/atoms/EmptyState';

type AccessEntry = {
  role_id: string;
  role_name: string;
  actions: { action_id: string; effect: string }[];
};

// Known action columns (ordered). 'execute' belongs here because functions
// promoted to a module require an `execute` grant for /data-query/functions/exec.
const ACTION_COLS = ['read', 'write', 'execute', 'approve', 'export', 'connect'];

function EffectCell({ effect }: { effect: string | undefined }) {
  if (!effect) return <Minus size={14} className="text-slate-300 mx-auto" />;
  if (effect === 'allow') return <ShieldCheck size={14} className="text-emerald-500 mx-auto" />;
  return <ShieldX size={14} className="text-red-500 mx-auto" />;
}

export function AccessPanel({ access }: { access: AccessEntry[] }) {
  // Discover all action columns from data
  const actionCols = useMemo(() => {
    const seen = new Set<string>();
    for (const entry of access) {
      for (const a of entry.actions) seen.add(a.action_id);
    }
    // Prefer known ordering, then alphabetical for extras
    const ordered = ACTION_COLS.filter(c => seen.has(c));
    const extras = [...seen].filter(c => !ACTION_COLS.includes(c)).sort();
    return [...ordered, ...extras];
  }, [access]);

  if (access.length === 0) {
    return (
      <EmptyState
        icon={<ShieldCheck size={32} />}
        message="No role permissions assigned to this module"
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-200 text-left text-slate-500">
            <th className="pb-2 font-medium">Role</th>
            {actionCols.map(a => (
              <th key={a} className="pb-2 font-medium text-center capitalize w-16">{a}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {access.map(entry => {
            const actionMap = new Map(entry.actions.map(a => [a.action_id, a.effect]));
            return (
              <tr key={entry.role_id} className="border-b border-slate-100">
                <td className="py-2 pr-3">
                  <div className="font-medium text-slate-800">{entry.role_name}</div>
                  <div className="text-[10px] text-slate-400 font-mono">{entry.role_id}</div>
                </td>
                {actionCols.map(a => (
                  <td key={a} className="py-2 text-center">
                    <EffectCell effect={actionMap.get(a)} />
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
