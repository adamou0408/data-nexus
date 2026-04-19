import { ModuleTreeNode } from '../../api';
import { TreePanel, TreeNodeBase } from '../shared/TreePanel';
import { Boxes, FolderPlus, Plus } from 'lucide-react';

/** Adapt ModuleTreeNode → TreeNodeBase for generic TreePanel */
type ModuleNode = TreeNodeBase & ModuleTreeNode;

function toTreeNodes(nodes: ModuleTreeNode[]): ModuleNode[] {
  return nodes.map(n => ({
    ...n,
    id: n.resource_id,
    label: n.display_name,
    parentId: n.parent_id,
  }));
}

export function ModuleTree({
  nodes, selectedId, onSelect, onCreateNew, onCreateChild,
}: {
  nodes: ModuleTreeNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreateNew?: () => void;
  onCreateChild?: (parentId: string) => void;
}) {
  const treeNodes = toTreeNodes(nodes);

  return (
    <TreePanel<ModuleNode>
      nodes={treeNodes}
      selectedId={selectedId}
      onSelect={onSelect}
      searchPlaceholder="Search modules..."
      countLabel={`${nodes.length} modules`}
      renderNode={(node, { isSelected }) => (
        <>
          <Boxes size={14} className={`shrink-0 ${isSelected ? 'text-blue-500' : 'text-slate-400'}`} />
          <div className="flex-1 min-w-0 truncate font-medium">{node.display_name}</div>
        </>
      )}
      renderHoverAction={onCreateChild ? (node) => (
        <button
          className="shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-blue-100 text-blue-400"
          title="Add sub-module"
          onClick={e => { e.stopPropagation(); onCreateChild(node.resource_id); }}
        >
          <FolderPlus size={13} />
        </button>
      ) : undefined}
      renderBadges={(node) => (
        <div className="shrink-0 flex gap-1.5 text-[10px] text-slate-400">
          {node.table_count > 0 && <span>{node.table_count}t</span>}
          {node.child_module_count > 0 && <span>{node.child_module_count}m</span>}
        </div>
      )}
      footer={onCreateNew ? (
        <div className="p-3 border-t border-slate-200">
          <button onClick={onCreateNew} className="btn btn-sm w-full bg-blue-600 text-white hover:bg-blue-700 flex items-center justify-center gap-1.5">
            <Plus size={14} /> New Module
          </button>
        </div>
      ) : undefined}
    />
  );
}
