// Catalog DetailView — renders both `module-detail` and `page-detail` frames.
//
// MODULE-DETAIL branch:
//   - Header (ModuleBreadcrumb + display_name + sub-modules)
//   - Sub-tabs sourced from `api.moduleDescriptors()` (NOT hardcoded)
//   - Body delegates to existing TablesPanel / AccessPanel / MetadataGrid /
//     EmptyState. Page row click pushes a `page-detail` frame onto the stack
//     instead of dispatching the legacy `open-auto-page` event.
//   - Phase 1 skips ModuleFormModal / PageEditModal / PagesAdminTable.
//
// PAGE-DETAIL branch:
//   - Loads page metadata (api.pageDetail) for breadcrumb context. 404 on
//     auto:* IDs is expected and falls through to a synthetic breadcrumb.
//   - Calls api.configExecPage(pageId, params) to render. Handler-driven
//     pages are dispatched through HandlerHost (handler_name path).
//   - Branch on meta.published_dag → form + multi-output table; preserves
//     meta.outputs primary-first ordering verbatim.
//   - Else → DataTable-style with useSavedView; URL ?view= is mirrored via
//     api.replaceQueryParam (NOT window.history.replaceState).
//   - Form values + active sub-tab persist via api.setViewState so the
//     stack's LRU restore round-trips correctly.

import {
  useCallback, useEffect, useMemo, useState, FormEvent, ReactNode,
} from 'react';
import {
  Loader2, AlertTriangle, ChevronRight, Code2, FileText, Workflow,
} from 'lucide-react';
import {
  api, ModuleDetails, ModuleTreeNode, UIDescriptor, PagesAdminDetail,
} from '../../api';
import { useAuthz } from '../../AuthzContext';
import { useRenderTokens, RenderTokens } from '../../RenderTokensContext';
import { useSavedView } from '../../hooks/useSavedView';
import { SavedViewBar } from '../SavedViewBar';
import { FeedbackButton } from '../FeedbackButton';
import { TablesPanel } from '../modules/TablesPanel';
import { AccessPanel } from '../modules/AccessPanel';
import { MetadataGrid } from '../shared/MetadataGrid';
import { EmptyState } from '../shared/atoms/EmptyState';
import { ModuleBreadcrumb } from '../shared/atoms/ModuleBreadcrumb';
import { HandlerHost } from './HandlerHost';
import { PublishedDagExplorer } from './PublishedDagExplorer';
import { loadModuleTreeCached, peekModuleTreeCache } from './moduleTreeCache';
import type {
  CatalogStackAPI, ModuleDetailFrame, PageDetailFrame, DetailViewState,
} from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Local type widening — api.configExecPage returns `unknown`-shaped meta/config.
// We mirror the load-bearing fields from ConfigEngine here so DetailView can
// branch on `meta.published_dag` and order `meta.outputs` without leaking ConfigEngine
// internals.
// ─────────────────────────────────────────────────────────────────────────────

type PublishedFormField = {
  name: string;
  type: string;
  pg_type?: string;
  required: boolean;
  default: unknown;
  help_text?: string;
  source_node_id: string;
};

type PublishedDagOutput = {
  columns: Array<{ name: string; semantic_type?: string; dataTypeID?: number }>;
  rows: Record<string, unknown>[];
  row_count: number;
  truncated: boolean;
};

type ColumnDef = {
  key: string;
  label: string;
  data_type: string;
  render?: string;
  sortable?: boolean;
  align?: string;
  help_text?: string;
};

type FilterDef = {
  field: string;
  type: string;
  options: string[];
  default: string;
  help_text?: string;
};

type DrilldownDef = {
  page_id: string;
  param_mapping: Record<string, string>;
};

type PageConfig = {
  page_id: string;
  title: string;
  subtitle?: string;
  layout: string;
  columns?: ColumnDef[];
  filters?: FilterDef[];
  row_drilldown?: DrilldownDef;
  handler_name?: string;
  published_dag_id?: string;
  form_schema?: PublishedFormField[];
};

type PageMeta = {
  filteredCount?: number;
  totalCount?: number;
  columnMasks?: Record<string, string>;
  published_dag?: boolean;
  stage?: 'form_load' | 'exec';
  form_schema?: PublishedFormField[];
  output_node_id?: string;
  row_count?: number;
  truncated?: boolean;
  elapsed_ms?: number;
  lineage?: Array<{ node_id: string; detail: string }>;
  outputs?: Record<string, PublishedDagOutput>;
  primary_output_node_id?: string;
  // EXPLORER-MODE-V01 Phase B
  display_mode?: 'tabular' | 'explorer';
  edges?: Array<{
    source: string;
    target: string;
    sourceHandle?: string | null;
    targetHandle?: string | null;
  }>;
  exposed_node_ids?: string[];
};

// ─────────────────────────────────────────────────────────────────────────────
// Top-level dispatcher
// ─────────────────────────────────────────────────────────────────────────────

type DetailViewProps = {
  frame: ModuleDetailFrame | PageDetailFrame;
  api: CatalogStackAPI;
};

export function DetailView({ frame, api: stackApi }: DetailViewProps) {
  if (frame.kind === 'module-detail') {
    return <ModuleDetailBody frame={frame} stackApi={stackApi} />;
  }
  return <PageDetailBody frame={frame} stackApi={stackApi} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// MODULE-DETAIL — analog of ModuleDetail.tsx, rewired to api.push(...) and
// shipped without the curator/admin chrome (covered in Phase 2 admin polish).
// ─────────────────────────────────────────────────────────────────────────────

function ModuleDetailBody({
  frame, stackApi,
}: {
  frame: ModuleDetailFrame;
  stackApi: CatalogStackAPI;
}) {
  const { isSteward: _isSteward } = useAuthz();
  void _isSteward; // reserved for Phase 2 admin-mode pages tab

  const [details, setDetails] = useState<ModuleDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [descriptors, setDescriptors] = useState<UIDescriptor[]>([]);
  const [modules, setModules] = useState<ModuleTreeNode[]>(peekModuleTreeCache());

  // Sub-tab is persisted in viewState so stack-back restores selection.
  const detailVS: DetailViewState =
    stackApi.viewState.viewMode === 'detail'
      ? stackApi.viewState
      : { viewMode: 'detail', scrollTop: 0 };
  const subTab = detailVS.subTab ?? 'tables';
  const setSubTab = useCallback((next: string) => {
    stackApi.setViewState((prev) => {
      if (prev.viewMode !== 'detail') return prev;
      return { ...prev, subTab: next };
    });
  }, [stackApi]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api.moduleDetails(frame.moduleId);
      setDetails(d);
    } finally {
      setLoading(false);
    }
  }, [frame.moduleId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    api.moduleDescriptors()
      .then((d) => { if (!cancelled) setDescriptors(d); })
      .catch(() => { /* fall back to no descriptors → empty tabs */ });
    loadModuleTreeCached()
      .then((tree) => { if (!cancelled) setModules(tree); })
      .catch(() => { /* breadcrumb renders without parents */ });
    return () => { cancelled = true; };
  }, []);

  if (loading || !details) {
    return (
      <div className="flex items-center justify-center py-16 text-slate-400">
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  const { module: mod, children, access, profiles, user_permissions } = details;
  const isAdmin = user_permissions?.is_admin ?? false;
  const canWrite = isAdmin || (user_permissions?.actions ?? []).includes('write');

  const sectionDataCount: Record<string, number> = {
    tables: children.tables.length,
    functions: children.functions?.length ?? 0,
    pages: children.pages?.length ?? 0,
    access: access.length,
    profiles: profiles.length,
  };

  const tabs = descriptors
    .filter((d) => {
      if (d.visibility === 'admin') return isAdmin;
      if (d.visibility === 'write') return canWrite;
      return true;
    })
    .map((d) => ({
      key: d.section_key,
      label: d.section_label,
      count: sectionDataCount[d.section_key] ?? 0,
    }));

  // Auto-correct subTab if descriptors filtered out the persisted choice.
  const activeTab = tabs.find((t) => t.key === subTab) ? subTab : (tabs[0]?.key ?? 'tables');

  return (
    <div className="card h-full flex flex-col">
      {/* Breadcrumb */}
      <div className="px-4 pt-3">
        <ModuleBreadcrumb
          moduleId={mod.resource_id}
          modules={modules}
          onClickModule={(id) => stackApi.push({ kind: 'module-detail', moduleId: id })}
        />
      </div>

      {/* Header */}
      <div className="p-4 border-b border-slate-200">
        <h2 className="text-base font-bold text-slate-900 truncate">{mod.display_name}</h2>
        <div className="text-xs text-slate-500 font-mono mt-0.5">{mod.resource_id}</div>

        {children.modules.length > 0 && (
          <div className="flex gap-1.5 mt-3 flex-wrap">
            {children.modules.map((m) => (
              <button
                key={m.resource_id}
                onClick={() => stackApi.push({ kind: 'module-detail', moduleId: m.resource_id })}
                className="badge badge-blue text-[10px] cursor-pointer hover:bg-blue-100 transition-colors"
              >
                {m.display_name} ({m.table_count}t)
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Sub-tabs (descriptor-driven) */}
      <div className="border-b border-slate-200 px-4 flex gap-0">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setSubTab(t.key)}
            className={`px-3 py-2.5 text-xs font-medium border-b-2 transition-colors
              ${activeTab === t.key
                ? 'border-blue-500 text-blue-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          >
            {t.label} ({t.count})
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'tables' && (
          <TablesPanel
            tables={children.tables}
            modules={modules}
            moduleId={frame.moduleId}
            onMutate={() => { load(); }}
            readOnly={!canWrite}
          />
        )}

        {activeTab === 'functions' && (
          (children.functions?.length ?? 0) === 0 ? (
            <EmptyState icon={<Code2 size={32} />} message="No functions mapped to this module" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="pb-2 font-medium">Function</th>
                    <th className="pb-2 font-medium">Schema</th>
                    <th className="pb-2 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {children.functions.map((f) => (
                    <tr key={f.resource_id} className="border-b border-slate-100">
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-1.5">
                          <Code2 size={12} className="text-amber-600" />
                          <span className="font-medium text-slate-800">{f.display_name}</span>
                        </div>
                        <div className="text-[10px] text-slate-400 font-mono">{f.resource_id}</div>
                      </td>
                      <td className="py-2 pr-3 font-mono text-slate-600">{f.schema || '—'}</td>
                      <td className="py-2 pr-3 font-mono text-slate-600">{f.data_source_id || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {activeTab === 'pages' && (
          (children.pages?.length ?? 0) === 0 ? (
            <EmptyState
              icon={<FileText size={32} />}
              message="No saved pages under this module yet — save a DAG snapshot via Composer to populate."
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="pb-2 font-medium">Page</th>
                    <th className="pb-2 font-medium">Page ID</th>
                    <th className="pb-2 font-medium">Source DAG</th>
                    <th className="pb-2 font-medium w-12 text-right">Order</th>
                  </tr>
                </thead>
                <tbody>
                  {children.pages.map((p) => (
                    <tr
                      key={p.resource_id}
                      className="border-b border-slate-100 hover:bg-blue-50/50 cursor-pointer transition-colors"
                      onClick={() => stackApi.push({
                        kind: 'page-detail',
                        pageId: p.page_id,
                        params: {},
                      })}
                      title="Open page snapshot"
                    >
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-1.5">
                          <FileText size={12} className="text-blue-600" />
                          <span className="font-medium text-slate-800">{p.display_name}</span>
                        </div>
                      </td>
                      <td className="py-2 pr-3 font-mono text-slate-600">{p.page_id}</td>
                      <td className="py-2 pr-3 font-mono text-slate-600">{p.dag_id || '—'}</td>
                      <td className="py-2 pr-3 text-right font-mono text-slate-500">{p.display_order ?? 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {activeTab === 'access' && <AccessPanel access={access} />}

        {activeTab === 'profiles' && (() => {
          const desc = descriptors.find((d) => d.section_key === 'profiles');
          return desc
            ? <MetadataGrid descriptor={desc} data={profiles as unknown as Record<string, unknown>[]} rowKey="profile_id" />
            : null;
        })()}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE-DETAIL — analog of ConfigEngine's "current page" render path.
// ─────────────────────────────────────────────────────────────────────────────

type PageLoaded = {
  config: PageConfig;
  data: Record<string, unknown>[];
  meta?: PageMeta;
};

function PageDetailBody({
  frame, stackApi,
}: {
  frame: PageDetailFrame;
  stackApi: CatalogStackAPI;
}) {
  const [pageDetail, setPageDetail] = useState<PagesAdminDetail | null>(null);
  const [pageDetailMissing, setPageDetailMissing] = useState(false);
  const [modules, setModules] = useState<ModuleTreeNode[]>(peekModuleTreeCache());

  const [loaded, setLoaded] = useState<PageLoaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form values for published-DAG re-runs are cached in viewState so back/restore
  // brings them back.
  const detailVS: DetailViewState =
    stackApi.viewState.viewMode === 'detail'
      ? stackApi.viewState
      : { viewMode: 'detail', scrollTop: 0 };
  const persistedFormValues = detailVS.formValues;

  const setPersistedFormValues = useCallback((next: Record<string, unknown>) => {
    stackApi.setViewState((prev) => {
      if (prev.viewMode !== 'detail') return prev;
      return { ...prev, formValues: next };
    });
  }, [stackApi]);

  // Fetch page metadata (for breadcrumb). 404 on auto:* is fine.
  useEffect(() => {
    let cancelled = false;
    setPageDetail(null);
    setPageDetailMissing(false);
    api.pageDetail(frame.pageId)
      .then((d) => { if (!cancelled) setPageDetail(d); })
      .catch(() => { if (!cancelled) setPageDetailMissing(true); });
    loadModuleTreeCached()
      .then((tree) => { if (!cancelled) setModules(tree); })
      .catch(() => { /* breadcrumb falls back to no parents */ });
    return () => { cancelled = true; };
  }, [frame.pageId]);

  // Initial config-exec load (combines params + previously persisted form values).
  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setError(null);
    setLoading(true);
    const initialParams = {
      ...frame.params,
      ...(persistedFormValues ?? {}),
    };
    api.configExecPage(frame.pageId, initialParams)
      .then((result) => {
        if (cancelled) return;
        setLoaded({
          config: result.config as unknown as PageConfig,
          data: (result.data as Record<string, unknown>[]) || [],
          meta: result.meta as unknown as PageMeta | undefined,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message ?? String(err));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // Intentionally only re-run when pageId changes — mid-form param updates
    // route through onSubmit() below and write back into loaded state directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame.pageId]);

  const breadcrumbModuleId =
    pageDetail?.page.parent_module_id ?? null;
  const breadcrumbLeaf =
    pageDetail?.page.title ?? loaded?.config.title ?? frame.pageId;

  if (loading && !loaded) {
    return (
      <div>
        <div className="px-4 pt-3">
          <ModuleBreadcrumb
            moduleId={breadcrumbModuleId}
            modules={modules}
            leaf={{ label: breadcrumbLeaf }}
          />
        </div>
        <div className="flex items-center justify-center py-16 text-slate-400">
          <Loader2 size={20} className="animate-spin mr-2" /> Loading page…
        </div>
      </div>
    );
  }

  if (error && !loaded) {
    return (
      <div>
        <div className="px-4 pt-3">
          <ModuleBreadcrumb
            moduleId={breadcrumbModuleId}
            modules={modules}
            leaf={{ label: breadcrumbLeaf }}
          />
        </div>
        <div className="m-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700 flex items-start gap-2">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <div>{error}</div>
        </div>
      </div>
    );
  }

  if (!loaded) return null;
  void pageDetailMissing; // surfaced via empty breadcrumb already

  const { config, data, meta } = loaded;

  // Handler-driven page → delegate to HandlerHost.
  if (config.handler_name) {
    return (
      <div>
        <div className="px-4 pt-3">
          <ModuleBreadcrumb
            moduleId={breadcrumbModuleId}
            modules={modules}
            leaf={{ label: config.title }}
          />
        </div>
        <HandlerHost
          frame={{ kind: 'handler', handlerName: config.handler_name, pageId: frame.pageId }}
          api={stackApi}
        />
      </div>
    );
  }

  // Published-DAG page → form + multi-output renderer.
  if (config.published_dag_id || meta?.published_dag) {
    // EXPLORER-MODE-V01 Phase B: branch on display_mode. Tabular path is
    // unchanged; explorer takes over the same slot with stack-based drill
    // navigation. We hand the explorer its own re-exec authority because
    // drill-on-cell-click is its private concern.
    const isExplorer = meta?.display_mode === 'explorer';
    return (
      <div>
        <div className="px-4 pt-3">
          <ModuleBreadcrumb
            moduleId={breadcrumbModuleId}
            modules={modules}
            leaf={{ label: config.title }}
          />
        </div>
        <div className="p-4">
          <h2 className="text-xl font-bold text-slate-900 mb-1">{config.title}</h2>
          {config.subtitle && <p className="text-sm text-slate-500 mb-4">{config.subtitle}</p>}
          {isExplorer ? (
            <PublishedDagExplorer
              pageId={frame.pageId}
              schema={config.form_schema || meta?.form_schema || []}
              initialFormValues={persistedFormValues ?? frame.params}
              initialMeta={meta}
              initialOutputs={meta?.outputs}
              stackApi={stackApi}
            />
          ) : (
            <PublishedDagBody
              pageId={frame.pageId}
              schema={config.form_schema || meta?.form_schema || []}
              initialFormValues={persistedFormValues ?? frame.params}
              data={data}
              meta={meta}
              onSubmit={async (values) => {
                setPersistedFormValues(values);
                try {
                  const result = await api.configExecPage(frame.pageId, values);
                  setLoaded({
                    config: result.config as unknown as PageConfig,
                    data: (result.data as Record<string, unknown>[]) || [],
                    meta: result.meta as unknown as PageMeta | undefined,
                  });
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            />
          )}
        </div>
      </div>
    );
  }

  // Tabular layout → DataTable + saved view bar.
  if (config.layout === 'table' && config.columns) {
    return (
      <div>
        <div className="px-4 pt-3">
          <ModuleBreadcrumb
            moduleId={breadcrumbModuleId}
            modules={modules}
            leaf={{ label: config.title }}
          />
        </div>
        <div className="p-4">
          <h2 className="text-xl font-bold text-slate-900 mb-1">{config.title}</h2>
          {config.subtitle && <p className="text-sm text-slate-500 mb-4">{config.subtitle}</p>}
          <TablePageBody
            pageId={frame.pageId}
            stackApi={stackApi}
            columns={config.columns}
            data={data}
            filters={config.filters || []}
            drilldown={config.row_drilldown}
            columnMasks={meta?.columnMasks || {}}
            meta={meta}
          />
        </div>
      </div>
    );
  }

  // Fallback — unsupported layout for Phase 1.
  return (
    <div className="p-4">
      <div className="px-4 pt-3">
        <ModuleBreadcrumb
          moduleId={breadcrumbModuleId}
          modules={modules}
          leaf={{ label: config.title }}
        />
      </div>
      <div className="m-4 p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-700 flex items-start gap-2">
        <AlertTriangle size={16} className="shrink-0 mt-0.5" />
        <div>
          Layout <code className="font-mono">{config.layout}</code> is not supported by the catalog
          DetailView (Phase 1). Open this page via the Config Explorer for now.
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PublishedDagBody — Phase-1 port of ConfigEngine.PublishedDagPage. Accepts
// a `data` array (back-compat for V086 single-table render) and a `meta` object
// (preserves multi-output ordering when meta.outputs is present).
// ─────────────────────────────────────────────────────────────────────────────

function fieldInitialValue(field: PublishedFormField, override: unknown): unknown {
  if (override !== undefined && override !== null && override !== '') {
    if (Array.isArray(override)) return (override as unknown[]).map(String).join(', ');
    if (typeof override === 'object') return JSON.stringify(override, null, 2);
    return override;
  }
  if (field.default !== null && field.default !== undefined) {
    if (field.type === 'array' && Array.isArray(field.default)) {
      return (field.default as unknown[]).map(String).join(', ');
    }
    if (field.type === 'bool') return Boolean(field.default);
    if (field.type === 'json') return JSON.stringify(field.default, null, 2);
    return String(field.default);
  }
  if (field.type === 'bool') return false;
  return '';
}

function coerceFormValue(field: PublishedFormField, raw: unknown): unknown {
  if (raw === '' || raw === null || raw === undefined) {
    return field.required ? raw : null;
  }
  switch (field.type) {
    case 'array': {
      const s = String(raw).trim();
      if (!s) return [];
      return s.split(',').map((t) => t.trim()).filter(Boolean);
    }
    case 'number': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
    case 'bool':
      return Boolean(raw);
    case 'json': {
      const s = String(raw).trim();
      if (!s) return null;
      try { return JSON.parse(s); } catch { return s; }
    }
    default:
      return raw;
  }
}

function PublishedDagBody({
  pageId,
  schema,
  initialFormValues,
  data,
  meta,
  onSubmit,
}: {
  pageId: string;
  schema: PublishedFormField[];
  initialFormValues: Record<string, unknown> | undefined;
  data: Record<string, unknown>[];
  meta?: PageMeta;
  onSubmit: (values: Record<string, unknown>) => void | Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const init: Record<string, unknown> = {};
    for (const f of schema) init[f.name] = fieldInitialValue(f, initialFormValues?.[f.name]);
    return init;
  });

  const handleChange = (name: string, raw: unknown) => {
    setValues((prev) => ({ ...prev, [name]: raw }));
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const coerced: Record<string, unknown> = {};
    for (const f of schema) coerced[f.name] = coerceFormValue(f, values[f.name]);
    void onSubmit(coerced);
  };

  const stage = meta?.stage;
  const lineage = meta?.lineage || [];
  const elapsedMs = meta?.elapsed_ms;
  const truncated = meta?.truncated;
  const rowCount = meta?.row_count;

  // DAG-PUBLISH-V01-FU: ordered list of (nodeId, frame) tuples — primary first,
  // intermediates after, sorted for stability. Verbatim port from ConfigEngine
  // line 765-775 (do not change without re-validating against the same fixture).
  const orderedOutputs = useMemo(() => {
    const map = meta?.outputs;
    if (!map) return [] as Array<[string, PublishedDagOutput]>;
    const primary = meta?.primary_output_node_id ?? meta?.output_node_id;
    const ids = Object.keys(map);
    const others = ids.filter((id) => id !== primary).sort();
    const ordered = [primary && map[primary] ? primary : null, ...others].filter(
      (id): id is string => id !== null && Object.prototype.hasOwnProperty.call(map, id),
    );
    return ordered.map((id) => [id, map[id]] as [string, PublishedDagOutput]);
  }, [meta?.outputs, meta?.primary_output_node_id, meta?.output_node_id]);

  const primaryNodeId = meta?.primary_output_node_id ?? meta?.output_node_id;

  // Back-compat columns (V086 era) — derived from data[0].
  const fallbackColumns: string[] = useMemo(
    () => (data.length === 0 ? [] : Object.keys(data[0])),
    [data],
  );

  return (
    <div>
      {/* Form */}
      <form onSubmit={handleSubmit} className="mb-6 p-4 bg-white border border-slate-200 rounded-lg">
        <div className="text-sm font-medium text-slate-700 mb-3 flex items-center gap-2">
          <span>Parameters</span>
          {meta?.output_node_id && (
            <span className="text-xs font-mono text-slate-400">→ {meta.output_node_id}</span>
          )}
        </div>

        {schema.length === 0 ? (
          <div className="text-xs text-slate-500 italic mb-3">
            No exposed parameters — DAG will run with snapshot-bound inputs.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            {schema.map((field) => (
              <div key={field.name} className="flex flex-col">
                <label className="text-xs font-medium text-slate-600 mb-1 flex items-center gap-1">
                  <span className="font-mono">{field.name}</span>
                  {field.required && <span className="text-red-500">*</span>}
                  {field.pg_type && (
                    <span className="text-slate-400 font-normal">({field.pg_type})</span>
                  )}
                </label>
                {field.type === 'bool' ? (
                  <label className="inline-flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={Boolean(values[field.name])}
                      onChange={(e) => handleChange(field.name, e.target.checked)}
                      className="w-4 h-4"
                    />
                    <span className="text-slate-600 text-xs">{String(Boolean(values[field.name]))}</span>
                  </label>
                ) : field.type === 'json' ? (
                  <textarea
                    value={String(values[field.name] ?? '')}
                    onChange={(e) => handleChange(field.name, e.target.value)}
                    placeholder={field.required ? 'required' : 'optional'}
                    rows={4}
                    className="border border-slate-300 rounded px-2 py-1 text-sm font-mono"
                  />
                ) : (
                  <input
                    type={field.type === 'number' ? 'number' : 'text'}
                    value={String(values[field.name] ?? '')}
                    onChange={(e) => handleChange(field.name, e.target.value)}
                    placeholder={
                      field.type === 'array'
                        ? 'comma,separated,values'
                        : field.required ? 'required' : 'optional'
                    }
                    className="border border-slate-300 rounded px-2 py-1 text-sm"
                  />
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded font-medium"
          >
            Run DAG
          </button>
          {stage === 'exec' && (
            <span className="text-xs text-slate-500">
              {typeof rowCount === 'number' && <>Returned <strong>{rowCount}</strong> row(s)</>}
              {truncated && <span className="ml-2 text-amber-600">(truncated)</span>}
              {typeof elapsedMs === 'number' && <span className="ml-2">in {elapsedMs} ms</span>}
            </span>
          )}
        </div>
      </form>

      {/* Result */}
      {stage === 'exec' && (
        orderedOutputs.length > 0 ? (
          <div className="space-y-4">
            {orderedOutputs.map(([nodeId, block]) => {
              const isPrimary = nodeId === primaryNodeId;
              const cols = block.columns?.length
                ? block.columns.map((c) => c.name)
                : (block.rows[0] ? Object.keys(block.rows[0]) : []);
              return (
                <div key={nodeId}>
                  <div className="flex items-baseline gap-2 mb-1.5">
                    <span className="text-xs font-mono text-slate-700">{nodeId}</span>
                    {isPrimary ? (
                      <span className="text-[10px] uppercase tracking-wide bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded">
                        primary
                      </span>
                    ) : (
                      <span className="text-[10px] uppercase tracking-wide bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded">
                        intermediate
                      </span>
                    )}
                    <span className="text-xs text-slate-500">
                      {block.row_count} row{block.row_count === 1 ? '' : 's'}
                      {block.truncated && <span className="ml-1 text-amber-600">(truncated)</span>}
                    </span>
                  </div>
                  {block.rows.length === 0 ? (
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded text-xs text-slate-500">
                      No rows returned.
                    </div>
                  ) : (
                    <SimpleResultTable cols={cols} rows={block.rows} />
                  )}
                </div>
              );
            })}
          </div>
        ) : data.length === 0 ? (
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-500">
            No rows returned.
          </div>
        ) : (
          <SimpleResultTable cols={fallbackColumns} rows={data} />
        )
      )}

      {/* Lineage */}
      {stage === 'exec' && lineage.length > 0 && (
        <details className="mt-3 text-xs text-slate-500">
          <summary className="cursor-pointer hover:text-slate-700">
            Execution lineage ({lineage.length} step{lineage.length === 1 ? '' : 's'})
          </summary>
          <div className="mt-2 p-2 bg-slate-50 border border-slate-200 rounded font-mono space-y-1">
            {lineage.map((step, i) => (
              <div key={i}>
                <span className="text-slate-400">{i + 1}.</span>{' '}
                <span className="text-slate-700">{step.node_id}</span>{' '}
                <span className="text-slate-500">— {step.detail}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      <FeedbackButton pageId={pageId} />
    </div>
  );
}

function SimpleResultTable({
  cols, rows,
}: {
  cols: string[];
  rows: Record<string, unknown>[];
}) {
  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200">
            {cols.map((c) => (
              <th key={c} className="px-3 py-2 text-left font-medium text-slate-600 font-mono text-xs">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-slate-100 hover:bg-slate-50">
              {cols.map((c) => {
                const v = row[c];
                return (
                  <td key={c} className="px-3 py-2 text-slate-700">
                    {v === null || v === undefined
                      ? <span className="text-slate-300">—</span>
                      : typeof v === 'object'
                        ? <code className="font-mono text-xs">{JSON.stringify(v)}</code>
                        : String(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TablePageBody — DataTable + saved-view bar. Mirrors ConfigEngine.TablePageWithSavedView
// but routes the URL ?view= mirror through stackApi.replaceQueryParam (NOT
// window.history.replaceState).
// ─────────────────────────────────────────────────────────────────────────────

function TablePageBody({
  pageId, stackApi, columns, data, filters, drilldown, columnMasks, meta,
}: {
  pageId: string;
  stackApi: CatalogStackAPI;
  columns: ColumnDef[];
  data: Record<string, unknown>[];
  filters: FilterDef[];
  drilldown?: DrilldownDef;
  columnMasks: Record<string, string>;
  meta?: PageMeta;
}) {
  const initialViewId = useMemo(() => {
    if (typeof window === 'undefined') return undefined;
    return new URLSearchParams(window.location.search).get('view') || undefined;
  }, []);

  const sv = useSavedView({ pageId, initialViewId });

  const [liveState, setLiveState] = useState<{
    sortKey: string;
    sortDir: 'asc' | 'desc';
    filterValues: Record<string, string>;
    hiddenCols: string[];
  }>({ sortKey: '', sortDir: 'asc', filterValues: {}, hiddenCols: [] });

  const liveConfig = useMemo(() => ({
    filters: Object.entries(liveState.filterValues)
      .filter(([, v]) => v && v !== 'All')
      .map(([field, value]) => ({ field, op: 'eq' as const, value })),
    sort: liveState.sortKey
      ? { col: liveState.sortKey, dir: liveState.sortDir }
      : undefined,
    hidden_cols: liveState.hiddenCols.length ? liveState.hiddenCols : undefined,
  }), [liveState]);

  // Mirror activeView ↔ URL via stackApi.replaceQueryParam — never touch
  // window.history directly inside catalog/.
  useEffect(() => {
    stackApi.replaceQueryParam('view', sv.activeView ? sv.activeView.view_id : null);
  }, [sv.activeView, stackApi]);

  const initialFromView = useMemo(() => {
    const cfg = sv.activeView?.config_json;
    if (!cfg) return { sort: undefined, filters: undefined, hidden: undefined };
    const filterValues: Record<string, string> = {};
    for (const f of cfg.filters || []) {
      if (f.op === 'eq') filterValues[f.field] = f.value;
    }
    return {
      sort: cfg.sort,
      filters: filterValues,
      hidden: cfg.hidden_cols || [],
    };
  }, [sv.activeView]);

  const handleRowClick = useCallback((row: Record<string, unknown>) => {
    if (!drilldown) return;
    const params: Record<string, string> = {};
    for (const [paramName, source] of Object.entries(drilldown.param_mapping)) {
      if (typeof source === 'string' && source.startsWith('$row.')) {
        params[paramName] = String(row[source.slice(5)] ?? '');
      } else {
        params[paramName] = String(source);
      }
    }
    stackApi.push({ kind: 'page-detail', pageId: drilldown.page_id, params });
  }, [drilldown, stackApi]);

  return (
    <>
      <SavedViewBar
        views={sv.views}
        active={sv.activeView}
        loading={sv.loading}
        currentConfig={liveConfig}
        onApply={sv.applyView}
        onClear={sv.clearActive}
        onSaveAs={(name, cfg, isDefault) => sv.saveAsView(name, cfg, isDefault).then(() => undefined)}
        onUpdateActive={sv.updateActiveView}
        onRename={sv.renameView}
        onSetDefault={sv.setDefault}
        onDelete={sv.deleteView}
      />
      <DataTable
        key={sv.activeView?.view_id || 'no-view'}
        columns={columns}
        data={data}
        filters={filters}
        drilldown={drilldown}
        columnMasks={columnMasks}
        meta={meta}
        onRowClick={drilldown ? handleRowClick : undefined}
        initialSort={initialFromView.sort}
        initialFilters={initialFromView.filters}
        initialHiddenCols={initialFromView.hidden}
        onStateChange={setLiveState}
      />
      <FeedbackButton pageId={pageId} />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// DataTable — local copy of ConfigEngine.DataTable. Keeping it inline avoids
// editing ConfigEngine.tsx (forbidden by Agent B brief) and keeps the
// catalog package self-contained for Phase 2 stand-alone use.
// ─────────────────────────────────────────────────────────────────────────────

function DataTable({
  columns,
  data,
  filters,
  drilldown,
  columnMasks,
  meta,
  onRowClick,
  initialSort,
  initialFilters,
  initialHiddenCols,
  onStateChange,
}: {
  columns: ColumnDef[];
  data: Record<string, unknown>[];
  filters: FilterDef[];
  drilldown?: DrilldownDef;
  columnMasks: Record<string, string>;
  meta?: PageMeta;
  onRowClick?: (row: Record<string, unknown>) => void;
  initialSort?: { col: string; dir: 'asc' | 'desc' };
  initialFilters?: Record<string, string>;
  initialHiddenCols?: string[];
  onStateChange?: (s: {
    sortKey: string;
    sortDir: 'asc' | 'desc';
    filterValues: Record<string, string>;
    hiddenCols: string[];
  }) => void;
}) {
  const tokens = useRenderTokens();
  const [sortKey, setSortKey] = useState<string>(initialSort?.col || '');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(initialSort?.dir || 'asc');
  const [filterValues, setFilterValues] = useState<Record<string, string>>(initialFilters || {});
  const [hiddenCols, setHiddenCols] = useState<string[]>(initialHiddenCols || []);

  const initialKey = useMemo(
    () => JSON.stringify({ initialSort, initialFilters, initialHiddenCols }),
    [initialSort, initialFilters, initialHiddenCols],
  );
  useEffect(() => {
    setSortKey(initialSort?.col || '');
    setSortDir(initialSort?.dir || 'asc');
    setFilterValues(initialFilters || {});
    setHiddenCols(initialHiddenCols || []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey]);

  useEffect(() => {
    onStateChange?.({ sortKey, sortDir, filterValues, hiddenCols });
  }, [sortKey, sortDir, filterValues, hiddenCols, onStateChange]);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const handleFilterChange = (field: string, value: string) => {
    setFilterValues((prev) => ({ ...prev, [field]: value }));
  };

  const visibleColumns = useMemo(
    () => columns.filter((c) => !hiddenCols.includes(c.key)),
    [columns, hiddenCols],
  );

  const processedData = useMemo(() => {
    let result = [...data];
    for (const [field, value] of Object.entries(filterValues)) {
      if (value && value !== 'All') {
        result = result.filter((row) => String(row[field]) === value);
      }
    }
    if (sortKey) {
      result.sort((a, b) => {
        const va = a[sortKey];
        const vb = b[sortKey];
        if (va === null || va === undefined) return 1;
        if (vb === null || vb === undefined) return -1;
        const cmp = String(va).localeCompare(String(vb), undefined, { numeric: true });
        return sortDir === 'asc' ? cmp : -cmp;
      });
    }
    return result;
  }, [data, filterValues, sortKey, sortDir]);

  return (
    <div>
      {filters.length > 0 && (
        <div className="flex flex-wrap gap-3 mb-4">
          {filters.map((f) => (
            <div key={f.field} className="flex items-center gap-1.5">
              <label className="text-xs font-medium text-slate-500 capitalize">
                {f.field.replace(/_/g, ' ')}
              </label>
              <select
                value={filterValues[f.field] || f.default}
                onChange={(e) => handleFilterChange(f.field, e.target.value)}
                className="text-xs border border-slate-200 rounded-md px-2 py-1.5 bg-white focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
              >
                {f.options.map((opt) => (
                  <option key={opt} value={opt}>{opt}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}

      {meta && (
        <div className="flex items-center gap-4 mb-3 text-xs text-slate-500">
          <span>
            Showing <strong>{processedData.length}</strong> of {meta.filteredCount} filtered ({meta.totalCount} total)
          </span>
          {Object.keys(columnMasks).length > 0 && (
            <span className="text-amber-600">
              {Object.keys(columnMasks).length} column(s) masked/denied
            </span>
          )}
        </div>
      )}

      <div className="overflow-x-auto border border-slate-200 rounded-lg">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              {visibleColumns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => col.sortable && handleSort(col.key)}
                  className={`px-3 py-2.5 text-left font-medium text-slate-600 whitespace-nowrap
                    ${col.sortable ? 'cursor-pointer hover:bg-slate-100 select-none' : ''}
                    ${col.align === 'right' ? 'text-right' : ''}
                    ${columnMasks[col.key] ? 'text-amber-600' : ''}`}
                  title={columnMasks[col.key] || undefined}
                >
                  {col.label}
                  {col.sortable && sortKey === col.key && (
                    <span className="ml-1">{sortDir === 'asc' ? '↑' : '↓'}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {processedData.length === 0 ? (
              <tr>
                <td colSpan={visibleColumns.length} className="px-3 py-8 text-center text-slate-400">
                  No data available
                </td>
              </tr>
            ) : (
              processedData.map((row, i) => (
                <tr
                  key={i}
                  onClick={() => drilldown && onRowClick?.(row)}
                  className={`border-b border-slate-100 hover:bg-blue-50/50 transition-colors ${drilldown ? 'cursor-pointer' : ''}`}
                >
                  {visibleColumns.map((col) => (
                    <td
                      key={col.key}
                      className={`px-3 py-2 ${col.align === 'right' ? 'text-right' : ''}`}
                    >
                      {renderCell(row[col.key], col.render, tokens)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function renderCell(value: unknown, render: string | undefined, tokens: RenderTokens): ReactNode {
  if (value === null || value === undefined) return <span className="text-slate-300">—</span>;
  const str = String(value);

  if (str === '[DENIED]') {
    return <span className="text-red-400 font-mono text-xs" title="Access denied by policy">[DENIED]</span>;
  }
  if (!render) return str;

  switch (render) {
    case 'status_badge': {
      const color = tokens.status_color[str] || 'bg-slate-100 text-slate-600';
      return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${color}`}>{str}</span>;
    }
    case 'phase_tag': {
      const color = tokens.phase_color[str] || 'bg-blue-100 text-blue-700';
      return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${color}`}>{str}</span>;
    }
    case 'gate_badge': {
      const color = tokens.gate_color[str] || 'bg-slate-100 text-slate-700';
      const label = str.replace(/_/g, ' ').replace(/^G(\d)/, 'G$1:');
      return <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${color}`}>{label}</span>;
    }
    case 'yield_bar': {
      const pct = parseFloat(str);
      if (Number.isNaN(pct)) return str;
      const barColor = pct >= 95 ? 'bg-emerald-500' : pct >= 90 ? 'bg-amber-500' : 'bg-red-500';
      return (
        <div className="flex items-center gap-2">
          <div className="w-16 h-2 bg-slate-200 rounded-full overflow-hidden">
            <div className={`h-full rounded-full ${barColor}`} style={{ width: `${Math.min(pct, 100)}%` }} />
          </div>
          <span className="text-xs font-mono whitespace-nowrap">{pct.toFixed(1)}%</span>
        </div>
      );
    }
    default:
      return str;
  }
}

// Suppress unused import warnings on ChevronRight + Workflow which are kept
// for future polish (used by the legacy module breadcrumb / republish path).
void ChevronRight; void Workflow;
