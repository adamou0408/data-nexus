# Phison Data Nexus — Progress Tracker

> **This file is the SSOT for project progress and goals.**
> All sessions should read this first and update it when completing work.
> For feature requests detail: `docs/wishlist-features.md`
> For tech debt detail: `docs/backlog-tech-debt.md`
> Last updated: 2026-04-17

---

## Milestone 1: AuthZ Runs Locally — DONE

- [x] Docker Compose (PG 16 + Redis 7)
- [x] DB migrations V001-V017
- [x] `authz_resolve()`, `authz_check()`, `authz_filter()` PG functions
- [x] Dev seed data (18 groups, 19 users, 16 roles, 40+ resources)
- [x] `make verify` passes
- [x] Makefile dev workflow

## Milestone 2: First Page Is Permission-Aware — DONE

- [x] Express API service (`services/authz-api`, port 3001)
  - Routes: resolve, check, filter, browse, matrix, pool, rls-simulate
- [x] React dashboard (`apps/authz-dashboard`, port 5173)
  - Tabs: Overview, Resolve, Check, Matrix, RLS, Workbench, Pool, Browser, Audit
- [x] AuthzProvider context + meta-driven tab visibility
- [x] SSOT-driven pool denied_columns (V015)
- [x] L2 column masks + L0 column deny in RLS Simulator
- [x] API AuthZ middleware (requireAuth / requireRole / requirePermission)
- [x] Auth headers (X-User-Id, X-User-Groups)

## Milestone 3: All Three Paths Enforced — DONE

### Done
- [x] Path B: Express middleware wired (requireAuth, requirePermission, requireRole)
- [x] Path C: Pool management CRUD (profiles, assignments, credentials)
- [x] Path C: `authz_sync_db_grants()` + pgbouncer config generation
- [x] Path C: Native RLS policies on lot_status/sales_order (V019)
- [x] LDAP: OpenLDAP + phpLDAPadmin Docker setup (`deploy/docker-compose/docker-compose.ldap.yml`)
- [x] LDAP: Seed LDIF with 19 groups + 18 users + membership (`deploy/ldap/seed/`)
- [x] LDAP: V018 `authz_group_member` table + `authz_resolve_user_groups()` function
- [x] LDAP: `identity-sync` service (`services/identity-sync/`)
- [x] LDAP: API middleware auto-resolves groups from DB when header not provided
- [x] All seed data has `ldap_dn` populated
- [x] Data Source Registry: V020 `authz_data_source` table + pool_profile FK
- [x] Data Source Registry: CRUD + test + discover API (`/api/datasources`)
- [x] Data Source Registry: Dynamic pool management in `db.ts`
- [x] rls-simulate.ts + pool.ts use dynamic data source pools
- [x] ARCH-01: Business DB separation (nexus_authz + nexus_data in same PG instance)
- [x] ARCH-01: Migrations split into `migrations/` (authz) and `migrations/data/` (business)
- [x] ARCH-01: Seed data split into `seed/` (authz) and `seed/data/` (business)
- [x] ARCH-01: pgbouncer + pg_hba point pool roles at nexus_data

- [x] W-IT-01: Audit logging for all admin operations (pool + datasource CRUD)
- [x] W-IT-01: AuditTab access_path filter (All/A/B/C)
- [x] W-USER-01: WorkbenchTab row statistics + denied column tooltip
- [x] Phase 6: PoolTab Data Sources section (register, test, discover)
- [x] Phase 7: MatrixTab data source filter dropdown
- [x] W-USER-02: OverviewTab My Access Card (L0 grouped by type + L1 scope summary)
- [x] W-DBA-03: Profile create → credential setup prompt
- [x] W-IT-02: Assignment subject dropdown (replaces freetext input)
- [x] W-IT-03/04, W-DBA-04: Already implemented via action-items API
- [x] Business DB: resource attributes tagged with data_source_id
- [x] Business DB: ds:local host corrected for Docker networking
- [x] Config-Driven UI Engine Phase 1 (V022 authz_ui_page + fn_ui_page/fn_ui_root + /api/config-exec + ConfigEngine.tsx)
- [x] Shared masked-query helper (JS-side masks, no cross-DB dependency)
- [x] Data V003: 6 remaining business tables migrated to nexus_data
- [x] Admin CRUD: BrowserTab SSOT dropdowns (roles, groups, actions, resources, parent_id)
- [x] Admin CRUD: Search/filter on all 5 entity sections
- [x] Path C: pgbouncer live reload (apply+reload endpoint + writable volume)

- [x] Path C: External DB Grant Sync (sync SSOT grants to remote DBs)
- [x] Path C: Credential rotation auto-syncs to remote DBs
- [x] Path C: Drift detection (SSOT vs remote DB comparison)
- [x] V025: External sync support (sync_log table + data_source tracking)
- [x] V026: `allowed_modules` column on pool profiles
- [x] Metadata-driven table-to-module mapping (bulk API + UI)
- [x] Relational pool profiles (allowed_modules → recursive CTE expansion at sync time)
- [x] Table Mapping UI in DataSourcesSection (prefix grouping, module dropdown, bulk save)
- [x] Profile Form: allowed_modules field + Modules column in profiles table
- [x] pg_k8cluster scenario: Tiptop ERP modules + profile mapping
- [x] Greenplum compatibility: two-step table query, RLS skip, graceful column revoke

- [x] V027: EdgePolicy fusion schema (policy_assignment, data_classification, clearance_mapping, security_clearance/job_level on role)
- [x] V028: Phase 5 seed data (policy assignments, role clearance values, column classifications)
- [x] V029: Fix fn_ui_root card_grid layout filter
- [x] Phase 0: Shared helpers extraction (request-helpers.ts: getUserId, getClientIp, isAdminUser)
- [x] Phase 0: AuthzContext `isAdmin` centralized (removed 4 duplicate inline computations)
- [x] Phase 1: Browse route security split (browse-read.ts public + browse-admin.ts requireRole guard)
- [x] Phase 2: SSOT fixes — dynamic action list, dynamic role-pool map, dynamic default table
- [x] Phase 3: Admin audit completion — 11 missing logAdminAction calls in pool.ts + datasource.ts
- [x] Phase 4: AuditTab admin audit sub-tab + BrowserTab policy assignments + role clearance + classification UI
- [x] Phase 4: api.ts new endpoints (adminAuditLogs, policyAssignment*, roleClearanceUpdate, classifications, columnsClassified)
- [x] Phase 6: operation-detector integrated into rewrite pipeline (skip non-SELECT)
- [x] Phase 6: isAdminUser shared helper (removed duplicate in resolve.ts)
- [x] Config-exec fix: card_grid sub-page child population with authz_check filtering

### Remaining
(Milestone 3 complete — remaining items moved to Milestone 4)

## Milestone 4: Production-Ready — IN PROGRESS

### Done
- [x] Metabase BI: Docker Compose + Makefile targets (`make metabase-up`)
- [x] Metabase connects to nexus_data via pgbouncer Path C (SSOT — PG GRANT+RLS enforced)
- [x] DX-03: Dev port scheme (PG:15432, PgBouncer:16432, Redis:16379, API:13001, Dashboard:13173)
- [x] Config Tools: Export snapshot API (`GET /api/config/snapshot`) — 9 sections, selective export
- [x] Config Tools: Bulk import API (`POST /api/config/bulk`) — dry_run, dependency order, transaction-safe
- [x] Config Tools: ConfigToolsTab UI (export/import panels, dry run preview, result display)
- [x] Agent roles: 16 agent definitions in `.claude/agents/` (5 technical + 1 PO + 9 domain experts + shared principles)
- [x] TimescaleDB: Docker image switched to `timescale/timescaledb:latest-pg16`
- [x] V030: `authz_audit_log` → hypertable (7-day chunks, 30-day compression, 2-year retention)
- [x] V030: Continuous aggregates `audit_hourly_summary` + `audit_daily_by_subject`
- [x] data/V006: `lot_status_history` hypertable + trigger on `lot_status`
- [x] data/V006: `yield_events` hypertable + trigger on `cp_ft_result`
- [x] data/V006: Continuous aggregates `yield_daily_trend` + `lot_daily_flow`
- [x] Discover tab (bottom-up catalog): `GET /api/discover` + `/api/discover/stats` (admin-only) — cross-source view of every table/view/function with mapped/unmapped status, type/search/unmapped filters, 6 Playwright E2E tests (plan: `plan-bottom-up-ux-refactor.md`)
- [x] Discover → Promote to Module (Phase B): `POST /api/discover/promote` + per-row "Promote" button + modal — closes the bottom-up loop (existing data → 1-click permission-controlled Module). Transactional, refreshes module_tree_stats, writes admin audit. 2 Playwright E2E tests.

### Remaining — Infrastructure (Milestone 4 core)
- [ ] SEC-06: Production secrets management (P0 blocker — detail: `backlog-tech-debt.md`)
- [ ] Redis L1 cache layer + `authz_check_from_cache()`
- [ ] Helm chart + K8s deployment
- [ ] LDAP sync CronJob (scheduled, not just manual)
- [ ] Keycloak SSO integration (optional)

### Remaining — Feature (current development focus, detail: `wishlist-features.md`)
- [ ] Data Mining module: Config-SM business logic pages (design: `design-data-mining-engine.md`)
- [ ] Metabase BI self-service: lower barrier for BI users
- [ ] Policy Simulator + Impact Analysis

### Planned — Oracle 19c CDC Support
> Design complete (7 steps, 8 architecture decisions D1-D8). Plan: `.claude/plans/`

- [ ] V032: Migration — `cdc_target_schema`, `oracle_connection` columns on `authz_data_source`
- [ ] data/V005: CDC schema helper function `_nexus_create_cdc_schema()`
- [ ] `oracledb` dependency + `getOracleConnection()` / `getLocalDataPool()` in `db.ts`
- [ ] `datasource.ts`: Oracle-aware registration, test, discovery
- [ ] `oracle-exec.ts`: Oracle function call proxy route (`POST /api/oracle-exec`)
- [ ] `remote-sync.ts`: Oracle source grant sync redirected to local PG
- [ ] Frontend: Oracle data source form fields + discovery display

---

## Project Goals — Roadmap

> SSOT: milestones and goals are tracked here. Other docs reference this file.

```
Milestone 1: AuthZ Runs Locally                    ✅ Complete
Milestone 2: First Page Is Permission-Aware        ✅ Complete
Milestone 3: All Three Paths Enforced              ✅ Complete
Milestone 4: Production-Ready                      🟡 In Progress
  ├── Infrastructure: SEC-06, Redis, Helm, LDAP CronJob, Keycloak
  ├── Feature: Data Mining, Metabase BI, Policy Simulator
  └── Oracle CDC: 7-step implementation plan ready
Phase 2: AI Agent Integration (Smart Analyst 2.0)  ⏳ Blocked on M4
  └── Decision (2026-02-11): Data Nexus goes live first
```

---

## Database Migrations

| Migration | Content | Status |
|-----------|---------|--------|
| V001 | ENUM types | Done |
| V002 | Core tables (subject, resource, action, role, permission, subject_role) | Done |
| V003 | Policy tables (policy, composite_action, mask_function) | Done |
| V004 | Pool tables (pool_profile, pool_assignment, pool_credentials) | Done |
| V005 | Sync & audit tables + indexes | Done |
| V006 | Policy version table + auto-version trigger | Done |
| V007 | Core functions (_authz_resolve_roles, authz_check, authz_filter) | Done |
| V008 | Path A: authz_resolve() | Done |
| V009 | Path B: authz_resolve_web_acl() | Done |
| V010 | Path C: authz_sync_db_grants(), authz_sync_pgbouncer_config() | Done |
| V011 | Audit batch insert function | Done |
| V012 | Cache invalidation triggers (LISTEN/NOTIFY) | Done |
| V013 | Base seed data (roles, actions, mask function registry) | Done |
| V014 | Sample lot_status + sales_order data | Done |
| V015 | SSOT pool denied_columns + v_pool_ssot_check view | Done |
| V016 | Column mask PG functions (fn_mask_full/partial/hash/range) | Done |
| V017 | Fix authz_filter() resource_condition data_domain matching | Done |
| V018 | Group membership table + authz_resolve_user_groups() | Done |
| V019 | Path C native RLS (PG roles, GRANT, RLS policies, views) | Done |
| V020 | Data Source Registry (authz_data_source) + pool_profile FK | Done |
| V021 | Create 6 physical business tables in nexus_authz | Done |
| V022 | Config-Driven UI Engine (authz_ui_page + fn_ui_page/fn_ui_root) | Done |
| V023 | Fix authz_sync_pgbouncer_config() STABLE → VOLATILE | Done |
| V024 | Fix authz_check_from_cache() deny-wins + authz_resolve() include deny in L0 | Done |
| V025 | External sync support (authz_sync_log + last_grant_sync_at) | Done |
| V026 | `allowed_modules` TEXT[] on authz_db_pool_profile | Done |
| V027 | EdgePolicy fusion schema (policy_assignment, classification, clearance_mapping, role columns) | Done |
| V028 | Phase 5 seed data (policy assignments, role clearance, column classifications) | Done |
| V029 | Fix fn_ui_root: remove card_grid layout exclusion | Done |
| V030 | TimescaleDB audit hypertable (7-day chunks, 30-day compression, 2-year retention) + continuous aggregates | Done |
| data/V003 | 6 remaining business tables migrated to nexus_data | Done |
| data/V004 | Path C RLS: remove current_setting(), add identity-only pg_has_role | Done |
| data/V006 | TimescaleDB business hypertables (lot_status_history, yield_events) + triggers + continuous aggregates | Done |

## Services

| Service | Path | Port | Status |
|---------|------|------|--------|
| authz-api | `services/authz-api` | 13001 | Running |
| identity-sync | `services/identity-sync` | CLI | Manual sync via `make ldap-sync` |
| authz-dashboard | `apps/authz-dashboard` | 13173 | Running |
| PostgreSQL | `deploy/docker-compose` | 15432 | Docker |
| PgBouncer | `deploy/docker-compose` | 16432 | Docker |
| Redis | `deploy/docker-compose` | 16379 | Docker |

## Key Docs

| Doc | Purpose | When to read |
|-----|---------|-------------|
| `PROGRESS.md` (this file) | Where are we now | Every session start |
| `phison-data-nexus-architecture-v2.4.md` | What we're building (full spec) | Architecture decisions |
| `er-diagram.md` | Database schema diagram | DB changes |
| `nexus-startup-guide.md` | How to get started | First-time setup |
| `backlog-tech-debt.md` | Known issues + tech debt | Sprint planning |
| `wishlist-features.md` | User feature requests + current focus | Sprint planning |
| `design-data-mining-engine.md` | Data Mining module execution plan | When implementing Data Mining |
| `design-data-mining-vision.md` | Data Mining long-term vision | When trigger conditions met |
| `.claude/agents/README.md` | Agent roles (16 agents) + architecture principles | AI-assisted development |
| `.claude/plans/` | Oracle CDC implementation plan (D1-D8) | When starting Oracle support |
| `standards/` | Dev standards, security rules, known risks | Before writing code |
