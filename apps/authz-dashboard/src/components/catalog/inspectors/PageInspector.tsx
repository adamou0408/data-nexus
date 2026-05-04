// Catalog PageInspector — copy of PagesTab.LineagePanel adapted for the
// inspector slot. Drops the third "Recent activity" column (grid becomes
// md:grid-cols-2) per design §11.1 / Agent B brief.
//
// Loads detail via api.pageDetail and embedders via raw fetch to
// /api/dag/published/${rid}/embedders (kept as raw fetch — no api.ts wrapper
// exists for this endpoint per Agent B brief "Critical traps").

import { useEffect, useState } from 'react';
import {
  Workflow, AlertTriangle, Loader2, X, ExternalLink,
} from 'lucide-react';
import { api, ModuleTreeNode, PagesAdminDetail } from '../../../api';
import { ModuleBreadcrumb } from '../../shared/atoms/ModuleBreadcrumb';
import { loadModuleTreeCached, peekModuleTreeCache } from '../moduleTreeCache';
import type { InspectorRendererProps } from '../types';

// Same Embedder shape as PagesTab.tsx line 45.
type Embedder = {
  parent_page_id: string;
  parent_title: string;
  parent_published_dag_id: string;
  parent_published_dag_rid: string;
};

type State =
  | { kind: 'loading' }
  | { kind: 'error'; msg: string }
  | { kind: 'ready'; detail: PagesAdminDetail; parents: Embedder[] };

export function PageInspector({ target, onClose, onOpen }: InspectorRendererProps) {
  // Inspector registry contract guarantees `kind` matches; assert and narrow.
  if (target.kind !== 'page') {
    throw new Error(`PageInspector received non-page target: ${target.kind}`);
  }
  const pageTarget = target;

  const [state, setState] = useState<State>({ kind: 'loading' });
  const [modules, setModules] = useState<ModuleTreeNode[]>(peekModuleTreeCache());

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });

    // Module tree — once per app-load (shared cache module).
    loadModuleTreeCached().then((tree) => { if (!cancelled) setModules(tree); }).catch(() => {/* breadcrumb will render with empty modules */});

    // Detail + embedders. api.pageDetail will 404 on auto:* IDs — catch and
    // fall back to error state with a graceful message.
    api.pageDetail(pageTarget.pageId)
      .then(async (detail) => {
        const rid = detail.page.published_dag_rid;
        let parents: Embedder[] = [];
        try {
          const resp = await fetch(
            `/api/dag/published/${encodeURIComponent(rid)}/embedders`,
            { credentials: 'same-origin' },
          );
          if (resp.ok) {
            const j = await resp.json() as { parents?: Embedder[] };
            parents = j.parents ?? [];
          }
        } catch { /* ignore — render with empty parents */ }
        if (!cancelled) setState({ kind: 'ready', detail, parents });
      })
      .catch((err) => {
        if (!cancelled) setState({
          kind: 'error',
          msg: err?.message ?? 'Failed to load page detail',
        });
      });

    return () => { cancelled = true; };
  }, [pageTarget.pageId]);

  const openComposer = (dagId: string) => {
    window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'flow-composer' } }));
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('flow-composer-load-dag', { detail: { dag_id: dagId } }));
    }, 0);
  };

  const headerTitle =
    state.kind === 'ready' ? state.detail.page.title : pageTarget.pageId;
  const parentModuleId =
    state.kind === 'ready' ? state.detail.page.parent_module_id : null;

  // XDB-TIER-B-L4: helper — derive cross-DS / render-mode chip metadata so
  // the header can show them at-a-glance without scrolling into the body.
  const xdbBadges = (() => {
    if (state.kind !== 'ready') return null;
    const p = state.detail.page;
    const dsCount = (p.data_source_ids || []).length;
    const isCrossDs = dsCount > 1;
    return {
      isCrossDs,
      dsCount,
      renderMode: p.render_mode,
      cachedAt: p.snapshot_cached_at,
    };
  })();

  return (
    <div className="flex flex-col h-full bg-white dark:bg-zinc-900">
      {/* Header */}
      <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
        <div className="flex items-start justify-between gap-2 mb-1.5">
          <div className="text-sm font-semibold truncate" title={headerTitle}>{headerTitle}</div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 shrink-0"
            aria-label="Close inspector"
          >
            <X size={14} />
          </button>
        </div>
        <ModuleBreadcrumb
          moduleId={parentModuleId}
          modules={modules}
          leaf={{ label: headerTitle }}
        />
        {/* XDB-TIER-B-L4: at-a-glance chips for the new render_mode axis     */}
        {/* + cross-DS shape.  Snapshot chip surfaces cached_at; live chip    */}
        {/* says "re-runs each render".  Cross-DS badge appears when the     */}
        {/* snapshot's nodes touch >1 distinct data_source_id.               */}
        {xdbBadges && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1">
            <span
              className={
                xdbBadges.renderMode === 'live'
                  ? 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-50 border border-emerald-300 text-emerald-800'
                  : 'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-sky-50 border border-sky-300 text-sky-800'
              }
              title={
                xdbBadges.renderMode === 'live'
                  ? 'Re-executes the DAG under the caller authz on every render'
                  : `Frozen at publish time${xdbBadges.cachedAt ? ` (${xdbBadges.cachedAt})` : ''}`
              }
              data-testid="page-inspector-render-mode"
            >
              {xdbBadges.renderMode === 'live' ? 'Live' : 'Snapshot'}
            </span>
            {xdbBadges.isCrossDs && (
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-50 border border-amber-300 text-amber-800"
                title={`This DAG fans out across ${xdbBadges.dsCount} data sources`}
                data-testid="page-inspector-cross-ds"
              >
                Cross-DS · {xdbBadges.dsCount} sources
              </span>
            )}
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto p-3 text-xs">
        {state.kind === 'loading' && (
          <div className="flex items-center gap-2 text-slate-500">
            <Loader2 size={12} className="animate-spin" /> Loading lineage…
          </div>
        )}

        {state.kind === 'error' && (
          <div className="bg-red-50 border border-red-200 rounded p-2 text-red-700 flex items-start gap-1.5">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{state.msg}</span>
          </div>
        )}

        {state.kind === 'ready' && (() => {
          const { detail, parents } = state;
          const meta = detail.snapshot_meta;
          return (
            <div className="grid md:grid-cols-2 gap-3">
              {/* ── Snapshot ── */}
              <div className="border border-slate-200 rounded bg-white p-2">
                <div className="text-[11px] font-semibold text-slate-700 mb-1.5 flex items-center gap-1">
                  <Workflow size={11} /> Snapshot
                </div>
                <dl className="text-[11px] space-y-0.5">
                  <div className="flex justify-between"><dt className="text-slate-500">Nodes</dt><dd className="font-mono">{meta.node_count}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Output</dt><dd className="font-mono">{meta.output_node_id ?? '—'}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Exposed</dt><dd className="font-mono">{meta.exposed_node_ids.length > 0 ? meta.exposed_node_ids.join(', ') : '—'}</dd></div>
                  <div className="flex justify-between"><dt className="text-slate-500">Data source</dt><dd className="font-mono truncate max-w-[140px]" title={detail.page.data_source_id ?? ''}>{detail.page.data_source_id ?? '—'}</dd></div>
                </dl>
                {meta.form_schema.length > 0 && (
                  <div className="mt-2">
                    <div className="text-[10px] text-slate-500 mb-0.5">Form fields ({meta.form_schema.length})</div>
                    <ul className="text-[10px] font-mono space-y-0.5">
                      {meta.form_schema.map((f) => (
                        <li key={f.name} className="text-slate-700">
                          <span className="text-slate-900">{f.name}</span>
                          <span className="text-slate-400">: {f.type}</span>
                          {f.required && <span className="text-red-500">*</span>}
                          {f.default != null && f.default !== '' && (
                            <span className="text-slate-400"> = {String(f.default).slice(0, 24)}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              {/* ── Subdag relationships ── */}
              <div className="border border-slate-200 rounded bg-white p-2">
                <div className="text-[11px] font-semibold text-slate-700 mb-1.5 flex items-center gap-1">
                  <Workflow size={11} /> Subdag links
                </div>
                <div className="text-[10px] text-slate-500 mb-0.5">Embeds (this → child)</div>
                {meta.embedded_subdags.length === 0 ? (
                  <div className="text-[11px] text-slate-400 italic">none</div>
                ) : (
                  <ul className="text-[10px] font-mono space-y-0.5">
                    {meta.embedded_subdags.map((e) => (
                      <li key={e.subdag_node_id} className="text-slate-700 truncate" title={e.child_rid}>
                        <span className="text-slate-900">{e.subdag_node_id}</span>
                        <span className="text-slate-400"> → {e.child_rid}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-2 text-[10px] text-slate-500 mb-0.5">Embedded by (parents)</div>
                {parents.length === 0 ? (
                  <div className="text-[11px] text-slate-400 italic">none</div>
                ) : (
                  <ul className="text-[11px] space-y-0.5">
                    {parents.map((p) => (
                      <li key={p.parent_page_id} className="flex items-center justify-between">
                        <span className="truncate text-slate-700" title={p.parent_published_dag_rid}>
                          <span className="text-slate-900">{p.parent_title}</span>
                          <span className="text-slate-400 font-mono"> · {p.parent_page_id}</span>
                        </span>
                        <button
                          onClick={() => openComposer(p.parent_published_dag_id)}
                          className="text-blue-600 hover:underline text-[10px] flex items-center gap-0.5 shrink-0"
                        >
                          <Workflow size={10} /> open
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          );
        })()}
      </div>

      {/* Action footer */}
      <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-700 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onOpen({ kind: 'page-detail', pageId: pageTarget.pageId, params: {} })}
          className="btn btn-primary btn-sm flex-1 flex items-center justify-center gap-1"
        >
          <ExternalLink size={12} /> Open in detail
        </button>
        {state.kind === 'ready' && (
          <button
            type="button"
            onClick={() => openComposer(state.detail.page.dag_id)}
            className="btn btn-secondary btn-sm flex items-center justify-center gap-1"
            title="Republish via Flow Composer"
          >
            <Workflow size={12} /> Republish
          </button>
        )}
      </div>
    </div>
  );
}
