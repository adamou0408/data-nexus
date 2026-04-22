<!-- /autoplan restore point: ~/.gstack/projects/adamou0408-data-nexus/master-autoplan-restore-20260422-114919.md -->
# Plan: Cross-Source Discovery Tab (formerly Bottom-Up UX Refactor)

> Branch: `master` · Created: 2026-04-22 · Owner: Adam
> **REVISED 2026-04-22** after CEO premise gate + tag-model spike

## Revision history

**v1 (rejected):** Full bottom-up IA refactor, ~19h. Killed by CEO review:
- Premise factually wrong — `Layout.tsx:46-53` already exposes Data Explorer/Query/Flow/Metabase independent of Modules
- M4 critical path is infrastructure (SEC-06, Keycloak, Oracle CDC), not UX
- Tab consolidation (P5) deserves own RFC

**Spike: Modules-as-tag** (2026-04-22, 30min):
- `authz_check` (V007:55-64) uses RECURSIVE CTE on `parent_id` for permission inheritance
- Tag model = rewrite 3 SSOT PG functions + migrate all `authz_role_permission` rows → 40h+
- **Verdict: container stays. Tag deferred indefinitely.**

**v2 (this doc):** Discover tab only — fills the *one* real gap CEO review didn't dispute.

## Scope (v2)

ONE deliverable: **`/api/discover` endpoint + `Discover` admin tab** that lists tables/views/functions across all data sources the admin can see, with a filter for "unmapped to any module".

That's it. No nav refactor, no Builder workflow, no consolidation, no renames.

## Why this and only this

- Real gap: today there is **no single page** showing "what raw resources exist across DS X+Y+Z, and which are unmapped". Admin has to open each DS one by one in the Pool tab.
- Pure additive — new tab + new endpoint. Does not touch SSOT, AuthZ functions, or existing tabs.
- Read-only — no constitution-protected mutations.
- Fits in a single working session. No M4 risk.

## NOT in scope

- Module Builder wizard (deferred — wait for real user demand or M5 Smart Analyst)
- Tab consolidation (deferred — needs RFC with named admin sign-off)
- Nav region restructure (deferred — vocabulary needs user validation)
- Renames (`Pool → Data Sources`, `Modules → Catalog`) — deferred for the same reason
- "+ Add to Module" inline action — deferred until Builder exists; Discover v2 is read-only

## Files & changes

### Backend (new)
**`services/authz-api/src/routes/discover.ts`** (new, ~120 lines)
- `GET /api/discover?type=table|view|function|all&unmapped_only=true&q=<search>`
- Reads `authz_data_source` rows the admin has read on
- For each DS, queries cached schema introspection (already exists in `lib/remote-sync.ts`)
- LEFT JOIN against `authz_resource` to determine `mapped_to_module: string | null`
- Returns `{ data_source_id, ds_display_name, type, schema, name, mapped_to_module, mapped_to_module_name }[]`
- Cache: 60s in-memory per-user (no Redis dependency to keep it simple)
- AuthZ: `requireRole('admin')`

**`services/authz-api/src/index.ts`** (mount route)

### Frontend (new)
**`apps/authz-dashboard/src/components/DiscoverTab.tsx`** (new, ~200 lines)
- Page header: "Cross-Source Discovery"
- Top filter row: type chips (All/Tables/Views/Functions), unmapped toggle, search box
- Stat strip: Total / Mapped / Unmapped / DS count
- Virtualized table (react-window if >500 rows; plain <table> below): columns `Name`, `Type`, `Data Source`, `Schema`, `Mapped to Module`
- Empty state when nothing matches filter
- Row click → expand to show ID + raw introspection metadata

**`apps/authz-dashboard/src/api.ts`** — add `discover(filters)` typed wrapper

**`apps/authz-dashboard/src/components/Layout.tsx`** — add ONE new nav item under existing `Data Policy` group:
```ts
{ id: 'discover', label: 'Discover', icon: <Search size={18} />, adminOnly: true }
```
**`apps/authz-dashboard/src/App.tsx`** — render `<DiscoverTab />` for `tab === 'discover'`
**`Layout.tsx` TabId union** — add `'discover'`

### Tests
**`apps/authz-dashboard/e2e/06-discover.spec.ts`** (new)
1. Admin sees Discover in nav; non-admin doesn't
2. Discover tab loads, shows >0 rows from at least one DS
3. Unmapped toggle reduces row count
4. Search filter narrows results
5. Each row shows DS name + type + mapped-or-not status

## Failure modes

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Cross-DS query slow on Greenplum/Oracle | Medium | Medium | Use cached schema from `remote-sync` (already cached); add explicit "loading per DS" indicator; degrade gracefully if a single DS times out |
| Admin sees DS they don't have read on | Low | High | Filter `authz_data_source` by `authz_check(user, ds.resource_id, 'read')` |
| Mapped-module join is N+1 | Medium | Low | Single SQL: `SELECT … FROM introspection_rows LEFT JOIN authz_resource ar ON ar.attributes->>'physical_name' = introspection_rows.name AND ar.attributes->>'data_source_id' = introspection_rows.ds_id` |
| `mapped_to_module` ambiguous if a table is grandchild of multiple modules | Low | Low | Show innermost module (closest parent); add "+N" badge if >1 |

## Effort estimate

| Phase | Time |
|---|---|
| P1: Backend route + tests | 1.5h |
| P2: Frontend tab + table | 1.5h |
| P3: Wire nav + types | 30min |
| P4: E2E tests | 1h |
| **Total** | **4.5h CC** |

## Decisions taken (no longer open)

1. **Container model stays** — tag-model rewrite is 40h+ and breaks SSOT. Defer indefinitely.
2. **No nav refactor in this plan** — Discover slots into existing `Data Policy` group as one new item.
3. **Read-only Discover for v2** — "+ Add to Module" inline action waits for actual Builder (which itself waits for real user demand).
4. **No Redis caching** — 60s in-memory per-user is simpler; revisit if user count crosses ~20 admins.

## References

- CEO review findings (chat 2026-04-22): premise mismatch, M4 critical path
- Spike result: V007__core_functions.sql:55-64 — RECURSIVE CTE on parent_id
- Existing introspection: `services/authz-api/src/lib/remote-sync.ts`
- Layout.tsx:46-69 — current nav (Data + Data Policy groups)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/autoplan` Phase 1 | Strategy & scope | 1 | issues_open | 2 critical (premise wrong, M4 critical path), 3 high, 3 medium → plan revised v1→v2 |
| Spike | inline (post-CEO) | Tag-model viability | 1 | rejected | Container model baked into SSOT PG functions; tag rewrite = 40h+ |
| Codex Review | (codex not installed) | Independent 2nd opinion | 0 | unavailable | — |
| Eng Review | not run | Plan v2 scope ≤5h, single new tab | 0 | skipped | Scope below threshold; standard PR review at /ship time |
| Design Review | not run | Pure read-only filter+table | 0 | skipped | Reuses existing PageHeader/EmptyState/StatCard atoms |

**VERDICT:** APPROVED v2 — execute Plan A (Discover tab only, ~4.5h). All other v1 scope deferred.
