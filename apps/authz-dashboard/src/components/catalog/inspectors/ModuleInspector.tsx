// Catalog inspector — module row peek drawer.
// Header renders <ModuleBreadcrumb moduleId={moduleId} modules={modules} />
// (ux-three-asks 案 2). Module tree is fetched once on mount; for hot-path
// caching Phase 2 may move this into a context.
//
// Phase 2 wires this into InspectorRegistry via:
//   registerInspector('module', ModuleInspector);

import { useEffect, useState } from 'react';
import { X, ExternalLink, Loader2 } from 'lucide-react';
import { api, ModuleTreeNode } from '../../../api';
import { ModuleBreadcrumb } from '../../shared/atoms/ModuleBreadcrumb';
import type { InspectorRendererProps } from '../types';

export function ModuleInspector(props: InspectorRendererProps) {
  if (props.target.kind !== 'module') return null;
  const { moduleId } = props.target;
  const [modules, setModules] = useState<ModuleTreeNode[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.moduleTree()
      .then((tree) => { if (!cancelled) setModules(tree); })
      .catch(() => { /* fall back to empty list — breadcrumb shows root only */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const node = modules.find((m) => m.resource_id === moduleId) || null;

  return (
    <aside
      className="fixed top-0 right-0 z-40 h-full w-80 border-l border-slate-200 bg-white shadow-xl flex flex-col"
      role="complementary"
      aria-label="Module inspector"
      data-testid="module-inspector"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
        <h3 className="text-sm font-semibold text-slate-900">Module</h3>
        <button
          onClick={props.onClose}
          className="text-slate-400 hover:text-slate-700"
          title="Close"
        >
          <X size={16} />
        </button>
      </div>
      <div className="px-4 py-2 border-b border-slate-100">
        <ModuleBreadcrumb moduleId={moduleId} modules={modules} />
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-xs">
        {loading && (
          <div className="flex items-center gap-2 text-slate-500">
            <Loader2 size={12} className="animate-spin" /> Loading…
          </div>
        )}
        {!loading && (
          <>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-slate-400">Module ID</div>
              <div className="font-mono text-slate-800 break-all">{moduleId}</div>
            </div>
            {node && (
              <>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-slate-400">Display name</div>
                  <div className="text-slate-800">{node.display_name}</div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-slate-50 rounded p-2">
                    <div className="text-[10px] text-slate-400">Sub-modules</div>
                    <div className="font-mono text-sm text-slate-800">{node.child_module_count}</div>
                  </div>
                  <div className="bg-slate-50 rounded p-2">
                    <div className="text-[10px] text-slate-400">Tables</div>
                    <div className="font-mono text-sm text-slate-800">{node.table_count}</div>
                  </div>
                  <div className="bg-slate-50 rounded p-2">
                    <div className="text-[10px] text-slate-400">Columns</div>
                    <div className="font-mono text-sm text-slate-800">{node.column_count}</div>
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
      <div className="px-4 py-3 border-t border-slate-200">
        <button
          onClick={() => props.onOpen({ kind: 'module-detail', moduleId })}
          className="w-full text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 flex items-center justify-center gap-1.5"
          data-testid="module-inspector-open"
        >
          <ExternalLink size={12} /> Open module
        </button>
      </div>
    </aside>
  );
}
