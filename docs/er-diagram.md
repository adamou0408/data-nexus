# Phison Data Nexus — ER Diagram

## Full Database Schema

```mermaid
erDiagram
    %% ============================================================
    %% CORE AUTHZ TABLES
    %% ============================================================

    authz_subject {
        TEXT subject_id PK
        TEXT subject_type "ldap_group | user | service_account"
        TEXT display_name
        TEXT ldap_dn
        JSONB attributes
        BOOLEAN is_active
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }

    authz_role {
        TEXT role_id PK
        TEXT display_name
        TEXT description
        BOOLEAN is_system
        BOOLEAN is_active
        TIMESTAMPTZ created_at
    }

    authz_action {
        TEXT action_id PK
        TEXT display_name
        TEXT description
        TEXT_ARRAY applicable_paths "A, B, C"
        BOOLEAN is_active
    }

    authz_resource {
        TEXT resource_id PK
        TEXT resource_type "module | page | table | column | function | ai_tool | web_page | web_api | db_schema | db_table | db_pool"
        TEXT parent_id FK
        TEXT display_name
        JSONB attributes
        BOOLEAN is_active
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }

    %% ============================================================
    %% ASSIGNMENT & PERMISSION TABLES
    %% ============================================================

    authz_subject_role {
        BIGSERIAL id PK
        TEXT subject_id FK
        TEXT role_id FK
        TIMESTAMPTZ valid_from
        TIMESTAMPTZ valid_until
        TEXT granted_by
        BOOLEAN is_active
        TIMESTAMPTZ created_at
    }

    authz_role_permission {
        BIGSERIAL id PK
        TEXT role_id FK
        TEXT action_id FK
        TEXT resource_id FK
        authz_effect effect "allow | deny"
        BOOLEAN is_active
        TIMESTAMPTZ created_at
    }

    authz_group_member {
        TEXT group_id FK "PK"
        TEXT user_id FK "PK"
        TIMESTAMPTZ synced_at
        TEXT source "ldap_sync | manual"
    }

    %% ============================================================
    %% POLICY TABLES
    %% ============================================================

    authz_policy {
        BIGSERIAL policy_id PK
        TEXT policy_name UK
        TEXT description
        authz_granularity granularity "L0 | L1 | L2 | L3"
        INTEGER priority
        authz_effect effect "allow | deny"
        policy_status status "active | inactive | pending_review"
        TEXT_ARRAY applicable_paths "A, B, C"
        JSONB subject_condition
        JSONB resource_condition
        JSONB action_condition
        JSONB environment_condition
        TEXT rls_expression
        JSONB column_mask_rules
        TEXT created_by
        TEXT approved_by
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
        TIMESTAMPTZ effective_from
        TIMESTAMPTZ effective_until
    }

    authz_policy_version {
        BIGSERIAL version_id PK
        BIGINT policy_id FK
        INTEGER version_number
        JSONB snapshot
        TEXT changed_by
        TIMESTAMPTZ changed_at
        TEXT change_reason
    }

    authz_composite_action {
        BIGSERIAL id PK
        TEXT policy_name UK
        TEXT target_action FK
        TEXT target_resource FK
        JSONB approval_chain
        JSONB preconditions
        INTEGER timeout_hours
        policy_status status
        TIMESTAMPTZ created_at
    }

    authz_mask_function {
        TEXT function_name PK
        mask_type mask_type "none | full | partial | hash | range | custom"
        TEXT pg_function
        TEXT description
        TEXT example_input
        TEXT example_output
        TEXT template
    }

    %% ============================================================
    %% PATH C: DB CONNECTION POOL
    %% ============================================================

    authz_db_pool_profile {
        TEXT profile_id PK
        TEXT pg_role UK
        TEXT_ARRAY allowed_schemas
        TEXT_ARRAY allowed_tables
        JSONB denied_columns
        db_connection_mode connection_mode "readonly | readwrite | admin"
        INTEGER max_connections
        CIDR_ARRAY ip_whitelist
        TEXT valid_hours
        BOOLEAN rls_applies
        TEXT description
        BOOLEAN is_active
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }

    authz_db_pool_assignment {
        BIGSERIAL id PK
        TEXT subject_id FK
        TEXT profile_id FK
        TEXT granted_by
        TIMESTAMPTZ valid_from
        TIMESTAMPTZ valid_until
        BOOLEAN is_active
        TIMESTAMPTZ created_at
    }

    authz_pool_credentials {
        TEXT pg_role PK_FK
        TEXT password_hash
        BOOLEAN is_active
        TIMESTAMPTZ last_rotated
        INTERVAL rotate_interval
    }

    %% ============================================================
    %% SYNC & AUDIT
    %% ============================================================

    authz_sync_log {
        BIGSERIAL sync_id PK
        TEXT sync_type "rls_policy | column_view | ui_metadata | web_acl | db_grant | pgbouncer_config | agent_scope"
        BIGINT source_policy_id
        TEXT target_name
        TEXT generated_sql
        TEXT generated_config
        sync_status sync_status "pending | synced | failed | rollback"
        TEXT error_message
        TIMESTAMPTZ synced_at
        TIMESTAMPTZ created_at
    }

    authz_audit_log {
        BIGSERIAL audit_id PK "partitioned"
        TIMESTAMPTZ timestamp PK "partition key"
        CHAR access_path "A | B | C"
        TEXT subject_id
        TEXT action_id
        TEXT resource_id
        authz_effect decision "allow | deny"
        BIGINT_ARRAY policy_ids
        JSONB context
        INTEGER duration_ms
    }

    %% ============================================================
    %% BUSINESS DATA TABLES (for RLS simulation)
    %% ============================================================

    lot_status {
        TEXT lot_id PK
        TEXT product_line "SSD | eMMC | SD | PCIe"
        TEXT chip_model
        TEXT grade
        NUMERIC unit_price "restricted"
        NUMERIC cost "highly restricted"
        TEXT customer
        TEXT wafer_lot
        TEXT site "HQ | HK | JP"
        TEXT status "active | hold | shipped | scrapped"
        TIMESTAMPTZ created_at
    }

    sales_order {
        TEXT order_id PK
        TEXT customer
        TEXT product_line
        TEXT chip_model
        INTEGER quantity
        NUMERIC unit_price
        NUMERIC total_amount
        TEXT region "TW | CN | US | JP | EU"
        TEXT status "pending | confirmed | shipped | closed"
        DATE order_date
        TIMESTAMPTZ created_at
    }

    %% ============================================================
    %% RELATIONSHIPS
    %% ============================================================

    %% Core RBAC
    authz_subject ||--o{ authz_subject_role : "is assigned"
    authz_role ||--o{ authz_subject_role : "assigned to"
    authz_role ||--o{ authz_role_permission : "has"
    authz_action ||--o{ authz_role_permission : "permits"
    authz_resource ||--o{ authz_role_permission : "on"

    %% Resource hierarchy (self-referencing)
    authz_resource ||--o{ authz_resource : "parent_id"

    %% Group membership (LDAP sync)
    authz_subject ||--o{ authz_group_member : "group_id (group)"
    authz_subject ||--o{ authz_group_member : "user_id (member)"

    %% Policy system
    authz_policy ||--o{ authz_policy_version : "versioned"
    authz_action ||--o{ authz_composite_action : "target_action"
    authz_resource ||--o{ authz_composite_action : "target_resource"

    %% Path C pool
    authz_subject ||--o{ authz_db_pool_assignment : "assigned to pool"
    authz_db_pool_profile ||--o{ authz_db_pool_assignment : "profile"
    authz_db_pool_profile ||--|| authz_pool_credentials : "pg_role"
```

## Simplified Relationship Summary

```
                    ┌─────────────────┐
                    │  authz_subject   │ ← LDAP groups, users, svc accounts
                    └──┬────┬────┬────┘
                       │    │    │
          ┌────────────┘    │    └─────────────────┐
          ▼                 ▼                       ▼
 ┌─────────────────┐ ┌──────────────┐  ┌────────────────────────┐
 │authz_subject_role│ │authz_group_  │  │authz_db_pool_assignment│
 │ (role binding)  │ │  member      │  │  (pool binding)        │
 └────────┬────────┘ │ (LDAP sync)  │  └───────────┬────────────┘
          │          └──────────────┘               │
          ▼                                         ▼
   ┌────────────┐                      ┌──────────────────────┐
   │ authz_role │                      │authz_db_pool_profile │
   └──────┬─────┘                      └──────────┬───────────┘
          │                                       │
          ▼                                       ▼
 ┌──────────────────┐                  ┌──────────────────────┐
 │authz_role_       │                  │authz_pool_credentials│
 │  permission      │                  └──────────────────────┘
 │ (role→action→    │
 │  resource)       │
 └──┬──────────┬────┘
    │          │
    ▼          ▼
┌──────────┐ ┌──────────────┐     ┌───────────────┐
│authz_    │ │authz_resource│────→│authz_resource  │ (self-ref: parent)
│ action   │ └──────┬───────┘     └───────────────┘
└──────────┘        │
                    │  (target)
                    ▼
          ┌──────────────────────┐
          │authz_composite_action│ (L3 approval workflows)
          └──────────────────────┘

          ┌──────────────┐      ┌────────────────────┐
          │ authz_policy │─────→│authz_policy_version│
          │ (ABAC L1-L3) │      └────────────────────┘
          └──────────────┘
                                ┌─────────────────┐
          ┌───────────────┐     │ authz_audit_log  │ (partitioned)
          │authz_sync_log │     │ (decision trail) │
          └───────────────┘     └─────────────────┘

    ═══════════ Business Data (RLS targets) ═══════════
    ┌────────────┐           ┌──────────────┐
    │ lot_status │           │ sales_order  │
    │ (by product│           │ (by region)  │
    │  line/site)│           └──────────────┘
    └────────────┘
```

## Table Count Summary

| Category | Tables | Description |
|----------|--------|-------------|
| Core RBAC | 4 | subject, role, action, resource |
| Assignment | 3 | subject_role, role_permission, group_member |
| Policy | 4 | policy, policy_version, composite_action, mask_function |
| Path C Pool | 3 | pool_profile, pool_assignment, pool_credentials |
| Ops | 2 | sync_log, audit_log (partitioned) |
| Business | 2 | lot_status, sales_order |
| **Total** | **18** | |
