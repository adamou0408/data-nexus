import { useState } from 'react';
import { api, ModuleTreeNode } from '../../api';
import { useToast } from '../Toast';
import { EmptyState } from '../shared/atoms/EmptyState';
import { Table2, Eye, Save } from 'lucide-react';

type TableRow = {
  resource_id: string;
  display_name: string;
  resource_type: string;
  column_count: number;
  data_source_id: string | null;
};

export function TablesPanel({
  tables, modules, moduleId, onMutate, readOnly,
}: {
  tables: TableRow[];
  modules: ModuleTreeNode[];
  moduleId: string;
  onMutate: () => void;
  readOnly?: boolean;
}) {
  const toast = useToast();
  const [reassignments, setReassignments] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const dirty = Object.keys(reassignments).length > 0;

  const handleReassign = (resourceId: string, newParent: string) => {
    if (newParent === moduleId) {
      // No change — remove from reassignments
      setReassignments(prev => {
        const next = { ...prev };
        delete next[resourceId];
        return next;
      });
    } else {
      setReassignments(prev => ({ ...prev, [resourceId]: newParent }));
    }
  };

  const handleSave = async () => {
    const mappings = Object.entries(reassignments).map(([resource_id, parent_id]) => ({
      resource_id,
      parent_id,
    }));
    if (mappings.length === 0) return;
    setSaving(true);
    try {
      await api.resourcesBulkParent(mappings);
      toast.success(`${mappings.length} table(s) reassigned`);
      setReassignments({});
      onMutate();
    } catch (err: any) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  if (tables.length === 0) {
    return (
      <EmptyState
        icon={<Table2 size={32} />}
        message="No tables mapped to this module"
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-200 text-left text-slate-500">
              <th className="pb-2 font-medium">Table</th>
              <th className="pb-2 font-medium">Type</th>
              <th className="pb-2 font-medium">Columns</th>
              <th className="pb-2 font-medium">Source</th>
              {!readOnly && <th className="pb-2 font-medium">Reassign</th>}
            </tr>
          </thead>
          <tbody>
            {tables.map(t => (
              <tr key={t.resource_id} className={`border-b border-slate-100 ${reassignments[t.resource_id] ? 'bg-amber-50' : ''}`}>
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-1.5">
                    {t.resource_type === 'view'
                      ? <Eye size={13} className="text-violet-400 shrink-0" />
                      : <Table2 size={13} className="text-emerald-400 shrink-0" />}
                    <span className="font-mono truncate max-w-[200px]">{t.display_name}</span>
                  </div>
                </td>
                <td className="py-2 pr-3">
                  <span className={`badge text-[10px] ${t.resource_type === 'view' ? 'badge-purple' : 'badge-blue'}`}>
                    {t.resource_type.toUpperCase()}
                  </span>
                </td>
                <td className="py-2 pr-3 text-slate-500">{t.column_count}</td>
                <td className="py-2 pr-3 font-mono text-slate-400 truncate max-w-[120px]">{t.data_source_id || '-'}</td>
                {!readOnly && (
                  <td className="py-2">
                    <select
                      className="input text-[11px] py-1 px-2 max-w-[160px]"
                      value={reassignments[t.resource_id] || moduleId}
                      onChange={e => handleReassign(t.resource_id, e.target.value)}
                    >
                      {modules.map(m => (
                        <option key={m.resource_id} value={m.resource_id}>
                          {m.display_name}
                        </option>
                      ))}
                    </select>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {dirty && (
        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            className="btn btn-sm bg-blue-600 text-white hover:bg-blue-700 flex items-center gap-1.5 disabled:opacity-50"
          >
            <Save size={14} />
            {saving ? 'Saving...' : `Save ${Object.keys(reassignments).length} Reassignment(s)`}
          </button>
        </div>
      )}
    </div>
  );
}
