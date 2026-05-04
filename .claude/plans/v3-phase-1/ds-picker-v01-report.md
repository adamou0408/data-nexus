# DS-PICKER-V01 — Global Data Source Picker

**Status:** implemented, NOT committed (staged only)
**Date:** 2026-05-04
**Author:** Claude (Opus 4.7)
**Decision:** Adam's option **B** — remove the `ds:pg_k8` hardcoded default in
`api.ts`; force every consumer to pass `dataSourceId` explicitly via a global
picker, mirroring the persisted `X-User-Id` UserPicker pattern. Adam is the
only user; no backwards-compat needed.

## Architecture summary

1. **`DataSourceContext`** owns the global selection. State is a single
   `activeDataSourceId: string | null` persisted to `localStorage` under key
   `nx_active_ds_v1`. Mirrors the `nx_auth_v1` hydration pattern in `api.ts` so
   the picker survives browser refresh and Vite HMR.
2. **`DataSourcePicker`** is rendered in `Layout.tsx`'s sidebar bottom block,
   directly below the existing X-User-Id `<select>`. (There is no top header
   bar in the dashboard — UserPicker is also a bottom-sidebar inline `<select>`,
   so DS picker lives in the same slot.)
3. The five `api.ts` query-path helpers (`rlsSimulate`, `rlsData`, `tables`,
   `tableSchema`, `dataExplorer`) drop their `= DEFAULT_DATA_SOURCE_ID`
   defaults; `dataSourceId` is now a **required positional parameter**. The
   `DEFAULT_DATA_SOURCE_ID` const is removed.
4. Each consumer reads `activeDataSourceId` from `useDataSource()` and either
   passes it through or renders an empty state when null.
5. `DataSourceProvider` refetches `api.datasources()` when the authenticated
   user changes — first-load race fix (the X-User-Id header is empty before
   the user picks, so the mount-time call would otherwise return empty
   forever).
6. Discover Tab is intentionally **decoupled** — it manages its own per-source
   selection inline (per-source discovery semantics differ from "I'm browsing
   one source").

### Provider nesting (`App.tsx`)

```tsx
<AuthzProvider>
  <DataSourceProvider>          {/* NEW — depends on useAuthz() for user-change refetch */}
    <RenderTokensProvider>
      <ToastProvider>
        <AppInner />
```

## Files changed

### New files

| Path | Purpose |
|---|---|
| `apps/authz-dashboard/src/DataSourceContext.tsx` | Provider, hook (`useDataSource`), localStorage persistence (`nx_active_ds_v1`), mount-time + on-user-change `api.datasources()` fetch, stale-id cleanup |
| `apps/authz-dashboard/src/components/DataSourcePicker.tsx` | Sidebar `<select>` styled like the X-User-Id picker; collapsed-mode icon button; "No data sources — Discover" empty state that fires `navigate-tab` event |

### Modified files

| Path | Reason |
|---|---|
| `apps/authz-dashboard/src/api.ts` | Removed `DEFAULT_DATA_SOURCE_ID`; `rlsSimulate` / `rlsData` / `tables` / `tableSchema` / `dataExplorer` signatures now require `dataSourceId` (no default). Note `tables` uses `userId: string \| undefined, groups: string[] \| undefined, dataSourceId: string` — TS doesn't allow a required param after optional ones, so explicit-undefined is the call site shape. |
| `apps/authz-dashboard/src/App.tsx` | Wrap with `<DataSourceProvider>` between `AuthzProvider` and `RenderTokensProvider` |
| `apps/authz-dashboard/src/components/Layout.tsx` | Render `<DataSourcePicker collapsed={collapsed} />` below the X-User-Id `<select>` in the bottom-of-sidebar block |
| `apps/authz-dashboard/src/components/RlsTab.tsx` | Read `activeDataSourceId`; gate effect + simulate call; render empty state when null; pass to both `api.tables` and `api.rlsSimulate` calls |
| `apps/authz-dashboard/src/components/catalog/GridView.tsx` | `TableGrid` reads `activeDataSourceId`; passes to `api.tables`; renders empty state inside the same `<GridHeader>` shell when null |
| `apps/authz-dashboard/src/components/catalog/SchemaView.tsx` | Reads `activeDataSourceId`; passes to both branches (`api.dataExplorer` when user logged in, `api.tableSchema` when anonymous); early-return empty state when null |
| `apps/authz-dashboard/src/components/catalog/inspectors/TableInspector.tsx` | Reads `activeDataSourceId`; passes to `api.tableSchema`; inline empty-state message inside the drawer (drawer not blocked, just shows "pick one" instead of loading spinner) |

## Consumers skipped or not found

- **`api.rlsData()`** — zero callers in the codebase. Default removed; signature now `(data_source_id: string)`. No consumer wiring needed; documented here so it's not flagged as missed.
- No other callers of the five helpers were found beyond the four listed above (verified via grep `api\.tables|api\.tableSchema|api\.dataExplorer|api\.rlsSimulate|api\.rlsData`).

## Verification

```bash
cd /d/Adam/project/data-nexus/apps/authz-dashboard
./node_modules/.bin/tsc --noEmit
# (no output — clean)

./node_modules/.bin/vite build
# vite v5.4.21 building for production...
# transforming...
# ✓ 2002 modules transformed.
# rendering chunks...
# computing gzip size...
# dist/index.html                     0.46 kB │ gzip:   0.32 kB
# dist/assets/index-DewjMvyI.css     96.39 kB │ gzip:  14.14 kB
# dist/assets/index-CVZKJmRT.js   1,151.92 kB │ gzip: 297.81 kB
# ✓ built in 6.40s
```

Both pass. (The 1.15 MB chunk warning is pre-existing — unchanged from before this work.)

No backend files modified. No `services/authz-api` typecheck needed.

## Manual test checklist for Adam

Stack: `docker compose -f deploy/docker-compose/docker-compose.dev.yml up` (or whatever your dev script is). Open `http://localhost:13173`.

### Scenario 1 — fresh state, no datasources registered
1. `localStorage.clear()` in DevTools, hard reload.
2. Pick any user from sidebar.
3. Expect: bottom-of-sidebar shows **"No data sources — Discover"** button (only if zero rows in `authz_data_source`).
4. Click it → navigates to Discover tab.

### Scenario 2 — datasources registered, none selected
1. With ≥ 1 datasource in DB, hard reload.
2. Bottom-of-sidebar picker shows **"Select Data Source..."** placeholder.
3. **Permissions / RLS Simulator tab** (`g p` or sidebar) — RLS sub-section: shows empty state "No data source selected — Pick one from the sidebar picker (bottom-left)."
4. **Data Explorer (`Layers` icon, `g e`) → Raw Tables** — shows empty-state card with Database icon + "Pick one from the sidebar…".
5. Open any **`table-schema`** frame (push from a different tab if seeded, or skip): same empty-state.
6. Open the **`TableInspector`** drawer (single-click a row in Raw Tables — but tables list is empty here, so this case is hard to hit without datasource). Skip this scenario in the no-DS state.

### Scenario 3 — pick a datasource, verify live
1. From the bottom picker, select a real source (e.g. `ds:pg_k8`).
2. **Raw Tables** grid populates (was empty).
3. Click any row → `TableInspector` drawer opens with column count.
4. Click "Open schema" → `SchemaView` renders columns + sample data.
5. Go to **Permissions** → **RLS Simulator**: target table buttons appear; pick two users; click "Run RLS Simulation"; both panels render.

### Scenario 4 — persistence across refresh
1. With a source selected, hard reload (Ctrl+F5).
2. Picker still shows the same selected source.
3. Raw Tables / SchemaView / RLS still load without re-picking.

### Scenario 5 — re-select to a different source
1. Open the picker, choose another source (if seeded — Adam may need to register one in Discover).
2. Raw Tables list refreshes to that source's tables.
3. Open a schema frame → reflects the new source.

### Scenario 6 — clear selection
1. Open picker, select **"Select Data Source..."** (the blank option).
2. Raw Tables / RLS / SchemaView all flip back to empty state.
3. `localStorage.getItem('nx_active_ds_v1')` returns `null` in DevTools.

### Scenario 7 — stale persisted id (DB reset / source deleted)
1. With a source selected, delete that row from `authz_data_source` (via admin tab) or run a seed reset.
2. Hard reload.
3. Picker drops the stale selection automatically (see `DataSourceContext.reload()` cleanup) — placeholder shown again.

### Scenario 8 — Discover Tab still independent
1. Pick a source globally.
2. Open Discover tab.
3. Discover's own per-source dropdown is **not** linked to the global picker (deliberate — per task constraint #6).

## Known minor items

- The `DataSourcePicker` collapsed-mode icon button currently routes to Discover on click (since you can't realistically operate a `<select>` in 28px width). Acceptable since collapsed sidebar is rarely used during data-source picking. If Adam wants a popover instead, that's a small follow-up.
- The picker option labels are `"<display_name> (<source_id>)"`. If Adam prefers just `display_name`, trivial one-line change in `DataSourcePicker.tsx`.
- The 1.15 MB JS chunk warning is pre-existing; no chunking done as part of this work (out of scope).

## How to roll back

```bash
git checkout -- apps/authz-dashboard/src/api.ts apps/authz-dashboard/src/App.tsx apps/authz-dashboard/src/components/Layout.tsx apps/authz-dashboard/src/components/RlsTab.tsx apps/authz-dashboard/src/components/catalog/GridView.tsx apps/authz-dashboard/src/components/catalog/SchemaView.tsx apps/authz-dashboard/src/components/catalog/inspectors/TableInspector.tsx
rm apps/authz-dashboard/src/DataSourceContext.tsx apps/authz-dashboard/src/components/DataSourcePicker.tsx
```
