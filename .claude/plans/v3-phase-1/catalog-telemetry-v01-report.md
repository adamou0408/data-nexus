# CATALOG-TELEMETRY-V01 — Implementation Report

Date: 2026-05-04
Status: Implemented (B-path), changes left staged for Adam to review.

## Architecture summary

Stack: **client-side event buffer → POST /api/catalog/usage-event → catalog_usage_event hypertable → catalog_usage_daily continuous aggregate → GET /api/catalog/usage-stats → useUsageStats → UsageBadge**.

Key decisions:

- **Storage**: TimescaleDB hypertable + 1-day continuous aggregate. 7-day chunks, 30-day compression (segment by preset+frame_kind), 365-day retention. Mirrors V030 patterns.
- **Idempotent migration**: Hypertable conversion guarded by `_timescaledb_catalog.hypertable` lookup; cagg DDL guarded by `timescaledb_information.continuous_aggregates`; all indexes `IF NOT EXISTS`; policies use `if_not_exists => true`.
- **Trigger plumbing**: Single `nextTriggerRef` set by history-sync / cross-tab effects before they dispatch, consumed (and reset to `'click'`) by the diff effect — avoids inferring trigger from React effect ordering.
- **Diff-based emit**: `prevFramesRef` tracks the previous frame array; on every change we compute the longest common prefix, emit closes for popped suffix, opens for new suffix. Index-keyed `openedAtRef` records `performance.now()` at open so close events carry `dwell_ms`.
- **pagehide flush**: Final batch sent via `navigator.sendBeacon` (Blob, application/json) with `fetch` keepalive fallback. Buffer otherwise flushes at size 10 or after 2s idle.
- **Read gate**: GET `/usage-stats` requires `AUTHZ_ADMIN` or `DATA_STEWARD` (mirrors activity router). POST `/usage-event` is open to any signed-in user; subject_id pulled from `getUserId(req)`.
- **Bounce metric**: `bounce_count` = closes with `dwell_ms < 3000`. `bounce_rate = bounce_count / open_count` (per spec — close events can be missing on tab-close even with sendBeacon, so close_event_count would understate the denominator).
- **Top-quartile threshold**: Computed client-side in `useUsageStats` over the visible row set (75th percentile of open_count).

## File-by-file change list

| # | File | Status | Lines |
|---|------|--------|-------|
| 1 | `database/migrations/V091__catalog_usage_telemetry.sql` | new | ~95 |
| 2 | `services/authz-api/src/routes/catalog-usage.ts` | new | ~175 |
| 3 | `services/authz-api/src/index.ts` | edited | +5 |
| 4 | `apps/authz-dashboard/src/components/catalog/useTelemetry.ts` | new | ~155 |
| 5 | `apps/authz-dashboard/src/components/catalog/UsageBadge.tsx` | new | ~95 |
| 6 | `apps/authz-dashboard/src/components/catalog/CatalogWorkspace.tsx` | edited | +60 |
| 7 | `apps/authz-dashboard/src/components/catalog/GridView.tsx` | edited | +20 |
| 8 | `apps/authz-dashboard/src/components/catalog/TreeView.tsx` | edited | +6 |
| 9 | `apps/authz-dashboard/src/api.ts` | edited | +35 |

## Verification output

**Backend typecheck** (`cd services/authz-api && ./node_modules/.bin/tsc --noEmit`):
- Only pre-existing error: `src/routes/data-query.ts(422,39): TS2724 'OracleDB' has no exported member 'DBType_Number'` — unrelated to this change, present on master.
- Zero errors on `routes/catalog-usage.ts` and the modified `index.ts`.

**Frontend typecheck** (`cd apps/authz-dashboard && ./node_modules/.bin/tsc --noEmit`):
- Clean. Zero errors.

**Frontend build** (`cd apps/authz-dashboard && ./node_modules/.bin/vite build`):
- Pass. 2000 modules transformed, built in 10.26s. Chunk size warning is pre-existing (1.15 MB main bundle).

## Open questions / deferred items

1. **CardGridView NOT wired** with `<UsageBadge>`. The 4 root tiles are static navigation aids that route to other presets — a per-tile open count would conflate workspace-switch traffic with target popularity. Skipped intentionally; if Adam wants tile-level analytics they'd live under a `home`-preset stats query.
2. **module-tree target_id is null** when its frame is opened. The spec suggested `frame.dataSourceId if present`, but the type `ModuleTreeFrame = { kind: 'module-tree'; selectedModuleId: string | null }` has no `dataSourceId`. Using `selectedModuleId` would inflate distinct-target counts because it changes as the user clicks within the same frame. TreeView still surfaces module-level stats by joining on `module-detail` open events (target_id = `frame.moduleId`).
3. **Dwell on tab-close is best-effort**. `pagehide` fires reliably on modern browsers, but pre-render-cancel paths in mobile Safari may drop the beacon. Treat dwell averages as a lower-bound count of completed close events, not a true session timer.
4. **CORS preflight on sendBeacon**: We pass `Blob([..], { type: 'application/json' })`. Same-origin in dev (Vite proxy) and prod (same host) so no preflight cost, but if the dashboard is ever served from a different origin than the API, switch to `text/plain` and have `express` accept text bodies.
5. **No client-side pruning of huge buffers**. Buffer flush triggers at size 10; if the user does pathological rapid navigation faster than network round-trips drain, we'd accumulate. Current acceptable failure mode is `keepalive: true` on the fetch + sendBeacon at pagehide.
6. **Stats refresh cadence**: Continuous aggregate has a `start_offset = 8 days, end_offset = 1 hour, schedule_interval = 1 hour` policy. For windows ≤ 1 day the route falls back to the raw hypertable so today's events are visible immediately. For 7d/30d/90d the most recent ~1 hour of activity is missing from the rollup.
7. **Filter chip target_id semantics** are debatable: `page-grid` with `filter.module_id='X'` records target_id=X. That tracks "users viewing pages filtered by module X", not "the page-grid view itself". Same for `table-grid`. Acceptable for an MVP signal but worth tightening later.

## Manual test checklist for Adam

### Trigger events

1. `make dev-up` (or your usual dev stack), navigate to dashboard at http://localhost:13173.
2. Open the Catalog tab (any preset — Modules / Pages / Tables / Resources). The bottom frame fires an `'initial'` open event on mount.
3. Click a card / row to push a deeper frame (e.g. open a module's detail). The new frame fires an `'open'` event with `trigger='click'`.
4. Click breadcrumb back; the popped frame fires a `'close'` event with `dwell_ms` measured from its open.
5. Use browser back/forward — popstate handler tags `trigger='history'` on the next dispatch.
6. From DiscoverTab or DagTab "Generate App", open a page in Catalog → `trigger='cross-tab'`.
7. Close the tab; `pagehide` flush should land any remaining buffered events.

### Verify ingest

```sql
-- Connect to nexus_authz (port 15432)
SELECT ts, subject_id, preset, frame_kind, target_id, action, dwell_ms, trigger
  FROM catalog_usage_event
 ORDER BY ts DESC
 LIMIT 30;
```

You should see a mix of opens (no dwell) and closes (with dwell). `trigger` column reflects the navigation source.

### Verify aggregation

```sql
-- Force-refresh the cagg if you don't want to wait an hour
CALL refresh_continuous_aggregate('catalog_usage_daily', NULL, NULL);

SELECT * FROM catalog_usage_daily ORDER BY bucket DESC LIMIT 20;
```

### Verify badges

- Sign in as `sysadmin` / `authz-admin` / a `DATA_STEWARD`.
- Open Catalog → Pages. Open a few page-detail frames repeatedly to seed events. Reload the Pages workspace.
- Each row should now have a small badge in its first column:
  - **grey "N"** — default count (visible after the first few opens).
  - **green "↑ N"** — top 25% of open_count among visible rows.
  - **orange "⚠ XX%"** — bounce_rate > 30% with at least 3 opens.
- Repeat for Tables (badge by `schema.table`), Resources (badge per resource_id), Modules tree (badge per module).

### Verify silent failure for non-admin

- Sign in as a non-admin (e.g. `bi_user`). Open Catalog.
- The badge query 403s; the hook catches and returns an empty Map. No toast, no console error breaks the workspace, badges simply don't render. Verify in DevTools that the failed `/api/catalog/usage-stats` request is the only side effect.

### Verify the API directly

```bash
# Ingest (authed user)
curl -s -X POST http://localhost:13001/api/catalog/usage-event \
  -H 'Content-Type: application/json' \
  -H 'X-User-Id: sysadmin' \
  -d '{"events":[{"session_id":"test-1","preset":"pages","frame_kind":"page-detail","target_id":"page:demo","action":"open","trigger":"click"}]}'

# Read stats (admin)
curl -s "http://localhost:13001/api/catalog/usage-stats?preset=pages&window=7d" \
  -H 'X-User-Id: sysadmin'
```
