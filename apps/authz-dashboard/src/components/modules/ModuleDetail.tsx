import { useState, useEffect, useCallback, useMemo } from 'react';
import { api, ModuleDetails, ModuleTreeNode, UIDescriptor } from '../../api';
import { useToast } from '../Toast';
import { TablesPanel } from './TablesPanel';
import { AccessPanel } from './AccessPanel';
import { MetadataGrid } from '../shared/MetadataGrid';
import { DangerConfirmModal, ConfirmState } from '../shared/DangerConfirmModal';
import { Loader2, Trash2, Pencil, FolderPlus, ChevronRight } from 'lucide-react';
import { ModuleFormModal } from './ModuleFormModal';

/** Build breadcrumb path from root → current module */
function buildBreadcrumb(moduleId: string, nodes: ModuleTreeNode[]): { id: string; name: string }[] {
  const nodeMap = new Map(nodes.map(n => [n.resource_id, n]));
  const path: { id: string; name: string }[] = [];
  let current = moduleId;
  while (current) {
    const node = nodeMap.get(current);
    if (!node) break;
    path.unshift({ id: node.resource_id, name: node.display_name });
    current = node.parent_id || '';
  }
  return path;
}

export function ModuleDetail({
  moduleId, nodes, descriptors, onMutate, onDeleted, onCreateChild, onSelectModule,
}: {
  moduleId: string;
  nodes: ModuleTreeNode[];
  descriptors: UIDescriptor[];
  onMutate: () => void;
  onDeleted: () => void;
  onCreateChild?: (parentId: string) => void; // undefined = user cannot create
  onSelectModule: (id: string) => void;
}) {
  const toast = useToast();
  const [details, setDetails] = useState<ModuleDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [subTab, setSubTab] = useState<string>('tables');
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [showEdit, setShowEdit] = useState(false);

  const breadcrumb = useMemo(() => buildBreadcrumb(moduleId, nodes), [moduleId, nodes]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.moduleDetails(moduleId);
      setDetails(d);
    } catch (err) {
      toast.error('Failed to load module details');
      console.warn(err);
    } finally {
      setLoading(false);
    }
  }, [moduleId]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = () => {
    if (!details) return;
    const hasChildren = details.children.modules.length + details.children.tables.length;
    setConfirm({
      title: 'Delete Module',
      message: `This will soft-delete "${details.module.display_name}".${hasChildren > 0 ? ` ${hasChildren} children will be reassigned to the parent module.` : ''}`,
      impact: hasChildren > 0
        ? `${details.children.modules.length} sub-modules and ${details.children.tables.length} tables will be reassigned`
        : 'No children to reassign',
      onConfirm: async () => {
        try {
          await api.moduleDelete(moduleId, hasChildren > 0);
          toast.success('Module deleted');
          onDeleted();
        } catch (err: any) {
          toast.error(err.message || 'Delete failed');
        }
      },
    });
  };

  if (loading || !details) {
    return (
      <div className="card h-full flex items-center justify-center text-slate-400">
        <Loader2 size={24} className="animate-spin" />
      </div>
    );
  }

  const { module: mod, children, access, profiles, user_permissions } = details;
  const isAdmin = user_permissions?.is_admin ?? false;
  const canWrite = isAdmin || (user_permissions?.actions ?? []).includes('write');

  // Sub-tabs driven by UI descriptors (L1 metadata)
  // Visibility rules: 'all'/'read' → everyone, 'write' → canWrite, 'admin' → isAdmin
  const sectionDataCount: Record<string, number> = {
    tables: children.tables.length,
    access: access.length,
    profiles: profiles.length,
  };

  const tabs = descriptors
    .filter(d => {
      if (d.visibility === 'admin') return isAdmin;
      if (d.visibility === 'write') return canWrite;
      return true; // 'all' or 'read'
    })
    .map(d => ({
      key: d.section_key,
      label: d.section_label,
      count: sectionDataCount[d.section_key] ?? 0,
    }));

  return (
    <div className="card h-full flex flex-col">
      {/* Breadcrumb */}
      {breadcrumb.length > 1 && (
        <div className="px-4 pt-3 flex items-center gap-1 text-[11px] text-slate-400 flex-wrap">
          {breadcrumb.map((crumb, i) => (
            <span key={crumb.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRight size={11} className="text-slate-300" />}
              {i < breadcrumb.length - 1 ? (
                <button
                  className="hover:text-blue-500 hover:underline transition-colors"
                  onClick={() => onSelectModule(crumb.id)}
                >
                  {crumb.name}
                </button>
              ) : (
                <span className="text-slate-600 font-medium">{crumb.name}</span>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Header */}
      <div className="p-4 border-b border-slate-200">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-slate-900 truncate">{mod.display_name}</h2>
            <div className="text-xs text-slate-500 font-mono mt-0.5">{mod.resource_id}</div>
          </div>
          {canWrite && (
            <div className="flex gap-1.5 shrink-0">
              {onCreateChild && (
                <button
                  onClick={() => onCreateChild(moduleId)}
                  className="btn-ghost btn-sm p-1.5 text-blue-500 hover:bg-blue-50"
                  title="Add sub-module"
                >
                  <FolderPlus size={14} />
                </button>
              )}
              <button onClick={() => setShowEdit(true)} className="btn-ghost btn-sm p-1.5" title="Edit">
                <Pencil size={14} />
              </button>
              {isAdmin && (
                <button onClick={handleDelete} className="btn-ghost btn-sm p-1.5 text-red-500 hover:bg-red-50" title="Delete">
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          )}
        </div>

        {/* Sub-module badges — clickable to navigate */}
        {children.modules.length > 0 && (
          <div className="flex gap-1.5 mt-3 flex-wrap">
            {children.modules.map(m => (
              <button
                key={m.resource_id}
                onClick={() => onSelectModule(m.resource_id)}
                className="badge badge-blue text-[10px] cursor-pointer hover:bg-blue-100 transition-colors"
              >
                {m.display_name} ({m.table_count}t)
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Sub-tabs */}
      <div className="border-b border-slate-200 px-4 flex gap-0">
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setSubTab(t.key)}
            className={`px-3 py-2.5 text-xs font-medium border-b-2 transition-colors
              ${subTab === t.key
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          >
            {t.label} ({t.count})
          </button>
        ))}
      </div>

      {/* Sub-tab content — tables & access use domain components, profiles uses MetadataGrid (L4) */}
      <div className="flex-1 overflow-y-auto p-4">
        {subTab === 'tables' && <TablesPanel tables={children.tables} modules={nodes} moduleId={moduleId} onMutate={() => { load(); onMutate(); }} readOnly={!canWrite} />}
        {subTab === 'access' && <AccessPanel access={access} />}
        {subTab === 'profiles' && (() => {
          const desc = descriptors.find(d => d.section_key === 'profiles');
          return desc
            ? <MetadataGrid descriptor={desc} data={profiles as unknown as Record<string, unknown>[]} rowKey="profile_id" />
            : null;
        })()}
      </div>

      <DangerConfirmModal state={confirm} onClose={() => setConfirm(null)} />

      {showEdit && (
        <ModuleFormModal
          modules={nodes}
          editModule={mod}
          onClose={() => setShowEdit(false)}
          onCreated={() => { setShowEdit(false); load(); onMutate(); }}
        />
      )}
    </div>
  );
}
