import { useState, useEffect, useCallback } from 'react';
import { api, ModuleTreeNode, UIDescriptor } from '../../api';
import { useToast } from '../Toast';
import { ModuleTree } from './ModuleTree';
import { ModuleDetail } from './ModuleDetail';
import { ModuleFormModal } from './ModuleFormModal';
import { MasterDetailLayout } from '../shared/MasterDetailLayout';
import { StatCard } from '../shared/atoms/StatCard';
import { EmptyState } from '../shared/atoms/EmptyState';
import { PageHeader } from '../shared/atoms/PageHeader';
import { Boxes, Table2, GitBranch } from 'lucide-react';

/**
 * ModulesTab can be rendered in two ways:
 *   1. Via ConfigEngine with a `config` prop (page metadata from authz_ui_page)
 *   2. Standalone (fallback to hardcoded title/subtitle)
 */
export function ModulesTab({ config }: { config?: { title: string; subtitle?: string } } = {}) {
  const toast = useToast();
  const [nodes, setNodes] = useState<ModuleTreeNode[]>([]);
  const [descriptors, setDescriptors] = useState<UIDescriptor[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createParent, setCreateParent] = useState<string | null | undefined>(undefined);
  // undefined = modal closed, null = root module, string = pre-filled parent

  const load = useCallback(async () => {
    try {
      const [data, desc] = await Promise.all([
        api.moduleTree(),
        api.moduleDescriptors(),
      ]);
      setNodes(data);
      setDescriptors(desc);
    } catch (err) {
      toast.error('Failed to load modules');
      console.warn(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onMutate = () => { load(); };

  // Stats
  const totalModules = nodes.length;
  const totalTables = nodes.reduce((s, n) => s + n.table_count, 0);
  const rootModules = nodes.filter(n => !n.parent_id).length;
  const totalColumns = nodes.reduce((s, n) => s + n.column_count, 0);

  const stats = [
    { label: 'Modules', value: totalModules, sub: `${rootModules} root`, icon: <Boxes size={18} className="text-blue-500" />, iconBg: 'bg-blue-50' },
    { label: 'Tables Mapped', value: totalTables, icon: <Table2 size={18} className="text-emerald-500" />, iconBg: 'bg-emerald-50' },
    { label: 'Sub-modules', value: totalModules - rootModules, icon: <GitBranch size={18} className="text-violet-500" />, iconBg: 'bg-violet-50' },
    { label: 'Columns', value: totalColumns, icon: <Table2 size={18} className="text-amber-500" />, iconBg: 'bg-amber-50' },
  ];

  if (loading) {
    return <div className="text-center py-20 text-slate-400">Loading modules...</div>;
  }

  const showModal = createParent !== undefined;
  const canWrite = nodes.some(n => n.user_actions.includes('write') || n.user_actions.includes('admin'));

  return (
    <div className="space-y-5">
      {/* Header — uses Config-SM metadata when available, falls back otherwise */}
      <PageHeader
        title={config?.title ?? 'Module Management'}
        subtitle={config?.subtitle ?? (canWrite
          ? 'Organize data tables into business domains for department-level access'
          : 'Browse business domain modules and their table mappings')}
      />

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {stats.map(s => (
          <StatCard key={s.label} {...s} />
        ))}
      </div>

      {/* Master-detail layout (L5: reusable layout component) */}
      <MasterDetailLayout
        hasSelection={!!selectedId}
        onBack={() => setSelectedId(null)}
        backLabel="Back to tree"
        master={
          <ModuleTree
            nodes={nodes}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onCreateNew={canWrite ? () => setCreateParent(null) : undefined}
            onCreateChild={canWrite ? (parentId) => setCreateParent(parentId) : undefined}
          />
        }
        detail={
          selectedId ? (
            <ModuleDetail
              moduleId={selectedId}
              nodes={nodes}
              descriptors={descriptors}
              onMutate={onMutate}
              onDeleted={() => { setSelectedId(null); onMutate(); }}
              onCreateChild={canWrite ? (parentId) => setCreateParent(parentId) : undefined}
              onSelectModule={setSelectedId}
            />
          ) : null
        }
        emptyState={
          <div className="card h-full flex items-center justify-center">
            <EmptyState
              icon={<Boxes size={40} />}
              message="Select a module from the tree to view details"
              size="lg"
            />
          </div>
        }
      />

      {/* Create/edit modal */}
      {showModal && (
        <ModuleFormModal
          modules={nodes}
          initialParent={createParent}
          onClose={() => setCreateParent(undefined)}
          onCreated={() => { setCreateParent(undefined); onMutate(); }}
        />
      )}
    </div>
  );
}
