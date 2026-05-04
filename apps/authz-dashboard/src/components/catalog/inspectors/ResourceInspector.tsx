// Catalog inspector — resource row peek drawer.
// Lightweight read-only summary: resource_id, type, parent. Wired to
// CatalogStackAPI via InspectorRendererProps so "Open" pushes a frame.
//
// Phase 2 wires this into InspectorRegistry via:
//   registerInspector('resource', ResourceInspector);

import { X, ExternalLink } from 'lucide-react';
import type { InspectorRendererProps } from '../types';
import { typeMeta } from '../columns/resourceColumns';

export function ResourceInspector(props: InspectorRendererProps) {
  if (props.target.kind !== 'resource') return null;
  const { rid, resource_type } = props.target;
  const meta = typeMeta(resource_type);

  return (
    <aside
      className="fixed top-0 right-0 z-40 h-full w-80 border-l border-slate-200 bg-white shadow-xl flex flex-col"
      role="complementary"
      aria-label="Resource inspector"
      data-testid="resource-inspector"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
        <div className="flex items-center gap-2">
          <span className={meta.color}>{meta.icon}</span>
          <h3 className="text-sm font-semibold text-slate-900">Resource</h3>
        </div>
        <button
          onClick={props.onClose}
          className="text-slate-400 hover:text-slate-700"
          title="Close"
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 text-xs">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Resource ID</div>
          <div className="font-mono text-slate-800 break-all">{rid}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-slate-400">Type</div>
          <span className={`badge ${meta.badge} inline-flex items-center gap-1`}>
            <span className="opacity-80">{meta.icon}</span>
            {resource_type}
          </span>
        </div>
      </div>
      <div className="px-4 py-3 border-t border-slate-200">
        {resource_type === 'module' && (
          <button
            onClick={() => props.onOpen({ kind: 'module-detail', moduleId: rid })}
            className="w-full text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 flex items-center justify-center gap-1.5"
          >
            <ExternalLink size={12} /> Open module
          </button>
        )}
        {resource_type === 'page' && (
          <button
            onClick={() => props.onOpen({ kind: 'page-detail', pageId: rid, params: {} })}
            className="w-full text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 flex items-center justify-center gap-1.5"
          >
            <ExternalLink size={12} /> Open page
          </button>
        )}
      </div>
    </aside>
  );
}
