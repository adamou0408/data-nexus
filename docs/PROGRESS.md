# Phison Data Nexus — Progress Tracker

> **This file is the SSOT for project progress.**
> All sessions should read this first and update it when completing work.
> Last updated: 2026-04-13

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

### Remaining
(Milestone 3 complete — remaining items moved to Milestone 4)

## Milestone 4: Production-Ready — IN PROGRESS

### Done
- [x] Metabase BI: Docker Compose + Makefile targets (`make metabase-up`)
- [x] Metabase connects to nexus_data via pgbouncer Path C (SSOT — PG GRANT+RLS enforced)

### Remaining
- [ ] Redis L1 cache layer + `authz_check_from_cache()`
- [ ] Helm chart + K8s deployment
- [ ] Policy Simulator + Impact Analysis
- [ ] LDAP sync CronJob (scheduled, not just manual)
- [ ] Keycloak SSO integration (optional)

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
| data/V003 | 6 remaining business tables migrated to nexus_data | Done |
| data/V004 | Path C RLS: remove current_setting(), add identity-only pg_has_role | Done |

## Services

| Service | Path | Port | Status |
|---------|------|------|--------|
| authz-api | `services/authz-api` | 3001 | Running |
| identity-sync | `services/identity-sync` | CLI | New — manual sync via `make ldap-sync` |
| authz-dashboard | `apps/authz-dashboard` | 5173 | Running |

## Key Docs

| Doc | Purpose | When to read |
|-----|---------|-------------|
| `PROGRESS.md` (this file) | Where are we now | Every session start |
| `phison-data-nexus-architecture-v2.4.md` | What we're building (full spec) | Architecture decisions |
| `er-diagram.md` | Database schema diagram | DB changes |
| `nexus-startup-guide.md` | How to get started | First-time setup |
| `backlog-tech-debt.md` | Known issues + tech debt | Sprint planning |
| `wishlist-features.md` | User feature requests | Sprint planning |
| `plan-business-db-separation.md` | ARCH-01 implementation guide | When starting DB separation |
| `standards/` | Dev standards, security rules, known risks | Before writing code |
