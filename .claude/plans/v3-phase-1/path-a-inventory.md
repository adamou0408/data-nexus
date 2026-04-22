# Path A (Config-SM) Inventory — for v3 Phase 1 Migration

**Status:** Inventory complete (2026-04-22, by Explore agent)
**Linked from:** `docs/plan-v3-phase-1.md` §1.1 "Path A 辦死"
**Purpose:** Basis for Q1 2027 migration to Tier 2 admin 表單模式 (gated by G2 in §6.2)

---

## 1. Path A / Config-SM Frontend Components

**Core Config Engine (metadata-driven UI renderer):**
- `apps/authz-dashboard/src/components/ConfigEngine.tsx` — Main metadata-driven router. Renders `card_grid`, `table`, and `tree_detail` layouts from `authz_ui_page` config. Dispatches `tree_detail` to registered handlers via `handler_name`.

**Config Management Tools:**
- `apps/authz-dashboard/src/components/ConfigToolsTab.tsx` — Export/import UI. Calls `/api/config/snapshot` (read) and `/api/config/bulk` (write).

**Module System (tree_detail handler):**
- `apps/authz-dashboard/src/components/modules/ModulesTab.tsx` — `tree_detail` layout handler. Registered as `modules_home_handler` in V038 migration.
- `apps/authz-dashboard/src/components/modules/ModuleDetail.tsx` — Master-detail view with 4+ sub-tabs (Tables, Functions, Access, Profiles) driven by UI descriptors.
- `apps/authz-dashboard/src/components/modules/ModuleTree.tsx` — Hierarchical tree view (parent/child modules).
- `apps/authz-dashboard/src/components/modules/ModuleFormModal.tsx` — Create/edit form for modules.
- `apps/authz-dashboard/src/components/modules/TablesPanel.tsx` — Grid of tables mapped to module.
- `apps/authz-dashboard/src/components/modules/AccessPanel.tsx` — Role permission matrix for module.
- `apps/authz-dashboard/src/components/modules/ProfilesPanel.tsx` — Pool profiles that reference module.

**Pool Lifecycle (data source onboarding flow):**
- `apps/authz-dashboard/src/components/pool/DataSourceLifecycle.tsx` — 6-phase stepper (lifecycle manager).
- `apps/authz-dashboard/src/components/pool/ConnectionPhase.tsx` — DB connection test and validation.
- `apps/authz-dashboard/src/components/pool/DiscoveryPhase.tsx` — Schema/table discovery.
- `apps/authz-dashboard/src/components/pool/OrganizationPhase.tsx` — Map discovered tables into modules/resources.
- `apps/authz-dashboard/src/components/pool/ProfilesPhase.tsx` — Create pool profiles (roles, allowed_tables, allowed_modules).
- `apps/authz-dashboard/src/components/pool/CredentialsPhase.tsx` — Generate/rotate DB credentials.
- `apps/authz-dashboard/src/components/pool/DeploymentPhase.tsx` — Deploy to pgbouncer, final validation.

---

## 2. Path A / Config-SM Backend Routes and Handlers

**Config-Driven UI Execution:**
- `services/authz-api/src/routes/config-exec.ts`
  - `POST /api/config-exec/root` — `fn_ui_root($user_id, $groups)` returns card_grid landing
  - `POST /api/config-exec` — `fn_ui_page($page_id)` + authz_check + buildMaskedSelect + drilldown WHERE clause

**Config Export/Import:**
- `services/authz-api/src/routes/config-snapshot.ts` — `GET /api/config/snapshot` exports roles, subjects, resources, policies, pool profiles, UI pages (14 sections, nested JSON).
- `services/authz-api/src/routes/config-bulk.ts` — `POST /api/config/bulk` applies changes with `dry_run` support.

**Module Management:**
- `services/authz-api/src/routes/modules.ts`
  - `GET /api/modules/tree` — permission-filtered module tree (uses `module_tree_stats` matview, `authz_check_batch` for L3 fast path)
  - `GET /api/modules/:id` — module details with children/access/profiles
  - `POST /api/modules` — create
  - `PUT /api/modules/:id` — update
  - `DELETE /api/modules/:id` — soft-delete with child reassignment

**Pool Lifecycle:**
- `services/authz-api/src/routes/pool.ts`
  - `GET /api/pool/lifecycle/:ds_id` — loads phase status from `authz_lifecycle_phase` table
  - `POST /api/pool/lifecycle/:ds_id/:phase` — advances phase (connection → discovery → organization → profiles → credentials → deployment)
  - `GET/POST/PUT/DELETE /api/pool/profiles` — CRUD for `authz_db_pool_profile` (includes `allowed_modules` column V026)

**UI Metadata:**
- `services/authz-api/src/routes/ui.ts` — `GET /api/ui/descriptors/:page_id` returns `authz_ui_descriptor` rows (section_key, columns, render_hints).

---

## 3. Database Tables Backing Path A

**Core Config-SM Schema:**
- `authz_ui_page` (V022) — `page_id`, `title`, `layout` (`card_grid` | `table` | `tree_detail`), `data_table`, `row_drilldown` JSONB, `columns_override`, `filters_config`, **`handler_name`** (V038), `icon`, `description`
- `authz_ui_descriptor` (V035) — `descriptor_id`, `page_id`, `section_key`, `columns` JSONB, `render_hints` JSONB (defines sub-tabs within tree_detail)
- Functions: `fn_ui_page($page_id)`, `fn_ui_root($user_id, $groups)`, `fn_ui_descriptors($page_id)` (V022, V038)

**Pool Lifecycle Schema:**
- `authz_data_source` — `db_type`, `host`, `port`, `database_name`, `oracle_connection` JSONB, `cdc_target_schema`
- `authz_lifecycle_phase` — `phase` (`connection` | `discovery` | `organization` | `profiles` | `credentials` | `deployment`), `status`, `data` JSONB
- `authz_db_pool_profile` — `profile_id`, `pg_role`, `allowed_schemas`, `allowed_tables`, `allowed_modules` TEXT[] (V026), `connection_mode`, `max_connections`, `ip_whitelist`, `valid_hours`, `rls_applies`
- `authz_pool_credentials` — `pg_role`, `rotate_interval`

**Module Resource Hierarchy:**
- `authz_resource` (`type='module'`) — `parent_id` (forms tree), `attributes` JSONB
- `module_tree_stats` (V034 matview) — pre-computed `parent_id`, `child_module_count`, `table_count`, `column_count`
- `authz_check_batch()` (V040) — batch permission check using resource_ancestors (L3 optimization)

---

## 4. Pool 生命週期頁 — Phase Breakdown

Each phase is a collapsible card in `DataSourceLifecycle` with status (`pending` | `in_progress` | `done`):

1. **ConnectionPhase** — Test DB connectivity, validate credentials, detect db_type (PostgreSQL / Oracle / MySQL)
2. **DiscoveryPhase** — Query `information_schema`, discover tables/views, auto-detect schemas
3. **OrganizationPhase** — Assign discovered tables to modules (resource hierarchy), set `parent_id`
4. **ProfilesPhase** — Define pool profiles: `pg_role`, `allowed_tables[]`, `allowed_modules[]`, `connection_mode`, `max_connections`
5. **CredentialsPhase** — Generate/manage PG password for `pg_role`, set `rotate_interval`, track `last_rotated`
6. **DeploymentPhase** — Validate pgbouncer config, apply external grants (remote_sync), final health check, mark `is_active=true`

---

## 5. Modules Tab — Sub-Features and Descriptors

`ModulesTab` dispatches to 4 descriptor-driven sections (from `authz_ui_descriptor`):

1. **Tables** (visibility: read) — Maps columns: `display_name`, `resource_type`, `column_count`, `data_source_id`. Actions: reassign table to different module.
2. **Functions** (visibility: read) — Lists database functions bound to module (from `authz_resource` with `type='function'`).
3. **Access** (visibility: admin) — Action grid: shows which roles have (`read` | `write` | `admin` | `execute`) on this module. Editable: add/remove role permissions.
4. **Profiles** (visibility: admin) — Pool profiles that reference this module via `allowed_modules[]`. Shows `connection_mode`, `data_source_id`.

Master-detail layout: left panel = tree view (`ModuleTree`), right panel = detail (`ModuleDetail` with sub-tabs).

---

## 6. Migration Complexity Estimate (T-Shirt Sizing)

| Area | Complexity | Effort | Notes |
|------|-----------|--------|-------|
| **ConfigEngine Router** | S-M | 5-8d | Routes `card_grid` / `table` / `tree_detail`. `tree_detail` dispatch moves from hardcoded `TREE_DETAIL_HANDLERS` to `handler_name` column. Wizard mode replaces drilldown with linear multi-step form. |
| **Config-SM Data Layer (`authz_ui_page`)** | S | 3-5d | Migrate page configs to Tier 2 form state (JSON → form state). No schema change if reusing `handler_name` as-is. |
| **Pool Lifecycle (6 phases)** | M-L | 12-18d | Each phase = separate form screen in wizard. `OrganizationPhase` is complex (tree organization). `CredentialsPhase` requires credential rotation logic. `DeploymentPhase` external_sync calls. |
| **Modules tree_detail Handler** | M | 8-12d | Descriptor-driven sub-tabs → wizard screens. Tables reassign, Access role grid, Profiles listing all become form controls. Master-detail layout → sequential screens. |
| **Pool Profiles CRUD** | S | 4-6d | `allowed_modules` expansion (V026) already exists. Form-based CRUD straightforward. |
| **Config Tools (Export/Import)** | M | 6-10d | Bulk JSON import/preview → form wizard validating each section. CSV import option requires new schema. |
| **Database Migrations** | S-M | 5-7d | Backfill `handler_name`, add `tier2_wizard_template` column to `authz_ui_page`, new `authz_tier2_form_state` table (WIP). |
| **UI Descriptor System** | S-M | 4-6d | Reuse existing metadata for form rendering (L1 `columns[]` → form fields). Add form-specific hints: `step_index`, `required[]`, `conditional[]`. |

**Total Estimate (Path A 辦死):** 50-80 days (M-L effort).

**Q1 2027 feasibility (assumes Tier 2 admin form framework ready by mid-Q4 2026):**
- Start migration discovery in Nov 2026
- Form wizard framework ready mid-Dec 2026
- Parallel path: migrate highest-priority pages (Modules, Pool Lifecycle) first
- Reuse descriptor system for form rendering (minimal new metadata)

**Key Dependencies:**
- Tier 2 admin form framework (multi-step wizard, state persistence)
- New JSON schema for form templates (replaces `row_drilldown`, `filters_config`)
- Credential rotation abstraction (shared with Pool phase)

**Highest-risk migration items (do first):**
1. **Pool Lifecycle phase orchestration** — stateful, multi-step, external system (pgbouncer) dependency
2. **CredentialsPhase rotation** — security-critical, no rollback if mishandled
3. **OrganizationPhase tree mapping** — complex UX, hard to re-do if migration breaks user workflow

---

## 7. G2 Pilot Gate Recommendations

Per `docs/plan-v3-phase-1.md` §6.2 G2: Tier 2 admin 表單 alpha must run 3-5 pilot users × 2 weeks **before** Path A migration starts.

**Recommended pilot workflows (Q4 2026 alpha):**
1. **Module CRUD via Tier 2 admin form** — replicate `ModuleFormModal` flow as Tier 2 wizard, hand to 2 DBA pilots
2. **Pool Profile create/edit** — replicate `ProfilesPhase` as Tier 2 wizard, hand to 2 SRE pilots
3. **Bulk policy import** — replicate `ConfigToolsTab` import flow, hand to 1 admin pilot

**Pass criteria for G2:**
- Pilots return for ≥ 3 sessions per workflow over the 2-week window without prompting
- ≤ 2 P1 bugs per workflow
- Pilots write a one-paragraph "would you use this instead of the old page" sign-off
