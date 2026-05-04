// catalog/types.ts
//
// Authoritative type contracts for the Catalog Workspace.
// Owned by Agent A. Agents B and C import from here and never redefine.
//
// See `.claude/plans/v3-phase-1/catalog-workspace-unified-design.md` §1.

import type { ReactNode } from 'react';

/* ---------- View modes ---------- */

export type ViewMode = 'tree' | 'grid' | 'detail' | 'schema';

/* ---------- Frame discriminated union ----------
 * Every frame kind is enumerated. There is NO "etc." kind.
 * Adding a kind requires updating: this union, FRAME_TO_VIEWMODE,
 * the URL parser, and the renderer switch in CatalogWorkspace.
 */

export type CardGridFrame = {
  kind: 'card-grid';
  // Root preset landing — tiles for entry points (modules, pages, tables, resources).
  // Has no params; viewState is purely scroll position.
};

export type ModuleTreeFrame = {
  kind: 'module-tree';
  selectedModuleId: string | null;       // master pane selection
};

export type ModuleDetailFrame = {
  kind: 'module-detail';
  moduleId: string;
};

export type PageGridFrame = {
  kind: 'page-grid';
  // Filter chip — null = all, otherwise restrict to module/owner/etc.
  filter?: { module_id?: string; status?: 'published' | 'draft' };
};

export type PageDetailFrame = {
  kind: 'page-detail';
  pageId: string;                        // either an admin row id or auto:<source>:<schema>.<table>
  // Inline params for parameterised pages (form_schema). Empty by default.
  params: Record<string, unknown>;
};

export type TableGridFrame = {
  kind: 'table-grid';
  filter?: { module_id?: string; pool?: string };
};

export type TableSchemaFrame = {
  kind: 'table-schema';
  table: string;                         // "schema.table"
};

export type ResourceGridFrame = {
  kind: 'resource-grid';
  // Type chip filter; null = all types.
  resourceType?: 'module' | 'table' | 'view' | 'column' | 'function' |
                 'dag' | 'web_page' | 'web_api' | 'db_pool' | 'page' | null;
};

export type HandlerFrame = {
  kind: 'handler';
  handlerName: string;                   // e.g. 'modules_home_handler'
  pageId: string;                        // origin pageId (so saved-view scope still works)
};

export type CatalogFrame =
  | CardGridFrame
  | ModuleTreeFrame
  | ModuleDetailFrame
  | PageGridFrame
  | PageDetailFrame
  | TableGridFrame
  | TableSchemaFrame
  | ResourceGridFrame
  | HandlerFrame;

export type FrameKind = CatalogFrame['kind'];

/* ---------- Frame → ViewMode mapping (exhaustive) ---------- */

export const FRAME_TO_VIEWMODE: Record<FrameKind, ViewMode> = {
  'card-grid':     'grid',
  'module-tree':   'tree',
  'module-detail': 'detail',
  'page-grid':     'grid',
  'page-detail':   'detail',
  'table-grid':    'grid',
  'table-schema':  'schema',
  'resource-grid': 'grid',
  'handler':       'detail',  // handlers render their own UI inside detail slot
};

/* ---------- ViewState (per-frame snapshot) ----------
 * Discriminated by viewMode. Restored on goBack.
 * NOT a flat object — tree state ≠ grid state ≠ detail form state.
 */

export type TreeViewState = {
  viewMode: 'tree';
  expandedIds: string[];          // expanded tree node ids
  scrollTop: number;
};

export type GridViewState = {
  viewMode: 'grid';
  scrollTop: number;
  // Per-grid preferences. Saved-view-id lives in URL (?view=), not here.
  search?: string;
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  // GridView is column-config-driven; column visibility lives in saved view server-side.
};

export type DetailViewState = {
  viewMode: 'detail';
  scrollTop: number;
  // Form values for parameterised pages. PublishedDagPage / handler frames may store
  // their interactive form state here so a goBack restores user input.
  formValues?: Record<string, unknown>;
  // Sub-tab id, if the detail body has tabs (e.g. ModuleDetail tables/functions/pages).
  subTab?: string;
};

export type SchemaViewState = {
  viewMode: 'schema';
  scrollTop: number;
  selectedColumn?: string;
};

export type ViewState =
  | TreeViewState
  | GridViewState
  | DetailViewState
  | SchemaViewState;

/* ---------- Inspector ---------- */

// Subjects an inspector can describe. The grid/tree/detail emits one of these
// when the user clicks a row's "peek" affordance.
export type InspectorTarget =
  | { kind: 'page';     pageId: string }
  | { kind: 'module';   moduleId: string }
  | { kind: 'table';    table: string }
  | { kind: 'resource'; rid: string; resource_type: string };

export type InspectorRendererProps<T extends InspectorTarget = InspectorTarget> = {
  target: T;
  onClose: () => void;
  // Inspectors may push a frame onto the stack (e.g. "Open in detail").
  onOpen: (frame: CatalogFrame) => void;
};

export type InspectorRenderer = (props: InspectorRendererProps) => ReactNode;

export type InspectorRegistry = Partial<Record<InspectorTarget['kind'], InspectorRenderer>>;

/* ---------- Stack API ---------- */

export type CatalogStackAPI = {
  // The frame stack — index 0 is root.
  frames: readonly CatalogFrame[];
  // Index of the currently-rendered top frame.
  topIndex: number;

  push:    (frame: CatalogFrame) => void;
  pop:     () => void;                              // shrinks stack by 1
  goTo:    (index: number) => void;                 // for breadcrumb clicks
  replace: (frame: CatalogFrame) => void;           // replaces top frame
  reset:   (frame: CatalogFrame) => void;           // clears stack and pushes one frame

  // ViewState snapshot for the top frame.
  viewState: ViewState;
  setViewState: (next: ViewState | ((prev: ViewState) => ViewState)) => void;

  // Inspector pane.
  inspector: InspectorTarget | null;
  setInspector: (next: InspectorTarget | null) => void;

  // URL helper — for sub-features that need their own query param (saved view).
  // Use this INSTEAD of touching window.history directly.
  // Setting val=null removes the param.
  replaceQueryParam: (key: string, val: string | null) => void;
};

/* ---------- Preset ---------- */

export type CatalogPreset =
  | 'modules'      // root: module-tree
  | 'pages'        // root: page-grid
  | 'tables'       // root: table-grid
  | 'resources'    // root: resource-grid
  | 'home';        // root: card-grid (entry tiles)

export type PresetSpec = {
  id: CatalogPreset;
  rootFrame: CatalogFrame;
  title: string;
  // For breadcrumb root label.
};

/* ---------- Default ViewState factory (shared by useStack & urlSync) ---------- */

export function makeDefaultViewState(kind: FrameKind): ViewState {
  const mode = FRAME_TO_VIEWMODE[kind];
  switch (mode) {
    case 'tree':
      return { viewMode: 'tree', expandedIds: [], scrollTop: 0 };
    case 'grid':
      return { viewMode: 'grid', scrollTop: 0 };
    case 'detail':
      return { viewMode: 'detail', scrollTop: 0 };
    case 'schema':
      return { viewMode: 'schema', scrollTop: 0 };
  }
}
