# Catalog Workspace Unified Design

**Phase**: v3 Phase 1 — Foundation only
**Mode**: One-shot, no backwards compatibility (UI/UX 設計驗證階段,尚未 deploy 給真實使用者)
**Audience**: 3 implementation agents working in parallel with zero cross-talk
**Integrator**: Adam (Phase 2 — wires everything into App.tsx and deletes legacy)
**Cross-plan coordination**: 與 `ux-three-asks-plan.md` 案 2(ModuleBreadcrumb)合併;案 1、案 3 平行獨立。詳見 §11。

---

## 0. Goal & Non-Goals

### Goal
Replace 4 sidebar tabs (`access-resources`, `modules`, `access-pages`, `raw-tables`) plus the hidden `auto-page` slot with ONE component `<CatalogWorkspace preset={...} />`. The preset selects the initial root frame; everything else is shared infrastructure: a single frame stack, a view-mode router, an inspector drawer, URL sync, and LRU mount.

### Non-goals (explicit)
- No backwards-compatible URLs. Old query params for those 4 tabs are dropped.
- No router library (no react-router). Vanilla `history.pushState` / `popstate` only.
- No animation framework beyond what already exists.
- No new server endpoints. Reuses `api.ts` exactly as-is.
- Phase 1 ships the workspace **scaffold + extracted views**. Phase 2 (Adam) wires it into `App.tsx` and deletes legacy. No agent edits `App.tsx`, `Layout.tsx`, or any of the legacy tab files.

### Hard partition rule (do not violate)
**Agents only CREATE files under `apps/authz-dashboard/src/components/catalog/` and one shared atom under `apps/authz-dashboard/src/components/shared/atoms/`.** They do not edit, move, or delete any pre-existing file. All edits and deletes outside that folder are Phase-2 work owned by Adam. This is the only partition that achieves zero file-overlap; it is enforced by review.

This means: when Agent B "extracts" `PublishedDagPage` from `ConfigEngine.tsx`, they **copy** the logic into a fresh file under `catalog/`. The original stays put until Phase 2 deletes it. Same for everything Agent C "extracts" from `PagesTab.tsx` and `ResourcesSection.tsx`.

---

## 1. Type Contracts (authoritative)

These types are the integration interface. Agent A owns the file `catalog/types.ts`. Agents B and C import from it and never redefine these.

```ts
// catalog/types.ts

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

export type InspectorRenderer = (props: InspectorRendererProps) => React.ReactNode;

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
```

### Design decisions locked

1. **`HandlerFrame` is its own kind, not a sub-state of `DetailViewState`.** Handlers (`modules_home_handler`, `audit_home_handler`, `npi_gate_console_handler`) get a first-class frame because they own the entire body and bypass `PublishedDagPage`. They map to `viewMode='detail'` so they sit in the detail slot.
2. **ViewState is a discriminated union, not a flat object.** Each viewMode has its own state shape. Type-narrowing via `viewState.viewMode === 'grid'` is the contract.
3. **Saved-view id lives in the URL `?view=` query, not in ViewState.** This preserves existing `useSavedView` behaviour and makes a saved-view link copy/pasteable. ViewState restores ephemeral UI (scroll, search, sort) only.
4. **`replaceQueryParam` is the only sanctioned way to mutate `window.history.search` from inside a frame.** Direct `window.history.replaceState` calls inside frame components are forbidden — they would race with stack URL sync.
5. **LRU policy: top 3 frames (deepest first) stay mounted with `display:none` when not active. Frames below that are replaced by their snapshot only and re-mount + re-fetch on goBack.** This bound is fixed; agents do not parameterise it.

---

## 2. URL Schema

### Hash for stack
```
#/cat/<preset>/<frame0>[/<frame1>[/<frame2>...]]
```

`<frameN>` encodes the kind plus its non-default params, separated by `~`:
```
module-tree~m=mod123
module-detail~m=mod123
page-grid~module=mod123
page-detail~id=auto:pg:public.users
table-grid
table-schema~t=public.orders
resource-grid~type=table
handler~h=modules_home_handler~p=modules_home
card-grid
```

Param keys (no spaces, no `/`, no `~`):
- `m` = moduleId / selectedModuleId
- `id` = pageId (URL-encoded; colons in `auto:src:schema.table` are kept as-is)
- `module` = filter.module_id
- `status` = filter.status
- `pool` = filter.pool
- `t` = table (schema.table)
- `type` = resourceType
- `h` = handlerName
- `p` = handler's origin pageId
- `pv:<key>` = formValues entry for parameterised detail (URL-encoded JSON-encoded value)

### Query for per-frame extras
```
?view=<savedViewId>
```
Owned by the active frame's saved view. `replaceQueryParam('view', id)` updates without dirtying the stack hash. No other query params are reserved by Catalog; sub-features may add their own as long as they go through `replaceQueryParam`.

### Parser/serializer signatures (Agent A implements)

```ts
// catalog/urlSync.ts
export function parseHash(hash: string): { preset: CatalogPreset; frames: CatalogFrame[] } | null;
export function serializeHash(preset: CatalogPreset, frames: readonly CatalogFrame[]): string;

// History sync — push on push/replace, replaceState on viewState-only changes,
// listen to popstate to drive `pop` / `goTo`.
export function installHistorySync(
  api: CatalogStackAPI,
  preset: CatalogPreset,
): () => void; // returns unsubscribe
```

### `popstate` semantics
- Browser back: hash diffs, `installHistorySync` recomputes target stack and calls `goTo(N)` (snapshot restore — no re-fetch above LRU window).
- Browser forward: same recompute path. If frame is below LRU window, restore from snapshot only; the renderer may re-fetch lazily.
- Frames whose URL params changed get `replace`, not `push`.

---

## 3. File Ownership Table

Every file has exactly one owner. **Agents do not touch any file outside their column.** All paths are relative to `apps/authz-dashboard/src/`.

| Path | Owner | Action |
|---|---|---|
| `components/catalog/CatalogWorkspace.tsx` | **A** | CREATE |
| `components/catalog/types.ts` | **A** | CREATE |
| `components/catalog/useStack.ts` | **A** | CREATE |
| `components/catalog/urlSync.ts` | **A** | CREATE |
| `components/catalog/presets.ts` | **A** | CREATE |
| `components/catalog/Inspector.tsx` | **A** | CREATE — slot only; renders from registry |
| `components/catalog/InspectorRegistry.ts` | **A** | CREATE — empty registry, type only |
| `components/catalog/Breadcrumbs.tsx` | **A** | CREATE — drill-down trail; no Home button |
| `components/catalog/CardGridView.tsx` | **A** | CREATE — root tiles for `card-grid` frame |
| `components/catalog/_stubs.tsx` | **A** | CREATE — temporary placeholder so A's branch compiles; deleted in Phase 2 |
| `components/shared/atoms/ModuleBreadcrumb.tsx` | **A** | CREATE — **module-tree position breadcrumb (合併自 ux-three-asks 案 2)**;見 §11.1 |
| `components/catalog/__tests__/urlSync.test.ts` | **A** | CREATE if test infra exists |
| `components/catalog/DetailView.tsx` | **B** | CREATE — copy logic from `ConfigEngine.PublishedDagPage` + `TablePageWithSavedView` |
| `components/catalog/SchemaView.tsx` | **B** | CREATE — copy logic from `TablesTab.tsx` |
| `components/catalog/HandlerHost.tsx` | **B** | CREATE — wraps existing `HANDLER_REGISTRY` calls; reuses `ConfigEngine`'s handler imports |
| `components/catalog/handlerRegistry.ts` | **B** | CREATE — copy of `ConfigEngine.HANDLER_REGISTRY` lines 161-167 |
| `components/catalog/inspectors/PageInspector.tsx` | **B** | CREATE — copy of `PagesTab.LineagePanel` minus `recent_audit` column |
| `components/catalog/inspectors/TableInspector.tsx` | **B** | CREATE |
| `components/catalog/GridView.tsx` | **C** | CREATE — column-config-driven, parameterised by frame kind |
| `components/catalog/TreeView.tsx` | **C** | CREATE |
| `components/catalog/columns/pageColumns.tsx` | **C** | CREATE |
| `components/catalog/columns/tableColumns.tsx` | **C** | CREATE |
| `components/catalog/columns/resourceColumns.tsx` | **C** | CREATE |
| `components/catalog/dialogs/PageEditDialog.tsx` | **C** | CREATE — copy from `PagesTab.tsx` |
| `components/catalog/dialogs/PageDeleteDialog.tsx` | **C** | CREATE — copy from `PagesTab.tsx` |
| `components/catalog/inspectors/ResourceInspector.tsx` | **C** | CREATE |
| `components/catalog/inspectors/ModuleInspector.tsx` | **C** | CREATE |
| `App.tsx` | **Phase 2 / Adam** | EDIT |
| `components/Layout.tsx` | **Phase 2 / Adam** | EDIT |
| `components/ConfigEngine.tsx` | **Phase 2 / Adam** | DELETE candidates listed in §6 |
| `components/PagesTab.tsx` | **Phase 2 / Adam** | DELETE |
| `components/TablesTab.tsx` | **Phase 2 / Adam** | DELETE |
| `components/modules/ModulesTab.tsx` | **Phase 2 / Adam** | DELETE |
| `components/access-manager/ResourcesSection.tsx` | **Phase 2 / Adam** | DELETE |
| `components/DiscoverTab.tsx` | **Phase 2 / Adam** | EDIT — rewire `open-auto-page` |
| `components/DagTab.tsx` | **Phase 2 / Adam** | EDIT — rewire `open-auto-page` + (ux-three-asks 案 2) publish dialog 改用 `<ModuleBreadcrumb>` |
| `components/modules/ModuleDetail.tsx` | **Phase 2 / Adam** | DELETE — Agent B 已複製進 DetailView;ux-three-asks 案 2 對此檔的 inline 重構**因刪檔而免做** |

**Conflict avoidance**: agents B and C both extract from `PagesTab.tsx`, `ConfigEngine.tsx`, etc., but only by **copying** into their fresh files. They never open the originals for write. The Phase-2 deletion happens after both agents land.

---

## 4. Agent Briefs

### Agent A — Foundation (no extraction, builds the chassis)

**Branch**: `agent-a/catalog-foundation`

**Files (CREATE only, listed in §3)**:
1. `catalog/types.ts` — exact contents of §1.
2. `catalog/useStack.ts` — exposes `CatalogStackAPI`. Internally a `useReducer` over `{ frames, topIndex, viewStates: ViewState[], inspector }`. ViewStates is parallel to frames; on `push`, append a default ViewState derived from `FRAME_TO_VIEWMODE[frame.kind]`; on `pop`, drop both.
3. `catalog/urlSync.ts` — `parseHash`, `serializeHash`, `installHistorySync`. The two-way sync: stack mutations → `pushState`/`replaceState`; `popstate` → drive stack via `goTo`/`reset`. **Idempotency**: do not re-push when the target hash already matches. **`replaceQueryParam`** mutates the search string only; never the hash.
4. `catalog/presets.ts` — definitions for each `CatalogPreset` → `PresetSpec`:
   - `modules` → root `{ kind: 'module-tree', selectedModuleId: null }`
   - `pages` → root `{ kind: 'page-grid' }`
   - `tables` → root `{ kind: 'table-grid' }`
   - `resources` → root `{ kind: 'resource-grid', resourceType: null }`
   - `home` → root `{ kind: 'card-grid' }`
5. `catalog/CatalogWorkspace.tsx` — accepts `{ preset: CatalogPreset; initialFrameOverride?: CatalogFrame }`. Mounts `useStack`, installs `installHistorySync`, renders:
   - `<Breadcrumbs frames=... onGoTo=... />`
   - LRU-mounted frame slots (top 3 visible-or-hidden, deeper unmounted)
   - The frame renderer (see §5.5 below — switch on `kind`, lazy-imports views from peer files)
   - `<Inspector />` slot on the right
6. `catalog/Inspector.tsx` — slide-in drawer; reads `inspector` from stack API; looks up renderer in `InspectorRegistry`; passes `{ target, onClose, onOpen }`. If kind has no registered renderer, shows a fallback "Inspector unavailable" state.
7. `catalog/InspectorRegistry.ts` — exports a mutable registry instance plus a `registerInspector(kind, renderer)` helper. **Phase-2 wiring** populates it; Phase-1 ships empty.
8. `catalog/Breadcrumbs.tsx` — list of crumbs from `frames`; clicking crumb N calls `goTo(N)`. **No Home button.** The first crumb (preset root) is the Home equivalent. **此為 drill-down trail breadcrumb;與 §11.1 的 ModuleBreadcrumb 是兩個不同的元件,語意不同。**
9. `catalog/CardGridView.tsx` — landing tiles for `card-grid` frame: 4 tiles linking to Modules / Pages / Tables / Resources via `replace({ kind: 'module-tree', ... })` etc. (Same workspace, just swap root frame; URL preset stays `home`.)
10. **`shared/atoms/ModuleBreadcrumb.tsx`(合併自 ux-three-asks 案 2)** — 見 §11.1 完整 spec。Agent A 同時擁有此檔,因為:
    - 與 Agent A 的 `Breadcrumbs.tsx` 概念對偶(drill-down trail vs module-tree position),由同一 owner 維持風格一致
    - Agent B 的 `DetailView` 會 import 它(用來在 page-detail 內顯示 `Catalog › Modules › {parent} › {page}`)
    - Agent C 的 `GridView` / `PageInspector` 也會用到

**Renderer switch (Agent A in `CatalogWorkspace`)**:

```ts
// Agent A imports placeholders from peer files. Until Agent B/C land,
// these are no-op stubs Agent A ships in their own branch as throwaway
// tsx files OR — preferred — as a single `__stubs.tsx` they own and delete
// in Phase 2. Agent A's branch must compile standalone.
import { GridView } from './GridView';        // C
import { TreeView } from './TreeView';        // C
import { DetailView } from './DetailView';    // B
import { SchemaView } from './SchemaView';    // B
import { HandlerHost } from './HandlerHost';  // B
import { CardGridView } from './CardGridView';// A

function FrameRenderer({ frame }: { frame: CatalogFrame }) {
  switch (frame.kind) {
    case 'card-grid':     return <CardGridView />;
    case 'module-tree':   return <TreeView frame={frame} />;
    case 'module-detail': return <DetailView frame={frame} />;
    case 'page-grid':     return <GridView frame={frame} />;
    case 'page-detail':   return <DetailView frame={frame} />;
    case 'table-grid':    return <GridView frame={frame} />;
    case 'table-schema':  return <SchemaView frame={frame} />;
    case 'resource-grid': return <GridView frame={frame} />;
    case 'handler':       return <HandlerHost frame={frame} />;
  }
}
```

**Stub strategy**: Agent A creates `catalog/_stubs.tsx` that exports `GridView`, `TreeView`, `DetailView`, `SchemaView`, `HandlerHost` as trivial placeholders so Agent A's branch compiles. **Phase 2 deletes `_stubs.tsx`.** This file is solely Agent A's; no other agent touches it. If Agent A ships dummy components inside the real-named files instead, agent C/B branches would clobber them on merge — DO NOT do that.

**Acceptance**:
- Vite build succeeds on Agent A's branch with stubs.
- `parseHash(serializeHash(p, frames)) === { preset: p, frames }` for round-trip tests across all frame kinds.
- Browser back/forward correctly drives `goTo` without infinite loops.
- `replaceQueryParam('view', 'foo')` updates the URL without affecting the hash and without triggering a stack `popstate`.
- LRU policy: pushing 5 frames keeps frames 2/3/4 mounted with display:none and unmounts frames 0/1.
- `<ModuleBreadcrumb>` 渲染正確的 module 鏈、null moduleId 顯示「Catalog」、leaf 段不可 click。

**Out of scope for Agent A**:
- Any view rendering (grids, trees, detail, schema).
- Any data fetching (except `ModuleBreadcrumb` consumes a `modules` prop passed by parent — Agent A 不在 atom 內部抓 module tree)。
- Any inspector content.

---

### Agent B — Detail + Schema extraction

**Branch**: `agent-b/catalog-detail-schema`

**Files (CREATE only)**:
1. `catalog/DetailView.tsx` — accepts `{ frame: ModuleDetailFrame | PageDetailFrame; api: CatalogStackAPI }`. Branches on frame.kind:
   - `module-detail`: render lifted-and-copied logic from `components/modules/ModuleDetail.tsx`. Sub-tabs (`tables`/`functions`/`pages`/`access`/`profiles`) map to `viewState.subTab`. **Replace** the `open-auto-page` window dispatch (currently line 286 of original) with `api.push({ kind: 'page-detail', pageId, params: {} })`.
   - `page-detail`: render lifted-and-copied logic from `ConfigEngine.PublishedDagPage` (form_schema rendering, exec stages, multi-output via `meta.outputs` and `primary_output_node_id`). Also handles non-form pages by calling `configExecPage(pageId, {})` and rendering rows like `TablePageWithSavedView` does. The internal saved-view sync MUST go through `api.replaceQueryParam('view', id)` — do **not** call `window.history.replaceState` directly.
   - **Top of detail body**:渲染 `<ModuleBreadcrumb moduleId={parentModuleId} modules={modules} leaf={{label: title}} />`(從 `shared/atoms/ModuleBreadcrumb.tsx`)— 解 ux-three-asks 案 2 對 auto-page renderer 的需求(D5 變得不需要,因為 page-detail frame 直接帶 parent_module_id 進來,或 Agent B 自己抓 `api.moduleTree()`)。

2. `catalog/SchemaView.tsx` — copy logic from `components/TablesTab.tsx`: `api.tables`, `api.tableSchema`, `api.dataExplorer`. Renders columns (visible/masked/denied badges), sample data, RLS filter, mask functions. `viewState.selectedColumn` highlights a column.

3. `catalog/HandlerHost.tsx` — for `HandlerFrame`. Imports the `HANDLER_REGISTRY` from `catalog/handlerRegistry.ts` (Agent B-owned, copied verbatim from `ConfigEngine.tsx` lines 161-167). Renders the named handler component with props derived from frame; handlers like `modules_home_handler` will internally call `api.push(...)` to navigate.

4. `catalog/handlerRegistry.ts` — copy of `ConfigEngine.HANDLER_REGISTRY` map. The handler-component imports themselves stay where they are (don't move them). Phase-2 deletes the original constant from ConfigEngine.

5. `catalog/inspectors/PageInspector.tsx` — copy `PagesTab.LineagePanel` (lines 661-798 of original), **deleting the third "Recent audit" column**. Layout becomes 2 columns: Snapshot, Subdag links. Calls `api.pageDetail(pageId)` to load. Buttons: Open in detail (calls `onOpen({ kind: 'page-detail', pageId, params: {} })`), Edit, Republish, Delete. **Top of inspector**:渲染 `<ModuleBreadcrumb>` 顯示該 page 在 module hierarchy 的位置(解 ux-three-asks 案 2 對 PagesTab 展開列的需求)。

6. `catalog/inspectors/TableInspector.tsx` — small drawer showing column count, RLS summary, last refresh; "Open schema" button calls `onOpen({ kind: 'table-schema', table })`.

**Critical traps for Agent B**:
- The original `TablePageWithSavedView` calls `window.history.replaceState` on every saved-view change. Replace this with `api.replaceQueryParam('view', id)` in your copy.
- The original `PagesTab` does a raw `fetch('/api/dag/published/${rid}/embedders')` (no api.ts wrapper). When you copy `LineagePanel`, keep that raw fetch — do not invent a typed wrapper, and do not block waiting for one.
- `PublishedDagPage` accepts `meta` from `configExecPage`'s response; `meta.outputs` is an array and `meta.primary_output_node_id` selects which one renders by default. Preserve this.
- `ModuleDetail` sub-tabs (tables/functions/pages/access/profiles) are descriptor-driven via `api.moduleDescriptors()`. Keep the descriptor logic — do not hardcode tab list.
- `<ModuleBreadcrumb>` 需要 `modules: ModuleTreeNode[]` prop。Agent B 在 `DetailView` mount 時呼叫 `api.moduleTree()` 一次,把結果 cache 在頂層 ref(避免每個 frame 重抓)。

**Acceptance**:
- `DetailView` renders for both kinds; pushed via Agent A's stack works; goBack restores form values from `viewState.formValues`.
- `SchemaView` renders the same data as the legacy `TablesTab`.
- `PageInspector` opens, shows snapshot + subdag, Open button pushes a `page-detail` frame.
- `<ModuleBreadcrumb>` 在 page-detail 與 PageInspector 內正確顯示,無 parent_module_id 時隱藏。
- No direct `window.history.*` calls in Agent B's files (grep your branch).
- Branch compiles standalone using Agent A's `_stubs.tsx` (you don't ship stubs of your own).

**Out of scope for Agent B**:
- Any list/grid rendering.
- Any tree rendering.
- Editing/deleting page rows (those dialogs are Agent C's).
- 建立 `<ModuleBreadcrumb>` 元件本身(由 Agent A 建立並維護,Agent B 只 import + 使用)。

---

### Agent C — Grid + Tree + Dialogs

**Branch**: `agent-c/catalog-grid-tree`

**Files (CREATE only)**:
1. `catalog/GridView.tsx` — accepts `{ frame: PageGridFrame | TableGridFrame | ResourceGridFrame; api: CatalogStackAPI }`. Branches on frame.kind to load:
   - `page-grid`: `api.pagesList(filter)` → render with `pageColumns`. Row click → `api.setInspector({ kind: 'page', pageId })`. Row "Open" → `api.push({ kind: 'page-detail', pageId, params: {} })`. Row 4-button actions: Open, Edit (open `PageEditDialog`), Republish (calls existing endpoint), Delete (open `PageDeleteDialog`).
     **Top of grid**: 渲染 `<ModuleBreadcrumb moduleId={null} rootLabel="Catalog" leaf={{label: 'Pages'}} />` — 固定二段「Catalog › Pages」(解 ux-three-asks 案 2 對 PagesTab PageHeader 的需求)。
   - `table-grid`: `api.tables()` → `tableColumns`. Row click → `setInspector({ kind: 'table', table })`. Row "Open" → `push({ kind: 'table-schema', table })`. Top: `<ModuleBreadcrumb moduleId={null} leaf={{label: 'Raw Tables'}} />`.
   - `resource-grid`: `api.resources()` → `resourceColumns`. Row click → `setInspector({ kind: 'resource', rid, resource_type })`. Type chip filter from `frame.resourceType`; chip change → `api.replace({ kind: 'resource-grid', resourceType: next })`. Top: `<ModuleBreadcrumb moduleId={null} leaf={{label: 'Resources'}} />`.

   Uses `useSavedView({ pageId: <derived> })` for per-grid saved views. The `pageId` is synthesised:
   - `page-grid` → `'__catalog_pages'`
   - `table-grid` → `'__catalog_tables'`
   - `resource-grid` → `'__catalog_resources'`

   Search/sort/scroll lives in `GridViewState`.

2. `catalog/TreeView.tsx` — for `module-tree`. Master-detail layout: tree on left (from `api.moduleTree()`), preview on right that shows a "selected module summary" placeholder with a button "Open module" → `api.push({ kind: 'module-detail', moduleId })`. The full ModuleDetail rendering happens in DetailView. `viewState.expandedIds` controls tree expansion.

3. `catalog/columns/pageColumns.tsx` — column config: name, page_id, owner, status, updated_at, source kind (auto vs admin), action buttons.

4. `catalog/columns/tableColumns.tsx` — column config: schema.table, pool, row count (if available), last refresh, has-RLS badge.

5. `catalog/columns/resourceColumns.tsx` — column config: rid, resource_type (chip), name, parent (for nested table→column).

6. `catalog/dialogs/PageEditDialog.tsx` — copy of `PagesTab.PageEditDialog` (lines 350-450 of original).

7. `catalog/dialogs/PageDeleteDialog.tsx` — copy of `PagesTab.PageDeleteDialog` (lines 466-650 of original).

8. `catalog/inspectors/ResourceInspector.tsx` — small drawer for resource subjects.

9. `catalog/inspectors/ModuleInspector.tsx` — small drawer for module subjects with "Open module" button. **Top**: 渲染 `<ModuleBreadcrumb moduleId={moduleId} modules={modules} />` 顯示該 module 自身在 hierarchy 的位置。

**Critical traps for Agent C**:
- `ResourcesSection.tsx` has `TYPE_META` (lines 15-26) and grouped table with parent-child nesting (table → column expansion). Lift this into `resourceColumns` + a row-expansion mechanic in `GridView`. Don't reinvent — copy it verbatim and adapt.
- Saved-view URL sync: rely on `useSavedView` as-is, but ensure any `?view=` writes go through `api.replaceQueryParam` (the hook may itself touch history; if it does, that's a known issue Agent C surfaces in its PR description for Phase 2 to revisit — do not modify `useSavedView` in Agent C's branch).
- `PagesTab` row "Edit Flow" action dispatches `navigate-tab` + `flow-composer-load-dag` (lines 113-117 of original). In your copy, keep dispatching those events — Flow Composer (`DagTab`) is outside Catalog and still listens to them.
- Do not depend on `<DetailView>`, `<SchemaView>`, or `<Inspector>` content — only on the stack API. Agent A's `_stubs.tsx` provides the placeholders for compile.
- `<ModuleBreadcrumb>` 由 Agent A 建立。Agent C 直接 `import` 使用,不可在自己分支內也建立同名元件。

**Acceptance**:
- Grids render data and respond to filter chips.
- Tree renders modules; expand/collapse persists across goBack.
- Edit/Delete dialogs open and submit against `api.pageUpdate` / `api.pageDelete`.
- Branch compiles standalone using Agent A's `_stubs.tsx`.
- 三種 grid 與 ModuleInspector 都有 ModuleBreadcrumb header。

**Out of scope for Agent C**:
- DetailView rendering, including any `PublishedDagPage` logic.
- SchemaView rendering.
- LineagePanel / PageInspector (Agent B owns it).
- 建立 `<ModuleBreadcrumb>` 元件本身。

---

## 5. Phase 2 Integration Steps (Adam)

Order matters — each step assumes the previous landed.

### 5.1 Merge order
1. Agent A foundation merges first (must be green standalone with `_stubs.tsx`).
2. Agents B and C merge in either order (each green standalone using A's `_stubs.tsx`).
3. **Phase 2 begins**.

### 5.2 Wire inspectors
- Edit `catalog/InspectorRegistry.ts` to register:
  ```ts
  registerInspector('page',     PageInspector);     // from B
  registerInspector('table',    TableInspector);    // from B
  registerInspector('resource', ResourceInspector); // from C
  registerInspector('module',   ModuleInspector);   // from C
  ```

### 5.3 Delete the stub file
- Delete `catalog/_stubs.tsx`. Now `CatalogWorkspace` resolves real `GridView` / `TreeView` / `DetailView` / `SchemaView` / `HandlerHost`.

### 5.4 Edit `App.tsx` (sketch)
- Delete imports: `TablesTab`, `PagesTab`, `ConfigEngine` (if unused after handler check), `MetabaseTab` if affected (it isn't).
- Add import: `import { CatalogWorkspace } from './components/catalog/CatalogWorkspace';`
- Delete `autoPagePreview` state + the `open-auto-page` event listener (lines 76-86) + the `'auto-page'` rendering branch (lines 166-174).
- Delete `legacyTabRedirect` and `navigate`'s redirect lookup; just `setTab(next as TabId)`.
- Replace tab renderers:
  ```tsx
  {tab === 'tables'           && <CatalogWorkspace preset="resources" />}  // OR see Q1
  {tab === 'modules'          && <CatalogWorkspace preset="modules"   />}
  {tab === 'access-pages'     && <CatalogWorkspace preset="pages"     />}
  {tab === 'raw-tables'       && <CatalogWorkspace preset="tables"    />}
  {tab === 'access-resources' && <CatalogWorkspace preset="resources" />}  // pending Q1
  ```
- Remove `auto-page` from the renderer table entirely.

### 5.5 Edit `Layout.tsx`
- Remove `'auto-page'` from `TabId` (line ~13-23).
- (Pending Q1) decide whether `access-resources` collapses into another preset.

### 5.6 Rewire `open-auto-page` dispatchers
The following call sites currently dispatch `new CustomEvent('open-auto-page', { detail: { page_id } })`:
- `DiscoverTab.tsx:521` (Generate App success)
- `DiscoverTab.tsx:528` (alternate path)
- `DagTab.tsx:1909` (SaveAsPageDialog onPublished)
- `DagTab.tsx:1927` (PublishDagDialog onPublished)
- `modules/ModuleDetail.tsx:286` (open published page snapshot) — **Agent B already rewires this in their copy. Phase 2 only needs to delete the original file.**

Replacement (pending Q2): swap dispatch to `new CustomEvent('catalog-open-page', { detail: { page_id, params: {} } })` and have `App.tsx` listen for it, switch to a Catalog tab, and call into the workspace via a ref/imperative handle. (See Q2 for alternatives.)

### 5.7 DagTab publish dialog 改用 ModuleBreadcrumb(ux-three-asks 案 2 收尾)
- `DagTab.tsx:3143-3155` 的 `parentBreadcrumb` 內聯實作 → 改 import `<ModuleBreadcrumb>`,維持 testid 不變(`publish-page-breadcrumb`)。
- 此項本來在 ux-three-asks 案 2 §3.2.2,合併進 Phase 2 一次做。

### 5.8 Delete legacy files
After verifying no remaining imports:
- `components/PagesTab.tsx`
- `components/TablesTab.tsx`
- `components/modules/ModulesTab.tsx`
- `components/modules/ModuleDetail.tsx` — Agent B 已複製進 DetailView
- `components/access-manager/ResourcesSection.tsx` (and remove `'resources'` from `AccessSection` union)
- Surgical deletes inside `components/ConfigEngine.tsx`:
  - `PublishedDagPage` (lines 710-996) — copied into `DetailView`
  - `TablePageWithSavedView` (lines 564-658) — copied into `DetailView`
  - `NavigationBar` Home button (deletion target inside lines 509-557)
  - `HANDLER_REGISTRY` (lines 161-167) — moved to `catalog/handlerRegistry.ts` if Agent B chose that path; otherwise keep here and import from there.
  - `LUCIDE_ICON_CATALOG` stays (other components may use it — verify with grep before deletion).
  - The top-level `ConfigEngine` component itself: keep if `audit_home_handler` / handler-driven pages outside Catalog still need it (see Q3); delete otherwise.

### 5.9 Smoke checks
- Click each Catalog sidebar tab — workspace mounts with correct preset.
- Browser back/forward across pushed frames preserves URL fidelity.
- Generate App flow lands inside Catalog at the correct page-detail frame.
- Save flow from Flow Composer lands inside Catalog.
- `audit` tab still works (Q3 outcome).
- All `useSavedView`-using grids still pick up `?view=` from URL.
- `<ModuleBreadcrumb>` 在 DagTab publish dialog、page-detail、PageInspector、grid headers 都正確顯示。

---

## 6. Deletion Checklist

Organized by file. Marker `[A2]` = Phase-2 only.

### `App.tsx` [A2]
- [ ] Delete `autoPagePreview` state (line 49)
- [ ] Delete `open-auto-page` listener `useEffect` (lines 76-86)
- [ ] Delete `'auto-page' && autoPagePreview` rendering block (lines 166-174)
- [ ] Delete `legacyTabRedirect` map (lines 36-41)
- [ ] Simplify `navigate` to `setTab(next as TabId)`
- [ ] Replace 4 tab branches with `<CatalogWorkspace preset=... />`
- [ ] Remove unused imports: `TablesTab`, `PagesTab`, possibly `ConfigEngine`

### `Layout.tsx` [A2]
- [ ] Remove `'auto-page'` from `TabId`
- [ ] (Pending Q1) update Catalog group entries

### `ConfigEngine.tsx` [A2]
- [ ] Delete `PublishedDagPage` (lines 710-996)
- [ ] Delete `TablePageWithSavedView` (lines 564-658)
- [ ] Delete `NavigationBar` Home button
- [ ] Move or delete `HANDLER_REGISTRY` (lines 161-167)
- [ ] Decide fate of top-level `ConfigEngine` (see Q3)

### `PagesTab.tsx` [A2]
- [ ] Delete entire file (after Agent C's copy is verified)

### `TablesTab.tsx` [A2]
- [ ] Delete entire file (after Agent B's copy is verified)

### `modules/ModulesTab.tsx` [A2]
- [ ] Delete entire file (after Agent C's TreeView and Agent B's DetailView are verified)

### `modules/ModuleDetail.tsx` [A2]
- [ ] Delete entire file (Agent B copied logic into `DetailView.tsx`)
- [ ] **ux-three-asks 案 2 §3.2.2 對此檔的「替換為 atom」變得不需要**(直接刪檔)

### `access-manager/ResourcesSection.tsx` [A2]
- [ ] Delete entire file (after Agent C's resource grid is verified)
- [ ] Remove `'resources'` from `AccessSection` union in `AccessSectionPage.tsx`
- [ ] Delete the `'access-resources'` → `'resources'` mapping in App.tsx's `accessTabMap`

### `DiscoverTab.tsx` [A2]
- [ ] Replace `open-auto-page` dispatch on lines 521, 528 with chosen replacement (Q2)

### `DagTab.tsx` [A2]
- [ ] Replace `open-auto-page` dispatch on lines 1909, 1927 with chosen replacement (Q2)
- [ ] Replace inline `parentBreadcrumb` (lines 3143-3155) with `<ModuleBreadcrumb>` import(ux-three-asks 案 2 收尾)

---

## 7. Verification Checklist

Run after Phase 2 lands. Each item is a behaviour, not an implementation detail.

### Stack & URL
- [ ] Click sidebar `Modules` → URL hash is `#/cat/modules/module-tree`.
- [ ] Click a module card → hash becomes `#/cat/modules/module-tree~m=mod123/module-detail~m=mod123`.
- [ ] Browser Back → returns to tree, tree's `expandedIds` and scroll restored.
- [ ] Open a page-detail with form values, fill form partially, push another frame, Back → form values preserved.
- [ ] Direct paste of a deep hash URL into a fresh tab loads that exact frame stack.
- [ ] LRU: push 5 frames, frames 0-1 unmount and re-fetch on Back (expected behaviour, not a bug).

### Per-frame saved view
- [ ] On `page-grid`, applying a saved view updates `?view=<id>` in the URL.
- [ ] Navigating to a `module-detail` and back preserves the previous `?view=` only if you came back to the same frame; new frames have no `?view=`.
- [ ] `replaceQueryParam` does not trigger `popstate`.

### Inspectors
- [ ] Click a row in `page-grid` → inspector opens with `PageInspector`.
- [ ] Inspector "Open" pushes a `page-detail` frame.
- [ ] Closing inspector does not change URL.

### ModuleBreadcrumb (ux-three-asks 案 2)
- [ ] PagesTab grid 上方顯示「Catalog › Pages」。
- [ ] PageInspector 上方顯示「Catalog › Modules › {parent module} › {page title}」(若 page 有 parent_module_id)。
- [ ] auto-page (page-detail frame) renderer 上方顯示同上鏈。
- [ ] DagTab publish dialog 內 breadcrumb 視覺與 atom 抽前一致(testid `publish-page-breadcrumb` 仍可掃)。
- [ ] sidebar 群組 label「Catalog」仍**不可** click(§3.2.3 一致)。

### Cross-feature
- [ ] Generate App (`DiscoverTab`) opens an `auto:*` page inside Catalog.
- [ ] Save flow (`DagTab`) opens the new page inside Catalog.
- [ ] Edit Flow row action navigates to Flow Composer with the dag preloaded.
- [ ] `audit` tab still works (Q3).
- [ ] V083 tri-flag gate still hides Catalog tabs from non-admin/steward users (sidebar level — unchanged).

### Type & build
- [ ] `tsc --noEmit` clean — no `any`, no implicit any.
- [ ] No remaining imports of `PagesTab`, `TablesTab`, `ModulesTab`, `ResourcesSection`, `ModuleDetail`, `PublishedDagPage`, `TablePageWithSavedView`.
- [ ] Grep for `'open-auto-page'` → zero hits.
- [ ] Grep for `'auto-page'` as TabId → zero hits.
- [ ] Grep for `window.history.replaceState` inside `catalog/` → zero hits except in `urlSync.ts`.
- [ ] Grep for inline `buildBreadcrumb` 重複實作 → 零(僅剩 atom 一份)。

---

## 8. Open Questions for Adam

These block Phase 2 and partially affect Phase 1. Agents A/B/C should NOT block on them; they design conservatively (everything still works) and Adam decides during integration.

### Q1 — Sidebar consolidation: keep `access-resources` separate or fold into Catalog?
The Resources view is conceptually a typeChip filter (`resource_type='*'`) over the catalog. Two options:
- **A**: Keep `access-resources` sidebar entry → `<CatalogWorkspace preset="resources" />`. (No sidebar change.)
- **B**: Drop `access-resources`, add a typeChip on the Tables/Pages preset. Reduces nav clutter but hides the cross-type view.

Phase 1 supports both — `preset="resources"` is implemented. Adam picks during sidebar edit in step 5.5.

### Q2 — Replacement mechanism for `open-auto-page` dispatchers in DiscoverTab/DagTab/ModuleDetail.
Three viable replacements:
- **A**: Rename event to `catalog-open-page`. App.tsx listens, switches to a default Catalog tab (e.g. `access-pages`), then needs an imperative handle on `<CatalogWorkspace>` to call `stack.push({ kind: 'page-detail', ... })`. Cleanest split, but requires Agent A to expose a `ref` API.
- **B**: A small `CatalogNavigationContext` provided at App.tsx scope. Cross-tab dispatchers call `useCatalogNavigation().openPage(pageId)`. Cleaner React, but couples non-Catalog tabs to a Catalog context.
- **C**: Keep the event but rename it; have `<CatalogWorkspace>` listen and self-push. Each preset listens; only the active one acts. Simplest; no new API surface.

Recommendation: **C** (event-based, decoupled, mirrors the existing pattern). Agent A should expose a documented "`catalog-open-page` listener" hook in `CatalogWorkspace` so Phase 2 just renames the existing dispatchers.

### Q3 — Survival of handler-driven non-Catalog pages (`audit_home_handler`, `npi_gate_console_handler`).
The `audit` tab and `npi-gate` (Govern group) still render via `<ConfigEngine initialPageId="audit_home" />` (App.tsx line 177). If Phase 2 deletes top-level `ConfigEngine`, those tabs break.

Options:
- **A**: Keep `ConfigEngine` alive, deleted only of `PublishedDagPage` and `TablePageWithSavedView` (the parts Catalog absorbed). Audit/Govern keep working.
- **B**: Move `audit` and `npi-gate` into Catalog as additional presets (`preset="audit"`, `preset="govern"`). Larger scope.

Recommendation: **A** for v3 Phase 1. Phase 1 doesn't move audit/govern. Phase 2 deletes only what was absorbed.

### Q4 — Saved-view scope after lift.
`useSavedView({ pageId })` keys saved views by `pageId`. Catalog grids synthesise pageIds (`__catalog_pages`, etc.) so they have their own saved-view bucket. But the previous `access-pages` page may have had pageId `"pages_home"` or similar with existing user-saved views. After lift, those views become orphaned.

Options:
- **A**: Accept orphaning — no-backwards-compat already allows this. Communicate to users.
- **B**: Server-side migration — rename `pages_home` saved views to `__catalog_pages`. Out of scope for FE.

Recommendation: **A**, document it in the release note. If Adam wants migration, that's a separate server task.

### Q5 — ux-three-asks 案 2 D5 自動失效
原本案 2 的決策點 D5(「Auto-page breadcrumb 是否需要後端補 `parent_module_id`」)在本合併 plan 下**失效**:
- auto-page tab 整個刪除,不再有 ConfigEngine 直渲染的 entry
- page-detail frame 由 DetailView 渲染,Agent B 在 DetailView mount 時自抓 `api.moduleTree()` + `api.pageDetail(pageId)`,自然帶回 `parent_module_id`
- 不需要新後端 endpoint

→ **D5 標記為 "no-op, superseded by Catalog merge"**。

---

## 9. Testing & CI

- Each agent's branch must pass `pnpm typecheck` and `pnpm build` standalone.
- Agent A SHOULD include a unit test for `urlSync.parseHash`/`serializeHash` round-trip across all frame kinds if the project has Vitest configured (check `apps/authz-dashboard/package.json` — if `test` script exists, add it; otherwise skip).
- Phase 2 smoke test is manual via the verification checklist above.

---

## 10. Glossary

- **Frame** — one step of navigation history. Discriminated by `kind`.
- **ViewMode** — the layout shape used to render a frame (`tree` / `grid` / `detail` / `schema`).
- **Stack** — the array of frames. Top of stack = current view.
- **Inspector** — right-side drawer showing read-only details of a clicked row, without consuming a frame.
- **Preset** — the entry-point selector that picks the root frame.
- **LRU** — least-recently-used. Top 3 frames stay mounted; older frames become snapshot-only.
- **Snapshot** — `viewState` for a frame retained across goBack so scroll/expansion/form inputs survive.
- **Handler** — a hard-coded React component looked up by name in `HANDLER_REGISTRY`, used for pages whose body isn't expressible via `PageConfig` (e.g. `modules_home_handler`).
- **Drill-down breadcrumb** — `Breadcrumbs.tsx`,顯示使用者**走過的 frame 鏈**(workspace 動態 stack)。
- **Module breadcrumb** — `ModuleBreadcrumb.tsx` atom,顯示**靜態的 module-tree 位置**(資料的歸屬層級,非導航軌跡)。

---

## 11. Cross-plan Coordination(與 ux-three-asks-plan.md 的整合)

`.claude/plans/v3-phase-1/ux-three-asks-plan.md` 提案三個獨立 UX 案件;與本 Catalog Workspace plan 的關係如下:

### 11.1 案 2(Catalog Breadcrumb)— **合併進 Phase 1**

**判斷**:案 2 的最大行動「抽 `<ModuleBreadcrumb>` atom + 落到 PagesTab / auto-page renderer」99% 都是 Catalog Workspace plan 的子集。原 ux-three-asks 案 2 有 4 個落地點:

| 案 2 原計畫落地點 | 在合併 plan 的歸屬 |
|---|---|
| PagesTab PageHeader 上方 | Agent C `GridView` (page-grid) header |
| PagesTab LineagePanel 內 | Agent B `PageInspector` header |
| Auto-page renderer | Agent B `DetailView` (page-detail) header(auto-page tab 已刪) |
| ModuleDetail.tsx 重構 | **失效** — ModuleDetail.tsx 整檔被刪 |
| DagTab publish dialog | Phase 2 / Adam (DagTab.tsx 整檔超出 Phase 1 範圍,但收尾整合很便宜) |

**ModuleBreadcrumb atom spec(Agent A 建立、其他兩 agent 消費)**:

```ts
// shared/atoms/ModuleBreadcrumb.tsx
import { ModuleTreeNode } from '../../api';

type Props = {
  moduleId: string | null;       // null → 起點為 rootLabel(預設 'Catalog')
  modules: ModuleTreeNode[];      // walk parent_id 鏈用;由呼叫者傳入(避免每處重抓)
  leaf?: { label: string };       // 末段非 module 的當前頁(例如 page title 或 'Pages')
  rootLabel?: string;             // default 'Catalog'
  onClickModule?: (id: string) => void;  // 可 click 跳到該 module 的 module-detail frame
};

// 內部沿用 ModuleDetail.tsx 既有 buildBreadcrumb walk 邏輯,搬入 atom。
// 渲染:`{rootLabel} › {module1} › {module2} › ... › {leaf?}`
// rootLabel 不可 click(sidebar IA 一致,見 ux-three-asks §3.2.3)
// leaf 段不可 click(當前頁)
// 中間 module 段:有 onClickModule 時可 click,呼叫者注入 push frame 邏輯
```

**重構消重**:
- `ModuleDetail.tsx:14-22` 的 `buildBreadcrumb` → 進 atom
- `DagTab.tsx:3143-3155` 的 `parentBreadcrumb` → Phase 2 替換成 atom 呼叫
- 三份重複實作合併為一份,符合 ux-three-asks 案 2 §3.2.1 的目標

### 11.2 案 1(Query Tool Edit / Duplicate)— **平行獨立**

- 動到的檔案:`services/authz-api/src/routes/data-query.ts` + `apps/authz-dashboard/src/components/DataQueryTab.tsx` + `api.ts`(加 `dataQueryFunctionDdl`)
- 與 Catalog plan **零檔案交集**。`DataQueryTab` 在 Consume 群,不在 Catalog refactor 範圍。
- 可由**第四個 agent**(若 Adam 同意)同時進行,或由 Adam 單獨切票。
- 估時 1 天,獨立 PR。

### 11.3 案 3(Flow Composer Run Trace)— **平行獨立**

- 動到的檔案:`apps/authz-dashboard/src/components/DagTab.tsx`(可能抽 `RunTracePanel.tsx`)
- 與 Catalog plan **零檔案交集**(Phase 1 不動 DagTab)。Phase 2 整合會碰 DagTab 的 `open-auto-page` dispatch 與 publish dialog breadcrumb,但與 Run Trace panel 不同區塊。
- 可由**第五個 agent**同時進行,但 DagTab 已 3258 行,案 3 與 Phase 2 對 DagTab 的編輯**會 rebase 衝突**。建議:
  - **方案 A(保守)**:案 3 留到 Phase 2 之後,序列化進行。
  - **方案 B(激進)**:案 3 與 Catalog Phase 1 平行開,merge 時 Adam 在本機 rebase(改動位置不重疊,衝突可手動解)。
- 估時 1.5 天。

### 11.4 整體並行調度建議(Phase 1)

```
時間 →
─────────────────────────────────────────────────────────────
Agent A (Foundation + ModuleBreadcrumb atom)        ████████
Agent B (DetailView + SchemaView + Inspectors)      ████████
Agent C (GridView + TreeView + Dialogs)             ████████
Agent D (Query Tool Edit/Duplicate)  [optional]     ██████
Agent E (Flow Composer Run Trace)    [optional]     ██████████
─────────────────────────────────────────────────────────────
Phase 2 Adam 整合 (含案 2 收尾、案 1/3 merge)               ████
```

**建議**:先發 Agent A/B/C 三個 Catalog agents(本 plan 主軸),案 1、案 3 看 Adam 是否要當下追發 Agent D/E。三個 Catalog agents 完成後,Adam 整合 Phase 2,順帶把案 2 在 DagTab publish dialog 的收尾、案 1/3 的 merge(若已完成)一併處理。

### 11.5 ux-three-asks 決策點對照

| 原決策 | 合併 plan 的處置 |
|---|---|
| D1(三案都做?) | Catalog plan 強制吞下案 2;案 1/3 由 Adam 拍板是否同步發 agent |
| D2(案 1 限 steward+) | 不變 |
| D3(案 1 Edit banner 警告) | 不變 |
| D4(案 2 抽 atom 順帶重構 ModuleDetail / DagTab) | ModuleDetail 重構**失效**(整檔刪);DagTab 重構移至 Phase 2 |
| D5(案 2 Auto-page 後端補 parent_module_id) | **失效** — 見 §8 Q5 |
| D6(案 3 trace panel 抽進獨立檔) | 不變 |
| D7(案 3 last_run_seq 持久化) | 不變 |

---

*End of design document.*
