# Phison Data Nexus — Progress Tracker

> **This file is the SSOT for project progress (STATE).**
> **Plan SSOT (active Phase 1):** `docs/plan-v3-phase-1.md`
> **Sub-plans index:** `.claude/plans/v3-phase-1/README.md`
> All sessions should read this file first and update it when completing work.
> For feature requests detail: `docs/wishlist-features.md`
> For tech debt detail: `docs/backlog-tech-debt.md`
> Last updated: 2026-04-26

---

## Phase 1 Active — Weekly Tracker (2026-04-26 → 2027-05)

**Demo target:** Q2 2027 · **Master plan:** `docs/plan-v3-phase-1.md`
**Mode:** 純軟體開發 — no hiring / cross-team / 訪談 paths in scope（見 memory `project_pure_software_dev.md`）

### This week (2026-04-26 → 2026-05-03)

**新近完成（本 session 落地）:**
- [x] **PLATFORM-MODEL-01** — Two-Tier Platform Model framework 寫入 plan + standards (`.claude/plans/v3-phase-1/two-tier-platform-model.md` + `docs/standards/metadata-driven-ui.md`,master plan §2.1 鎖定為 4th architectural decision)
- [x] **AUDIT-AI-01** — Constitution §9.7 admin-audit columns(actor_type / agent_id / model_id / consent_given)落地 (V049 + admin-audit lib,commit dac27d6)
- [x] **Constitution v2.0** — Article 9 (AI Agent Operations) ratified (commit 82c6790)
- [x] **Plan §2.6/§5/§6 cross-team ghost paths 剔除** — commit d13618c
- [x] **DS-CASCADE-02** — fix /purge FK gaps (composite_actions + pool_credentials + sync_log,commit 50921ab)
- [x] **SEMANTIC-01** — V044 semantic-layer columns on authz_resource(business_term/definition/formula/owner_subject_id/status lifecycle/blessed_at/by);self-reviewed promote 2026-04-26
- [x] **RENDER-TOKEN-01** — ICON_MAP / STATUS_COLORS / PHASE_COLORS / GATE_COLORS 從 hardcoded 搬進 `authz_ui_render_token` (V053);新增 `RenderTokensContext` + `/api/ui/render-tokens` endpoint;Curator INSERT 新 token 零 React 改動(2026-04-26)
- [x] **DAG-SAVE-PAGE-01 (Path A)** — DAG 任一 node 跑完可一鍵存成 Tier B snapshot page;V054 加 `authz_ui_page.snapshot_data` JSONB + 更新 `fn_ui_page`;新 endpoint `POST /api/dag/save-as-page`;config-exec.ts step 3a short-circuit 直接回傳 cached rows + columns;DagTab Inspector 加「Save as page」按鈕 + dialog,save 後自動跳 auto-page tab 看頁(2026-04-26)

**進行中(this week,可獨立完成):**
- [x] **V044 self-review & promote** — semantic layer columns 落地 `database/migrations/V044__authz_resource_business_term.sql`(2026-04-26)。修改:owner_user_id → owner_subject_id 對齊 V020;blessed_fields_check 鬆綁讓 deprecated 保留 audit history。Smoke-tested:lifecycle (draft→blessed→deprecated)、unique on blessed business_term、blessing invariants 全部通過。
- [ ] **V045 self-review & promote** — `.claude/plans/v3-phase-1/migration-drafts/V045__resource_cascade_policy.sql` 同上模式 (depends on V044) (Adam,~2h)
- [ ] **ARCH-01-FU-1 verify** — restart authz-api,確認 `POST /api/rls/simulate {table:'lot_status'}` 回傳業務資料 (Adam,~10min)

**下一個 sprint 候選**(not commit yet):
- ~~A) ICON_MAP / STATUS_COLORS 動態化~~ ✅ done (RENDER-TOKEN-01, 2026-04-26)
- B) `help_text` primitive (Tier A,1-2 天)
- C) business_term-driven column mask 自動化 (Tier A,depends on V044,1 週)
- D) default-by-convention permission preset (Tier A,1-2 週)

### Phase 1 milestone gates(純軟體版本 — pilot / SLO 由 Adam 自評)

| Gate | Date | Exit criteria | Status |
|------|------|---------------|--------|
| **G1** | 2026-09 | M4 prod-ready 上線 (SEC-06 / Helm / Keycloak / LDAP Cron / Redis) | 🟡 planning |
| **G2** | 2026-12 | Tier 2 admin 表單 alpha 自跑端到端 ≥ 1 個業務場景(取代 pilot) | ⏳ not started |
| **G3** | 2027-03 | LLM eval set 200 筆 + Adam 自評 text-to-SQL ≥85%, recall@10 ≥0.90 | ⏳ eval set 待開工 |
| **G4** | 2027-04 | Tier 1 自建引擎 render 1 個業務 dashboard 端到端 | ⏳ not started |

### Phase 1 quarterly snapshot

| Track | Q3 2026 | Q4 2026 | Q1 2027 | Q2 2027 |
|-------|---------|---------|---------|---------|
| M4 prod-ready | 🟡 kickoff | target 100% (G1 by 09/2026) | — | — |
| Tier A primitive (help_text / saved_view / feedback / subscription) | 🟡 help_text | saved_view + feedback | subscription | — |
| Tier 2 分析 wizard | — | alpha target | expand | demo-ready |
| Tier 2 admin 表單 | — | 🚧 alpha (G2 self-test) | Path A migration | done |
| AI 側欄 | — | — | 🚧 build | polish |
| Tier 3 Query Tool | — | — | — | 🚧 build |
| Tier 1 dashboard | — | — | — | 🚧 build (G4) |
| eval set 200 筆 | 🟡 self-collect | 🎯 200 complete | SLO self-eval | quarterly +20 |
| business_term | 🟡 V044 migration self-review | ≥20 blessed | ≥50 | ≥100 |

> **Legend:** 🟢 done · 🟡 in progress · 🚧 building · 🎯 milestone · ⏳ pending · 🔴 at risk

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
- [x] ARCH-01: Business DB separation (nexus_authz + nexus_data in same PG instance) — **部署驗證 2026-04-23** (dev postgres 容器兩個 DB 都在,pgbouncer 路由正確)
- [x] ARCH-01: Migrations split into `migrations/` (authz) and `migrations/data/` (business) — deployed
- [x] ARCH-01: Seed data split into `seed/` (authz) and `seed/data/` (business) — deployed
- [x] ARCH-01: pgbouncer + pg_hba point pool roles at nexus_data — verified
- [x] ARCH-01: Cleaned up nexus_authz legacy business tables (pre-ARCH-01 init residue)
- [~] ARCH-01-FU-1: Fixed rls-simulate.ts to use getLocalDataPool() for business-table scan (待 dev api restart 驗證 live)
- [~] ARCH-01-FU-2: Audited browse-read.ts / config-exec.ts / masked-query.ts / datasource.ts info_schema queries — fixed three browse-read endpoints + config-exec fallback to use getLocalDataPool() (2026-04-23, commit d3b31a7). tsc clean. 待 dev api restart 驗證。Bonus: 順手修了 config-bulk.ts 兩處 pre-existing typo。
- [~] ARCH-01-FU-3: Split V019 — kept cluster-level role + BYPASSRLS only; removed business-table GRANT/RLS/POLICY/VIEW (data/V002 已是 SSOT) (2026-04-23, commit 75cab5b). 待 DBA 簽核 split + 下次 fresh init 驗證。

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
- [x] Discover → Promote attach mode (Phase C): same `POST /api/discover/promote` extended with `target_module_id` discriminator — modal toggles between "Create new module" and "Add to existing" (lazy-loads `moduleTree()`, searchable list). Audit action `ATTACH_TO_MODULE`. +1 Playwright E2E (3 total).
- [x] Discover → Reparent (Phase D): `POST /api/discover/reparent` — inverse of /promote. From a mapped row, Move to another Module or Detach back to the unmapped pool (parent_id = NULL). Modal with Move/Detach toggle, current module shown. Audit actions `MOVE_TO_MODULE` / `DETACH_FROM_MODULE`. +2 Playwright E2E in `08-discover-reparent.spec.ts` (33 total).
- [x] Discover → Bulk operations (Phase E): `POST /api/discover/bulk` — three modes: `create_attach` (one new Module + attach all), `attach` (existing Module), `detach` (clear parents). Frontend: per-row checkbox + select-all + sticky action bar with mapped/unmapped split + Promote N / Attach N / Detach N buttons + bulk modal. Skip-and-report semantics for rows that don't match the mode's precondition (already_mapped, not_mapped, wrong_type). Audit actions `BULK_PROMOTE_TO_MODULE` / `BULK_ATTACH_TO_MODULE` / `BULK_DETACH_FROM_MODULE`. +2 Playwright E2E in `09-discover-bulk.spec.ts` (35 total).
- [x] Path A clarity: Pool → Organization phase summary now states the consequence ("non-admins can't access via Path A/B until then") + amber banner explaining why action is needed + "Open Discover filtered" deeplink (sessionStorage + CustomEvent navigation, no router needed). Discover gained DS filter dropdown that consumes the deeplink hint.
- [x] Module access UI: surfaced `execute` action (in addition to read/write/approve/export/connect) — fixes silent gap where `module:analytics`-style execute grants weren't visible in AccessPanel and weren't probed in `/api/modules/:id/details.user_permissions`. Affects `services/authz-api/src/routes/modules.ts:219` + `apps/authz-dashboard/src/components/modules/AccessPanel.tsx:13`.
- [x] DAG: production seed `dag:material_360_trace` (`database/seed/dag_material_360_trace.sql`) under `module:analytics` — 4 pg_k8 functions (`fn_material_lookup` → `fn_material_substitution_map` / `fn_material_full_trace` / `fn_cxmzr115_shipment_history_by_material_no`), 3 fan-out edges on `material_no`. Re-runnable (ON CONFLICT DO UPDATE). Verified inheritance: `BI_USER` with `execute` on `module:analytics` → all 4 nodes pass `authz_check`.
- [x] BU-04/05: Discover sensitive-column scan + suggested-policy approval queue (`POST /api/discover/scan-rules`, `GET /api/discover/pending-policies`, `POST /api/discover/approve|reject`). Engine seeds suggestions into `authz_policy.status='pending_review'` from regex rules in `authz_discovery_rule`. Idempotent via `ON CONFLICT (policy_name) WHERE status='pending_review'`.
- [x] BU-06: Bottom-up loop column_mask end-to-end. Engine output shape now matches `PolicyEvaluator` expectations (`resource_condition.table` = bare table, `column_mask_rules` = `{ '<table>.<col>': { function, mask_type } }`). V047 migration replaces V046's broken `current_setting()` row_filter templates with `${subject.x}` (resolved at app layer in `rls.ts`). Verified by `services/authz-api/src/scripts/bu06-e2e.ts`: discover → approve → evaluate → rewrite → execute on live `nexus_data.lot_status` returns `cost: '***'` instead of `cost: '6.80'`. **Caveat: row_filter end-to-end deferred** — no seeded table has a `tenant_id`/`org_id`/`owner_id`-shaped column yet, so V047's row_filter UPDATE was `UPDATE 0` and the E2E only exercised the mask path.
- [x] BU-07: My Permissions tab L2 panel re-grouped by table (was: by policy). New `MaskedColumnsCard` flattens `{ policy: { 'table.col': rule } }` → per-table list with human-readable mask hints (`fn_mask_full` → "fully hidden, e.g. '***'"). End-user-friendly answer to "if I SELECT * FROM <table>, what gets masked?". `apps/authz-dashboard/src/components/ResolveTab.tsx`.
- [x] BU-08: Schema-driven UI POC — bottom-up "schema → SQL → UI auto-generation" sealed. New `lib/schema-to-ui.ts` introspects any registered data source (`information_schema.columns` + `pg_index` for PK), maps PG types → semantic kinds via existing `classifyType`, derives render hints (email_link / mono / relative_time / active_badge / json_truncate / array_pills / date) and Title-Case labels. `POST /api/discover/generate-app` (admin) inserts `authz_ui_page` (layout='table', `columns_override` populated so existing `config-exec` / `DataTable` renders without a new descriptor-aware path) + `authz_ui_descriptor` (`status='derived'`, `derived_from` JSONB w/ schema_hash for drift detection). Page_id namespace `auto:<source>:<schema>.<table>` keeps auto-pages isolated from hand-seeded pages; `config-exec` validator widened to accept it. UI: Generate App button on Discover Tab table/view rows → fires `open-auto-page` event → `App.tsx` swaps to `auto-page` slot, ConfigEngine renders preview. Default landing zone `module:_unmapped` auto-created so orphan auto-pages don't break the module tree. Verified end-to-end by `services/authz-api/src/scripts/bu08-e2e.ts`: happy path (201 + render hints assert per type), 409 idempotency, 412 unscanned-resource precondition, full cleanup. Migration: V048 (descriptor `status` + `derived_at` + `derived_from` columns). **POC scope**: derived descriptors are read-only (override editor lands in Phase 4). Plan: `docs/design-schema-driven-ui.md`.

### Remaining — Infrastructure (Milestone 4 core)
- [~] SEC-06: Production secrets management — code-layer done (06a/b/d/e/f in commit ff7982a, 2026-04-23). Infra-layer remaining: 06c pgbouncer MD5 rotation + Vault/external-secrets wiring. Detail: `backlog-tech-debt.md`.
- [~] Redis L1 cache layer + `authz_check_from_cache()` integration — in-process MVP done 2026-04-23 (FEAT-01: `policy-cache.ts` + `policy-events.ts` LISTEN `authz_policy_changed`, scope `/api/resolve` only). Redis cluster + `/api/check` fast-path remain. Detail: `backlog-tech-debt.md` FEAT-01.
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
| V049 | AUDIT-AI-01: admin-audit columns (actor_type/agent_id/model_id/consent_given) for Constitution §9.7 | Done (commit dac27d6) |
| V050 | audit_home_handler — staged for `audit_home` Tier B page | Untracked (in tree) |
| V044 | Semantic layer: business_term/definition/formula/owner_subject_id/status/blessed_at/by on authz_resource | Done (2026-04-26, self-reviewed promote) |
| V053 | UI render-token registry (icon / status_color / phase_color / gate_color) — RENDER-TOKEN-01 | Done (2026-04-26) |
| V054 | `authz_ui_page.snapshot_data` JSONB + fn_ui_page refresh — DAG-SAVE-PAGE-01 Path A | Done (2026-04-26) |
| V045 (draft) | resource_cascade_policy table (stateless_auto vs stateful_sandbox_30d) | Drafted 2026-04-23, awaiting self-review + promote (depends on V044) |
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
| `design-mining-vision.md` | Data Mining long-term vision | When trigger conditions met |
| `.claude/agents/README.md` | Agent roles (16 agents) + architecture principles | AI-assisted development |
| `.claude/plans/` | Oracle CDC implementation plan (D1-D8) | When starting Oracle support |
| `standards/` | Dev standards, security rules, known risks | Before writing code |
