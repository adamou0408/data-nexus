import { useState } from 'react';
import { api, ModuleTreeNode } from '../../api';
import { useToast } from '../Toast';
import { X, Info } from 'lucide-react';

/** Generate module ID following convention: module:parent_slug.child_slug */
function generateModuleId(displayName: string, parentId: string | null, nodes: ModuleTreeNode[]): string {
  const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (!slug) return 'module:';

  if (parentId) {
    // Extract parent's domain prefix: "module:mrp" → "mrp", "module:mrp.lot_tracking" → "mrp.lot_tracking"
    const parentSlug = parentId.replace(/^module:/, '');
    return `module:${parentSlug}.${slug}`;
  }
  return `module:${slug}`;
}

export function ModuleFormModal({
  modules,
  editModule,
  initialParent,
  onClose,
  onCreated,
}: {
  modules: ModuleTreeNode[];
  editModule?: { resource_id: string; display_name: string; parent_id: string | null };
  initialParent?: string | null; // null = root, string = pre-fill parent
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  const isEdit = !!editModule;

  const [displayName, setDisplayName] = useState(editModule?.display_name || '');
  const [resourceId, setResourceId] = useState(editModule?.resource_id || '');
  const [parentId, setParentId] = useState(editModule?.parent_id || initialParent || '');
  const [autoId, setAutoId] = useState(!isEdit);
  const [saving, setSaving] = useState(false);

  // Auto-generate resource_id from display name + parent context
  const handleNameChange = (name: string) => {
    setDisplayName(name);
    if (autoId && !isEdit) {
      setResourceId(generateModuleId(name, parentId || null, modules));
    }
  };

  const handleParentChange = (newParent: string) => {
    setParentId(newParent);
    if (autoId && !isEdit && displayName) {
      setResourceId(generateModuleId(displayName, newParent || null, modules));
    }
  };

  const handleSubmit = async () => {
    if (!displayName.trim() || (!isEdit && !resourceId.trim())) {
      toast.error('Display name and module ID are required');
      return;
    }
    // Validate ID format
    if (!isEdit && !resourceId.startsWith('module:')) {
      toast.error('Module ID must start with "module:"');
      return;
    }
    setSaving(true);
    try {
      if (isEdit) {
        await api.resourceUpdate(editModule!.resource_id, {
          display_name: displayName,
          parent_id: parentId || undefined,
        });
        toast.success('Module updated');
      } else {
        await api.resourceCreate({
          resource_id: resourceId,
          resource_type: 'module',
          display_name: displayName,
          parent_id: parentId || undefined,
        });
        toast.success('Module created');
      }
      onCreated();
    } catch (err: any) {
      toast.error(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // Find parent display name for helper text
  const parentNode = parentId ? modules.find(m => m.resource_id === parentId) : null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl max-w-md w-full" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <h3 className="font-bold text-slate-900">{isEdit ? 'Edit Module' : 'New Module'}</h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        <div className="p-4 space-y-4">
          {/* Parent Module — shown first to influence ID generation */}
          <div>
            <label className="text-xs font-medium text-slate-600">Parent Module</label>
            <select
              className="input mt-1"
              value={parentId}
              onChange={e => handleParentChange(e.target.value)}
            >
              <option value="">None (root module)</option>
              {modules
                .filter(m => m.resource_id !== editModule?.resource_id)
                .map(m => (
                  <option key={m.resource_id} value={m.resource_id}>
                    {m.display_name} ({m.resource_id})
                  </option>
                ))}
            </select>
          </div>

          {/* Display Name */}
          <div>
            <label className="text-xs font-medium text-slate-600">Display Name *</label>
            <input
              className="input mt-1"
              value={displayName}
              onChange={e => handleNameChange(e.target.value)}
              placeholder={parentNode ? `e.g. Lot Tracking (under ${parentNode.display_name})` : 'e.g. MRP System'}
              autoFocus
            />
          </div>

          {/* Module ID */}
          <div>
            <label className="text-xs font-medium text-slate-600">Module ID *</label>
            <input
              className="input mt-1 font-mono text-sm"
              value={resourceId}
              onChange={e => { setResourceId(e.target.value); setAutoId(false); }}
              placeholder="module:mrp.lot_tracking"
              disabled={isEdit}
            />
            {!isEdit && (
              <div className="flex items-start gap-1.5 mt-1.5">
                <Info size={12} className="text-blue-400 shrink-0 mt-0.5" />
                <span className="text-[10px] text-slate-400">
                  Auto-generated using <span className="font-mono">module:parent.child</span> convention. Edit to customize.
                </span>
              </div>
            )}
          </div>

          {/* Preview */}
          {!isEdit && resourceId && (
            <div className="bg-slate-50 rounded-lg p-3 text-xs">
              <div className="text-slate-500 font-medium mb-1">Preview</div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-blue-600">{resourceId}</span>
              </div>
              {parentNode && (
                <div className="text-slate-400 mt-1">
                  Under: {parentNode.display_name}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex gap-2 justify-end p-4 border-t border-slate-200">
          <button onClick={onClose} className="btn btn-sm bg-white text-slate-600 border border-slate-300 hover:bg-slate-50">
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || !displayName.trim() || (!isEdit && !resourceId.trim())}
            className="btn btn-sm bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Saving...' : isEdit ? 'Update' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  );
}
