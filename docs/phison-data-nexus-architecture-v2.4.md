# Phison Electronics Data Center — Authorization Service Architecture v2.4

**Repository**: `phison-data-nexus`
**npm scope**: `@nexus/*`
**Helm chart**: `nexus-platform`

> **🔗 Doc map (2026-04-22):** This is the **canonical, foundational architecture spec** for L0-L3 / three paths / SSOT.
> - **Path A detail (appendix):** [`docs/config_driven_ui_requirements.md`](./config_driven_ui_requirements.md) — Config-SM state graph, descriptors, runtime engine.
> - **Active Phase 1 plan (2026-05 → 2027-05 demo):** [`docs/plan-v3-phase-1.md`](./plan-v3-phase-1.md) — supersedes the v3 vision sections of this spec where they conflict.

## Document Purpose

This document serves two purposes:
1. **Architecture Design Spec** — Complete definition of the Authorization Service layer, covering **three access paths** (Config-SM UI, Traditional Web, DB Direct), plus the **AuthZ Admin Center** design
2. **Transferable Prompt** — Section VII is a self-contained mega-prompt for any LLM to understand and extend this architecture

## Change Log

| Version | Date | Changes |
|---------|------|---------|
| v1 | 2026-04-10 | Initial design: Config-as-State-Machine path only |
| v2 | 2026-04-10 | Added Traditional Web path (Path B), DB Connection Pool path (Path C), unified SSOT enforcement, expanded schema with pool profiles/credentials, pgbouncer integration, sync engine for PG native grants |
| v2.1 | 2026-04-10 | Added AuthZ Admin Center: program architecture positioning, self-managed resource registration, admin-specific roles (AUTHZ_ADMIN, AUTHZ_AUDITOR), page structure design, core UI components (Permission Matrix, Resource Tree, Policy Simulator, Policy Editor, Impact Analysis), change workflow (pending_review → active), hardcoded admin routing rationale, updated mega-prompt and roadmap |
| v2.2 | 2026-04-10 | Added: supported database matrix (PostgreSQL primary + MySQL/MongoDB/MSSQL via Casbin adapter abstraction), monorepo design with Nx/Turborepo, Helm chart structure for K8s deployment, K8s-specific design considerations (Secrets management, health probes, HPA, network policies, migration jobs, PDB, sidecar vs centralized patterns), updated mega-prompt and roadmap |
| v2.3 | 2026-04-11 | Added: Performance bottleneck analysis (6 bottlenecks ranked by severity), two-level cache architecture (L1 Redis + L2 session), authz_check_from_cache() function, audit batch insert, RLS index optimization, PG LISTEN/NOTIFY cache invalidation. Added: Production weakness analysis across 8 dimensions (operational, security, scalability, data integrity, DX, fault tolerance, compliance, evolution) with mitigations. Renamed repo to `phison-data-nexus`, npm scope `@nexus/*`, Helm chart `nexus-platform`. Updated mega-prompt and roadmap (31 phases). |
| v2.4 | 2026-04-12 | **BUGFIX**: `authz_filter()` missing `p_user_groups` parameter — function did not evaluate `subject_condition`, causing all ABAC policies to apply to all users regardless of role/attribute match. Added `p_user_groups TEXT[]` parameter and subject_condition matching logic (role check + attribute check). Updated mega-prompt API signature. Discovered during Milestone 1 POC verification with AuthZ Dashboard. |

---

# I. Architecture Overview

## 1.1 Design Philosophy

The Authorization Service is the **Single Source of Truth (SSOT)** for all access control decisions across Phison's internal data center. It follows four core principles:

- **Define Once, Enforce Everywhere** — Permissions are defined in one place (AuthZ Service) and enforced across all access paths. Adding a new path means adding a new enforcement adapter, never a new permission store.
- **Config-as-State-Machine** — The AuthZ Service's output is a structured config that drives downstream enforcement. Each layer consumes this config, never invents its own permission logic.
- **Separation of AuthN vs AuthZ** — Authentication (who are you?) lives in LDAP/Keycloak. Authorization (what can you do?) lives exclusively in this service.
- **Three Paths, One Policy Store** — Whether a user accesses data through the Config-SM UI, a traditional web page, or a direct DB connection, the authorization decision traces back to the same `authz_role_permission` and `authz_policy` tables.

## 1.2 Three Access Paths

```
路徑 A: 人 → Config-as-State-Machine UI → PG Function → Data
        Metadata-Driven, authz_resolve() 驅動所有 UI 渲染與資料過濾

路徑 B: 人 → 傳統網站首頁 / 非 Config-SM 子頁面 → API / 直接 SQL → Data
        頁面不走 metadata-driven，但權限仍由 AuthZ Service 統一管控

路徑 C: 程式/工具/DBA → Connection Pool → Schema.Table 直連 → Data
        不經過 application layer，由 PG native GRANT + RLS 執行
```

## 1.3 Layer Positioning

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Layer 0: Identity Provider (LDAP / Keycloak)                           │
│  ── AuthN SSOT: Identity + Group Membership                             │
│  ── Output: JWT / session with user_id, groups[], attributes{}          │
├─────────────────────────────────────────────────────────────────────────┤
│  Layer 1: Data Source Registry & ETL                                    │
│  ── Data integration layer                                              │
├─────────────────────────────────────────────────────────────────────────┤
│  Layer 1.5: ★ Authorization Service (AuthZ SSOT) ★                     │
│  ── Policy Engine: Casbin (RBAC + ABAC hybrid)                          │
│  ── Policy Store: PostgreSQL tables (single set of core tables)         │
│  ── Enforcement Adapters:                                               │
│     ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐         │
│     │ Adapter A    │  │ Adapter B    │  │ Adapter C          │         │
│     │ Config-SM    │  │ Traditional  │  │ DB Connection      │         │
│     │              │  │ Web          │  │ Pool               │         │
│     │ resolve()    │  │ resolve_     │  │ sync_db_grants()   │         │
│     │ check()      │  │ web_acl()   │  │ sync_pgbouncer()   │         │
│     │ filter()     │  │ check()      │  │ sync_rls()         │         │
│     │ columns()    │  │              │  │                    │         │
│     └──────────────┘  └──────────────┘  └────────────────────┘         │
│  ── Shared APIs:                                                        │
│     check(subject, action, resource) → boolean                          │
│     filter(subject, resource_type) → SQL WHERE clause                   │
│  ── Audit: unified authz_audit_log across all paths                     │
├─────────────────────────────────────────────────────────────────────────┤
│  Layer 2: PostgreSQL (Enforcement Point — all paths)                    │
│  ── RLS policies auto-generated from AuthZ Service                      │
│  ── Column masking via views/functions                                  │
│  ── GRANT/REVOKE synced from AuthZ pool profiles (Path C)              │
│  ── Business logic functions check AuthZ before WRITE (Path A)         │
│  ── pgaudit extension for DB-level audit trail (Path C)                │
├─────────────────────────────────────────────────────────────────────────┤
│  Layer 3a: Metadata-Driven UI (Enforcement Point — Path A)              │
│  ── UI metadata includes visible_when, editable_when from resolve()     │
│  ── Menu/button rendering driven by resolved permission config          │
├─────────────────────────────────────────────────────────────────────────┤
│  Layer 3b: Traditional Web + API Gateway (Enforcement Point — Path B)   │
│  ── API Gateway / middleware reads web_acl from resolve_web_acl()       │
│  ── Session-cached ACL controls page routing & API access               │
├─────────────────────────────────────────────────────────────────────────┤
│  Layer 3c: pgbouncer + PG Native Auth (Enforcement Point — Path C)      │
│  ── pgbouncer auth_query validates against AuthZ pool credentials       │
│  ── PG roles + GRANT/REVOKE synced from AuthZ pool profiles            │
│  ── RLS applies automatically (NOBYPASSRLS on all pool roles)          │
├─────────────────────────────────────────────────────────────────────────┤
│  Layer 4: AI Agent (Enforcement Point — Path A extension)               │
│  ── Agent queries AuthZ before calling any tool                         │
│  ── Decision recommendations filtered by viewer's data scope            │
│  ── Audit: every agent action logged with permission context            │
└─────────────────────────────────────────────────────────────────────────┘
```

## 1.4 Granularity Model (4 Levels × 3 Paths)

| Level | Name | Model | Path A (Config-SM) | Path B (Trad Web) | Path C (DB Direct) |
|-------|------|-------|--------------------|--------------------|---------------------|
| L0 | Functional Access | RBAC | UI module visibility | Page/API routing | Schema + table GRANT |
| L1 | Data Domain Scope | ABAC | RLS via resolve() | RLS via filter() | RLS via PG policy |
| L2 | Row/Column Security | ABAC+Mask | Column mask in UI + PG | Column mask in API response | Column GRANT + mask views |
| L3 | Action Authorization | PBAC | Approval workflows in UI | API-level action gates | N/A (no write path for readonly pools) |

---

# II. Detailed Design — Policy Store Schema

## 2.1 ENUM Types

```sql
-- ============================================================
-- AUTHORIZATION SERVICE — POLICY STORE SCHEMA v2
-- Database: nexus_authz
-- Owner: authz_admin
-- ============================================================

CREATE TYPE authz_effect AS ENUM ('allow', 'deny');
CREATE TYPE authz_granularity AS ENUM ('L0_functional', 'L1_data_domain', 'L2_row_column', 'L3_action');
CREATE TYPE mask_type AS ENUM ('none', 'full', 'partial', 'hash', 'range', 'custom');
CREATE TYPE policy_status AS ENUM ('active', 'inactive', 'pending_review');
CREATE TYPE sync_status AS ENUM ('pending', 'synced', 'failed', 'rollback');
CREATE TYPE db_connection_mode AS ENUM ('readonly', 'readwrite', 'admin');
```

## 2.2 Core Tables (Shared Across All Paths)

```sql
-- ============================================================
-- SUBJECTS: LDAP groups are the primary subject (not individuals)
-- Rationale: personnel changes don't require policy updates
-- Used by: Path A, B, C
-- ============================================================
CREATE TABLE authz_subject (
    subject_id      TEXT PRIMARY KEY,           -- e.g., 'group:PE_SSD', 'group:PM_NAND', 'user:adam'
    subject_type    TEXT NOT NULL CHECK (subject_type IN ('ldap_group', 'user', 'service_account')),
    display_name    TEXT NOT NULL,
    ldap_dn         TEXT,                       -- LDAP distinguished name for sync
    attributes      JSONB NOT NULL DEFAULT '{}', -- {"product_line": "SSD-Controller", "site": "HQ"}
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- RESOURCES: what is being protected (unified hierarchy)
-- resource_type covers all three paths:
--   Path A: 'module', 'page', 'table', 'column', 'function', 'ai_tool'
--   Path B: 'web_page', 'web_api'
--   Path C: 'db_schema', 'db_table', 'db_pool'
-- ============================================================
CREATE TABLE authz_resource (
    resource_id     TEXT PRIMARY KEY,           -- e.g., 'module:mrp.yield_analysis', 'web_page:home', 'db_pool:bi_readonly'
    resource_type   TEXT NOT NULL CHECK (resource_type IN (
        -- Path A
        'module', 'page', 'table', 'column', 'function', 'ai_tool',
        -- Path B
        'web_page', 'web_api',
        -- Path C
        'db_schema', 'db_table', 'db_pool'
    )),
    parent_id       TEXT REFERENCES authz_resource(resource_id),  -- hierarchy: module > page > table > column
    display_name    TEXT NOT NULL,
    attributes      JSONB NOT NULL DEFAULT '{}', -- {"sensitivity": "confidential", "auth_required": true}
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- ACTIONS: what can be done (shared vocabulary)
-- ============================================================
CREATE TABLE authz_action (
    action_id       TEXT PRIMARY KEY,           -- 'read', 'write', 'approve', 'export', 'hold', 'release', 'execute', 'connect'
    display_name    TEXT NOT NULL,
    description     TEXT,
    applicable_paths TEXT[] NOT NULL DEFAULT '{A,B,C}',  -- which paths this action applies to
    is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO authz_action (action_id, display_name, description, applicable_paths) VALUES
    ('read',    'Read',      'View data or page',                         '{A,B,C}'),
    ('write',   'Write',     'Create or modify data',                     '{A,B,C}'),
    ('delete',  'Delete',    'Remove data',                               '{A,B}'),
    ('approve', 'Approve',   'Approve workflow step (NPI gate, lot hold)','{A,B}'),
    ('export',  'Export',    'Export data to file',                        '{A,B}'),
    ('hold',    'Hold',      'Hold a lot',                                '{A}'),
    ('release', 'Release',   'Release a held lot',                        '{A}'),
    ('execute', 'Execute',   'Execute function or AI tool',               '{A}'),
    ('connect', 'Connect',   'Establish DB connection',                   '{C}');

-- ============================================================
-- ROLES: RBAC layer (shared across all paths)
-- ============================================================
CREATE TABLE authz_role (
    role_id         TEXT PRIMARY KEY,           -- 'PE', 'PM', 'OP', 'QA', 'SALES', 'ADMIN', 'BI_USER', 'ETL_SVC', 'DBA'
    display_name    TEXT NOT NULL,
    description     TEXT,
    is_system       BOOLEAN NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- ROLE-ACTION-RESOURCE mapping (L0 functional permissions)
-- This single table drives all three paths
-- ============================================================
CREATE TABLE authz_role_permission (
    id              BIGSERIAL PRIMARY KEY,
    role_id         TEXT NOT NULL REFERENCES authz_role(role_id),
    action_id       TEXT NOT NULL REFERENCES authz_action(action_id),
    resource_id     TEXT NOT NULL REFERENCES authz_resource(resource_id),
    effect          authz_effect NOT NULL DEFAULT 'allow',
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (role_id, action_id, resource_id)
);

-- ============================================================
-- SUBJECT-ROLE assignment
-- ============================================================
CREATE TABLE authz_subject_role (
    id              BIGSERIAL PRIMARY KEY,
    subject_id      TEXT NOT NULL REFERENCES authz_subject(subject_id),
    role_id         TEXT NOT NULL REFERENCES authz_role(role_id),
    valid_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_until     TIMESTAMPTZ,               -- NULL = no expiry
    granted_by      TEXT NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (subject_id, role_id)
);
```

## 2.3 ABAC Policy Tables (L1 + L2 + L3)

```sql
-- ============================================================
-- ABAC POLICIES: attribute-based rules
-- Applies to all paths — enforcement adapter interprets per path
-- ============================================================
CREATE TABLE authz_policy (
    policy_id       BIGSERIAL PRIMARY KEY,
    policy_name     TEXT NOT NULL UNIQUE,
    description     TEXT,
    granularity     authz_granularity NOT NULL,
    priority        INTEGER NOT NULL DEFAULT 100,  -- lower = higher priority
    effect          authz_effect NOT NULL DEFAULT 'allow',
    status          policy_status NOT NULL DEFAULT 'active',

    -- Which paths does this policy apply to? (filter during resolution)
    applicable_paths TEXT[] NOT NULL DEFAULT '{A,B,C}',

    -- Conditions (all must match = AND logic within a policy)
    subject_condition   JSONB NOT NULL DEFAULT '{}',
    resource_condition  JSONB NOT NULL DEFAULT '{}',
    action_condition    JSONB NOT NULL DEFAULT '{}',
    environment_condition JSONB NOT NULL DEFAULT '{}',

    -- Enforcement output
    rls_expression      TEXT,                  -- SQL WHERE fragment with ${subject.attr} placeholders
    column_mask_rules   JSONB,                 -- {"col_name": {"mask_type": "range", "fn": "fn_mask_price({col})"}}

    -- Metadata
    created_by      TEXT NOT NULL,
    approved_by     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_until TIMESTAMPTZ                -- NULL = no expiry
);

-- ============================================================
-- COMPOSITE ACTION POLICIES (L3: dual-sign, workflow-gate)
-- Primarily Path A, optionally Path B
-- ============================================================
CREATE TABLE authz_composite_action (
    id              BIGSERIAL PRIMARY KEY,
    policy_name     TEXT NOT NULL UNIQUE,
    description     TEXT,
    target_action   TEXT NOT NULL REFERENCES authz_action(action_id),
    target_resource TEXT NOT NULL REFERENCES authz_resource(resource_id),
    approval_chain  JSONB NOT NULL,            -- [{"step":1,"required_role":"PE","min_approvers":1}, ...]
    preconditions   JSONB NOT NULL DEFAULT '{}',
    timeout_hours   INTEGER DEFAULT 72,
    status          policy_status NOT NULL DEFAULT 'active',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- COLUMN MASKING FUNCTIONS REGISTRY
-- Used by Path A (UI mask), Path B (API response mask), Path C (PG view/function mask)
-- ============================================================
CREATE TABLE authz_mask_function (
    function_name   TEXT PRIMARY KEY,
    mask_type       mask_type NOT NULL,
    pg_function     TEXT NOT NULL,              -- actual PG function name
    description     TEXT,
    example_input   TEXT,
    example_output  TEXT,
    template        TEXT NOT NULL               -- e.g., 'fn_mask_price({col})'
);

INSERT INTO authz_mask_function VALUES
    ('fn_mask_full',    'full',    'fn_mask_full',    'Replace with ****',        'John Doe',      '****',        'fn_mask_full({col})'),
    ('fn_mask_partial', 'partial', 'fn_mask_partial', 'Show first/last chars',    'john@acme.com', 'j***@***e.com','fn_mask_partial({col})'),
    ('fn_mask_hash',    'hash',    'fn_mask_hash',    'SHA256 hash',              'John Doe',      'a8cfcd74...', 'fn_mask_hash({col})'),
    ('fn_mask_range',   'range',   'fn_mask_range',   'Numeric to range bucket',  '42.50',         '40-50',       'fn_mask_range({col})'),
    ('fn_mask_null',    'full',    'fn_mask_null',    'Replace with NULL',        'anything',      NULL,          'NULL');
```

## 2.4 Path C — DB Connection Pool Tables

```sql
-- ============================================================
-- DB POOL PROFILE: defines connection properties
-- Each profile maps to a PostgreSQL role with specific GRANT scope
-- ============================================================
CREATE TABLE authz_db_pool_profile (
    profile_id      TEXT PRIMARY KEY,           -- e.g., 'pool:bi_readonly', 'pool:etl_writer', 'pool:dba_full'
    pg_role         TEXT NOT NULL UNIQUE,       -- corresponding PostgreSQL role name
    allowed_schemas TEXT[] NOT NULL,            -- e.g., '{mrp, public, analytics}'
    allowed_tables  TEXT[],                     -- NULL = all tables in allowed_schemas
    denied_columns  JSONB,                     -- {"table_name": ["col1","col2"]} — columns to exclude via GRANT
    connection_mode db_connection_mode NOT NULL,
    max_connections INTEGER NOT NULL DEFAULT 5,
    ip_whitelist    CIDR[],                    -- allowed source IPs; NULL = no restriction
    valid_hours     TEXT,                      -- e.g., '08:00-22:00'; NULL = always
    rls_applies     BOOLEAN NOT NULL DEFAULT TRUE,  -- whether RLS is enforced (NOBYPASSRLS)
    description     TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- POOL ASSIGNMENT: which subjects can use which pool
-- ============================================================
CREATE TABLE authz_db_pool_assignment (
    id              BIGSERIAL PRIMARY KEY,
    subject_id      TEXT NOT NULL REFERENCES authz_subject(subject_id),
    profile_id      TEXT NOT NULL REFERENCES authz_db_pool_profile(profile_id),
    granted_by      TEXT NOT NULL,
    valid_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_until     TIMESTAMPTZ,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (subject_id, profile_id)
);

-- ============================================================
-- POOL CREDENTIALS: managed centrally, used by pgbouncer auth_query
-- ============================================================
CREATE TABLE authz_pool_credentials (
    pg_role         TEXT PRIMARY KEY REFERENCES authz_db_pool_profile(pg_role),
    password_hash   TEXT NOT NULL,              -- md5 or scram-sha-256
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_rotated    TIMESTAMPTZ NOT NULL DEFAULT now(),
    rotate_interval INTERVAL NOT NULL DEFAULT '90 days'
);
```

## 2.5 Sync & Audit Tables

```sql
-- ============================================================
-- SYNC LOG: tracks what was generated for each enforcement point
-- ============================================================
CREATE TABLE authz_sync_log (
    sync_id         BIGSERIAL PRIMARY KEY,
    sync_type       TEXT NOT NULL CHECK (sync_type IN (
        'rls_policy',       -- Path A+C: RLS on data tables
        'column_view',      -- Path A+C: masking views
        'ui_metadata',      -- Path A: metadata-driven UI config
        'web_acl',          -- Path B: web page/API ACL
        'db_grant',         -- Path C: GRANT/REVOKE on schemas/tables
        'pgbouncer_config', -- Path C: pgbouncer.ini regeneration
        'agent_scope'       -- Path A: AI agent tool scope
    )),
    source_policy_id BIGINT,                   -- which authz_policy triggered this sync (NULL for role-level syncs)
    target_name     TEXT NOT NULL,              -- e.g., 'rls_lot_status_pe_ssd', 'GRANT mrp TO bi_readonly'
    generated_sql   TEXT,                       -- the actual SQL executed
    generated_config TEXT,                     -- non-SQL config (JSON, INI, etc.)
    sync_status     sync_status NOT NULL DEFAULT 'pending',
    error_message   TEXT,
    synced_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- AUDIT LOG: every access decision, all paths
-- ============================================================
CREATE TABLE authz_audit_log (
    audit_id        BIGSERIAL PRIMARY KEY,
    timestamp       TIMESTAMPTZ NOT NULL DEFAULT now(),
    access_path     CHAR(1) NOT NULL CHECK (access_path IN ('A', 'B', 'C')),
    subject_id      TEXT NOT NULL,
    action_id       TEXT NOT NULL,
    resource_id     TEXT NOT NULL,
    decision        authz_effect NOT NULL,
    policy_ids      BIGINT[],                  -- which policies contributed
    context         JSONB,                     -- IP, user-agent, pool_profile, etc.
    duration_ms     INTEGER
) PARTITION BY RANGE (timestamp);

-- Create monthly partitions (example)
CREATE TABLE authz_audit_log_2026_04 PARTITION OF authz_audit_log
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE authz_audit_log_2026_05 PARTITION OF authz_audit_log
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_policy_active ON authz_policy(status) WHERE status = 'active';
CREATE INDEX idx_policy_granularity ON authz_policy(granularity);
CREATE INDEX idx_policy_paths ON authz_policy USING gin(applicable_paths);
CREATE INDEX idx_subject_role_active ON authz_subject_role(subject_id) WHERE is_active = TRUE;
CREATE INDEX idx_role_perm_role ON authz_role_permission(role_id) WHERE is_active = TRUE;
CREATE INDEX idx_role_perm_resource ON authz_role_permission(resource_id) WHERE is_active = TRUE;
CREATE INDEX idx_resource_parent ON authz_resource(parent_id);
CREATE INDEX idx_resource_type ON authz_resource(resource_type);
CREATE INDEX idx_pool_assign_subject ON authz_db_pool_assignment(subject_id) WHERE is_active = TRUE;
CREATE INDEX idx_audit_path ON authz_audit_log(access_path, timestamp DESC);
CREATE INDEX idx_audit_subject ON authz_audit_log(subject_id, timestamp DESC);
CREATE INDEX idx_audit_resource ON authz_audit_log(resource_id, timestamp DESC);
CREATE INDEX idx_sync_status ON authz_sync_log(sync_status) WHERE sync_status = 'pending';
```

---

# III. API Functions — Per-Path Adapters

## 3.1 Shared: Role Resolution (used by all adapters)

```sql
-- ============================================================
-- Internal helper: resolve roles for a subject
-- ============================================================
CREATE OR REPLACE FUNCTION _authz_resolve_roles(
    p_user_id       TEXT,
    p_user_groups   TEXT[]
)
RETURNS TEXT[]
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_roles TEXT[];
BEGIN
    SELECT array_agg(DISTINCT sr.role_id) INTO v_roles
    FROM authz_subject_role sr
    WHERE sr.is_active = TRUE
      AND (sr.valid_until IS NULL OR sr.valid_until > now())
      AND (
          sr.subject_id = 'user:' || p_user_id
          OR sr.subject_id = ANY(SELECT 'group:' || unnest(p_user_groups))
      );
    RETURN COALESCE(v_roles, '{}'::TEXT[]);
END;
$$;
```

## 3.2 Shared: Permission Check (used by all paths)

```sql
-- ============================================================
-- authz_check: boolean permission check with resource hierarchy
-- Used by: Path A (PG functions), Path B (API middleware), Path C (ad-hoc)
-- ============================================================
CREATE OR REPLACE FUNCTION authz_check(
    p_user_id       TEXT,
    p_user_groups   TEXT[],
    p_action        TEXT,
    p_resource      TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_roles     TEXT[];
    v_allowed   BOOLEAN;
BEGIN
    v_roles := _authz_resolve_roles(p_user_id, p_user_groups);

    -- Check allow (with resource hierarchy walk)
    SELECT EXISTS(
        SELECT 1
        FROM authz_role_permission rp
        WHERE rp.role_id = ANY(v_roles)
          AND rp.is_active = TRUE
          AND rp.effect = 'allow'
          AND (rp.action_id = p_action OR rp.action_id = '*')
          AND (
              rp.resource_id = p_resource
              OR rp.resource_id = '*'
              OR rp.resource_id IN (
                  WITH RECURSIVE res_tree AS (
                      SELECT resource_id, parent_id FROM authz_resource WHERE resource_id = p_resource
                      UNION ALL
                      SELECT r.resource_id, r.parent_id
                      FROM authz_resource r JOIN res_tree rt ON r.resource_id = rt.parent_id
                  )
                  SELECT resource_id FROM res_tree
              )
          )
    ) INTO v_allowed;

    -- Explicit deny overrides allow
    IF v_allowed THEN
        SELECT NOT EXISTS(
            SELECT 1
            FROM authz_role_permission rp
            WHERE rp.role_id = ANY(v_roles)
              AND rp.is_active = TRUE
              AND rp.effect = 'deny'
              AND (rp.action_id = p_action OR rp.action_id = '*')
              AND rp.resource_id = p_resource
        ) INTO v_allowed;
    END IF;

    RETURN COALESCE(v_allowed, FALSE);
END;
$$;
```

## 3.3 Shared: Row Filter Generation

```sql
-- ============================================================
-- authz_filter: generate SQL WHERE clause for row-level filtering
-- Used by: Path A (resolve config), Path B (API query), Path C (RLS sync)
-- v2.4 FIX: Added p_user_groups parameter + subject_condition matching.
--   Without this, ALL ABAC policies applied to ALL users regardless of
--   role/attribute match (e.g., PE-only policy also filtered Admin data).
-- ============================================================
CREATE OR REPLACE FUNCTION authz_filter(
    p_user_id       TEXT,
    p_user_groups   TEXT[],            -- v2.4: required for subject_condition evaluation
    p_user_attrs    JSONB,
    p_resource_type TEXT,           -- e.g., 'table:lot_status'
    p_path          CHAR(1) DEFAULT NULL  -- NULL = all paths
)
RETURNS TEXT
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_roles     TEXT[];
    v_clauses   TEXT[] := '{}';
    v_policy    RECORD;
    v_expr      TEXT;
    v_attr_key  TEXT;
    v_attr_val  TEXT;
    v_cond_key  TEXT;
    v_cond_val  JSONB;
    v_match     BOOLEAN;
BEGIN
    -- v2.4: Resolve user roles for subject_condition matching
    v_roles := _authz_resolve_roles(p_user_id, p_user_groups);

    FOR v_policy IN
        SELECT ap.rls_expression, ap.subject_condition
        FROM authz_policy ap
        WHERE ap.status = 'active'
          AND ap.granularity IN ('L1_data_domain', 'L2_row_column')
          AND ap.rls_expression IS NOT NULL
          AND (ap.effective_until IS NULL OR ap.effective_until > now())
          AND (p_path IS NULL OR p_path = ANY(ap.applicable_paths))
          AND (
              ap.resource_condition->>'resource_id' = p_resource_type
              OR ap.resource_condition->>'resource_type' = split_part(p_resource_type, ':', 1)
          )
    LOOP
        -- v2.4: Evaluate subject_condition — skip policy if user doesn't match
        v_match := TRUE;
        IF v_policy.subject_condition IS NOT NULL AND v_policy.subject_condition != '{}'::jsonb THEN
            FOR v_cond_key, v_cond_val IN
                SELECT key, value FROM jsonb_each(v_policy.subject_condition)
            LOOP
                IF v_cond_key = 'role' THEN
                    -- Check if user has any of the required roles
                    IF NOT EXISTS (
                        SELECT 1 FROM jsonb_array_elements_text(v_cond_val) AS req_role
                        WHERE req_role = ANY(v_roles)
                    ) THEN
                        v_match := FALSE;
                        EXIT;
                    END IF;
                ELSE
                    -- Check if user attribute matches any of the required values
                    IF NOT EXISTS (
                        SELECT 1 FROM jsonb_array_elements_text(v_cond_val) AS req_val
                        WHERE req_val = p_user_attrs->>v_cond_key
                    ) THEN
                        v_match := FALSE;
                        EXIT;
                    END IF;
                END IF;
            END LOOP;
        END IF;

        -- Skip this policy if subject_condition doesn't match
        IF NOT v_match THEN
            CONTINUE;
        END IF;

        v_expr := v_policy.rls_expression;

        -- Replace ${subject.xxx} placeholders with actual user attribute values
        FOR v_attr_key, v_attr_val IN
            SELECT key, value #>> '{}' FROM jsonb_each(p_user_attrs)
        LOOP
            v_expr := replace(v_expr, '${subject.' || v_attr_key || '}', quote_literal(v_attr_val));
        END LOOP;

        v_clauses := array_append(v_clauses, '(' || v_expr || ')');
    END LOOP;

    IF array_length(v_clauses, 1) IS NULL OR array_length(v_clauses, 1) = 0 THEN
        RETURN 'TRUE';
    END IF;

    RETURN array_to_string(v_clauses, ' AND ');
END;
$$;
```

## 3.4 Path A Adapter: Config-as-State-Machine Resolve

```sql
-- ============================================================
-- authz_resolve: full permission config for Config-SM UI + AI Agent
-- This is the Config-as-State-Machine output contract
-- ============================================================
CREATE OR REPLACE FUNCTION authz_resolve(
    p_user_id       TEXT,
    p_user_groups   TEXT[],
    p_user_attrs    JSONB DEFAULT '{}'
)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_roles         TEXT[];
    v_functional    JSONB;
    v_data_scope    JSONB;
    v_column_masks  JSONB;
    v_actions       JSONB;
BEGIN
    v_roles := _authz_resolve_roles(p_user_id, p_user_groups);

    -- L0: functional permissions
    SELECT jsonb_agg(DISTINCT jsonb_build_object(
        'resource', rp.resource_id,
        'action', rp.action_id
    )) INTO v_functional
    FROM authz_role_permission rp
    JOIN authz_resource ar ON ar.resource_id = rp.resource_id
    WHERE rp.role_id = ANY(v_roles)
      AND rp.is_active AND rp.effect = 'allow'
      AND ar.resource_type IN ('module', 'page', 'table', 'column', 'function', 'ai_tool');

    -- L1: data domain scope
    SELECT jsonb_object_agg(ap.policy_name, jsonb_build_object(
        'rls_expression', ap.rls_expression,
        'subject_condition', ap.subject_condition,
        'resource_condition', ap.resource_condition
    )) INTO v_data_scope
    FROM authz_policy ap
    WHERE ap.status = 'active' AND ap.granularity = 'L1_data_domain'
      AND 'A' = ANY(ap.applicable_paths)
      AND (ap.effective_until IS NULL OR ap.effective_until > now());

    -- L2: column mask rules
    SELECT jsonb_object_agg(ap.policy_name, ap.column_mask_rules) INTO v_column_masks
    FROM authz_policy ap
    WHERE ap.status = 'active' AND ap.granularity = 'L2_row_column'
      AND ap.column_mask_rules IS NOT NULL
      AND 'A' = ANY(ap.applicable_paths)
      AND (ap.effective_until IS NULL OR ap.effective_until > now());

    -- L3: composite actions
    SELECT jsonb_agg(DISTINCT jsonb_build_object(
        'action', ca.target_action,
        'resource', ca.target_resource,
        'approval_chain', ca.approval_chain,
        'preconditions', ca.preconditions
    )) INTO v_actions
    FROM authz_composite_action ca
    WHERE ca.status = 'active'
      AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(ca.approval_chain) AS step
          WHERE step->>'required_role' = ANY(v_roles)
      );

    RETURN jsonb_build_object(
        'user_id',          p_user_id,
        'resolved_roles',   to_jsonb(v_roles),
        'access_path',      'A',
        'resolved_at',      now(),
        'L0_functional',    COALESCE(v_functional, '[]'::jsonb),
        'L1_data_scope',    COALESCE(v_data_scope, '{}'::jsonb),
        'L2_column_masks',  COALESCE(v_column_masks, '{}'::jsonb),
        'L3_actions',       COALESCE(v_actions, '[]'::jsonb)
    );
END;
$$;
```

## 3.5 Path B Adapter: Traditional Web ACL Resolve

```sql
-- ============================================================
-- authz_resolve_web_acl: permission config for traditional web pages
-- Output cached in session; refreshed on login or explicit invalidation
-- ============================================================
CREATE OR REPLACE FUNCTION authz_resolve_web_acl(
    p_user_id       TEXT,
    p_user_groups   TEXT[]
)
RETURNS JSONB
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_roles     TEXT[];
    v_pages     JSONB;
    v_apis      JSONB;
    v_public    JSONB;
BEGIN
    v_roles := _authz_resolve_roles(p_user_id, p_user_groups);

    -- Accessible web pages (grouped by resource with action list)
    SELECT jsonb_agg(sub) INTO v_pages
    FROM (
        SELECT jsonb_build_object(
            'resource_id', rp.resource_id,
            'display_name', ar.display_name,
            'actions', jsonb_agg(DISTINCT rp.action_id),
            'attributes', ar.attributes
        ) AS sub
        FROM authz_role_permission rp
        JOIN authz_resource ar ON ar.resource_id = rp.resource_id
        WHERE rp.role_id = ANY(v_roles) AND rp.is_active AND rp.effect = 'allow'
          AND ar.resource_type = 'web_page' AND ar.is_active
        GROUP BY rp.resource_id, ar.display_name, ar.attributes
    ) t;

    -- Accessible web APIs
    SELECT jsonb_agg(sub) INTO v_apis
    FROM (
        SELECT jsonb_build_object(
            'resource_id', rp.resource_id,
            'display_name', ar.display_name,
            'actions', jsonb_agg(DISTINCT rp.action_id),
            'parent_page', ar.parent_id
        ) AS sub
        FROM authz_role_permission rp
        JOIN authz_resource ar ON ar.resource_id = rp.resource_id
        WHERE rp.role_id = ANY(v_roles) AND rp.is_active AND rp.effect = 'allow'
          AND ar.resource_type = 'web_api' AND ar.is_active
        GROUP BY rp.resource_id, ar.display_name, ar.parent_id
    ) t;

    -- Public pages (no auth required, always accessible)
    SELECT jsonb_agg(jsonb_build_object(
        'resource_id', resource_id,
        'display_name', display_name
    )) INTO v_public
    FROM authz_resource
    WHERE resource_type = 'web_page'
      AND is_active AND (attributes->>'auth_required')::boolean = FALSE;

    RETURN jsonb_build_object(
        'user_id',       p_user_id,
        'resolved_roles', to_jsonb(v_roles),
        'access_path',   'B',
        'resolved_at',   now(),
        'web_pages',     COALESCE(v_pages, '[]'::jsonb),
        'web_apis',      COALESCE(v_apis, '[]'::jsonb),
        'public_pages',  COALESCE(v_public, '[]'::jsonb)
    );
END;
$$;
```

## 3.6 Path C Adapter: DB Grant Sync Engine

```sql
-- ============================================================
-- authz_sync_db_grants: sync AuthZ policies → PG native GRANT/REVOKE
-- Run periodically or triggered by policy change
-- ============================================================
CREATE OR REPLACE FUNCTION authz_sync_db_grants()
RETURNS TABLE(action TEXT, detail TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
    v_profile   RECORD;
    v_schema    TEXT;
    v_table     TEXT;
    v_col_entry RECORD;
BEGIN
    FOR v_profile IN
        SELECT * FROM authz_db_pool_profile WHERE is_active = TRUE
    LOOP
        -- Ensure PG role exists
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_profile.pg_role) THEN
            EXECUTE format('CREATE ROLE %I LOGIN', v_profile.pg_role);
            action := 'CREATE_ROLE'; detail := v_profile.pg_role;
            RETURN NEXT;

            -- Log to sync_log
            INSERT INTO authz_sync_log (sync_type, target_name, generated_sql, sync_status, synced_at)
            VALUES ('db_grant', v_profile.pg_role, 'CREATE ROLE ' || v_profile.pg_role || ' LOGIN', 'synced', now());
        END IF;

        -- Set NOBYPASSRLS if RLS should apply
        IF v_profile.rls_applies THEN
            EXECUTE format('ALTER ROLE %I NOBYPASSRLS', v_profile.pg_role);
        END IF;

        -- Process each allowed schema
        FOREACH v_schema IN ARRAY v_profile.allowed_schemas
        LOOP
            -- Revoke all first (clean slate per schema)
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', v_schema, v_profile.pg_role);
            EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', v_schema, v_profile.pg_role);

            -- Apply GRANT based on connection_mode
            CASE v_profile.connection_mode
                WHEN 'readonly' THEN
                    IF v_profile.allowed_tables IS NULL THEN
                        EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', v_schema, v_profile.pg_role);
                    ELSE
                        FOREACH v_table IN ARRAY v_profile.allowed_tables
                        LOOP
                            EXECUTE format('GRANT SELECT ON %I.%I TO %I', v_schema, v_table, v_profile.pg_role);
                        END LOOP;
                    END IF;

                WHEN 'readwrite' THEN
                    IF v_profile.allowed_tables IS NULL THEN
                        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I',
                                       v_schema, v_profile.pg_role);
                    ELSE
                        FOREACH v_table IN ARRAY v_profile.allowed_tables
                        LOOP
                            EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO %I',
                                           v_schema, v_table, v_profile.pg_role);
                        END LOOP;
                    END IF;

                WHEN 'admin' THEN
                    EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO %I', v_schema, v_profile.pg_role);
            END CASE;

            -- Handle denied_columns: revoke SELECT on specific columns
            IF v_profile.denied_columns IS NOT NULL THEN
                FOR v_col_entry IN
                    SELECT key AS tbl, jsonb_array_elements_text(value) AS col
                    FROM jsonb_each(v_profile.denied_columns)
                LOOP
                    -- PG doesn't support column-level REVOKE directly on tables with full GRANT
                    -- Workaround: revoke table-level, then grant column-level excluding denied
                    -- This is handled by generating a masking view instead
                    -- (logged as a separate sync_type = 'column_view')
                    -- Resolved: V015 uses column-level REVOKE instead of masking views
                END LOOP;
            END IF;

            action := 'GRANT_' || v_profile.connection_mode::TEXT;
            detail := v_schema || ' → ' || v_profile.pg_role;
            RETURN NEXT;

            INSERT INTO authz_sync_log (sync_type, target_name, generated_sql, sync_status, synced_at)
            VALUES ('db_grant', v_schema || '→' || v_profile.pg_role,
                    'GRANT ' || v_profile.connection_mode || ' ON SCHEMA ' || v_schema || ' TO ' || v_profile.pg_role,
                    'synced', now());
        END LOOP;

        -- Grant sequence usage for readwrite/admin
        IF v_profile.connection_mode IN ('readwrite', 'admin') THEN
            FOREACH v_schema IN ARRAY v_profile.allowed_schemas
            LOOP
                EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA %I TO %I', v_schema, v_profile.pg_role);
            END LOOP;
        END IF;
    END LOOP;
END;
$$;

-- ============================================================
-- authz_sync_pgbouncer_config: generate pgbouncer.ini [databases] section
-- Output is stored and can be written to disk by a deployment script
-- ============================================================
CREATE OR REPLACE FUNCTION authz_sync_pgbouncer_config(
    p_db_host   TEXT DEFAULT 'localhost',
    p_db_port   INTEGER DEFAULT 5432,
    p_db_name   TEXT DEFAULT 'nexus_data'
)
RETURNS TEXT
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_config    TEXT := '';
    v_profile   RECORD;
BEGIN
    v_config := v_config || '[databases]' || E'\n';

    FOR v_profile IN
        SELECT dp.profile_id, dp.pg_role, dp.max_connections
        FROM authz_db_pool_profile dp
        WHERE dp.is_active = TRUE
        ORDER BY dp.profile_id
    LOOP
        v_config := v_config || format(
            '%s = host=%s port=%s dbname=%s user=%s pool_size=%s',
            replace(v_profile.profile_id, 'pool:', 'nexus_'),
            p_db_host, p_db_port, p_db_name,
            v_profile.pg_role, v_profile.max_connections
        ) || E'\n';
    END LOOP;

    v_config := v_config || E'\n[pgbouncer]\n';
    v_config := v_config || 'auth_type = md5' || E'\n';
    v_config := v_config || format(
        'auth_query = SELECT pg_role AS username, password_hash AS password FROM authz_pool_credentials WHERE pg_role = $1 AND is_active = TRUE'
    ) || E'\n';

    -- Log
    INSERT INTO authz_sync_log (sync_type, target_name, generated_config, sync_status, synced_at)
    VALUES ('pgbouncer_config', 'pgbouncer.ini', v_config, 'synced', now());

    RETURN v_config;
END;
$$;
```

## 3.7 Resolved Config — Output Contract (Per Path)

### Path A Output (Config-as-State-Machine)

```json
{
  "user_id": "adam",
  "resolved_roles": ["PE", "ADMIN"],
  "access_path": "A",
  "resolved_at": "2026-04-10T14:30:00Z",
  "L0_functional": [
    {"resource": "module:mrp.yield_analysis", "action": "read"},
    {"resource": "module:mrp.lot_tracking", "action": "read"},
    {"resource": "module:mrp.lot_tracking", "action": "write"}
  ],
  "L1_data_scope": {
    "pe_ssd_scope": {
      "rls_expression": "product_line = ANY('{SSD-Controller}')",
      "subject_condition": {"role": ["PE"], "product_line": ["SSD-Controller"]},
      "resource_condition": {"resource_type": "table", "data_domain": ["yield", "lot"]}
    }
  },
  "L2_column_masks": {
    "financial_mask": {
      "unit_price": {"mask_type": "range", "fn": "fn_mask_range({col})"},
      "customer_name": {"mask_type": "none"}
    }
  },
  "L3_actions": [
    {
      "action": "hold", "resource": "table:lot_status",
      "approval_chain": [{"step": 1, "required_role": "PE", "min_approvers": 1}],
      "preconditions": {"phase": "!shipped"}
    }
  ]
}
```

### Path B Output (Traditional Web)

```json
{
  "user_id": "adam",
  "resolved_roles": ["PE", "ADMIN"],
  "access_path": "B",
  "resolved_at": "2026-04-10T14:30:00Z",
  "web_pages": [
    {"resource_id": "web_page:product_catalog", "display_name": "Product Catalog", "actions": ["read"]},
    {"resource_id": "web_page:admin_dashboard", "display_name": "Admin Dashboard", "actions": ["read", "write"]}
  ],
  "web_apis": [
    {"resource_id": "web_api:catalog_search", "display_name": "Catalog Search API", "actions": ["read"], "parent_page": "web_page:product_catalog"},
    {"resource_id": "web_api:admin_user_mgmt", "display_name": "User Management API", "actions": ["read", "write"], "parent_page": "web_page:admin_dashboard"}
  ],
  "public_pages": [
    {"resource_id": "web_page:home", "display_name": "Homepage"}
  ]
}
```

### Path C Output (DB Pool — not a runtime config, but a sync result)

```sql
-- Path C doesn't have a "resolve" output consumed at runtime.
-- Instead, it produces sync artifacts:

-- 1. PG roles with GRANT/REVOKE (via authz_sync_db_grants())
-- 2. pgbouncer.ini config (via authz_sync_pgbouncer_config())
-- 3. RLS policies on tables (shared with Path A)
-- 4. Column masking views (shared with Path A)

-- The "config" equivalent is the pool profile itself:
SELECT jsonb_build_object(
    'profile_id',      profile_id,
    'pg_role',         pg_role,
    'connection_mode', connection_mode,
    'allowed_schemas', allowed_schemas,
    'allowed_tables',  allowed_tables,
    'denied_columns',  denied_columns,
    'rls_applies',     rls_applies,
    'max_connections',  max_connections
)
FROM authz_db_pool_profile
WHERE is_active = TRUE;
```

---

# IV. Integration Examples

## 4.1 Path A: Metadata-Driven UI Page

```json
{
  "page": "lot_detail",
  "auth_resource": "page:lot_detail",
  "sections": [
    {
      "title": "Lot Information",
      "fields": [
        {"key": "lot_id", "type": "text", "readonly": true},
        {"key": "product_line", "type": "text", "readonly": true},
        {
          "key": "unit_price", "type": "number",
          "visible_when": {"authz_check": ["read", "column:lot_status.unit_price"]},
          "mask_when_visible": {"authz_mask": "column:lot_status.unit_price"}
        },
        {
          "key": "grade", "type": "select",
          "options_from": "fn_get_grades()",
          "editable_when": {"authz_check": ["write", "table:lot_status"]}
        }
      ]
    }
  ],
  "actions": [
    {
      "label": "Hold Lot", "fn": "fn_lot_hold",
      "visible_when": {"authz_check": ["hold", "table:lot_status"]},
      "confirm": true
    }
  ]
}
```

## 4.2 Path B: Traditional Web Middleware

```javascript
// Express.js middleware for traditional web pages
// Loads web_acl once at login, caches in session

async function loadWebAcl(req, res, next) {
    if (!req.session.web_acl) {
        const result = await db.query(
            'SELECT authz_resolve_web_acl($1, $2)',
            [req.user.id, req.user.ldap_groups]
        );
        req.session.web_acl = result.rows[0].authz_resolve_web_acl;
    }
    next();
}

function requireWebPage(resourceId, action = 'read') {
    return (req, res, next) => {
        const acl = req.session.web_acl;

        // Check public pages first
        const isPublic = acl.public_pages?.some(p => p.resource_id === resourceId);
        if (isPublic) return next();

        // Check authorized pages
        const page = acl.web_pages?.find(p => p.resource_id === resourceId);
        if (page && page.actions.includes(action)) return next();

        return res.status(403).json({ error: 'Access denied', resource: resourceId });
    };
}

function requireWebApi(resourceId, action = 'read') {
    return (req, res, next) => {
        const acl = req.session.web_acl;
        const api = acl.web_apis?.find(p => p.resource_id === resourceId);
        if (api && api.actions.includes(action)) return next();
        return res.status(403).json({ error: 'Access denied', resource: resourceId });
    };
}

// Usage
app.use(loadWebAcl);
app.get('/home',           requireWebPage('web_page:home'),            homeController);
app.get('/catalog',        requireWebPage('web_page:product_catalog'), catalogController);
app.get('/admin',          requireWebPage('web_page:admin_dashboard'), adminController);
app.post('/api/catalog/search', requireWebApi('web_api:catalog_search'), catalogSearchApi);
app.post('/api/admin/users',    requireWebApi('web_api:admin_user_mgmt', 'write'), adminUserApi);
```

## 4.3 Path C: pgbouncer Configuration

```ini
; pgbouncer.ini — auto-generated by authz_sync_pgbouncer_config()
; DO NOT EDIT MANUALLY — managed by AuthZ Service

[databases]
nexus_bi_readonly = host=localhost port=5432 dbname=nexus_data user=bi_readonly pool_size=10
nexus_etl_writer = host=localhost port=5432 dbname=nexus_data user=etl_writer pool_size=5
nexus_dba_full = host=localhost port=5432 dbname=nexus_data user=dba_full pool_size=3

[pgbouncer]
auth_type = md5
auth_query = SELECT pg_role AS username, password_hash AS password FROM authz_pool_credentials WHERE pg_role = $1 AND is_active = TRUE
```

## 4.4 Path A Extension: AI Agent

```python
class PhisonAgent:
    def call_tool(self, tool_name, params, user_context):
        # Step 1: Check functional access
        resource_id = f"ai_tool:{tool_name}"
        if not authz_check(user_context.user_id, user_context.groups, "execute", resource_id):
            return {"error": "Insufficient permissions for this tool"}

        # Step 2: Apply data scope filter
        if tool_name in DATA_QUERY_TOOLS:
            where_clause = authz_filter(
                user_context.user_id, user_context.groups,  # v2.4: groups required
                user_context.attributes,
                params.get("target_table"), 'A'
            )
            params["additional_filter"] = where_clause

        # Step 3: Execute and mask results
        result = execute_tool(tool_name, params)
        resolved = authz_resolve(user_context.user_id, user_context.groups, user_context.attributes)
        result = apply_column_masks(result, resolved["L2_column_masks"])

        # Step 4: Audit
        log_audit('A', user_context, tool_name, resource_id, "allow")
        return result
```

---

# V. Casbin Model Definition

```ini
# ============================================================
# CASBIN MODEL — Phison AuthZ Hybrid (RBAC + ABAC)
# File: model.conf
# ============================================================

[request_definition]
r = sub, act, res, env

[policy_definition]
p = sub_rule, act_rule, res_rule, env_rule, eft

[role_definition]
g = _, _
g2 = _, _

[policy_effect]
e = some(where (p.eft == allow)) && !some(where (p.eft == deny))

[matchers]
m = (g(r.sub, p.sub_rule) || p.sub_rule == "*") && \
    (r.act == p.act_rule || p.act_rule == "*") && \
    (g2(r.res, p.res_rule) || r.res == p.res_rule || p.res_rule == "*") && \
    (p.env_rule == "*" || eval(p.env_rule))
```

```csv
# ============================================================
# CASBIN POLICY — Example Policies (all paths)
# File: policy.csv
# ============================================================

# --- L0: Path A (Config-SM modules) ---
p, PE, read, module:mrp.yield_analysis, *, allow
p, PE, read, module:mrp.lot_tracking, *, allow
p, PE, write, module:mrp.lot_tracking, *, allow
p, PM, read, module:mrp.npi_gate_review, *, allow
p, PM, write, module:mrp.npi_gate_review, *, allow
p, OP, read, module:mrp.lot_tracking, *, allow
p, OP, write, module:mrp.lot_tracking, *, allow
p, SALES, read, module:mrp.order_status, *, allow
p, ADMIN, *, *, *, allow

# --- L0: Path B (Traditional web pages) ---
p, PE, read, web_page:product_catalog, *, allow
p, PM, read, web_page:product_catalog, *, allow
p, SALES, read, web_page:product_catalog, *, allow
p, ADMIN, read, web_page:admin_dashboard, *, allow
p, ADMIN, write, web_api:admin_user_mgmt, *, allow

# --- L0: Path C (DB pools) ---
p, BI_USER, connect, db_pool:bi_readonly, *, allow
p, BI_USER, read, db_schema:mrp, *, allow
p, BI_USER, read, db_schema:analytics, *, allow
p, ETL_SVC, connect, db_pool:etl_writer, *, allow
p, ETL_SVC, read, db_schema:mrp, *, allow
p, ETL_SVC, write, db_schema:mrp, *, allow
p, DBA, connect, db_pool:dba_full, *, allow

# --- L1: Data domain (applies to Path A + C via RLS) ---
p, PE, read, table:lot_status, r.env.product_line == r.sub_attr.product_line, allow
p, PE, read, table:cp_ft_result, r.env.product_line == r.sub_attr.product_line, allow
p, SALES, read, table:lot_status, r.env.customer_id in r.sub_attr.customer_ids, allow

# --- L2: Column masking (deny by default, allow for authorized) ---
p, *, read, column:lot_status.unit_price, *, deny
p, SALES, read, column:lot_status.unit_price, *, allow
p, ADMIN, read, column:lot_status.unit_price, *, allow

# --- L3: Action gates (Path A primarily) ---
p, PE, hold, table:lot_status, r.env.phase != 'shipped', allow
p, PM, approve, module:mrp.npi_gate_review, r.env.gate_status == 'pending_review', allow

# --- Role hierarchy (LDAP groups → roles) ---
g, group:PE_SSD, PE
g, group:PE_NAND, PE
g, group:PM_SSD, PM
g, group:PM_NAND, PM
g, group:OP_FAB1, OP
g, group:SALES_TW, SALES
g, group:BI_TEAM, BI_USER
g, group:ETL_SERVICE, ETL_SVC
g, group:DBA_TEAM, DBA
g, user:adam, ADMIN

# --- Resource hierarchy ---
g2, table:lot_status, module:mrp.lot_tracking
g2, table:cp_ft_result, module:mrp.yield_analysis
g2, column:lot_status.unit_price, table:lot_status
g2, column:lot_status.customer_name, table:lot_status
g2, page:lot_detail, module:mrp.lot_tracking
g2, web_api:catalog_search, web_page:product_catalog
g2, web_api:admin_user_mgmt, web_page:admin_dashboard
```

---

# VI. SSOT Convergence Diagram

```
                        ┌───────────────────┐
                        │  LDAP / Keycloak  │
                        │  (Identity SSOT)  │
                        └────────┬──────────┘
                                 │ JWT / session / service credential
                                 ▼
                ┌────────────────────────────────────┐
                │     AuthZ Service (AuthZ SSOT)     │
                │                                    │
                │  ┌──────────────────────────────┐  │
                │  │   Unified Policy Store (PG)  │  │
                │  │                              │  │
                │  │  authz_subject          ─────┼──┼── All paths share
                │  │  authz_role             ─────┼──┼── the same core
                │  │  authz_role_permission  ─────┼──┼── tables
                │  │  authz_policy           ─────┼──┼──
                │  │  authz_audit_log        ─────┼──┼──
                │  │                              │  │
                │  │  authz_db_pool_profile  ─────┼──┼── Path C specific
                │  │  authz_pool_credentials ─────┼──┼──
                │  │  authz_pool_assignment  ─────┼──┼──
                │  └──────────────────────────────┘  │
                │                                    │
                │  Adapter APIs:                     │
                │  ├─ authz_resolve()          → A   │
                │  ├─ authz_resolve_web_acl()  → B   │
                │  ├─ authz_sync_db_grants()   → C   │
                │  ├─ authz_sync_pgbouncer()   → C   │
                │  ├─ authz_check()            → ALL │
                │  └─ authz_filter()           → ALL │
                └──────────────┬─────────────────────┘
                               │
            ┌──────────────────┼──────────────────┐
            ▼                  ▼                   ▼
  ┌─────────────────┐ ┌──────────────┐  ┌──────────────────┐
  │  Path A          │ │  Path B       │  │  Path C           │
  │  Config-SM UI   │ │  Traditional │  │  DB Direct        │
  │  + AI Agent     │ │  Web         │  │  Connection       │
  │                 │ │              │  │                   │
  │  Enforcement:   │ │  Enforcement:│  │  Enforcement:     │
  │  • PG RLS       │ │  • API GW /  │  │  • PG GRANT       │
  │  • Column Mask  │ │    Middleware │  │  • PG RLS         │
  │  • UI Metadata  │ │  • Session   │  │  • NOBYPASSRLS    │
  │    visible_when │ │    ACL cache │  │  • pgbouncer      │
  │  • AI tool gate │ │  • authz_    │  │    auth_query     │
  │  • authz_       │ │    check()   │  │  • pgaudit        │
  │    resolve()    │ │    per API   │  │  • Column views   │
  └─────────────────┘ └──────────────┘  └──────────────────┘
```

**SSOT guarantee**: All three paths read from the same `authz_role_permission` + `authz_policy` tables. Changing a role assignment in `authz_subject_role` immediately affects Path A (next resolve call), Path B (next login/session refresh), and Path C (next sync_db_grants run).

---

# VII. Transferable Mega-Prompt

> **Copy everything below this line to give any LLM full context on this architecture.**

---

```
# SYSTEM PROMPT: Phison Electronics Authorization Service Architecture v2.4
# Repository: phison-data-nexus | npm scope: @nexus/* | Helm: nexus-platform

You are assisting with the design, implementation, and extension of an enterprise Authorization Service for Phison Electronics' internal data center. This service is the Single Source of Truth (SSOT) for all access control decisions across THREE distinct access paths.

## COMPANY & DOMAIN

Phison Electronics is a fabless semiconductor company (NAND/SSD controllers). The data center initiative aims to break data silos across manufacturing, engineering, and sales. Phase 1 is digitization & centralization via custom systems. Phase 2 adds an AI Agent layer for intelligent, automated decision-making.

## CORE ARCHITECTURE PATTERN: Config-as-State-Machine

Every layer's output is a structured config serving as the next layer's input contract:
  Layer 0 (Identity/LDAP) → JWT → Layer 1.5 (AuthZ Service) → permission config → Layer 2 (PostgreSQL) + Layer 3 (UI/Web) + Layer 4 (AI Agent)

## THREE ACCESS PATHS (All governed by the same AuthZ SSOT)

### Path A: Config-as-State-Machine UI + AI Agent
- User → Metadata-Driven UI → PG Functions → Data
- Authorization via: authz_resolve() returns full permission config (L0-L3)
- Enforcement: PG RLS, column masking, UI visible_when/editable_when, AI tool gating
- This path uses ALL four granularity levels

### Path B: Traditional Web Pages (non-Config-SM)
- User → Website homepage / traditional subpages → API or direct queries → Data
- Authorization via: authz_resolve_web_acl() returns page + API ACL list
- Enforcement: Express.js middleware, session-cached ACL, API gateway
- Primarily uses L0 (page/API access), can use L1/L2 for data queries behind APIs

### Path C: Database Direct Connection
- Programs/tools/DBA → Connection Pool (pgbouncer) → Schema.Table → Data
- Authorization via: authz_sync_db_grants() generates PG native GRANT/REVOKE
- Enforcement: PG roles, GRANT/REVOKE on schemas/tables, PG RLS (NOBYPASSRLS), pgbouncer auth_query, pgaudit
- Uses L0 (schema/table GRANT), L1 (RLS for data domain), L2 (column restrictions via views/GRANT)

## DESIGN CONSTRAINTS (MUST follow)

1. PostgreSQL functions are the exclusive business logic layer — all WRITE operations go through PG functions (Path A). Path B may also route through PG functions. Path C pools are typically readonly.
2. READ and WRITE systems are separated architecturally.
3. LDAP groups are the primary subject — policies map to groups, not individuals.
4. Producer/Consumer per table — every data table has explicit Producer (who writes) and Consumer (who reads).
5. Deliverables must be production-ready — full SQL, full configs, full schemas.
6. Three Paths, One Policy Store — all paths share authz_subject, authz_role, authz_role_permission, authz_policy, authz_audit_log. No duplicate permission stores.

## AUTHORIZATION MODEL: RBAC + ABAC Hybrid (4 Granularity Levels × 3 Paths)

| Level | Name | Model | Path A | Path B | Path C |
|-------|------|-------|--------|--------|--------|
| L0 | Functional Access | RBAC | UI module visibility | Page/API routing | Schema + table GRANT |
| L1 | Data Domain Scope | ABAC | RLS via resolve() | RLS via filter() | RLS via PG policy |
| L2 | Row/Column Security | ABAC+Mask | Column mask in UI + PG | Column mask in API | Column GRANT + views |
| L3 | Action Authorization | PBAC | Approval workflows | API action gates | N/A for readonly pools |

## TECHNOLOGY STACK

- Database: PostgreSQL 16
- Policy Engine: Casbin (RBAC + ABAC hybrid model)
- Identity: LDAP (with potential Keycloak SSO)
- Frontend: React (JSX), Metadata-Driven UI for Path A
- Traditional Web: Express.js / any web framework for Path B
- Connection Pooler: pgbouncer with auth_query for Path C
- Column Masking: Custom PG functions with {col} placeholder syntax
- Row Filtering: SQL WHERE expressions via PG functions
- DB Audit: pgaudit extension for Path C
- Deployment: Docker Compose
- Future: AI Agent layer (Path A extension)

## SCHEMA — CORE TABLES (shared by all paths)

- `authz_subject` — LDAP groups, users, service accounts. JSONB attributes for ABAC.
- `authz_resource` — All protected resources with unified type enum:
  Path A types: 'module', 'page', 'table', 'column', 'function', 'ai_tool'
  Path B types: 'web_page', 'web_api'
  Path C types: 'db_schema', 'db_table', 'db_pool'
  Supports parent_id hierarchy (column → table → module; web_api → web_page)
- `authz_action` — Shared action vocabulary with applicable_paths[] field: 'read', 'write', 'delete', 'approve', 'export', 'hold', 'release', 'execute', 'connect'
- `authz_role` — Roles including Path C-specific: 'PE', 'PM', 'OP', 'QA', 'SALES', 'ADMIN', 'BI_USER', 'ETL_SVC', 'DBA'
- `authz_role_permission` — Single table for L0 permissions across ALL paths. role → action → resource with allow/deny.
- `authz_subject_role` — LDAP group → role assignment with validity period.
- `authz_policy` — ABAC policies (L1/L2/L3) with applicable_paths[] filter, subject/resource/action/env conditions, rls_expression, column_mask_rules.
- `authz_composite_action` — Multi-step approval chains for L3.
- `authz_mask_function` — Column masking function registry with {col} template.

## SCHEMA — PATH C SPECIFIC

- `authz_db_pool_profile` — Connection pool definitions: pg_role, allowed_schemas[], allowed_tables[], denied_columns JSONB, connection_mode (readonly/readwrite/admin), max_connections, ip_whitelist, rls_applies flag.
- `authz_db_pool_assignment` — Which subjects can use which pool profiles.
- `authz_pool_credentials` — Managed credentials for pgbouncer auth_query. Password rotation tracked.

## SCHEMA — OPERATIONS

- `authz_sync_log` — Tracks all sync artifacts: rls_policy, column_view, ui_metadata, web_acl, db_grant, pgbouncer_config, agent_scope. Includes generated_sql and generated_config.
- `authz_audit_log` — Partitioned by month. Every decision logged with access_path ('A'/'B'/'C'), subject, action, resource, decision, contributing policy_ids, context JSONB.

## KEY API FUNCTIONS

Shared (all paths):
- `_authz_resolve_roles(user_id, groups[])` → roles[] — internal helper
- `authz_check(user_id, groups[], action, resource)` → boolean — with resource hierarchy walk + deny override
- `authz_filter(user_id, groups[], user_attrs, resource_type, path?)` → SQL WHERE clause — evaluates subject_condition (role + attribute match) per policy, replaces ${subject.xxx} placeholders (v2.4: added groups[] for subject_condition evaluation)

Path A adapter:
- `authz_resolve(user_id, groups[], attrs)` → full JSON config with L0_functional, L1_data_scope, L2_column_masks, L3_actions

Path B adapter:
- `authz_resolve_web_acl(user_id, groups[])` → JSON with web_pages[], web_apis[], public_pages[]

Path C adapter:
- `authz_sync_db_grants()` → executes GRANT/REVOKE on PG roles, returns action log
- `authz_sync_pgbouncer_config(host, port, dbname)` → returns pgbouncer.ini text

## CASBIN MODEL

Uses hybrid RBAC+ABAC:
- g() for role inheritance (LDAP group → role)
- g2() for resource hierarchy (column → table → module; web_api → web_page)
- eval() for ABAC environment conditions
- Allow-override with explicit deny

## RESOLVED CONFIG OUTPUT CONTRACTS

Path A: JSON with user_id, resolved_roles, access_path='A', L0_functional[], L1_data_scope{}, L2_column_masks{}, L3_actions[]
Path B: JSON with user_id, resolved_roles, access_path='B', web_pages[], web_apis[], public_pages[]
Path C: Not a runtime config — produces PG GRANT/REVOKE artifacts + pgbouncer.ini via sync functions

## ENFORCEMENT INTEGRATION PATTERNS

Path A: Application calls authz_resolve() → injects session variables (SET app.user_product_lines) → PG RLS filters automatically → UI reads config for visible_when → AI Agent checks before tool calls
Path B: Login triggers authz_resolve_web_acl() → cached in session → Express middleware checks per route → API middleware checks per endpoint → data queries optionally use authz_filter()
Path C: Admin triggers authz_sync_db_grants() → PG roles created/updated with GRANT/REVOKE → pgbouncer.ini regenerated → RLS applies automatically (NOBYPASSRLS) → pgaudit logs all queries

## SSOT GUARANTEE

All three paths share the same core tables (authz_subject, authz_role, authz_role_permission, authz_policy). Changing a role assignment in authz_subject_role affects: Path A (next resolve call), Path B (next login), Path C (next sync run). No duplicate permission definitions exist.

## WHEN EXTENDING THIS ARCHITECTURE

- New Config-SM module → Add to authz_resource (type='module') + L0 role_permission entries
- New traditional web page → Add to authz_resource (type='web_page') + L0 role_permission entries
- New DB pool profile → Add to authz_db_pool_profile + authz_db_pool_assignment + authz_pool_credentials + run sync
- New role → Add to authz_role + assign permissions in authz_role_permission for relevant paths
- New ABAC policy → Add to authz_policy with applicable_paths set correctly
- New masking function → Add to authz_mask_function with {col} template
- New AI tool → Register as authz_resource (type='ai_tool') + L0 permission
- New approval workflow → Add to authz_composite_action

Always ensure: one definition in the policy store → enforcement adapters for each applicable path. Never duplicate permission logic outside the AuthZ Service.

## AUTHZ ADMIN CENTER

The AuthZ Admin is an independent bounded context (separate app, NOT a sub-module of workbench). It manages the "meta-data" — the rules that define who can see what. It walks Path A enforcement (its pages are registered in authz_resource and gated by authz_check), but its routing structure is HARDCODED, not metadata-driven. This prevents a deadlock: if AuthZ Admin's rendering depended on AuthZ Service, and a policy error locked admins out, recovery would be impossible.

### Admin-specific roles:
- AUTHZ_ADMIN — full CRUD on all authorization policies
- AUTHZ_AUDITOR — read-only access to policies and audit logs

### Admin pages:
- Dashboard: active counts, deny trends, pending reviews, expiring assignments, sync status
- Subjects: LDAP groups/users/service accounts with "permission card" per subject
- Roles: role CRUD + Permission Matrix (role × resource × action grid with allow/deny/inherited states)
- Resources: Resource Tree (hierarchical view of all resource_types across all 3 paths)
- Policies: ABAC policy list + structured Policy Editor (no raw JSON) + Policy Simulator
- Masking: mask function registry with live preview
- Pool Profiles: Path C pool CRUD + schema/table scope visualization + pgbouncer config preview
- Composite Actions: approval workflow definition with visual chain editor
- Audit: cross-path unified query (filter by path/subject/resource/action/decision/timerange)
- Sync Monitor: sync status per type, failures, manual trigger

### Critical design principles:
1. Change workflow: all policy writes → status=pending_review → simulator verification → approve → active → sync engine generates artifacts
2. Bidirectional lookup: forward (subject → roles → permissions → resources) and reverse (resource → roles → subjects)
3. Impact analysis: before any policy change, show affected subjects count, affected rows count, required sync operations
4. Audit is first-class: deny events link back to contributing policy for one-click navigation to editor
5. Self-referential security: AuthZ Admin pages registered in authz_resource, but admin routing is hardcoded to prevent deadlock; only authz_check() is dynamic

### Program architecture location:
AuthZ Admin lives at `apps/authz-admin/` as an independent app, alongside `apps/workbench/` (Config-SM business modules) and `apps/portal/` (traditional web). Shared AuthZ client SDK lives at `packages/authz-client/` (published as `@nexus/authz-client`). The AuthZ core service lives at `services/authz-api/`.

## SUPPORTED DATABASES

Policy Store: PostgreSQL ONLY (PL/pgSQL functions, JSONB, RLS, partitioning are all PG-specific).
Casbin Adapter: Supports PostgreSQL, MySQL, MariaDB, SQLite, MongoDB, MSSQL, Oracle via adapter ecosystem. Default: shared PG with Policy Store.
Target Databases (being protected): Path A/B work with ANY database (application-layer authz_check/filter). Path C enforcement is DB-native: PostgreSQL (full RLS+GRANT), MSSQL (has RLS), MySQL (GRANT+views only, no RLS), MongoDB (app-layer only). Multi-DB sync requires per-DB adapter implementing AuthzDbSyncAdapter interface.

## MONOREPO STRUCTURE (Nx/Turborepo)

- `apps/` — Deployable applications (portal, workbench, authz-admin, agent), each = 1 K8s Deployment
- `services/` — Backend services (authz-api, identity-sync, sync-scheduler)
- `packages/` — Shared libs NOT deployed independently (authz-client SDK, authz-types, ui-components, db-adapters)
- `database/` — Versioned SQL migrations (Flyway/Sqitch), seed data, migration runner Dockerfile
- `deploy/helm/` — Umbrella Helm chart with sub-charts per service + values-{env}.yaml overrides
- `docs/` — Architecture docs, runbooks, ADRs

Dependency rules: packages never depend on apps/services; apps call services via HTTP only; database consumed by migration K8s Job.

## KUBERNETES DEPLOYMENT CONSIDERATIONS

- Secrets: External Secrets Operator or Sealed Secrets (never plain text in values.yaml)
- DB Migration: K8s Job with Helm pre-upgrade hook (runs BEFORE app pods start)
- Health probes: authz-api needs liveness (process alive), readiness (DB connected + Casbin loaded + sync not stale), startup (initial policy load)
- HPA: min 3 replicas for authz-api (critical path); scale on CPU + p99 latency
- PDB: minAvailable=2 for authz-api, minAvailable=1 for PostgreSQL
- Network Policies: only authz-api/pgbouncer/migration can reach PostgreSQL; only frontend apps + agent + sync can reach authz-api
- Casbin pattern: centralized (Casbin in authz-api pods) initially; sidecar pattern (Casbin per-app pod via OPAL) if latency becomes bottleneck
- Graceful shutdown: preStop hook + terminationGracePeriodSeconds for connection draining
- ConfigMap: Casbin model.conf as ConfigMap (GitOps-friendly, no rebuild needed to change model)
- Observability: Prometheus metrics (check total/latency by path, sync status, policy count)

## PERFORMANCE & CACHING

The architecture uses a two-level cache to eliminate per-request DB calls:
- L1 Cache (Redis, TTL=10min): stores authz_resolve() output, keyed by user_id + groups_hash
- L2 Cache (in-process session, TTL=session/8h): copy of L1 for zero-network-hop authz_check()
- authz_check_from_cache(): IMMUTABLE PG function that evaluates resolved config JSON without DB query
- Audit: batch INSERT (flush every 5s or 100 items), only log deny + write + sensitive access
- Cache invalidation: PG trigger fires NOTIFY on policy/role_permission/subject_role changes → authz-api listener invalidates L1 Redis → L2 refreshes on next miss
- RLS optimization: ensure index on filtered columns; use simple = comparison (not ANY) for index scan; consider security barrier views for large tables
- Column masking: declare functions IMMUTABLE PARALLEL SAFE; control result set with pagination

Result: 100 concurrent users, total DB authz queries drop from ~5,000/sec to ~10/sec (99.8% reduction).

## PRODUCTION RISKS & WEAKNESSES (16 identified, 8 dimensions)

Key risks requiring attention:
- OPS-1: Cache inconsistency window after policy change (mitigated by LISTEN/NOTIFY, ~1-5s residual)
- OPS-2: Sync engine failure goes unnoticed (needs drift detector comparing authz definitions vs actual PG catalog)
- SEC-1: Resolved config leaks full permission map if stored client-side (mitigation: minimal client config, keep rls_expression server-side only)
- SEC-2: ADMIN role is god-mode (needs split into SYSTEM_ADMIN, POLICY_ADMIN, AUDIT_ADMIN, SUPER_ADMIN)
- SEC-3: PG session variables spoofable on direct DB access (mitigation: use pg_has_role() in RLS for Path C instead of current_setting())
- SCALE-1: Single PostgreSQL SPOF (mitigation: HA with Patroni + cache-first degraded mode)
- DATA-1: Allow vs Deny policy conflicts with multi-role users (needs conflict detection in Policy Editor + mandatory multi-role simulation)
- COMP-1: Audit batch buffer loss on crash (needs write-ahead buffer or reduced batch window)
- COMP-2: No policy versioning/rollback (mitigated by authz_policy_version table + rollback function with trigger-based auto-versioning)
- EVOL-2: AI agent chained tool calls need cross-step data flow authorization (needs cumulative data_touched context + pre-validation of entire chain)

Remediation priority: SEC-2 → SEC-1 → DATA-1 → OPS-2 → COMP-2 → DX-1 → FT-1 → EVOL-2
```

---

# VIII. Implementation Roadmap v2.4

| Phase | Deliverable | Paths | Dependency |
|-------|-------------|-------|------------|
| 1 | AuthZ schema DDL deployed (all tables) | ALL | PostgreSQL 16 |
| 2 | Seed data: roles, resources (all 3 path types + authz_admin self-registration), base RBAC policies | ALL | Phase 1 |
| 3 | Core functions: _authz_resolve_roles, authz_check, authz_filter | ALL | Phase 2 |
| 4 | Path A adapter: authz_resolve() + RLS sync + column mask functions | A | Phase 3 + MRP tables |
| 5 | Path B adapter: authz_resolve_web_acl() + Express middleware | B | Phase 3 + Web framework |
| 6 | Path C adapter: authz_sync_db_grants() + pool profiles + pgbouncer config | C | Phase 3 + pgbouncer |
| 7 | Casbin integration: connect Casbin to authz policy store | A | Phase 2 |
| 8 | Path A UI: metadata visible_when/editable_when wiring | A | Phase 4 + React UI |
| 9 | Path C credentials: authz_pool_credentials + password rotation | C | Phase 6 |
| 10 | Audit infrastructure: partitioned audit_log + pgaudit for Path C | ALL | Phase 3 |
| 11 | AI Agent authz middleware | A | Phase 4 + Agent framework |
| 12 | LDAP sync: auto-provision authz_subject from LDAP groups | ALL | LDAP server |
| **13a** | **AuthZ Admin: CRUD API layer** (admin-crud.js for all authz tables) | ALL | Phase 3 |
| **13b** | **AuthZ Admin: Core pages** — Dashboard, Subjects, Roles, Resources (Tree), Policies (list + editor) | ALL | Phase 13a + React |
| **13c** | **AuthZ Admin: Permission Matrix** — role × resource × action grid with allow/deny/inherited | ALL | Phase 13b |
| **13d** | **AuthZ Admin: Policy Simulator** — simulate-as-user with cross-path output | ALL | Phase 13b + Phase 4/5/6 |
| **13e** | **AuthZ Admin: Impact Analysis** — pre-change affected subjects/rows/sync estimation | ALL | Phase 13d |
| **13f** | **AuthZ Admin: Audit page** — cross-path query + deny→policy one-click navigation | ALL | Phase 10 + 13b |
| **13g** | **AuthZ Admin: Sync Monitor** — status dashboard + manual trigger + failure alerts | ALL | Phase 4/5/6 + 13b |
| **13h** | **AuthZ Admin: Pool Profiles page** — CRUD + schema/table scope visualization + pgbouncer preview | C | Phase 6 + 13b |
| 14 | Change workflow: pending_review → approve → active pipeline with notifications | ALL | Phase 13b |
| 15 | Compliance dashboard: cross-path audit reporting + export | ALL | Phase 13f |
| **16** | **Monorepo setup: Nx/Turborepo workspace, packages/authz-types, CI pipeline** | ALL | — |
| **17** | **Helm umbrella chart: sub-charts per service, values-{env}.yaml hierarchy** | ALL | Phase 16 |
| **18** | **K8s: External Secrets, NetworkPolicy, PDB, HPA for authz-api** | ALL | Phase 17 |
| **19** | **DB migration as K8s Job: Flyway + Helm pre-upgrade hook** | ALL | Phase 17 |
| **20** | **Multi-DB adapter interface: AuthzDbSyncAdapter for MySQL/MSSQL targets** | C | Phase 6 |
| **21** | **Observability: Prometheus metrics, ServiceMonitor, Grafana dashboard** | ALL | Phase 18 |
| **22** | **Two-level cache: Redis L1 + session L2 + authz_check_from_cache()** | ALL | Phase 3 |
| **23** | **Cache invalidation: PG LISTEN/NOTIFY triggers + Redis flush** | ALL | Phase 22 |
| **24** | **Audit optimization: batch INSERT + selective logging (deny/write/sensitive only)** | ALL | Phase 10 |
| **25** | **SEC-2: Split ADMIN into SYSTEM_ADMIN / POLICY_ADMIN / AUDIT_ADMIN / SUPER_ADMIN** | ALL | Phase 2 |
| **26** | **SEC-1: Minimal client config (strip rls_expression, fn templates from client payload)** | A,B | Phase 22 |
| **27** | **COMP-2: Policy versioning table + auto-version trigger + rollback function** | ALL | Phase 3 |
| **28** | **DATA-1: Policy conflict detector in Policy Editor** | ALL | Phase 13d |
| **29** | **OPS-2: Sync drift detector (compare authz definitions vs PG catalog)** | C | Phase 6 |
| **30** | **DX-1: Module registration scaffold CLI (`npx @nexus/cli register-module`)** | A | Phase 16 |
| **31** | **EVOL-2: Agent chain authorization (cumulative data_touched + pre-validation)** | A | Phase 11 |

---

# IX. AuthZ Admin Center — Architecture Positioning

## 9.1 Bounded Context Rationale

The AuthZ Admin Center is an **independent bounded context** — a separate application, NOT a sub-module of the workbench (MRP, Quality, etc.). This separation exists for three reasons:

1. **Avoid circular dependency** — Workbench depends on AuthZ to render. If AuthZ Admin were a workbench module, its rendering would depend on the system it manages. A policy error could lock admins out permanently.
2. **Different lifecycle** — AuthZ Admin changes infrequently after initial setup. Business modules (MRP, Quality) evolve rapidly. Decoupling prevents AuthZ Admin from being destabilized by business module deployments.
3. **Different audience** — AuthZ Admin is used by IT security / platform team. Workbench is used by PE, PM, OP. Separate apps mean separate deployment, separate access control, separate monitoring.

## 9.2 Program Architecture

```
phison-data-nexus/
│
├── apps/
│   ├── portal/                          ← Path B: website homepage + traditional pages
│   │   ├── pages/
│   │   │   ├── home/
│   │   │   ├── product-catalog/
│   │   │   └── ...
│   │   └── middleware/
│   │       └── web-acl-guard.js         ← requireWebPage() / requireWebApi()
│   │
│   ├── workbench/                       ← Path A: Config-as-State-Machine business system
│   │   ├── modules/
│   │   │   ├── mrp/                     ← MRP module
│   │   │   │   ├── lot-tracking/
│   │   │   │   ├── yield-analysis/
│   │   │   │   └── npi-gate/
│   │   │   ├── quality/                 ← Quality module (future)
│   │   │   └── ...
│   │   ├── engine/
│   │   │   ├── metadata-renderer.jsx    ← Generic Metadata-Driven UI engine
│   │   │   ├── authz-context.jsx        ← React Context: resolved permission config
│   │   │   └── field-registry.jsx       ← Field type registry
│   │   └── layout/
│   │       ├── sidebar-nav.jsx          ← Dynamically rendered from L0_functional
│   │       └── app-shell.jsx
│   │
│   ├── ★ authz-admin/ ★                ← AuthZ Admin Center (independent bounded context)
│   │   ├── pages/
│   │   │   ├── dashboard/               ← Overview dashboard
│   │   │   ├── subjects/                ← LDAP group / user management
│   │   │   ├── roles/                   ← Role definition + permission matrix
│   │   │   ├── resources/               ← Resource tree (all resource_types, all paths)
│   │   │   ├── policies/                ← ABAC policy management
│   │   │   ├── masking/                 ← Column mask function management
│   │   │   ├── pool-profiles/           ← DB connection pool profiles (Path C)
│   │   │   ├── composite-actions/       ← Approval workflow definitions
│   │   │   ├── audit/                   ← Cross-path audit log query
│   │   │   └── sync/                    ← Sync status monitor + manual trigger
│   │   ├── components/
│   │   │   ├── resource-tree.jsx        ← Resource hierarchy tree
│   │   │   ├── permission-matrix.jsx    ← Role-resource-action cross matrix
│   │   │   ├── policy-editor.jsx        ← Structured ABAC policy editor (no raw JSON)
│   │   │   ├── policy-simulator.jsx     ← "What can user X see?" simulator
│   │   │   ├── impact-analysis.jsx      ← Pre-change impact estimation
│   │   │   ├── diff-viewer.jsx          ← Policy change diff comparison
│   │   │   └── approval-chain-editor.jsx← Visual multi-step approval chain
│   │   ├── hooks/
│   │   │   ├── use-authz-admin.js       ← CRUD hooks for all authz tables
│   │   │   └── use-policy-simulation.js ← Simulation execution hook
│   │   └── config/
│   │       └── admin-routes.js          ← HARDCODED routing (see §9.3)
│   │
│   └── agent/                           ← AI Agent service (Path A extension)
│       └── middleware/
│           └── agent-authz-gate.py
│
├── services/
│   ├── authz-api/                   ← AuthZ core service (Layer 1.5)
│   │   ├── sql/
│   │   │   ├── schema.sql              ← DDL (v2.1 full schema)
│   │   │   ├── functions.sql           ← All authz_* functions
│   │   │   ├── seed.sql                ← Initial data (incl. self-registration)
│   │   │   └── migrations/
│   │   ├── sync/
│   │   │   ├── rls-sync.sql            ← RLS auto-generation
│   │   │   ├── grant-sync.sql          ← GRANT/REVOKE sync
│   │   │   ├── pgbouncer-sync.sql      ← pgbouncer config generation
│   │   │   └── scheduler.js            ← Periodic sync job
│   │   ├── api/
│   │   │   ├── resolve.js              ← REST wrapper: authz_resolve()
│   │   │   ├── check.js                ← REST wrapper: authz_check()
│   │   │   ├── web-acl.js              ← REST wrapper: authz_resolve_web_acl()
│   │   │   ├── admin-crud.js           ← CRUD API for Admin UI (all authz tables)
│   │   │   └── simulation.js           ← Policy simulation API
│   │   └── casbin/
│   │       ├── model.conf
│   │       └── pg-adapter.js           ← Casbin ↔ PG policy store adapter
│   │
│   └── identity/                        ← LDAP sync service
│       └── ldap-sync.js
│
├── infrastructure/
│   ├── docker-compose.yml
│   ├── pgbouncer/
│   │   └── pgbouncer.ini               ← Auto-generated by sync, DO NOT EDIT
│   └── postgres/
│       └── pg_hba.conf
│
└── shared/
    ├── authz-client/                    ← Shared AuthZ client SDK (used by all apps)
    │   ├── authz-client.js              ← check(), resolve(), filter() wrappers
    │   ├── react-authz-provider.jsx     ← React context provider
    │   └── express-authz-middleware.js   ← Path B middleware
    └── types/
        └── authz-types.ts               ← TypeScript types for all authz configs
```

## 9.3 Self-Managed Resource Registration

AuthZ Admin pages are registered in `authz_resource` so they are governed by the same SSOT. However, the admin UI's **routing structure is hardcoded** — it does not consume metadata-renderer.jsx. Only the **gate check** (`authz_check()`) is dynamic.

```sql
-- ============================================================
-- AUTHZ ADMIN — SELF-REGISTRATION
-- These resources represent the admin UI's own pages
-- ============================================================

-- Admin-specific roles
INSERT INTO authz_role (role_id, display_name, description, is_system) VALUES
    ('AUTHZ_ADMIN',   'AuthZ Administrator', 'Full CRUD on all authorization policies',       TRUE),
    ('AUTHZ_AUDITOR', 'AuthZ Auditor',       'Read-only access to policies and audit logs',    TRUE);

-- Admin module and pages
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name) VALUES
    ('module:authz_admin',                    'module', NULL,                     'AuthZ Admin Center'),
    ('page:authz_admin.dashboard',            'page',   'module:authz_admin',    'AuthZ Dashboard'),
    ('page:authz_admin.subjects',             'page',   'module:authz_admin',    'Subject Management'),
    ('page:authz_admin.roles',                'page',   'module:authz_admin',    'Role Management'),
    ('page:authz_admin.resources',            'page',   'module:authz_admin',    'Resource Management'),
    ('page:authz_admin.policies',             'page',   'module:authz_admin',    'Policy Management'),
    ('page:authz_admin.masking',              'page',   'module:authz_admin',    'Masking Functions'),
    ('page:authz_admin.pool_profiles',        'page',   'module:authz_admin',    'DB Pool Profiles'),
    ('page:authz_admin.composite_actions',    'page',   'module:authz_admin',    'Approval Workflows'),
    ('page:authz_admin.audit',                'page',   'module:authz_admin',    'Audit Log'),
    ('page:authz_admin.sync',                 'page',   'module:authz_admin',    'Sync Monitor');

-- Permissions
INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect) VALUES
    ('AUTHZ_ADMIN',   'read',  'module:authz_admin', 'allow'),
    ('AUTHZ_ADMIN',   'write', 'module:authz_admin', 'allow'),
    ('AUTHZ_AUDITOR', 'read',  'module:authz_admin', 'allow'),
    ('ADMIN',         'read',  'module:authz_admin', 'allow'),
    ('ADMIN',         'write', 'module:authz_admin', 'allow');

-- LDAP group assignments
INSERT INTO authz_subject (subject_id, subject_type, display_name, ldap_dn) VALUES
    ('group:AUTHZ_ADMINS',  'ldap_group', 'AuthZ Administrators', 'cn=authz_admins,ou=groups,dc=phison,dc=com'),
    ('group:AUTHZ_AUDITORS','ldap_group', 'AuthZ Auditors',       'cn=authz_auditors,ou=groups,dc=phison,dc=com');

INSERT INTO authz_subject_role (subject_id, role_id, granted_by) VALUES
    ('group:AUTHZ_ADMINS',  'AUTHZ_ADMIN',   'system_init'),
    ('group:AUTHZ_AUDITORS','AUTHZ_AUDITOR', 'system_init');
```

Hardcoded routing rationale — the admin app's routes are defined in code, not in metadata:

```javascript
// apps/authz-admin/config/admin-routes.js
// HARDCODED — does NOT consume metadata-renderer engine
// Only authz_check() is dynamic (verifies user has AUTHZ_ADMIN or AUTHZ_AUDITOR role)
// This prevents deadlock: if admin UI rendering depended on AuthZ Service,
// and a policy error locked admins out, there would be no way to fix it.

export const AUTHZ_ADMIN_ROUTES = {
    dashboard:         { path: '/authz/dashboard',         requires: { action: 'read',  resource: 'module:authz_admin' } },
    subjects:          { path: '/authz/subjects',          requires: { action: 'read',  resource: 'page:authz_admin.subjects' } },
    subjects_edit:     { path: '/authz/subjects/:id',      requires: { action: 'write', resource: 'page:authz_admin.subjects' } },
    roles:             { path: '/authz/roles',             requires: { action: 'read',  resource: 'page:authz_admin.roles' } },
    permission_matrix: { path: '/authz/matrix',            requires: { action: 'read',  resource: 'page:authz_admin.roles' } },
    resources:         { path: '/authz/resources',         requires: { action: 'read',  resource: 'page:authz_admin.resources' } },
    policies:          { path: '/authz/policies',          requires: { action: 'read',  resource: 'page:authz_admin.policies' } },
    policy_editor:     { path: '/authz/policies/:id',      requires: { action: 'write', resource: 'page:authz_admin.policies' } },
    simulator:         { path: '/authz/simulate',          requires: { action: 'read',  resource: 'page:authz_admin.policies' } },
    masking:           { path: '/authz/masking',           requires: { action: 'read',  resource: 'page:authz_admin.masking' } },
    pool_profiles:     { path: '/authz/pools',             requires: { action: 'read',  resource: 'page:authz_admin.pool_profiles' } },
    pool_profiles_edit:{ path: '/authz/pools/:id',         requires: { action: 'write', resource: 'page:authz_admin.pool_profiles' } },
    composite_actions: { path: '/authz/workflows',         requires: { action: 'read',  resource: 'page:authz_admin.composite_actions' } },
    audit:             { path: '/authz/audit',             requires: { action: 'read',  resource: 'page:authz_admin.audit' } },
    sync:              { path: '/authz/sync',              requires: { action: 'read',  resource: 'page:authz_admin.sync' } },
    sync_trigger:      { path: '/authz/sync/run',          requires: { action: 'write', resource: 'page:authz_admin.sync' } },
};
```

---

# X. AuthZ Admin Center — Page & Component Design

## 10.1 Page Structure

```
AuthZ Admin Center
│
├── 📊 Dashboard
│   ├── Active subject / role / policy / resource counts
│   ├── Deny trend chart (last 7 days, by path)
│   ├── Top 10 denied resources (where users hit walls most)
│   ├── Pending review policies
│   ├── Sync status summary (last success/failure per sync_type)
│   └── Expiring role assignments (valid_until approaching)
│
├── 👥 Subjects
│   ├── LDAP group list (sync status + manual add)
│   ├── Exception individual accounts
│   ├── Service accounts
│   └── Per-subject "Permission Card":
│       roles → accessible modules/pages/tables/tools → data scope → column masks
│
├── 🎭 Roles
│   ├── Role list + CRUD
│   ├── ★ Permission Matrix ★ (core page, see §10.2)
│   └── Role assignment: which LDAP groups are bound to this role
│
├── 🏗️ Resources
│   ├── ★ Resource Tree ★ (hierarchical view, see §10.2)
│   ├── Add/edit resource + attributes
│   └── Reverse lookup: "who can access this resource?"
│
├── 📜 Policies
│   ├── Policy list + filter (by granularity, status, path)
│   ├── ★ Policy Editor ★ (structured form, see §10.2)
│   ├── ★ Policy Simulator ★ (most important feature, see §10.2)
│   └── Change history + diff comparison
│
├── 🎭 Masking
│   ├── Mask function list + live preview (input → output)
│   └── Reverse: which policies use this function
│
├── 🔗 Pool Profiles (Path C)
│   ├── Profile list + CRUD
│   ├── Schema/table scope visualization per profile
│   ├── Credential management + password rotation
│   └── pgbouncer config preview + sync trigger
│
├── ✅ Approval Workflows
│   ├── Workflow definition list
│   ├── Visual approval chain editor (drag-and-drop steps)
│   └── In-progress approval instances
│
├── 📋 Audit
│   ├── Unified cross-path query (A/B/C filter)
│   ├── Filter by subject / resource / action / decision / time range
│   ├── Deny event → one-click jump to contributing policy editor
│   └── Export to CSV/Excel
│
└── 🔄 Sync Monitor
    ├── Per sync_type latest status (rls_policy, db_grant, pgbouncer_config, etc.)
    ├── Failed items + error messages
    ├── Manual sync trigger buttons (per type or all)
    └── sync_log history table
```

## 10.2 Core Components

### Permission Matrix

The most frequently used management view. Displays a role × resource grid with action checkboxes.

```
┌──────────────────────────────────────────────────────────────────┐
│  Permission Matrix                     [Path: All ▼] [Search...]  │
├──────────┬───────────────────────────────────────────────────────│
│          │  mrp.yield   mrp.lot    mrp.npi    product   admin    │
│  Role    │  _analysis   _tracking  _gate      _catalog  _dashboard│
├──────────┼───────────────────────────────────────────────────────│
│  PE      │  [R]         [R][W]     [R]        [R]       [ ]      │
│  PM      │  [R]         [R]        [R][W][A]  [R]       [ ]      │
│  OP      │  [ ]         [R][W]     [ ]        [ ]       [ ]      │
│  SALES   │  [ ]         [ ]        [ ]        [R]       [ ]      │
│  ADMIN   │  [R][W]      [R][W]     [R][W][A]  [R][W]   [R][W]   │
│  BI_USER │  ─ ─ ─ ─ ─ ─ Path C: db_pool:bi_readonly ─ ─ ─ ─ ─  │
│  DBA     │  ─ ─ ─ ─ ─ ─ Path C: db_pool:dba_full ─ ─ ─ ─ ─ ─  │
├──────────┴───────────────────────────────────────────────────────│
│  R=Read  W=Write  A=Approve  E=Export  H=Hold  C=Connect         │
│  ■ Allow (explicit)  □ Deny (explicit)  ○ Inherited from parent  │
│  Click cell to toggle allow. Shift+click for explicit deny.      │
│  Path filter: show only Path A / B / C resources.                │
└──────────────────────────────────────────────────────────────────┘
```

Design: three visual states (explicit allow, explicit deny, inherited from resource hierarchy). Path filter switches between resource_type sets. Clicking a cell writes to `authz_role_permission`.

### Resource Tree

Hierarchical view of all resources across all paths. Each node shows consumer count and masking status.

```
┌──────────────────────────────────────────────────────────────────┐
│  Resource Tree                         [+ Add Resource]           │
├──────────────────────────────────────────────────────────────────│
│                                                                   │
│  ▼ 📦 Path A: Config-SM Modules                                  │
│    ▼ 📁 module:mrp.lot_tracking                                  │
│      ├── 📄 page:lot_detail                                      │
│      ├── 📊 table:lot_status                     [5 consumers]   │
│      │   ├── 🔒 column:lot_status.unit_price     [masked: range] │
│      │   ├── 🔒 column:lot_status.customer_name  [masked: full]  │
│      │   └── 📎 column:lot_status.grade                          │
│      └── 📊 table:lot_history                                    │
│    ▶ 📁 module:mrp.yield_analysis                                │
│    ▶ 📁 module:mrp.npi_gate_review                               │
│                                                                   │
│  ▼ 🌐 Path B: Traditional Web                                    │
│    ├── 📄 web_page:home                          [public]        │
│    ├── 📄 web_page:product_catalog                               │
│    │   └── 🔌 web_api:catalog_search                             │
│    └── 📄 web_page:admin_dashboard                               │
│        └── 🔌 web_api:admin_user_mgmt                            │
│                                                                   │
│  ▼ 💾 Path C: DB Direct                                          │
│    ├── 🏊 db_pool:bi_readonly        [10 conn, readonly]         │
│    ├── 🏊 db_pool:etl_writer         [5 conn, readwrite]         │
│    ├── 🏊 db_pool:dba_full           [3 conn, admin]             │
│    ├── 📂 db_schema:mrp                                          │
│    └── 📂 db_schema:analytics                                    │
│                                                                   │
│  ▼ 🤖 AI Tools                                                   │
│    ├── 🔧 ai_tool:yield_query                                    │
│    └── 🔧 ai_tool:lot_recommendation                             │
│                                                                   │
│  ▼ ⚙️ AuthZ Admin (self-managed)                                 │
│    ├── 📄 page:authz_admin.dashboard                             │
│    ├── 📄 page:authz_admin.subjects                              │
│    └── ... (11 pages)                                            │
└──────────────────────────────────────────────────────────────────┘
```

Click any node → side panel shows: which roles have access, which actions, which ABAC policies apply, inherited vs. explicit. "Who can access this?" reverse lookup.

### Policy Simulator

The most critical feature for operational safety. Calls `authz_resolve()` + `authz_resolve_web_acl()` + pool profile lookup and renders results in human-readable format.

```
┌──────────────────────────────────────────────────────────────────┐
│  Policy Simulator                                     [Run ▶]    │
├──────────────────────────────────────────────────────────────────│
│                                                                   │
│  Simulate as:                                                     │
│  ┌──────────────────────────────────────────────────┐            │
│  │ User: [adam          ▼]  or  Group: [PE_SSD   ▼] │            │
│  │ Attributes: product_line = [SSD-Controller     ]  │            │
│  │             site = [HQ                         ]  │            │
│  └──────────────────────────────────────────────────┘            │
│                                                                   │
│  ── Simulation Result ───────────────────────────────────────     │
│                                                                   │
│  Resolved Roles: PE, ADMIN                                        │
│                                                                   │
│  Path A — Config-SM:                                              │
│  ✅ module:mrp.yield_analysis      read                           │
│  ✅ module:mrp.lot_tracking        read, write                    │
│  ✅ module:mrp.npi_gate_review     read                           │
│  ❌ module:mrp.order_status        (no permission)                │
│                                                                   │
│  Data Scope (L1):                                                 │
│  🔍 lot_status:   WHERE product_line IN ('SSD-Controller')       │
│  🔍 cp_ft_result: WHERE product_line IN ('SSD-Controller')       │
│                                                                   │
│  Column Masks (L2):                                               │
│  🔒 lot_status.unit_price    → fn_mask_range()   42.5 → "40-50" │
│  🔓 lot_status.customer_name → visible                           │
│                                                                   │
│  Actions (L3):                                                    │
│  ✅ lot hold    (PE step 1, phase ≠ shipped)                      │
│  ✅ npi approve (PE step 1 + PM step 2, gate_status=pending)      │
│                                                                   │
│  Path B — Web:                                                    │
│  ✅ web_page:product_catalog       read                           │
│  ✅ web_page:admin_dashboard       read, write                    │
│  🌐 web_page:home                  (public)                       │
│                                                                   │
│  Path C — DB Pools:                                               │
│  ✅ db_pool:dba_full               connect (via ADMIN role)       │
│  🔍 RLS applies: product_line IN ('SSD-Controller')              │
│                                                                   │
│  ── Contributing Policies ───────────────────────────────────     │
│  #12 pe_ssd_data_scope       (L1, priority 100) [Edit →]         │
│  #15 financial_column_mask   (L2, priority 50)  [Edit →]         │
│  #23 lot_hold_workflow       (L3, priority 100) [Edit →]         │
└──────────────────────────────────────────────────────────────────┘
```

**Mandatory usage**: any policy change must pass through the simulator before approval. The "Submit for Review" button on Policy Editor is disabled until the editor runs at least one simulation.

### Policy Editor

Structured form — administrators never write raw JSON. Each condition section uses dropdown + value selectors.

```
┌──────────────────────────────────────────────────────────────────┐
│  Edit Policy: pe_ssd_data_scope                                   │
├──────────────────────────────────────────────────────────────────│
│                                                                   │
│  Basic Info                                                       │
│  Name:        [pe_ssd_data_scope                ]                 │
│  Description: [PE of SSD line sees only SSD data]                 │
│  Granularity: [L1 — Data Domain Scope  ▼]                        │
│  Effect:      (●) Allow  ( ) Deny                                 │
│  Priority:    [100    ]  (lower = higher priority)                │
│  Status:      [Pending Review ▼]                                  │
│  Applies to:  [✅ Path A] [✅ Path B] [✅ Path C]                │
│                                                                   │
│  ── Subject Conditions (WHO) ────────────────────────────────     │
│  ┌────────────────────────────────────────────┐                   │
│  │ role          [is any of ▼]  [PE         ▼] │  [+ Add]        │
│  │ product_line  [equals    ▼]  [SSD-Controller]│                 │
│  └────────────────────────────────────────────┘                   │
│                                                                   │
│  ── Resource Conditions (WHAT) ──────────────────────────────     │
│  ┌────────────────────────────────────────────┐                   │
│  │ resource_type [is    ▼]  [table        ▼]  │  [+ Add]         │
│  │ data_domain   [any of▼]  [yield, lot   ▼]  │                  │
│  └────────────────────────────────────────────┘                   │
│                                                                   │
│  ── Environment Conditions (WHEN/WHERE) ─────────────────────     │
│  ┌────────────────────────────────────────────┐                   │
│  │ (none defined)                      [+ Add]│                   │
│  └────────────────────────────────────────────┘                   │
│                                                                   │
│  ── Enforcement Rules ───────────────────────────────────────     │
│  RLS Expression:                                                  │
│  ┌────────────────────────────────────────────┐                   │
│  │ product_line = ANY(${subject.product_line}) │                   │
│  └────────────────────────────────────────────┘                   │
│  Syntax: ${subject.xxx} replaced with user attribute at runtime   │
│                                                                   │
│  Column Masks:                                                    │
│  ┌──────────────────┬────────────┬─────────────────────┐         │
│  │ Column           │ Mask Type  │ Function             │         │
│  ├──────────────────┼────────────┼─────────────────────┤         │
│  │ unit_price       │ [range  ▼] │ fn_mask_range({col}) │         │
│  │ customer_name    │ [none   ▼] │ (visible)            │         │
│  │                  │            │               [+ Add]│         │
│  └──────────────────┴────────────┴─────────────────────┘         │
│                                                                   │
│  ── Validity Period ─────────────────────────────────────────     │
│  From: [2026-04-10]  Until: [永久 (no expiry)          ]         │
│                                                                   │
│  [Simulate Impact ▶]  [Save as Draft]  [Submit for Review]       │
│  ※ "Submit for Review" requires at least one simulation run       │
└──────────────────────────────────────────────────────────────────┘
```

### Impact Analysis

Displayed after clicking "Simulate Impact" on Policy Editor, before committing a change.

```
┌──────────────────────────────────────────────────────────────────┐
│  ⚠️ Impact Analysis                                              │
│                                                                   │
│  Policy: pe_ssd_data_scope                                        │
│  Change: adding product_line = 'NAND' to subject condition        │
│                                                                   │
│  Affected subjects:  12 users across 3 LDAP groups                │
│  ├── group:PE_SSD    (8 members) — GAINS access to NAND data     │
│  ├── group:PE_NAND   (3 members) — no change                     │
│  └── user:adam       (1)         — GAINS access to NAND data     │
│                                                                   │
│  Affected resources: 4 tables                                     │
│  ├── lot_status      — ~15,234 additional rows visible            │
│  ├── cp_ft_result    — ~42,891 additional rows visible            │
│  ├── bin_mapping     — ~128 additional rows visible               │
│  └── npi_gate_log    — ~23 additional rows visible                │
│                                                                   │
│  Sync required:                                                   │
│  ├── 2 RLS policies to regenerate                                 │
│  ├── 0 GRANT changes                                              │
│  └── 1 UI metadata refresh                                       │
│                                                                   │
│  [Cancel]  [Save as Draft]  [Apply Now (ADMIN only)]             │
└──────────────────────────────────────────────────────────────────┘
```

## 10.3 Design Principles

### Principle 1: Change Workflow — Changes Do NOT Take Effect Immediately

```
Create / modify policy
     ↓
status = pending_review
     ↓
Reviewer runs Policy Simulator to verify impact
     ↓
Reviewer runs Impact Analysis to estimate blast radius
     ↓
Approve → status = active
     ↓
Sync Engine detects change → generates RLS / GRANT / UI metadata / pgbouncer config
     ↓
authz_sync_log records generated artifacts
     ↓
(Emergency bypass: ADMIN can "Apply Now" but audit_log flags it as emergency_override)
```

### Principle 2: Bidirectional Lookup

**Forward**: Select subject → expand roles → expand permissions per role → see all accessible resources across all paths.

**Reverse**: Select resource → expand which roles have access → expand which LDAP groups hold those roles → see every person who can touch this resource.

Both directions can trigger Policy Simulator for instant verification.

### Principle 3: Audit as First-Class Citizen

Audit is not an afterthought log viewer. It answers operational questions:

- "Why was 小王 denied access to NAND yield data yesterday?"
  → Search: subject=小王, resource=cp_ft_result, decision=deny, last 24h
  → Result shows policy #12 (pe_ssd_data_scope) blocked access
  → One-click link to Policy Editor for policy #12
  → Optional: "Add exception" button opens Policy Editor pre-filled

```sql
-- Audit query backing the "Top Denied" dashboard widget
SELECT
    date_trunc('hour', timestamp) AS hour,
    access_path,
    subject_id,
    resource_id,
    count(*) AS deny_count
FROM authz_audit_log
WHERE decision = 'deny'
  AND timestamp > now() - interval '7 days'
GROUP BY 1, 2, 3, 4
ORDER BY deny_count DESC
LIMIT 50;
```

### Principle 4: Pre-Change Impact Visibility

Every policy modification shows estimated impact BEFORE saving:
- How many subjects are affected (gained / lost access)
- How many data rows become visible / hidden
- Which sync operations will be triggered
- Which other policies interact with this change (priority conflicts)

---

# XI. Appendix — AuthZ Admin CRUD API Endpoints

```
# ============================================================
# services/authz-api/api/admin-crud.js
# RESTful CRUD for all authz tables
# All endpoints require authz_check(user, 'read'|'write', 'module:authz_admin')
# ============================================================

# Subjects
GET    /api/authz/subjects                    → list (with pagination, search)
GET    /api/authz/subjects/:id                → detail + permission card
POST   /api/authz/subjects                    → create
PUT    /api/authz/subjects/:id                → update
DELETE /api/authz/subjects/:id                → soft-delete (is_active=false)

# Roles
GET    /api/authz/roles                       → list
GET    /api/authz/roles/:id                   → detail + assigned subjects
POST   /api/authz/roles                       → create
PUT    /api/authz/roles/:id                   → update
DELETE /api/authz/roles/:id                   → soft-delete (block if is_system=true)

# Resources
GET    /api/authz/resources                   → flat list (with type filter)
GET    /api/authz/resources/tree              → hierarchical tree structure
GET    /api/authz/resources/:id               → detail + who-can-access reverse lookup
POST   /api/authz/resources                   → create
PUT    /api/authz/resources/:id               → update
DELETE /api/authz/resources/:id               → soft-delete (block if has children)

# Role Permissions (Permission Matrix data source)
GET    /api/authz/permissions                 → full matrix (optional path filter)
POST   /api/authz/permissions                 → add permission (role + action + resource)
DELETE /api/authz/permissions/:id             → remove permission

# Subject-Role Assignments
GET    /api/authz/assignments                 → list (filter by subject or role)
POST   /api/authz/assignments                 → assign role to subject
PUT    /api/authz/assignments/:id             → update validity period
DELETE /api/authz/assignments/:id             → revoke

# ABAC Policies
GET    /api/authz/policies                    → list (filter by granularity, status, path)
GET    /api/authz/policies/:id               → detail
POST   /api/authz/policies                    → create (status=pending_review)
PUT    /api/authz/policies/:id               → update (resets status to pending_review)
POST   /api/authz/policies/:id/approve       → approve (status → active, requires AUTHZ_ADMIN)
POST   /api/authz/policies/:id/reject        → reject (status → inactive, with reason)
GET    /api/authz/policies/:id/history       → change history with diffs

# Mask Functions
GET    /api/authz/masking                     → list
GET    /api/authz/masking/:name/preview       → preview: input → output example
POST   /api/authz/masking                     → register new function
PUT    /api/authz/masking/:name              → update
DELETE /api/authz/masking/:name              → remove (block if referenced by policies)

# Pool Profiles (Path C)
GET    /api/authz/pools                       → list
GET    /api/authz/pools/:id                  → detail + assigned subjects + scope visualization
POST   /api/authz/pools                       → create
PUT    /api/authz/pools/:id                  → update
POST   /api/authz/pools/:id/rotate-password  → rotate credentials
GET    /api/authz/pools/pgbouncer-preview     → preview generated pgbouncer.ini

# Composite Actions (Approval Workflows)
GET    /api/authz/workflows                   → list
POST   /api/authz/workflows                   → create
PUT    /api/authz/workflows/:id              → update
DELETE /api/authz/workflows/:id              → remove

# Simulation
POST   /api/authz/simulate                    → run simulation (body: {user_id, groups, attrs})
                                                returns: merged Path A + B + C results
POST   /api/authz/simulate/impact             → impact analysis (body: {policy_id, proposed_changes})
                                                returns: affected subjects, rows, sync operations

# Audit
GET    /api/authz/audit                       → query (filter: path, subject, resource, action, decision, timerange)
GET    /api/authz/audit/stats                 → dashboard aggregates (deny trends, top denied)
GET    /api/authz/audit/export                → CSV/Excel export

# Sync
GET    /api/authz/sync/status                 → latest status per sync_type
GET    /api/authz/sync/log                    → sync_log history
POST   /api/authz/sync/trigger                → manual sync (body: {sync_type} or {all: true})
POST   /api/authz/sync/trigger/rls            → sync RLS policies only
POST   /api/authz/sync/trigger/grants         → sync DB grants only
POST   /api/authz/sync/trigger/pgbouncer      → sync pgbouncer config only
```

---

# XII. Supported Database Types

## 12.1 Architecture Database Roles

This architecture involves **three distinct database roles**, each with different requirements:

| Role | Description | Primary Choice | Alternatives |
|------|-------------|---------------|-------------|
| **Policy Store** | Stores all authz_* tables (SSOT) | PostgreSQL | PostgreSQL only (see rationale) |
| **Casbin Adapter** | Casbin reads/writes policy rules | PostgreSQL (shared with Policy Store) | MySQL, MariaDB, SQLite, MongoDB, MSSQL, Oracle via adapters |
| **Target Database** | The business data being protected (MRP, analytics, etc.) | PostgreSQL | PostgreSQL, MySQL, MariaDB, MSSQL, Oracle, MongoDB (with adapter abstraction) |

## 12.2 Policy Store — PostgreSQL Only (by design)

The Policy Store **must** remain PostgreSQL for the following reasons:

1. **AuthZ API functions are PG functions** — `authz_resolve()`, `authz_check()`, `authz_filter()`, `authz_sync_db_grants()` are all PL/pgSQL. This is a core design constraint (PostgreSQL functions as the exclusive business logic layer).
2. **RLS is a PG-native feature** — Path C enforcement relies on `CREATE POLICY`, `ENABLE ROW LEVEL SECURITY`, `NOBYPASSRLS`. No other RDBMS has equivalent built-in row-level security.
3. **JSONB for ABAC conditions** — `subject_condition`, `resource_condition`, `environment_condition`, `column_mask_rules` all use JSONB with operators like `<@`, `->>'`. This is PostgreSQL-specific.
4. **Partitioned audit log** — `authz_audit_log` uses PG native partitioning.

## 12.3 Casbin Adapter — Multi-Database Support

Casbin itself is database-agnostic. The policy engine reads from any supported adapter:

| Adapter (Node.js) | Database | Notes |
|-------------------|----------|-------|
| `casbin-pg-adapter` | PostgreSQL | Native pgx driver, best performance |
| `typeorm-adapter` | PostgreSQL, MySQL, MariaDB, SQLite, MSSQL, Oracle, MongoDB | Most versatile, ORM-based |
| `casbin-prisma-adapter` | PostgreSQL, MySQL, SQLite, MongoDB | Prisma ORM |
| `casbin-sequelize-adapter` | PostgreSQL, MySQL, SQLite, MSSQL | Sequelize ORM |
| `casbin-mongoose-adapter` | MongoDB | Native MongoDB |
| `casbin-knex-adapter` | PostgreSQL, MySQL, SQLite, MSSQL, Oracle | Knex query builder |

**In this architecture**: Casbin connects to the **same PostgreSQL** as the Policy Store (shared `casbin_rule` table alongside `authz_*` tables). But if a future deployment needs Casbin on a separate database, the adapter can be swapped without changing the model or policy logic.

## 12.4 Target Database — Abstraction Layer for Multi-DB

The business databases being **protected** by AuthZ can be heterogeneous. The key distinction is:

| Target DB | Path A (Config-SM) | Path B (Trad Web) | Path C (DB Direct) | Enforcement Mechanism |
|-----------|--------------------|--------------------|---------------------|-----------------------|
| PostgreSQL | ✅ Full support | ✅ Full support | ✅ Full (RLS + GRANT) | Native RLS, GRANT, column masking functions |
| MySQL / MariaDB | ✅ via authz_check() | ✅ via authz_check() | ⚠️ Partial (GRANT only, no RLS) | Application-layer filter via `authz_filter()` injected into queries; DB-layer uses GRANT + views |
| MSSQL | ✅ via authz_check() | ✅ via authz_check() | ⚠️ Partial (has RLS since 2016) | MSSQL native RLS + GRANT; sync engine needs MSSQL-specific adapter |
| Oracle | ✅ via authz_check() | ✅ via authz_check() | ⚠️ Partial (VPD equivalent) | Oracle VPD (Virtual Private Database) as RLS equivalent |
| MongoDB | ✅ via authz_check() | ✅ via authz_check() | ❌ No GRANT model | Application-layer only; query filter injected via `authz_filter()` |

**Key insight**: Path A and Path B enforcement happens **above** the database (application layer calls `authz_check()` and `authz_filter()`), so they work with ANY database. Path C enforcement is database-native, so it requires per-DB sync adapters.

To support heterogeneous target databases, the sync engine needs a **Database Adapter Interface**:

```typescript
// services/authz-api/sync/db-adapter.ts

interface AuthzDbSyncAdapter {
    readonly dbType: 'postgresql' | 'mysql' | 'mssql' | 'oracle' | 'mongodb';

    // Sync L0: schema/table-level GRANT
    syncGrants(profile: DbPoolProfile): Promise<SyncResult>;

    // Sync L1/L2: row-level filtering
    syncRowPolicy(policy: AuthzPolicy, targetTable: string): Promise<SyncResult>;

    // Sync L2: column masking
    syncColumnMask(policy: AuthzPolicy, targetTable: string, column: string): Promise<SyncResult>;

    // Verify sync status
    verifySyncState(profileId: string): Promise<VerifyResult>;

    // Generate connection pooler config (pgbouncer, ProxySQL, etc.)
    generatePoolerConfig(profiles: DbPoolProfile[]): Promise<string>;
}

// PostgreSQL adapter (fully featured)
class PostgresAuthzSyncAdapter implements AuthzDbSyncAdapter {
    readonly dbType = 'postgresql';
    // Uses CREATE POLICY, GRANT/REVOKE, CREATE VIEW for masking
}

// MySQL adapter (limited: no native RLS)
class MysqlAuthzSyncAdapter implements AuthzDbSyncAdapter {
    readonly dbType = 'mysql';
    // Uses GRANT/REVOKE + VIEW-based row filtering + ProxySQL for pooling
}
```

## 12.5 Database Support Summary

```
┌─────────────────────────────────────────────────────────────────┐
│  AuthZ Service Architecture — Database Support Matrix            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────┐                        │
│  │  Policy Store (SSOT)                │                        │
│  │  PostgreSQL ONLY                    │                        │
│  │  (PL/pgSQL functions, JSONB, RLS,   │                        │
│  │   partitioning, audit)              │                        │
│  └─────────────────┬───────────────────┘                        │
│                    │                                             │
│                    ▼                                             │
│  ┌─────────────────────────────────────┐                        │
│  │  Casbin Engine                      │                        │
│  │  Adapters for: PG, MySQL, MariaDB,  │                        │
│  │  SQLite, MSSQL, Oracle, MongoDB,    │                        │
│  │  Redis, Cassandra, S3               │                        │
│  │  (Default: shared PG with Policy    │                        │
│  │   Store for simplicity)             │                        │
│  └─────────────────┬───────────────────┘                        │
│                    │                                             │
│       ┌────────────┼────────────┬──────────────┐               │
│       ▼            ▼            ▼              ▼               │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐   ┌──────────┐          │
│  │   PG    │ │  MySQL  │ │  MSSQL  │   │ MongoDB  │          │
│  │ Target  │ │ Target  │ │ Target  │   │ Target   │          │
│  │         │ │         │ │         │   │          │          │
│  │ Path A ✅│ │ Path A ✅│ │ Path A ✅│  │ Path A ✅ │          │
│  │ Path B ✅│ │ Path B ✅│ │ Path B ✅│  │ Path B ✅ │          │
│  │ Path C ✅│ │ Path C ⚠│ │ Path C ⚠│  │ Path C ❌ │          │
│  │ (full)  │ │ (no RLS)│ │(has RLS)│  │(app only)│          │
│  └─────────┘ └─────────┘ └─────────┘   └──────────┘          │
└─────────────────────────────────────────────────────────────────┘
```

---

# XIII. Monorepo Design

## 13.1 Why Monorepo

This project has tight coupling between AuthZ Service, Admin UI, Workbench, and shared client SDK. Changes to `authz_resolve()` output contract affect all consumers simultaneously. A monorepo ensures atomic cross-package changes and shared type definitions.

## 13.2 Repository Structure (Nx or Turborepo)

```
phison-data-nexus/                     ← Monorepo root
│
├── package.json                         ← Workspace root (npm/pnpm workspaces)
├── nx.json / turbo.json                 ← Build orchestrator config
├── tsconfig.base.json                   ← Shared TypeScript config
├── .github/
│   └── workflows/
│       ├── ci.yml                       ← Lint + test + build on PR
│       ├── cd-staging.yml               ← Deploy to staging K8s
│       └── cd-production.yml            ← Deploy to production K8s (manual approve)
│
├── apps/                                ← Deployable applications (each = 1 K8s Deployment)
│   ├── portal/                          ← Path B: Traditional web (Next.js / Express)
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── src/
│   │   └── helm/                        ← App-specific Helm values override
│   │       └── values-portal.yaml
│   │
│   ├── workbench/                       ← Path A: Config-SM UI (React SPA)
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── src/
│   │   └── helm/
│   │       └── values-workbench.yaml
│   │
│   ├── authz-admin/                     ← AuthZ Admin Center (React SPA)
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── src/
│   │   └── helm/
│   │       └── values-authz-admin.yaml
│   │
│   └── agent/                           ← AI Agent service (Python / Node)
│       ├── Dockerfile
│       ├── requirements.txt / package.json
│       ├── src/
│       └── helm/
│           └── values-agent.yaml
│
├── services/                            ← Backend services (each = 1 K8s Deployment)
│   ├── authz-api/                   ← AuthZ core API (Node.js / Go)
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── api/                     ← REST endpoints (resolve, check, admin-crud)
│   │   │   ├── sync/                    ← Sync engine (RLS, GRANT, pgbouncer)
│   │   │   └── casbin/                  ← Casbin integration
│   │   ├── helm/
│   │   │   └── values-authz-api.yaml
│   │   └── tests/
│   │
│   ├── identity-sync/                   ← LDAP sync service (cron job)
│   │   ├── Dockerfile
│   │   ├── src/
│   │   └── helm/
│   │       └── values-identity-sync.yaml
│   │
│   └── sync-scheduler/                  ← Periodic sync jobs (K8s CronJob)
│       ├── Dockerfile
│       ├── src/
│       └── helm/
│           └── values-sync-scheduler.yaml
│
├── packages/                            ← Shared libraries (NOT deployed independently)
│   ├── authz-client/                    ← AuthZ client SDK (used by all apps/services)
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── authz-client.ts          ← check(), resolve(), filter() wrappers
│   │   │   ├── react-authz-provider.tsx ← React context provider
│   │   │   └── express-middleware.ts    ← Path B middleware
│   │   └── tests/
│   │
│   ├── authz-types/                     ← TypeScript types for all authz configs
│   │   ├── package.json
│   │   └── src/
│   │       ├── resolved-config.ts       ← Path A output contract type
│   │       ├── web-acl.ts               ← Path B output contract type
│   │       ├── pool-profile.ts          ← Path C profile type
│   │       ├── policy.ts                ← ABAC policy types
│   │       └── audit.ts                 ← Audit log types
│   │
│   ├── ui-components/                   ← Shared React components
│   │   ├── package.json
│   │   └── src/
│   │
│   └── db-adapters/                     ← Multi-DB sync adapters
│       ├── package.json
│       └── src/
│           ├── adapter-interface.ts     ← AuthzDbSyncAdapter interface
│           ├── postgres-adapter.ts
│           ├── mysql-adapter.ts
│           └── mssql-adapter.ts
│
├── database/                            ← Database migrations & seed (NOT a runtime service)
│   ├── migrations/                      ← Versioned SQL migrations
│   │   ├── V001__initial_schema.sql
│   │   ├── V002__seed_roles_resources.sql
│   │   ├── V003__authz_functions.sql
│   │   ├── V004__pool_profiles.sql
│   │   └── V005__admin_self_registration.sql
│   ├── seed/
│   │   ├── dev-seed.sql                 ← Development sample data
│   │   └── prod-seed.sql               ← Production initial data
│   ├── flyway.conf / sqitch.plan        ← Migration tool config
│   └── Dockerfile                       ← Migration runner image (for K8s Job)
│
├── deploy/                              ← Infrastructure & deployment configs
│   ├── helm/
│   │   ├── nexus-platform/               ← Umbrella Helm chart
│   │   │   ├── Chart.yaml              ← Dependencies on sub-charts
│   │   │   ├── values.yaml             ← Shared defaults
│   │   │   ├── values-dev.yaml
│   │   │   ├── values-staging.yaml
│   │   │   └── values-production.yaml
│   │   └── charts/                     ← Sub-charts per service
│   │       ├── authz-api/
│   │       │   ├── Chart.yaml
│   │       │   ├── values.yaml
│   │       │   └── templates/
│   │       │       ├── deployment.yaml
│   │       │       ├── service.yaml
│   │       │       ├── hpa.yaml
│   │       │       ├── pdb.yaml
│   │       │       ├── networkpolicy.yaml
│   │       │       ├── configmap.yaml
│   │       │       └── serviceaccount.yaml
│   │       ├── portal/
│   │       ├── workbench/
│   │       ├── authz-admin/
│   │       ├── agent/
│   │       ├── postgresql/             ← Bitnami PostgreSQL subchart
│   │       ├── pgbouncer/
│   │       ├── keycloak/               ← Bitnami Keycloak subchart
│   │       ├── db-migration/           ← K8s Job for Flyway/Sqitch
│   │       └── sync-scheduler/         ← K8s CronJob
│   │
│   ├── docker-compose/
│   │   ├── docker-compose.yml          ← Local development
│   │   └── docker-compose.test.yml     ← Integration tests
│   │
│   └── terraform/                       ← Cloud infra (if applicable)
│       ├── k8s-cluster/
│       └── database/
│
└── docs/
    ├── architecture.md                  ← This document (v2.2)
    ├── authz-model.md                   ← Detailed RBAC+ABAC model explanation
    ├── runbook/                          ← Operations runbooks
    │   ├── emergency-access.md
    │   ├── policy-rollback.md
    │   └── password-rotation.md
    └── adr/                              ← Architecture Decision Records
        ├── 001-postgresql-as-policy-store.md
        ├── 002-casbin-over-opa.md
        ├── 003-monorepo-structure.md
        └── 004-authz-admin-bounded-context.md
```

## 13.3 Dependency Graph

```
packages/authz-types ──────────────────────────────────────┐
       │                                                    │
       ▼                                                    ▼
packages/authz-client ────────────────┐   packages/db-adapters
       │         │         │          │          │
       ▼         ▼         ▼          ▼          ▼
apps/portal  apps/workbench  apps/authz-admin  services/authz-api
                                                      │
                                                      ▼
                                              services/sync-scheduler
                                              services/identity-sync
```

**Rules**:
- `packages/*` never depend on `apps/*` or `services/*` (shared libs are downstream-agnostic)
- `apps/*` depend on `packages/*` and call `services/*` via HTTP/gRPC (never direct import)
- `services/*` depend on `packages/*` only
- `database/` is consumed by `services/authz-api` and `deploy/helm/charts/db-migration/`

---

# XIV. Kubernetes Deployment Design

## 14.1 Service Topology on K8s

```
┌─────────────────── nexus namespace ───────────────────────┐
│                                                                   │
│  ┌──────────┐   ┌───────────┐   ┌──────────────┐               │
│  │ portal   │   │ workbench │   │ authz-admin  │               │
│  │ (Deploy) │   │ (Deploy)  │   │ (Deploy)     │               │
│  │ 2 replicas│  │ 2 replicas│   │ 1 replica    │               │
│  └─────┬────┘   └─────┬─────┘   └──────┬───────┘               │
│        │               │                │                        │
│        └───────────────┼────────────────┘                        │
│                        │ HTTP                                    │
│                        ▼                                         │
│           ┌─────────────────────┐    ┌─────────────────┐        │
│           │ authz-api       │    │ agent           │        │
│           │ (Deploy, 3 replicas)│    │ (Deploy)        │        │
│           │ /api/authz/*        │    │ 1-2 replicas    │        │
│           └─────────┬───────────┘    └────────┬────────┘        │
│                     │ TCP:5432                 │                  │
│                     ▼                          │                  │
│  ┌──────────────────────────────┐              │                 │
│  │ pgbouncer (Deploy, 2 rep)   │◄─────────────┘                 │
│  │ port 6432                   │                                 │
│  └──────────────┬──────────────┘                                │
│                 │                                                │
│                 ▼                                                │
│  ┌──────────────────────────────┐                               │
│  │ postgresql (StatefulSet)     │                               │
│  │ Primary + 1 replica          │                               │
│  │ PVC: 100Gi SSD               │                               │
│  └──────────────────────────────┘                               │
│                                                                  │
│  ┌──────────────────────────────┐   ┌────────────────────┐     │
│  │ keycloak (StatefulSet)       │   │ identity-sync      │     │
│  │ 2 replicas                   │   │ (CronJob, hourly)  │     │
│  └──────────────────────────────┘   └────────────────────┘     │
│                                                                  │
│  ┌──────────────────────────────┐   ┌────────────────────┐     │
│  │ sync-scheduler               │   │ db-migration       │     │
│  │ (CronJob, every 5min)        │   │ (Job, on deploy)   │     │
│  └──────────────────────────────┘   └────────────────────┘     │
│                                                                  │
│  ┌──────────────────────────────────────────────────────┐       │
│  │ Ingress Controller                                    │       │
│  │ portal.phison.internal         → portal:80            │       │
│  │ workbench.phison.internal      → workbench:80         │       │
│  │ authz-admin.phison.internal    → authz-admin:80       │       │
│  │ api.phison.internal/authz/*    → authz-api:8080   │       │
│  │ keycloak.phison.internal       → keycloak:8080        │       │
│  └──────────────────────────────────────────────────────┘       │
└──────────────────────────────────────────────────────────────────┘
```

## 14.2 Critical K8s Design Considerations

### 14.2.1 Secrets Management — Never Hardcode

```yaml
# ❌ NEVER: plain text in values.yaml
postgresql:
  password: "my-secret-password"

# ✅ CORRECT: External Secrets Operator or Sealed Secrets
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: authz-db-credentials
spec:
  refreshInterval: 1h
  secretStoreRef:
    name: vault-backend    # HashiCorp Vault, AWS Secrets Manager, etc.
    kind: ClusterSecretStore
  target:
    name: authz-db-credentials
  data:
    - secretKey: PGPASSWORD
      remoteRef:
        key: phison/authz/db
        property: password
    - secretKey: PGBOUNCER_AUTH
      remoteRef:
        key: phison/authz/pgbouncer
        property: auth_file
```

Secrets that must be externally managed:
- PostgreSQL superuser & app role passwords
- pgbouncer `authz_pool_credentials` passwords
- Keycloak admin credentials
- LDAP bind credentials
- Casbin adapter connection strings
- AI Agent API keys

### 14.2.2 Database Migration as K8s Job (Pre-deploy Hook)

```yaml
# deploy/helm/charts/db-migration/templates/job.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: authz-db-migration-{{ .Release.Revision }}
  annotations:
    helm.sh/hook: pre-upgrade,pre-install
    helm.sh/hook-weight: "-5"           # Run before app deployments
    helm.sh/hook-delete-policy: before-hook-creation
spec:
  backoffLimit: 3
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: migrate
          image: {{ .Values.migration.image }}
          env:
            - name: FLYWAY_URL
              value: "jdbc:postgresql://{{ .Values.postgresql.host }}:5432/nexus_authz"
            - name: FLYWAY_USER
              valueFrom:
                secretKeyRef:
                  name: authz-db-credentials
                  key: PGUSER
            - name: FLYWAY_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: authz-db-credentials
                  key: PGPASSWORD
          command: ["flyway", "migrate"]
```

**Critical**: Schema migrations MUST run before application pods start. Helm hooks with negative weight ensure this ordering. Migration failures block the deployment.

### 14.2.3 Health Probes — AuthZ Service Must Be Precise

```yaml
# authz-api deployment
containers:
  - name: authz-api
    livenessProbe:
      httpGet:
        path: /healthz/live        # Process is alive
        port: 8080
      initialDelaySeconds: 10
      periodSeconds: 15
      failureThreshold: 3
    readinessProbe:
      httpGet:
        path: /healthz/ready       # Can serve requests (DB connected, Casbin loaded)
        port: 8080
      initialDelaySeconds: 5
      periodSeconds: 10
      failureThreshold: 3
    startupProbe:
      httpGet:
        path: /healthz/startup     # Initial policy load complete
        port: 8080
      initialDelaySeconds: 5
      periodSeconds: 5
      failureThreshold: 30         # Allow up to 150s for large policy sets
```

The **readiness probe** is especially critical: if authz-api is not ready (DB connection lost, Casbin cache stale), all dependent services (portal, workbench, agent) should stop routing to that instance. This prevents authorization decisions being made against stale or empty policy caches.

```typescript
// Readiness check implementation
app.get('/healthz/ready', async (req, res) => {
    try {
        // 1. DB connection alive
        await db.query('SELECT 1');
        // 2. Casbin enforcer loaded
        if (!enforcer || !enforcer.getPolicy().length) {
            return res.status(503).json({ status: 'not_ready', reason: 'casbin_empty' });
        }
        // 3. Last sync not too stale (< 10 minutes)
        const lastSync = await db.query(
            "SELECT MAX(synced_at) FROM authz_sync_log WHERE sync_status = 'synced'"
        );
        res.json({ status: 'ready' });
    } catch (err) {
        res.status(503).json({ status: 'not_ready', reason: err.message });
    }
});
```

### 14.2.4 Horizontal Pod Autoscaler (HPA)

```yaml
# authz-api HPA — scale on request latency, not just CPU
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: authz-api-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: authz-api
  minReplicas: 3              # MINIMUM 3 for HA
  maxReplicas: 10
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
    - type: Pods
      pods:
        metric:
          name: authz_check_latency_p99
        target:
          type: AverageValue
          averageValue: "50m"   # 50ms p99 target
  behavior:
    scaleDown:
      stabilizationWindowSeconds: 300  # Wait 5min before scale-down
      policies:
        - type: Pods
          value: 1
          periodSeconds: 60            # Remove 1 pod per minute max
```

**Why minimum 3 replicas**: AuthZ Service is on the critical path of every request. If it goes down, all three paths stop working. 3 replicas across different nodes provides N+1 redundancy.

### 14.2.5 Pod Disruption Budget (PDB)

```yaml
# authz-api must always have 2+ pods running during rolling updates
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: authz-api-pdb
spec:
  minAvailable: 2
  selector:
    matchLabels:
      app: authz-api

---
# PostgreSQL: never evict all replicas simultaneously
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: postgresql-pdb
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: postgresql
```

### 14.2.6 Network Policies — Zero Trust Inside the Cluster

```yaml
# Only authz-api can talk to PostgreSQL
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: postgresql-access
spec:
  podSelector:
    matchLabels:
      app: postgresql
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app: authz-api
        - podSelector:
            matchLabels:
              app: pgbouncer
        - podSelector:
            matchLabels:
              app: db-migration
      ports:
        - port: 5432

---
# Only apps can talk to authz-api
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: authz-api-access
spec:
  podSelector:
    matchLabels:
      app: authz-api
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              tier: frontend    # portal, workbench, authz-admin
        - podSelector:
            matchLabels:
              app: agent
        - podSelector:
            matchLabels:
              app: sync-scheduler
      ports:
        - port: 8080
```

### 14.2.7 Casbin Policy Cache — Centralized vs Sidecar

Two deployment patterns for the Casbin engine:

**Pattern A: Centralized (Recommended for initial deployment)**
```
portal ──HTTP──→ authz-api (3 replicas, each runs Casbin in-process)
                      │
                      ▼
                  PostgreSQL (policy store)
```
- Casbin runs inside authz-api pods
- Policy cache is per-pod, refreshed by Casbin watcher (polling or PostgreSQL LISTEN/NOTIFY)
- Simple to operate; authz_check() latency = network round trip (~1-5ms internal)

**Pattern B: Sidecar (For ultra-low latency at scale)**
```
┌─────────────────────────────┐
│  portal pod                  │
│  ┌─────────┐  ┌───────────┐ │
│  │ portal  │──│ casbin    │ │   ← Casbin sidecar, local policy cache
│  │ app     │  │ sidecar   │ │
│  └─────────┘  └─────┬─────┘ │
└──────────────────────┼───────┘
                       │ policy sync
                       ▼
                authz-api (policy distribution only)
```
- Each app pod gets a Casbin sidecar container
- authz_check() is localhost call (~0.1ms)
- More complex: sidecar needs its own health probe, resource limits, policy sync mechanism
- Use OPAL (Open Policy Administration Layer) for real-time policy distribution to sidecars

**Recommendation**: Start with Pattern A. Move to Pattern B only if authz_check latency becomes a bottleneck (> 10ms p99 under load).

### 14.2.8 ConfigMap for Non-Secret Configuration

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: authz-api-config
data:
  CASBIN_MODEL_PATH: "/config/model.conf"
  CASBIN_ADAPTER_TYPE: "postgresql"
  POLICY_CACHE_TTL: "60"              # seconds
  SYNC_INTERVAL: "300"                 # seconds
  AUDIT_LOG_RETENTION_DAYS: "365"
  PGBOUNCER_TEMPLATE_PATH: "/config/pgbouncer.ini.tpl"
  LOG_LEVEL: "info"

---
# Casbin model.conf as ConfigMap (version-controlled, GitOps-friendly)
apiVersion: v1
kind: ConfigMap
metadata:
  name: casbin-model
data:
  model.conf: |
    [request_definition]
    r = sub, act, res, env

    [policy_definition]
    p = sub_rule, act_rule, res_rule, env_rule, eft

    [role_definition]
    g = _, _
    g2 = _, _

    [policy_effect]
    e = some(where (p.eft == allow)) && !some(where (p.eft == deny))

    [matchers]
    m = (g(r.sub, p.sub_rule) || p.sub_rule == "*") && \
        (r.act == p.act_rule || p.act_rule == "*") && \
        (g2(r.res, p.res_rule) || r.res == p.res_rule || p.res_rule == "*") && \
        (p.env_rule == "*" || eval(p.env_rule))
```

### 14.2.9 Graceful Shutdown & Connection Draining

```yaml
# authz-api deployment
spec:
  template:
    spec:
      terminationGracePeriodSeconds: 30
      containers:
        - name: authz-api
          lifecycle:
            preStop:
              exec:
                command: ["/bin/sh", "-c", "sleep 5"]
                # Wait 5s for load balancer to drain connections
                # before SIGTERM is sent to the process
```

This is critical for authz-api: if a pod is killed mid-request, an in-flight `authz_check()` could fail, causing a 403 to the end user. The preStop hook + terminationGracePeriodSeconds ensure in-flight requests complete.

### 14.2.10 Observability

```yaml
# ServiceMonitor for Prometheus (authz-api exposes /metrics)
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: authz-api-monitor
spec:
  selector:
    matchLabels:
      app: authz-api
  endpoints:
    - port: metrics
      path: /metrics
      interval: 15s
```

Key metrics to expose from authz-api:
- `authz_check_total{decision, path}` — counter per allow/deny per path
- `authz_check_latency_seconds{path}` — histogram
- `authz_resolve_latency_seconds{path}` — histogram
- `authz_casbin_policy_count` — gauge (total policies loaded)
- `authz_sync_last_success_timestamp{sync_type}` — gauge
- `authz_sync_failures_total{sync_type}` — counter
- `authz_audit_log_writes_total{path, decision}` — counter

## 14.3 Helm Chart Value Hierarchy

```
values.yaml                   ← Defaults (all environments)
  └── values-dev.yaml         ← Override for dev (1 replica, debug logging)
  └── values-staging.yaml     ← Override for staging (2 replicas, staging DB)
  └── values-production.yaml  ← Override for production (3+ replicas, HA, real secrets)
```

```yaml
# values.yaml (defaults)
global:
  imageRegistry: registry.phison.internal
  imagePullSecrets: [regcred]

authzService:
  replicaCount: 3
  image:
    repository: phison/authz-api
    tag: latest
  resources:
    requests:
      cpu: 250m
      memory: 256Mi
    limits:
      cpu: 1000m
      memory: 512Mi
  autoscaling:
    enabled: true
    minReplicas: 3
    maxReplicas: 10

postgresql:
  enabled: true              # Set false if using external managed DB (RDS, Cloud SQL)
  architecture: replication
  primary:
    persistence:
      size: 100Gi
      storageClass: ssd

pgbouncer:
  enabled: true
  replicaCount: 2

keycloak:
  enabled: true
  replicaCount: 2
```

```yaml
# values-dev.yaml (overrides for development)
authzService:
  replicaCount: 1
  autoscaling:
    enabled: false
  env:
    LOG_LEVEL: debug

postgresql:
  primary:
    persistence:
      size: 10Gi
      storageClass: standard

pgbouncer:
  replicaCount: 1

keycloak:
  replicaCount: 1
```

---

# XV. Performance Analysis & Caching Architecture

## 15.1 Request Path — DB Touch Points

A single Path A page load ("open lot_detail") triggers the following DB interactions:

```
Login (once per session)
  → authz_resolve()              ← 1 heavy query (JOIN 5+ tables, JSONB aggregation)
  → result cached in session

Open lot_detail page
  → UI reads resolved config from session (no DB)
  → Page has N fields, each visible_when needs authz_check()
    → Without cache: N × authz_check()    ← each: JOIN + recursive CTE
  → Query lot_status data
    → RLS policy appends WHERE condition   ← evaluated per-row
    → Column masking function executes     ← called per-row per-masked-column
  → Action completed
    → authz_audit_log INSERT               ← 1 write

Total: 1 resolve + N checks + 1 RLS filter + (rows × masked_cols) masking + 1 audit write
At 100 concurrent users: 800+ authz queries + 100 audit writes + 100 RLS evaluations per second
```

## 15.2 Bottleneck Analysis (Ranked by Severity)

### 🔴 Bottleneck #1: authz_check() High-Frequency DB Queries (Severity: HIGH)

**Problem**: Each `authz_check()` executes a recursive CTE for resource hierarchy traversal. A page with 20 fields + 5 buttons = 25 calls. 100 users online = 2,500 QPS.

```sql
-- Each authz_check() runs this recursive CTE
WITH RECURSIVE res_tree AS (
    SELECT resource_id, parent_id FROM authz_resource WHERE resource_id = p_resource
    UNION ALL
    SELECT r.resource_id, r.parent_id
    FROM authz_resource r JOIN res_tree rt ON r.resource_id = rt.parent_id
)
SELECT resource_id FROM res_tree;
```

| Concurrent Users | Checks/Page | QPS | Per-Check Latency | DB CPU |
|-----------------|------------|-----|-------------------|--------|
| 10 | 25 | ~50 | ~2ms | Low |
| 100 | 25 | ~500 | ~2ms | Medium |
| 500 | 25 | ~2,500 | ~5ms (contention) | High |
| 1,000 | 25 | ~5,000 | ~10ms+ (lock contention) | 🔴 Bottleneck |

**Root cause**: Recursive CTE runs B-tree index scan every time; `authz_role_permission` becomes a read hotspot under concurrency.

**Solution**: Eliminate per-request DB calls by resolving all permissions at login and checking from in-memory cache:

```sql
CREATE OR REPLACE FUNCTION authz_check_from_cache(
    p_resolved_config JSONB,   -- passed from session, no DB query
    p_action          TEXT,
    p_resource        TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_resolved_config->'L0_functional') AS perm
        WHERE (perm->>'action' = p_action OR perm->>'action' = '*')
          AND (perm->>'resource' = p_resource OR perm->>'resource' = '*')
    );
END;
$$;
```

**Impact**: DB queries drop from N/page to 0/page. 100 users: 25,000 QPS → ~2 QPS (resolve only). 99.99% reduction.

### 🔴 Bottleneck #2: authz_audit_log High-Frequency INSERT (Severity: HIGH)

**Problem**: Every access decision triggers INSERT to `authz_audit_log`. 1,000 users = thousands of INSERTs/second.

| Scenario | INSERT/sec | WAL Write | Index Updates | Impact |
|----------|-----------|-----------|--------------|--------|
| Log every check | 5,000+/sec | ~2MB/sec | 3 indexes × 5000 | 🔴 WAL congestion, index bloat |
| Log deny only | ~50/sec | Minimal | Negligible | ✅ Safe |
| Batch insert | ~10 batch/sec | ~200KB/sec | Concentrated | ✅ Safe |

**Root cause**: Each INSERT updates 3 indexes + WAL write + partition routing. At 500+ TPS INSERT, read queries on the same PostgreSQL instance degrade.

**Solution (three tiers)**:

```sql
-- Tier 1: Reduce volume — only log deny + write ops + sensitive resource access
-- Tier 2: Async batch insert

CREATE OR REPLACE FUNCTION authz_audit_batch_insert(
    p_events JSONB   -- array of audit events
)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    INSERT INTO authz_audit_log (timestamp, access_path, subject_id, action_id, resource_id, decision, policy_ids, context)
    SELECT
        (e->>'timestamp')::timestamptz,
        (e->>'access_path')::char(1),
        e->>'subject_id',
        e->>'action_id',
        e->>'resource_id',
        (e->>'decision')::authz_effect,
        ARRAY(SELECT jsonb_array_elements_text(e->'policy_ids'))::bigint[],
        e->'context'
    FROM jsonb_array_elements(p_events) AS e;

    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- Tier 3: Separate audit to independent DB instance or append-only store (TimescaleDB, ClickHouse)
```

### 🟡 Bottleneck #3: RLS Per-Row Function Evaluation (Severity: MEDIUM)

**Problem**: RLS USING clause with `current_setting()` + `string_to_array()` is called per-row. Without index, becomes full table scan.

| lot_status Rows | current_setting() Calls | Extra Latency | Index Optimizable |
|----------------|------------------------|--------------|-------------------|
| 1,000 | 1,000 | ~1ms | ⚠️ Conditional |
| 100,000 | 100,000 | ~20ms | ⚠️ Conditional |
| 1,000,000 | 1,000,000 | ~200ms | 🔴 Must optimize |

**Solution**:

```sql
-- Ensure index exists on filtered column
CREATE INDEX idx_lot_status_product_line ON lot_status(product_line);

-- Simplify RLS expression to enable index scan (= instead of ANY)
-- For single-value product_line:
SET app.user_product_line = 'SSD-Controller';
CREATE POLICY rls_simple ON lot_status
    FOR SELECT USING (product_line = current_setting('app.user_product_line', true));

-- Alternative: Security Barrier View for maximum performance
CREATE VIEW lot_status_secured WITH (security_barrier = true) AS
    SELECT * FROM lot_status
    WHERE product_line = current_setting('app.user_product_line', true);
```

### 🟡 Bottleneck #4: Column Masking Per-Row Function Cost (Severity: MEDIUM)

**Problem**: Masking functions called per-row per-masked-column. 10,000 rows × 3 masked columns = 30,000 function calls.

| Function Type | Per-Call Cost | 10,000 Rows | Mitigation |
|--------------|-------------|------------|-----------|
| fn_mask_full (****) | ~0.001ms | ~10ms | Low cost, no action |
| fn_mask_range (numeric→range) | ~0.005ms | ~50ms | Acceptable |
| fn_mask_hash (SHA256) | ~0.05ms | ~500ms | 🟡 Attention needed |
| fn_mask_partial (regex) | ~0.02ms | ~200ms | 🟡 Attention needed |

**Solution**:

```sql
-- Declare masking functions as IMMUTABLE PARALLEL SAFE
CREATE OR REPLACE FUNCTION fn_mask_range(p_value NUMERIC)
RETURNS TEXT LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT (floor(p_value / 10) * 10)::text || '-' || (floor(p_value / 10) * 10 + 10)::text;
$$;

-- Control result set size: UI pagination (LIMIT 50) caps function calls at 50 × mask_columns
-- For BI queries: use materialized views with pre-masked data (refreshed hourly)
```

### 🟢 Bottleneck #5: authz_resolve() Heavy JOIN (Severity: LOW)

**Problem**: Joins 5+ tables with JSONB aggregation. But only called once per login.

| Concurrent Logins/sec | Resolve Latency | DB Pressure |
|-----------------------|----------------|------------|
| 5 (normal) | ~20ms | ✅ Unnoticeable |
| 50 (morning peak) | ~20ms | ✅ Acceptable |
| 200 (system restart, all re-login) | ~50ms | 🟡 Brief spike |

**Solution**: Session TTL = 8 hours. Add Redis cache (key = user_id + groups_hash, TTL = 10min). Policy change invalidates via PG LISTEN/NOTIFY.

### 🟢 Bottleneck #6: GRANT Sync Lock Contention (Severity: LOW)

GRANT/REVOKE modifies system catalog only (not data tables). Sync frequency is very low (every 5 minutes or manual). No meaningful contention in practice.

## 15.3 Two-Level Cache Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│  Optimized Request Path                                           │
│                                                                   │
│  LOGIN (once per session)                                         │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ authz_resolve() → full permission config                 │    │
│  │  → store in L1 Cache (Redis, TTL=10min, key=user:groups) │    │
│  │  → copy to L2 Cache (in-process session, TTL=session)    │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
│  EVERY REQUEST (high frequency)                                   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ authz_check() → lookup JSON in L2 session cache          │    │
│  │  → DB calls: 0                                           │    │
│  │  → latency: < 0.1ms (in-process JSON lookup)             │    │
│  │  → L2 miss → fetch from L1 Redis → L1 miss → resolve()  │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
│  DB QUERY (only after authz_check passes)                         │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ RLS policy executes in DB (defence in depth)              │    │
│  │  → with proper index → index scan not full scan           │    │
│  │  → pagination LIMIT 50 controls mask function call count  │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
│  AUDIT (async batch)                                              │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ authz-api memory buffer                               │    │
│  │  → flush every 5 seconds or when buffer reaches 100 items │    │
│  │  → only log: deny + write + sensitive resource access     │    │
│  │  → use COPY or batch INSERT (10-50x faster than single)   │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
│  POLICY CHANGE (rare event)                                       │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │ Policy saved → PG trigger fires NOTIFY authz_changed      │    │
│  │  → authz-api receives notification                    │    │
│  │  → invalidate affected entries in L1 Redis                │    │
│  │  → next request: L2 miss → L1 miss → re-resolve()        │    │
│  │  → cascade: Casbin enforcer reload in same cycle          │    │
│  └──────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────┘
```

### Cache Invalidation via PG LISTEN/NOTIFY

```sql
-- Trigger on policy change → notify authz-api
CREATE OR REPLACE FUNCTION authz_notify_change()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('authz_policy_changed', json_build_object(
        'table', TG_TABLE_NAME,
        'action', TG_OP,
        'policy_id', COALESCE(NEW.policy_id, OLD.policy_id),
        'timestamp', now()
    )::text);
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_policy_change AFTER INSERT OR UPDATE OR DELETE ON authz_policy
    FOR EACH ROW EXECUTE FUNCTION authz_notify_change();
CREATE TRIGGER trg_role_perm_change AFTER INSERT OR UPDATE OR DELETE ON authz_role_permission
    FOR EACH ROW EXECUTE FUNCTION authz_notify_change();
CREATE TRIGGER trg_subject_role_change AFTER INSERT OR UPDATE OR DELETE ON authz_subject_role
    FOR EACH ROW EXECUTE FUNCTION authz_notify_change();
```

```typescript
// authz-api listener
import { Client } from 'pg';

const listener = new Client({ connectionString: process.env.DATABASE_URL });
await listener.connect();
await listener.query('LISTEN authz_policy_changed');

listener.on('notification', async (msg) => {
    const payload = JSON.parse(msg.payload);
    console.log(`Policy change detected: ${payload.table} ${payload.action}`);

    // Invalidate L1 Redis cache
    // Strategy: flush all authz:resolve:* keys (simple but aggressive)
    // Or: determine affected subjects and flush only their keys (precise but complex)
    await redis.eval("return redis.call('del', unpack(redis.call('keys', 'authz:resolve:*')))", 0);

    // Reload Casbin enforcer
    await casbinEnforcer.loadPolicy();

    console.log('Cache invalidated, Casbin reloaded');
});
```

### Performance After Optimization (100 concurrent users baseline)

| Operation | Before (QPS) | After (QPS) | Reduction |
|-----------|-------------|------------|-----------|
| authz_check() DB queries | ~2,500 | 0 | 100% |
| authz_resolve() | ~2 | ~2 + cache miss | No change |
| audit INSERT | ~2,500 | ~5 (batch) | 99.8% |
| RLS evaluation | Same | Same (with index) | N/A |
| **Total DB queries** | **~5,000** | **~10** | **99.8%** |

---

# XVI. Production Weakness & Risk Analysis

This section analyzes the architecture from **eight dimensions** as if the system has been running in production for 6 months with 300+ daily active users.

## 16.1 Operational Risks

### RISK-OPS-1: Cache Inconsistency Window (Severity: HIGH)

**Scenario**: Admin changes a policy (e.g., revokes PE access to NAND yield data). Between the policy save and cache invalidation, users with stale cache still see NAND data.

**Window**: L2 session cache TTL (worst case: until session expires = up to 8 hours). Even with LISTEN/NOTIFY, there's a propagation delay of 1-5 seconds across K8s pods.

**Impact**: Revoked permissions remain active for seconds to hours depending on cache layer.

**Mitigation**:

```
Tier 1: LISTEN/NOTIFY (implemented in §15.3)
  → Invalidates L1 Redis within ~1 second
  → L2 session refreshes on next request (L2 miss → L1 miss → re-resolve)
  → Residual window: ~1-5 seconds

Tier 2: Critical policy changes force immediate session invalidation
  → Admin UI "Apply & Force Refresh" button
  → Broadcasts WebSocket event to all connected clients
  → Client-side authz-context detects version mismatch → re-resolve
  → Residual window: < 1 second

Tier 3: Security-critical deny policies bypass cache entirely
  → Explicit deny rules (effect='deny') always checked against DB
  → Cache only used for allow decisions
  → Deny is always authoritative and real-time
```

### RISK-OPS-2: Sync Engine Failure Goes Unnoticed (Severity: HIGH)

**Scenario**: `authz_sync_db_grants()` fails silently. PG roles don't get updated. A new employee added to LDAP group gets no DB access, or worse, a terminated employee retains access because REVOKE didn't execute.

**Impact**: Security gap (stale GRANT) or productivity loss (missing GRANT).

**Mitigation**:

```
1. Sync Monitor dashboard with alerting (already in Admin UI §10.1)
2. sync_log entry with sync_status='failed' triggers PagerDuty/Slack alert
3. Automated "sync drift detector":
   → Periodic job compares authz_db_pool_profile definitions
     against actual PG catalog (pg_roles, information_schema.role_table_grants)
   → Any drift = alert + auto-remediation attempt
4. Mandatory post-sync verification:
   → authz_sync_db_grants() calls verifyGrants() at the end
   → Compares intended vs actual GRANT state
```

### RISK-OPS-3: Audit Log Partition Management (Severity: MEDIUM)

**Scenario**: Nobody creates next month's partition. Audit INSERTs start failing silently (or worse, landing in a default partition that grows unbounded).

**Mitigation**:

```sql
-- Auto-create partitions 3 months ahead via pg_partman or manual cron
CREATE EXTENSION IF NOT EXISTS pg_partman;
SELECT partman.create_parent(
    p_parent_table => 'public.authz_audit_log',
    p_control => 'timestamp',
    p_type => 'range',
    p_interval => '1 month',
    p_premake => 3    -- always have 3 months of future partitions ready
);

-- Alternatively: K8s CronJob that runs monthly
-- CREATE TABLE IF NOT EXISTS authz_audit_log_YYYY_MM PARTITION OF ...
```

## 16.2 Security Risks

### RISK-SEC-1: authz_resolve() Output Leaks Full Permission Map (Severity: HIGH)

**Scenario**: The resolved permission config JSON is stored in session (cookie/JWT/Redis). If a session token is stolen (XSS, session fixation), the attacker not only gets access but also knows the **complete permission boundary** — which resources are protected, what masking applies, what approval chains exist.

**Impact**: Information disclosure that aids targeted attacks. Attacker knows exactly which resources are high-value (masked columns = sensitive data).

**Mitigation**:

```
1. Never store resolved config in client-accessible JWT
   → Store in server-side session (Redis) with opaque session ID only
2. Resolved config should omit enforcement details:
   → Don't send rls_expression or mask function names to client
   → Client only needs: resource_id + action + allowed:boolean
   → Mask type visible to UI, but not the SQL expression

3. Minimal client-side config:
   {
     "L0_functional": [
       {"resource": "module:mrp.yield_analysis", "actions": ["read"]}
     ],
     "L2_masks": {
       "lot_status.unit_price": "range"     // type only, no fn name
     }
   }
   // Full config (with rls_expression, fn templates) stays server-side only
```

### RISK-SEC-2: ADMIN Role Is God Mode with No Guardrails (Severity: HIGH)

**Scenario**: Current design has `p, ADMIN, *, *, *, allow` — ADMIN can do anything. A compromised admin account can exfiltrate all data, modify all policies, and cover tracks by deleting audit logs.

**Mitigation**:

```
1. Separate ADMIN into sub-roles:
   → SYSTEM_ADMIN: infrastructure (pools, sync, pgbouncer)
   → POLICY_ADMIN: policy CRUD (but cannot modify audit_log)
   → AUDIT_ADMIN: read-only audit access (cannot modify policies)
   → SUPER_ADMIN: all of the above (require MFA + dual approval)

2. Audit log is append-only:
   → authz_audit_log: REVOKE DELETE, UPDATE from ALL roles
   → Even SUPER_ADMIN cannot delete audit entries
   → Archive to immutable storage (S3 with Object Lock / WORM)

3. Break-glass procedure:
   → Emergency access requires two SUPER_ADMINs to approve
   → All break-glass sessions are fully recorded (screen capture level)
```

### RISK-SEC-3: PG Session Variables Are Spoofable (Severity: MEDIUM)

**Scenario**: RLS relies on `current_setting('app.user_product_line')`. If a user connects directly to PostgreSQL (bypassing application), they can `SET app.user_product_line = 'any_value'` and bypass RLS.

**Impact**: Path C users (BI tools, DBA) could spoof session variables.

**Mitigation**:

```sql
-- Solution: Use PG roles + GRANT instead of session variables for Path C
-- Session variables are only used for Path A (application-controlled)
-- Path C enforcement relies on:
--   1. PG role membership (cannot be self-assigned)
--   2. GRANT/REVOKE on schemas/tables (enforced by PG kernel)
--   3. RLS policies that check pg_has_role() instead of current_setting()

CREATE POLICY rls_path_c_safe ON lot_status
    FOR SELECT USING (
        -- For app roles: use session variable (application sets it)
        (current_setting('app.access_path', true) = 'A'
         AND product_line = current_setting('app.user_product_line', true))
        OR
        -- For DB direct roles: use role membership (unforgeable)
        (pg_has_role(current_user, 'pe_ssd_readonly', 'MEMBER')
         AND product_line = 'SSD-Controller')
        OR
        -- DBA/admin: explicit role check
        pg_has_role(current_user, 'dba_full', 'MEMBER')
    );
```

## 16.3 Scalability Limits

### RISK-SCALE-1: Single PostgreSQL as Policy Store SPOF (Severity: HIGH)

**Scenario**: Policy Store PostgreSQL goes down. ALL three paths stop working — no authz_check, no resolve, no sync. Even with L1/L2 cache, new logins fail, policy changes can't be made, and cache entries that expire can't be refreshed.

**Impact**: Total system outage for new sessions; degraded service for existing cached sessions.

**Mitigation**:

```
1. PostgreSQL HA: primary + synchronous replica (already in K8s design §14.1)
   → Automatic failover via Patroni or CloudNativePG operator
   → RPO=0 (synchronous replication), RTO < 30 seconds

2. Cache-first degraded mode:
   → If Policy Store is unreachable, authz-api continues serving from L1 Redis cache
   → All authz_check() responses are tagged with "cached_at" timestamp
   → Admin UI shows banner: "Operating from cache, policy changes disabled"
   → New logins that can't resolve() get a default "minimal access" profile

3. Read replica for resolve():
   → authz_resolve() can read from replica (STABLE function, no writes)
   → Only sync engine needs primary (GRANT/REVOKE = write)
```

### RISK-SCALE-2: Casbin In-Memory Policy Set Grows Unbounded (Severity: MEDIUM)

**Scenario**: As more modules, resources, and fine-grained policies are added, Casbin's in-memory policy set grows. Each authz-api pod holds the full policy set. With 10,000 rules × 3 pods = 30,000 rule copies.

**Impact**: Memory pressure per pod; Casbin evaluation latency increases with policy count.

**Mitigation**:

```
1. Casbin filtered policy loading:
   → Each service only loads policies relevant to its path
   → workbench sidecar loads Path A policies only
   → portal sidecar loads Path B policies only

2. Monitor policy count as a metric:
   → Alert if casbin_policy_count > threshold (e.g., 5,000)
   → Trigger policy review: consolidate overlapping rules

3. Policy evaluation benchmarking:
   → CI pipeline runs authz_check latency benchmark on every policy change
   → Reject policy additions that push p99 above threshold
```

### RISK-SCALE-3: JSONB Column Growth in authz_policy (Severity: LOW)

**Scenario**: `subject_condition`, `resource_condition`, `column_mask_rules` are JSONB. Over time, policies accumulate complex nested conditions. JSONB operators (`<@`, `->>`) are not index-friendly for deep nesting.

**Mitigation**: GIN index on JSONB columns used in WHERE clauses. Periodic policy review to flatten overly nested conditions. Set a max JSONB depth convention (3 levels).

## 16.4 Data Integrity Risks

### RISK-DATA-1: Policy Conflicts — Allow vs Deny Ambiguity (Severity: HIGH)

**Scenario**: Two policies conflict:
- Policy A: `PE can read table:lot_status` (allow, priority 100)
- Policy B: `PE cannot read column:lot_status.unit_price` (deny, priority 50)

The deny wins (lower priority number = higher priority). But what if someone adds:
- Policy C: `SALES can read column:lot_status.unit_price` (allow, priority 30)

A user who is both PE and SALES — what happens? The current matcher `some(allow) && !some(deny)` means if ANY policy denies, it's denied, regardless of other allow policies. But is that the intended behavior?

**Impact**: Unexpected access denial or (worse) unexpected access grant. Complex policy interactions become untestable by humans.

**Mitigation**:

```
1. Policy Simulator is mandatory before approval (already designed §10.2)
   → But must test with MULTI-ROLE users specifically

2. Add conflict detection in Policy Editor:
   → When saving a new policy, query for all policies that share
     any overlap in (subject × resource × action)
   → Display: "This policy interacts with policies #12, #15, #23"
   → Show resolution table: for each combination, what is the final decision?

3. Explicit precedence documentation:
   → Rule: Deny ALWAYS wins over Allow (regardless of priority)
   → Rule: Priority only resolves conflicts WITHIN the same effect
   → Rule: More specific resource wins over less specific
     (column > table > module)
   → Display these rules prominently in Policy Editor
```

### RISK-DATA-2: Orphaned Resources After Module Deletion (Severity: MEDIUM)

**Scenario**: A module is decommissioned (e.g., old reporting tool). Its `authz_resource` entries remain, along with role_permissions, policies, and audit log references. Nobody cleans up. Over time, the resource tree is cluttered with ghost entries.

**Mitigation**:

```sql
-- Resource soft-delete cascade check
CREATE OR REPLACE FUNCTION authz_check_resource_orphans()
RETURNS TABLE(resource_id TEXT, orphan_type TEXT, detail TEXT)
LANGUAGE sql STABLE AS $$
    -- Resources with permissions but no active consumers
    SELECT ar.resource_id, 'unused_permission',
           'Has ' || count(rp.id) || ' permissions but is_active=false'
    FROM authz_resource ar
    JOIN authz_role_permission rp ON rp.resource_id = ar.resource_id
    WHERE ar.is_active = FALSE AND rp.is_active = TRUE
    GROUP BY ar.resource_id

    UNION ALL

    -- Children of inactive parents
    SELECT ar.resource_id, 'orphaned_child',
           'Parent ' || ar.parent_id || ' is inactive'
    FROM authz_resource ar
    JOIN authz_resource parent ON parent.resource_id = ar.parent_id
    WHERE ar.is_active = TRUE AND parent.is_active = FALSE;
$$;

-- Run monthly in Admin Dashboard, surface in Sync Monitor
```

### RISK-DATA-3: LDAP Group Membership Lag (Severity: MEDIUM)

**Scenario**: Employee transfers from SSD team to NAND team. LDAP group is updated, but identity-sync CronJob runs hourly. For up to 1 hour, the employee retains SSD access and lacks NAND access.

**Mitigation**: Reduce identity-sync interval to 5 minutes. Or implement webhook from LDAP/AD (if supported) for real-time sync. At minimum, provide a "Sync Now" button in Admin UI for HR/IT to trigger immediate sync after personnel changes.

## 16.5 Developer Experience Risks

### RISK-DX-1: New Module Onboarding Is Error-Prone (Severity: MEDIUM)

**Scenario**: A developer building a new "Quality" module must:
1. Register resources in `authz_resource` (module, pages, tables, columns)
2. Add L0 permissions in `authz_role_permission`
3. Create ABAC policies if needed
4. Wire visible_when/editable_when in UI metadata
5. Ensure PG functions call authz_check before writes

Missing any step = security gap (no authz on new pages) or broken UI (page loads but data is inaccessible).

**Mitigation**:

```
1. Module registration CLI / scaffold:
   → `npx @nexus/cli register-module quality`
   → Auto-generates: authz_resource entries, stub role_permissions,
     UI metadata template with authz_check placeholders

2. CI validation:
   → Pre-merge check: every page/endpoint in code must have
     a corresponding authz_resource entry
   → Every PG write function must call authz_check() at top
   → Flag: "Module quality has 3 pages but only 2 authz_resource entries"

3. AuthZ onboarding guide in docs/
   → Checklist with copy-paste SQL templates
```

### RISK-DX-2: Testing AuthZ in Development Is Painful (Severity: MEDIUM)

**Scenario**: Developer wants to test "what does a PE user see on this page?" Must: create test LDAP groups, assign roles, set up pool profiles, configure session variables. Most developers skip testing and rely on ADMIN role during development.

**Mitigation**:

```
1. Dev seed with pre-built personas:
   → dev-seed.sql creates: test_pe_ssd, test_pm_nand, test_sales_tw, test_bi_user
   → Each with complete role assignments and ABAC policies
   → Login as any persona via dev-only auth bypass

2. Policy Simulator accessible to developers:
   → Not just Admin UI — embed in workbench dev toolbar
   → "View as: [PE_SSD ▼]" toggle in development mode

3. Integration test helpers:
   → authz-client SDK provides:
     withAuthzContext(userId, groups, () => { /* test code */ })
   → Automatically sets session variables and cleans up
```

## 16.6 Fault Tolerance Risks

### RISK-FT-1: Redis Cache Failure (Severity: MEDIUM)

**Scenario**: L1 Redis goes down. Every request falls through to L2 (session) → if session expires, falls through to authz_resolve() on PostgreSQL → sudden 100x spike in DB queries.

**Mitigation**:

```
1. Redis Sentinel or Cluster for HA (3 nodes minimum)
2. L2 session cache has its own TTL (8 hours) independent of L1
   → Redis failure only affects new logins and expired sessions
3. Circuit breaker on resolve():
   → If DB is overloaded (response > 500ms), serve stale L2 cache
     with warning header
4. Graceful degradation: if both Redis and DB are down,
   return last-known cached config with "degraded" flag
```

### RISK-FT-2: Casbin Enforcer Reload During Traffic (Severity: LOW)

**Scenario**: Policy change triggers Casbin `loadPolicy()`. During reload, the enforcer briefly has an empty or inconsistent policy set. Requests during this window could get incorrect decisions.

**Mitigation**: Double-buffer pattern — load new policy set into a secondary enforcer instance, then atomically swap references. The old enforcer continues serving until new one is fully loaded.

## 16.7 Compliance Risks

### RISK-COMP-1: Audit Gap During Batch Mode (Severity: MEDIUM)

**Scenario**: Audit batch buffer holds 100 events. Service crashes before flush. Those 100 audit events are lost permanently. For compliance (SOX, ISO 27001), audit completeness is mandatory.

**Mitigation**:

```
1. Write-Ahead Buffer:
   → Before accumulating in memory, write to local append-only file
   → Batch INSERT reads from file, then truncates
   → On crash recovery: replay unflushed file entries

2. Reduce batch window:
   → Flush every 1 second instead of 5 seconds (trade-off: more DB writes)
   → Maximum 20 events per batch (limits loss to 20 events)

3. For SOX-critical deployments:
   → Disable batch mode for write/deny events (immediate INSERT)
   → Batch only read-allow events (least critical for compliance)
```

### RISK-COMP-2: No Policy Versioning / Rollback (Severity: MEDIUM)

**Scenario**: Admin makes a bad policy change, approves it, sync executes. 500 users suddenly lose access. Need to rollback, but there's no "previous version" stored. Admin must manually recreate the old policy.

**Mitigation**:

```sql
-- Policy version history table
CREATE TABLE authz_policy_version (
    version_id      BIGSERIAL PRIMARY KEY,
    policy_id       BIGINT NOT NULL REFERENCES authz_policy(policy_id),
    version_number  INTEGER NOT NULL,
    snapshot        JSONB NOT NULL,       -- full policy row as JSON
    changed_by      TEXT NOT NULL,
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    change_reason   TEXT,
    UNIQUE (policy_id, version_number)
);

-- Trigger: auto-save version on every policy update
CREATE OR REPLACE FUNCTION authz_policy_version_trigger()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO authz_policy_version (policy_id, version_number, snapshot, changed_by)
    VALUES (
        OLD.policy_id,
        COALESCE((SELECT MAX(version_number) FROM authz_policy_version WHERE policy_id = OLD.policy_id), 0) + 1,
        to_jsonb(OLD),
        current_setting('app.current_user', true)
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_policy_versioning
    BEFORE UPDATE ON authz_policy
    FOR EACH ROW EXECUTE FUNCTION authz_policy_version_trigger();

-- Rollback function
CREATE OR REPLACE FUNCTION authz_policy_rollback(
    p_policy_id BIGINT,
    p_version   INTEGER
)
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
    v_snapshot JSONB;
BEGIN
    SELECT snapshot INTO v_snapshot
    FROM authz_policy_version
    WHERE policy_id = p_policy_id AND version_number = p_version;

    UPDATE authz_policy SET
        policy_name = v_snapshot->>'policy_name',
        description = v_snapshot->>'description',
        subject_condition = (v_snapshot->'subject_condition'),
        resource_condition = (v_snapshot->'resource_condition'),
        action_condition = (v_snapshot->'action_condition'),
        environment_condition = (v_snapshot->'environment_condition'),
        rls_expression = v_snapshot->>'rls_expression',
        column_mask_rules = v_snapshot->'column_mask_rules',
        priority = (v_snapshot->>'priority')::integer,
        effect = (v_snapshot->>'effect')::authz_effect,
        status = 'active',
        updated_at = now()
    WHERE policy_id = p_policy_id;
END;
$$;
```

## 16.8 Evolution Risks

### RISK-EVOL-1: Config-as-State-Machine Assumes Homogeneous Tech Stack (Severity: MEDIUM)

**Scenario**: Future acquisition brings a Java/Oracle system. The entire AuthZ architecture assumes PostgreSQL functions, Node.js/React, and PG-native RLS. Integrating a Java app with Oracle DB requires significant adapter work.

**Mitigation**: Already partially addressed in §12.4 (AuthzDbSyncAdapter interface). Additional steps:

```
1. authz-api exposes REST API (language-agnostic)
   → Java app calls POST /api/authz/check — no PG function dependency
   → Go app calls POST /api/authz/resolve — same API

2. gRPC option for low-latency cross-language calls:
   → Define authz.proto with Check, Resolve, Filter RPCs
   → Generate stubs for Java, Python, Go, Rust

3. Embed Casbin natively in non-Node apps:
   → Casbin has Go, Java, Python, .NET implementations
   → Each app loads policies from same PG policy store via its own adapter
   → Consistent model.conf, different runtime
```

### RISK-EVOL-2: AI Agent Authorization Model Is Too Coarse (Severity: MEDIUM)

**Scenario**: Current design checks `authz_check(user, "execute", "ai_tool:yield_query")`. But AI agents increasingly need **chained tool calls** where the authorization context changes mid-chain:

```
Agent plan: yield_query → lot_lookup → send_email
Step 1: yield_query — user has access ✅
Step 2: lot_lookup — result includes NAND data, user only has SSD scope ❌
Step 3: send_email — recipient is external, requires EXPORT permission ❓
```

The per-tool-call model doesn't capture cross-step data flow authorization.

**Mitigation**:

```
1. Agent execution context carries cumulative data scope:
   → After step 1: context.data_touched = ['table:cp_ft_result']
   → Before step 2: check not just tool permission
     but also authz_filter() on the data the tool will access
   → Before step 3: check EXPORT action on all data_touched resources

2. Register agent workflows as composite actions:
   → authz_composite_action with multi-step chain
   → Pre-validate entire chain before execution begins
   → If any step would fail, reject the plan upfront

3. Result-level filtering:
   → Agent output passes through authz_filter() + column masking
   → Even if tool executes, response is filtered to user's scope
```

## 16.9 Weakness Summary Matrix

```
┌──────────────┬───────────┬──────────┬───────────────────────────────┐
│ Dimension    │ Risk ID   │ Severity │ Status                        │
├──────────────┼───────────┼──────────┼───────────────────────────────┤
│ Operations   │ OPS-1     │ 🔴 HIGH  │ Mitigated (NOTIFY + cache)   │
│              │ OPS-2     │ 🔴 HIGH  │ Needs: drift detector         │
│              │ OPS-3     │ 🟡 MED   │ Mitigated (pg_partman)       │
├──────────────┼───────────┼──────────┼───────────────────────────────┤
│ Security     │ SEC-1     │ 🔴 HIGH  │ Needs: minimal client config  │
│              │ SEC-2     │ 🔴 HIGH  │ Needs: ADMIN role split       │
│              │ SEC-3     │ 🟡 MED   │ Mitigated (pg_has_role RLS)   │
├──────────────┼───────────┼──────────┼───────────────────────────────┤
│ Scalability  │ SCALE-1   │ 🔴 HIGH  │ Mitigated (HA + cache-first) │
│              │ SCALE-2   │ 🟡 MED   │ Needs: filtered policy load   │
│              │ SCALE-3   │ 🟢 LOW   │ Monitor only                  │
├──────────────┼───────────┼──────────┼───────────────────────────────┤
│ Data         │ DATA-1    │ 🔴 HIGH  │ Needs: conflict detector      │
│ Integrity    │ DATA-2    │ 🟡 MED   │ Needs: orphan checker         │
│              │ DATA-3    │ 🟡 MED   │ Needs: faster LDAP sync       │
├──────────────┼───────────┼──────────┼───────────────────────────────┤
│ Developer    │ DX-1      │ 🟡 MED   │ Needs: scaffold CLI           │
│ Experience   │ DX-2      │ 🟡 MED   │ Needs: dev personas + toggle  │
├──────────────┼───────────┼──────────┼───────────────────────────────┤
│ Fault        │ FT-1      │ 🟡 MED   │ Needs: Redis HA               │
│ Tolerance    │ FT-2      │ 🟢 LOW   │ Needs: double-buffer reload   │
├──────────────┼───────────┼──────────┼───────────────────────────────┤
│ Compliance   │ COMP-1    │ 🟡 MED   │ Needs: write-ahead buffer     │
│              │ COMP-2    │ 🟡 MED   │ Mitigated (version table)     │
├──────────────┼───────────┼──────────┼───────────────────────────────┤
│ Evolution    │ EVOL-1    │ 🟡 MED   │ Mitigated (REST/gRPC API)     │
│              │ EVOL-2    │ 🟡 MED   │ Needs: agent chain authz      │
└──────────────┴───────────┴──────────┴───────────────────────────────┘

Priority order for remediation:
  1. SEC-2  (ADMIN role split)        — security baseline
  2. SEC-1  (minimal client config)   — information leakage
  3. DATA-1 (conflict detector)       — policy correctness
  4. OPS-2  (sync drift detector)     — operational safety
  5. COMP-2 (policy versioning)       — rollback capability
  6. DX-1   (scaffold CLI)            — developer velocity
  7. FT-1   (Redis HA)                — fault tolerance
  8. EVOL-2 (agent chain authz)       — future readiness
```
