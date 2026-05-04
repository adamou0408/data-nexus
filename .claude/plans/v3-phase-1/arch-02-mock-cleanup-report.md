# ARCH-02 — Mock Business Cleanup Report

**Date:** 2026-05-04
**Author:** Claude (Opus 4.7) under Auto Mode
**Scope:** Remove the 14 mock business tables, register `ds:pg_k8`, and eliminate the "免註冊 fallback" anti-pattern in the query path.
**Status:** Code + migrations + seed changes COMPLETE in repo. Awaiting `make db-reset`. **Dashboard caller patches NOT done — see "Breaking API: live UI callers" below.**

---

## Goals (from brief)

| Goal | What | Status |
|------|------|--------|
| A | Drop 14 mock business tables from `nexus_data.public` | DONE in migrations |
| B | Bootstrap `ds:pg_k8` (Phison Greenplum / `tiptop` schema) into `dev-seed.sql` | DONE |
| C | Rename `getLocalData*` → `getInternalData*`; force `data_source_id` on query-path callers (HTTP 400 when missing) | DONE in routes |

---

## Files Changed

### New files (?? in `git status`)

| Path | Purpose |
|---|---|
| `database/migrations/data/V008__drop_demo_business_tables.sql` | Drops continuous aggregates → views → 10 hypertables/tables under `nexus_data.public`. All `IF EXISTS … CASCADE`. |
| `database/migrations/V090__drop_mock_resource_bindings.sql` | Cleans up `nexus_authz` side: deletes `authz_role_permission` + `authz_policy` rows that reference the dropped tables/columns; drops the `authz_resource` rows; then drops the 8 pre-ARCH-01 mock tables that V014 + V021 created on `nexus_authz` itself. |
| `docs/standards/path-c-rls-demo-pg_k8-tiptop.md` | Replacement Path C demo doc with `<TIPTOP_TEST_TABLE>` / `<TIPTOP_PRED_COL>` placeholders. Supersedes the `lot_status` POC fixtures. |

### Modified files (M in `git status`, ARCH-02-related only)

| Path | Change |
|---|---|
| `database/seed/dev-seed.sql` | Added section inserting `ds:pg_k8` row (192.168.199.72:30000/dc, `tiptop` schema, user `gpadmin`). `ON CONFLICT DO UPDATE` only touches `display_name` + `description` per Constitution Article 8 (cosmetic-only). `connector_password = NULL` — set out-of-band via dashboard or `PG_K8_PASSWORD` env. |
| `database/seed/data/business-seed.sql` | Gutted to header comment explaining ARCH-02 removal. File kept (not deleted) because `init-db.sh` sources every `*.sql` under that dir; deleting requires Makefile/init-db.sh change. |
| `.env.example` | Added `PG_K8_PASSWORD=` line tagged `[OPTIONAL in dev / REQUIRED to demo Path C]`. |
| `services/authz-api/src/db.ts` | Renamed `getLocalDataPool` → `getInternalDataPool`, `getLocalDataClient` → `getInternalDataClient`. Rewrote comment block on `resolveDataSource` (null → 400, no fallback) and the `getInternalData*` block (INFRASTRUCTURE ONLY — Oracle CDC schema setup, DAG sink provisioning, Path C native role infra; MUST NOT be used by query-path routes). |
| `services/authz-api/src/routes/browse-read.ts` | `POST /data-explorer`, `GET /tables`, `GET /tables/:table` all require `data_source_id` (400 with hint when missing). Import switched to `getDataSourcePool`. |
| `services/authz-api/src/routes/config-exec.ts` | Removed `getLocalDataPool` import + fallback. When `authz_resource.attributes->>'data_source_id'` is missing for a target table, returns HTTP 400 with explicit hint. |
| `services/authz-api/src/routes/rls-simulate.ts` | `ALLOWED_TABLES_BY_DS` now keyed by `data_source_id` (was unkeyed singleton). `loadAllowedTables(dsId)` queries via `getDataSourcePool(dsId)` across all non-system schemas. `POST /simulate` + `GET /data` both require explicit `table` and resolve DS via body/query or `resolveDataSource()`; 400 if neither. Removed `lot_status` default. |
| `services/authz-api/src/routes/datasource.ts` | Rename only: `getLocalDataPool` → `getInternalDataPool` (preserves Oracle CDC schema setup at line 201, Oracle test path at line 498). |
| `services/authz-api/src/lib/remote-sync.ts` | Rename only: `getLocalDataClient` → `getInternalDataClient` (preserves Oracle CDC GRANT logic). |
| `services/authz-api/src/scripts/bu06-e2e.ts` | Replaced hardcoded `lot_status`/`cost`/`'nexus_data'` with env vars `BU06_TEST_TABLE`, `BU06_TEST_COLUMN`, `BU06_TEST_DATABASE`. Exits with code 2 + helpful message if env vars not set. |
| `services/authz-api/src/lib/discovery-rule-engine.ts` | Comment-only fix: `'table:public.lot_status' → 'lot_status'` example replaced with neutral `'table:public.<name>' → '<name>'`. |

### Files NOT touched (intentionally)

- `services/authz-api/src/scripts/bu08-e2e.ts` — already constitution-compliant (`ds:_agent_bu08_test` prefix + self-cleanup).
- `services/authz-api/src/pool.ts` — does not import `getLocalData*`. Pre-ARCH-02 brief assumed it did; verified false.
- `services/authz-api/nul` — stray Windows-redirect artifact (untracked). Suggest Adam `rm services/authz-api/nul` manually; not deleted by agent per Auto Mode destructive-action guard.

---

## Validation

### `tsc --noEmit` on `services/authz-api`

PASS for all ARCH-02 changes. One **pre-existing, unrelated** error remains:

```
src/routes/data-query.ts(422,39): error TS2724: 'OracleDB' has no exported member named 'DBType_Number'. Did you mean 'DB_TYPE_NUMBER'?
```

This is in `data-query.ts` which is `M` in git but was modified by a parallel session before this task; the typo predates ARCH-02. **Recommend separate fix** — one-character change (`DBType_Number` → `DB_TYPE_NUMBER`).

### `tsc --noEmit` on `apps/authz-dashboard`

PASS — clean.

### `npx vite build` on `apps/authz-dashboard`

PASS — `built in 8.26s`, dist generated.

### Residual `getLocalData*` references in `services/authz-api/src`

Only one match, and it's in a comment about the rename history:

```
src/db.ts:131: // Renamed 2026-05-04 from getLocalDataPool / getLocalDataClient
```

No active code references remain.

---

## Breaking API: live UI callers (BLOCKING for next dev refresh)

After this lands, the following dashboard API helpers will start receiving HTTP 400 because they don't pass `data_source_id`. All are mounted in production tabs (verified via `App.tsx` + `PermissionsTab.tsx`).

| File:line | Helper | Server route | Reachable via |
|---|---|---|---|
| `apps/authz-dashboard/src/api.ts:115-118` | `rlsSimulate` | `POST /api/rls/simulate` | Permissions → RLS sub-tab (`PermissionsTab.tsx:59`, admin-only) |
| `apps/authz-dashboard/src/api.ts:120` | `rlsData` | `GET /api/rls/data` | Currently no caller in `apps/authz-dashboard/src` (helper unused but exposed) |
| `apps/authz-dashboard/src/api.ts:296-301` | `tables` | `GET /api/browse/tables` | Catalog → Raw Tables (mounted at `App.tsx:163` as `<CatalogWorkspace preset="tables" />`); also called by `RlsTab.tsx:28` for the table picker |
| `apps/authz-dashboard/src/api.ts:302-305` | `tableSchema` | `GET /api/browse/tables/:table` | Catalog table-schema frame + TableInspector drawer |
| `apps/authz-dashboard/src/api.ts:307-310` | `dataExplorer` | `POST /api/browse/data-explorer` | Catalog SchemaView (when user is logged in) |

### Why I did NOT patch these in this PR

This was the deliberate call after consulting the advisor:

1. The brief was scoped to **API/DB cleanup**, not UI redesign.
2. The right fix needs a UX decision (Adam's call) — pick one of:
   - **(a) Per-tab data-source picker** — RlsTab and Catalog Raw Tables get a dropdown sourced from `api.datasourcesLite()`, default to first or last-selected.
   - **(b) Workspace-level DS context** — like `AuthzContext`, a `DataSourceContext` that all "browse" features inherit; one switcher in the header.
   - **(c) Hardcode `ds:pg_k8`** as the default for now — fastest, least UX, fine for demo but bakes a value into UI code.
3. Auto Mode's "do not take overly destructive actions" guard — rewriting 4 components mid-stream without confirmed UX direction is risky.

### Recommended follow-up plan (not blocking ARCH-02 merge but blocking next dashboard deploy)

Suggested smallest-thing-that-works path: option (c) hardcoded default for the dev demo, then upgrade to (b) when Adam picks a DS-switcher pattern. Tactical edits would be:

```ts
// apps/authz-dashboard/src/api.ts
tables: (userId?: string, groups?: string[], dataSourceId = 'ds:pg_k8') => {
  const qs = new URLSearchParams({ data_source_id: dataSourceId });
  if (userId) qs.set('user_id', userId);
  if (groups?.length) qs.set('groups', groups.join(','));
  return request<...>(`/browse/tables?${qs}`);
},
tableSchema: (table: string, dataSourceId = 'ds:pg_k8') =>
  request<...>(`/browse/tables/${encodeURIComponent(table)}?data_source_id=${dataSourceId}`),
dataExplorer: (user_id, groups, attrs, table, dataSourceId = 'ds:pg_k8') =>
  request(..., { body: JSON.stringify({ user_id, groups, attributes: attrs, table, data_source_id: dataSourceId }) }),
rlsSimulate: (user_id, groups, attrs, table, path, dataSourceId = 'ds:pg_k8') =>
  request(..., { body: JSON.stringify({ user_id, groups, attributes: attrs, table, path, data_source_id: dataSourceId }) }),
```

This is ~30 lines, no new state, no UX redesign, and lets RlsTab + Catalog continue to work against `ds:pg_k8` without further changes.

---

## Validation steps for `make db-reset`

When Adam runs `make db-reset`, expected behaviour:

1. **`nexus_authz` migrations apply** — V001..V089 run as before. **V090** runs and:
   - Deletes the 9 stale `authz_role_permission` rows pointing at mock resources (varies; the migration counts and prints).
   - Deletes the 4 stale `authz_policy` rows.
   - Deletes the ~80 `authz_resource` column + ~14 table rows.
   - Drops the 8 pre-ARCH-01 mock tables that still live on `nexus_authz` (residue of V014 + V021).
2. **`nexus_data` migrations apply** — `data/V001..V007` run as before. **`data/V008`** runs and:
   - Drops continuous aggregates `yield_daily_trend`, `lot_daily_flow`.
   - Drops views `v_lot_status_pe`, `v_lot_status_sales`.
   - Drops 10 tables/hypertables (CASCADE handles RLS policies from `data/V002+V004`, hypertable metadata, triggers, indexes).
3. **Seed runs** — `dev-seed.sql` inserts `ds:pg_k8` (or no-ops if already there). `business-seed.sql` is now a header comment, no INSERTs.
4. **Result**: `\dt` on `nexus_data` should show only CDC sink schemas (`_cdc_*`), DAG sink tables, and any Path C native role infra; **zero** mock business tables. `SELECT * FROM authz_data_source WHERE source_id = 'ds:pg_k8'` returns one row with `is_active = true`.
5. **Smoke test**: `curl http://localhost:13001/api/browse/tables` → HTTP 400 with `{"error":"data_source_id query parameter is required",...}`. `curl 'http://localhost:13001/api/browse/tables?data_source_id=ds:pg_k8'` → returns the tiptop schema tables (assumes `connector_password` was set via dashboard or `PG_K8_PASSWORD` env).
6. **Dashboard at http://localhost:13173**:
   - Permissions → RLS Simulator → 400s on table picker (live regression — see "Breaking API: live UI callers" above).
   - Catalog → Raw Tables → 400s on initial load.
   - Both expected; resolve via the recommended follow-up patch above.

---

## Compliance notes

- **Constitution Article 8**: `dev-seed.sql` insert of `ds:pg_k8` uses `ON CONFLICT DO UPDATE` touching only `display_name` + `description` (cosmetic). Identity fields (host, port, database_name, connector_user, connector_password, schemas) are written **once** on insert and never overwritten.
- **No commit/push performed** per brief.
- **No docker/psql commands run** per brief — Adam runs `make db-reset`.

---

## Open issues / unrelated findings

1. `services/authz-api/src/routes/data-query.ts:422` — pre-existing TS error `DBType_Number` should be `DB_TYPE_NUMBER`. Single-character fix; needs Oracle-types-aware reviewer to confirm intent. Not in ARCH-02 scope.
2. `services/authz-api/nul` — stray empty file from a prior failed Windows redirect. Safe to `rm`.
3. `apps/authz-dashboard/src/components/TablesTab.tsx` is `D` (deleted) in git but `RlsTab.tsx` still calls `api.tables()`. The catalog rewrite replaced the TablesTab UI but RlsTab kept its old table-picker dependency. Not a regression caused by this PR, but worth knowing when planning the follow-up patch.
