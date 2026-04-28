# /autoplan Restore Point
Captured: 2026-04-22T03:49:20Z | Branch: master | Commit: 2f09b40

## Re-run Instructions
1. Copy 'Original Plan State' below back to docs/plan-bottom-up-ux-refactor.md
2. Invoke /autoplan

## Original Plan State
# Plan: Bottom-Up UX Refactor (Discover → Build → Use)

> Branch: `master` · Created: 2026-04-22 · Owner: Adam (tech lead)

## Context

Today the dashboard's IA is **top-down**: admin must first define a Module before
data can be browsed/queried/governed. This forces a planning step that does not
match how Phison actually works — engineers/QA/sales already have data in pg_k8,
TipTop, etc., and want to **discover what's there, then organize a slice into a
permission-controlled Module**.

Goal: invert the IA so the canonical admin journey is **raw data → grouped →
permissioned → consumed**, while keeping user journey "open the Module that's
been built for me" frictionless.

## Why

- **Mental-model mismatch**: current Modules tab assumes you start with structure
- **Discovery gap**: no single place lists "what raw tables/functions/views do we have across all data sources?"
- **Tab sprawl**: 13+ tabs split across 5 groups; user/admin overlap unclear
- **M5 (Smart Analyst 2.0) prerequisite**: AI Agent needs a clean Module-as-product
  primitive to generate against
- Aligns with `docs/requirements_spec.md` (v3 Universal Platform direction)

## In scope

1. **Nav IA refactor** — three intent-based regions: WORKSPACE / BUILD / INSPECT
2. **NEW Discover tab** — cross-DataSource catalog of tables/functions/views with "+ Add to Module"
3. **NEW Module Builder workflow** — 4-step (Pick raw → Group & name → Attach policies → Grant access)
4. **Modules tab refactor** — split into "Catalog Browser" (read) + delegate creation to Module Builder
5. **Tab consolidations**:
   - Resources + Policies → unified `Policies` master-detail
   - Subjects + Roles + Actions → unified `Identity` 3-pane
6. **Renames**: `Pool` → `Data Sources`; `Modules` (admin) → `Catalog`
7. **User-facing entry point**: `My Modules` lands page for non-admin

## NOT in scope (deferred to TODOS / wishlist)

- AI-assisted Module generation (Smart Analyst 2.0 / M5)
- Module versioning / draft → publish workflow
- Cross-tenant Modules
- Module diff/audit visualization
- Migrating existing Modules to new schema (none exist that need migration; all
  current rows live in `authz_resource` already and are addressable by `resource_id`)

## What already exists (reuse)

| Need | Existing code | Reuse strategy |
|---|---|---|
| Module tree rendering | `modules/ModuleTree.tsx` | Use as Step 2 parent-picker in Builder |
| Module CRUD API | `routes/modules.ts` (assumed; verify) | Add only `POST /modules/builder/draft` for save-as-draft |
| Tables/functions discovery per-DS | `routes/datasource.ts` schema introspection | Aggregate across DS in new `GET /api/discover` |
| Policy editor | `access-manager/` panels | Embed as Step 3 panel in Builder |
| Subject/Role/Action mgmt | `access-manager/SubjectsTab/RolesTab/ActionsTab` | Wrap in single `IdentityTab` with sub-nav |
| Toast/Modal/PageHeader/EmptyState atoms | `components/shared/atoms/*` | Direct reuse |
| Layout nav scaffold | `Layout.tsx:31-81` | Edit navGroups in place |

## Architecture

```
                                           ┌─────────────────────┐
        BUILD region (admin)               │  WORKSPACE region   │
                                           │       (all)         │
   ┌─────────────┐  ┌─────────────┐        │                     │
   │Data Sources │→ │  Discover   │        │  My Modules ────────┼──┐
   │ (Pool tab)  │  │  (NEW tab)  │        │  Browse Data        │  │
   └─────────────┘  └─────┬───────┘        │  Run Function       │  │
                          │                │   └ Compose Flow    │  │
                          ▼                │  Open in Metabase   │  │
                  ┌───────────────┐        └──────────▲──────────┘  │
                  │ Module Builder│                   │             │
                  │ Step 1 Pick   │ ─── creates ─────►│             │
                  │ Step 2 Group  │   `authz_resource` rows         │
                  │ Step 3 Policy │   type='module' + grants        │
                  │ Step 4 Grant  │                                 │
                  └───────────────┘ ◄──── grants land in ───────────┘
                                          authz_role_permission
```

## Implementation phases

### P1 — Nav IA refactor (no behavior change)
**Files:** `apps/authz-dashboard/src/components/Layout.tsx`
**Changes:**
- Restructure `navGroups` into `WORKSPACE / BUILD / INSPECT`
- Add `subtitle?: string` and `indent?: boolean` to NavItem type
- Render subtitle as `text-[11px] text-slate-400`; indent as `pl-7 border-l border-slate-800/50`
- Move existing TabIds to new groups (keep TabId strings unchanged → URLs intact)
- Rename labels only: `Pool` → `Data Sources`, admin `Modules` → `Catalog`
- Hide entire BUILD region for non-admin (not per-item)
- Indent Flow Composer under Run Function

**Estimate:** 1h | **Risk:** low

### P2 — Discover tab
**New files:** `apps/authz-dashboard/src/components/DiscoverTab.tsx`
**API:** new `GET /api/discover?type=table|function|view&data_source_id=...`
in `services/authz-api/src/routes/discover.ts`
- Aggregates across all `authz_data_source` rows the admin can read
- Returns `{data_source_id, type, schema, name, mapped_to_module: string|null}`
- Filters: `unmapped=true`, search by name/schema
- UI: virtualized table (rows can be 10k+), checkbox-select, sticky "+ Add to Module" toolbar
- "Add" → opens Module Builder pre-populated with selected items

**Estimate:** 4h | **Risk:** medium (cross-DS query perf — see Failure Modes)

### P3 — Module Builder workflow
**New files:**
- `apps/authz-dashboard/src/components/builder/ModuleBuilderModal.tsx`
- `builder/steps/{StepPick,StepGroup,StepPolicies,StepGrant}.tsx`

**API:**
- `POST /api/modules/builder/draft` (stash to localStorage server-side mirror via Redis, key=user_id+timestamp, TTL 7d)
- `POST /api/modules/builder/finalize` (transactional: create module row + bind tables + apply policies + grant roles)

**UX:**
- 4-step wizard inside Modal; left rail shows progress
- Each step's "Save draft" button → POST draft, restore on next open
- Step 4 finalize → toast "Module 'Engineering / Test Programs' published", auto-navigate user to Catalog Browser with new row highlighted

**Estimate:** 6h | **Risk:** medium (transaction integrity in finalize)

### P4 — Catalog Browser refactor
**Files:** `apps/authz-dashboard/src/components/modules/ModulesTab.tsx`
- Strip out the "create new module" button → replace with "Open Module Builder"
- Keep tree view + ModuleDetail intact (admins still need to inspect existing modules)
- Add "Built from N raw items" stat to ModuleDetail

**Estimate:** 1.5h | **Risk:** low

### P5 — Tab consolidations (Policies, Identity)
**New files:**
- `components/access-manager/PoliciesUnified.tsx` (master-detail: left resource tree, right policy editor)
- `components/access-manager/IdentityTab.tsx` (3-pane sub-nav: Subjects | Roles | Actions)

**Removed nav items:** Resources, Policies (now merged), Subjects, Roles, Actions (now merged)
**Preserved TabIds:** Old IDs become URL aliases that redirect to new tab + sub-pane

**Estimate:** 4h | **Risk:** medium (Resources tab has heavy CRUD; merging without losing capability)

### P6 — E2E coverage
**New file:** `apps/authz-dashboard/e2e/06-bottom-up-flow.spec.ts`
Tests:
1. Admin: nav has WORKSPACE/BUILD/INSPECT with correct items
2. Admin: Discover lists tables across DS, "+ Add" opens Builder pre-populated
3. Admin: Builder 4-step happy path → module appears in Catalog
4. Admin: Builder draft restore (close mid-flow → reopen → state intact)
5. User (non-admin): nav has WORKSPACE only, BUILD region hidden
6. User: My Modules lands page shows granted modules from Builder
7. URL alias: `?tab=access-resources` redirects to `policies?pane=resources`

**Estimate:** 2h | **Risk:** low

### P7 — Docs update
**Files:** `docs/PROGRESS.md`, `docs/api-reference.md`, `docs/architecture-diagram.md`
**Estimate:** 30min | **Risk:** low

## Total effort
**~19h CC time** (~2 working days). Human-eq: ~1.5 weeks.

## Failure modes & mitigations

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Discover cross-DS query slow on >10 DS | Medium | High | Cache schema introspection in Redis (TTL 1h), provide refresh button |
| Module Builder finalize partial-success | Low | High | Wrap in single PG transaction; rollback on any sub-step failure; surface specific error to UI |
| URL alias break old bookmarks | Medium | Medium | Add `<meta name="route-redirect">` + 1-week deprecation banner |
| Existing user Modules invisible after refactor | Low | High | Catalog Browser shows ALL `authz_resource WHERE resource_type='module'` regardless of who created |
| Tab consolidation drops capability (e.g., bulk role assign) | Medium | Medium | Pre-implement audit: list every action available in the 5 source tabs, ensure each is preserved post-merge |
| Translation/i18n breaks (zh-TW labels) | Low | Low | Touch only nav labels; existing i18n keys for tab content unchanged |

## Decisions to confirm

1. **Should `Browse Data` (today's Data Explorer) stay in WORKSPACE for users, or move to BUILD as "what raw data exists"?**
   - Recommend: WORKSPACE — it's permission-filtered; users use it for their granted tables
   - Discover (BUILD) is the *unfiltered* admin view of the same underlying introspection

2. **Catalog vs Module Builder — single tab with mode switch, or two distinct nav items?**
   - Recommend: two nav items. Catalog = "browse what exists"; Builder = "create new". Mode-switch inside one tab is hidden state, breaks deep links.

3. **Subjects/Roles/Actions merge — sub-tabs or query-param-driven panes?**
   - Recommend: query-param `?pane=subjects|roles|actions` so links from other features (e.g., Builder Step 4 → "edit role") are deep-linkable.

## Test plan summary

- **Backend unit:** `routes/discover.ts` (3 tests: cross-DS aggregation, filter unmapped, RBAC enforcement)
- **Backend integration:** `routes/modules/builder.ts` finalize transaction (rollback test)
- **Frontend unit:** `ModuleBuilderModal` step navigation + draft serialization
- **E2E:** see P6 — 7 scenarios covering admin + user paths, URL aliases, draft restore

## References

- `docs/requirements_spec.md` — v3 Universal Platform vision
- `docs/PROGRESS.md` §M3, M4 — current state
- `docs/wishlist-features.md` — items pulled into NOT-in-scope
- `apps/authz-dashboard/src/components/Layout.tsx:31-81` — nav structure
- `apps/authz-dashboard/src/components/modules/ModulesTab.tsx` — existing Modules logic to refactor
