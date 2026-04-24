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
        TEXT security_clearance "PUBLIC | INTERNAL | CONFIDENTIAL | RESTRICTED"
        INTEGER job_level
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
        TEXT resource_type "module | page | table | view | column | function | ai_tool | web_page | web_api | db_schema | db_table | db_pool | dag"
        TEXT parent_id FK
        TEXT display_name
        JSONB attributes "type-specific; for dag: {nodes, edges, data_source_id, version}"
        BOOLEAN is_active
        TEXT lifecycle_state "discovered | suggested | active | deprecated | retired (V046)"
        TIMESTAMPTZ discovered_at "V046"
        UUID discovered_by_scan_id "V046"
        TEXT approved_by "V046"
        TIMESTAMPTZ approved_at "V046"
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

    authz_policy_assignment {
        BIGSERIAL id PK
        BIGINT policy_id FK
        TEXT assignment_type "role | department | security_level | user | job_level_below | group"
        TEXT assignment_value
        BOOLEAN is_exception
        TIMESTAMPTZ created_at
    }

    authz_data_classification {
        SERIAL classification_id PK
        TEXT name UK "PUBLIC | INTERNAL | CONFIDENTIAL | RESTRICTED"
        INTEGER sensitivity_level
        TEXT description
        TIMESTAMPTZ created_at
    }

    authz_clearance_mapping {
        SERIAL id PK
        INTEGER min_job_level
        INTEGER max_job_level
        TEXT clearance "PUBLIC | INTERNAL | CONFIDENTIAL | RESTRICTED"
        TIMESTAMPTZ created_at
    }

    %% ============================================================
    %% DATA SOURCE & CONFIG-SM
    %% ============================================================

    authz_data_source {
        TEXT source_id PK
        TEXT display_name
        TEXT description
        TEXT db_type "postgresql | greenplum"
        TEXT host
        INTEGER port
        TEXT database_name
        TEXT_ARRAY schemas
        TEXT connector_user
        TEXT connector_password_enc
        TEXT owner_subject
        TEXT registered_by
        BOOLEAN is_active
        TIMESTAMPTZ last_synced_at
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }

    authz_ui_page {
        TEXT page_id PK
        TEXT title
        TEXT subtitle
        TEXT layout "card_grid | table | tree_detail | agg_table | split | timeline | context_panel"
        TEXT resource_id FK
        TEXT data_table
        TEXT order_by
        INTEGER row_limit
        JSONB row_drilldown
        JSONB columns_override
        JSONB filters_config
        TEXT parent_page_id FK
        TEXT icon
        TEXT description
        INTEGER display_order
        TEXT handler_name "V038 — ConfigEngine dispatch (e.g. audit_home_handler, modules_home_handler)"
        BOOLEAN is_active
        TIMESTAMPTZ created_at
    }

    authz_ui_descriptor {
        TEXT descriptor_id PK
        TEXT page_id FK
        TEXT section_key
        TEXT section_label
        TEXT section_icon
        INTEGER display_order
        TEXT visibility
        JSONB columns
        JSONB render_hints
        TEXT status "manual | derived | overridden | hybrid (V048)"
        TIMESTAMPTZ derived_at "V048"
        JSONB derived_from "V048 — {source_id, schema, table_name, schema_hash}"
    }

    authz_admin_audit_log {
        BIGSERIAL id PK
        TIMESTAMPTZ timestamp
        TEXT user_id
        TEXT action
        TEXT resource_type
        TEXT resource_id
        JSONB details
        TEXT ip_address
        TEXT actor_type "ai_agent | human | system (V049)"
        TEXT agent_id "V049 — required when actor_type=ai_agent"
        TEXT model_id "V049"
        TEXT consent_given "V049 — human_explicit | human_via_suggestion_card | agent_auto_read | agent_unauthorized"
        TIMESTAMPTZ created_at
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
        TEXT sync_type "rls_policy | column_view | ui_metadata | web_acl | db_grant | pgbouncer_config | agent_scope | external_db_grant | external_credential_sync | oracle_function_call"
        BIGINT source_policy_id
        TEXT target_name
        TEXT data_source_id FK
        TEXT generated_sql
        TEXT generated_config
        sync_status sync_status "pending | synced | failed | rollback"
        TEXT error_message
        TIMESTAMPTZ synced_at
        TIMESTAMPTZ created_at
    }

    authz_discovery_rule {
        UUID rule_id PK
        TEXT rule_type "column_mask | row_filter | classification"
        TEXT match_target "column_name | table_name | schema_name"
        TEXT match_pattern "regex"
        TEXT suggested_mask_fn FK
        TEXT suggested_filter_template "${subject.x} placeholder (V047 — resolved at app layer for Path A/B/C)"
        TEXT suggested_label
        TEXT description
        INTEGER priority
        BOOLEAN enabled
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
    %% BUSINESS DATA
    %% ============================================================
    %% Business tables are NOT control-plane tables — they live in
    %% external sources registered via authz_data_source. Each scanned
    %% table/column becomes an authz_resource row with lifecycle_state
    %% (discovered → suggested → active), so the ER doesn't enumerate
    %% them directly. See authz_resource.attributes for shape:
    %%   { data_source_id, table_schema, table_name, outputs:[columns] }

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

    %% Policy assignments (EdgePolicy)
    authz_policy ||--o{ authz_policy_assignment : "assigned via"

    %% Data source & Config-SM
    authz_data_source ||--o{ authz_db_pool_profile : "data_source_id"
    authz_data_source ||--o{ authz_sync_log : "data_source_id"
    authz_resource ||--o{ authz_ui_page : "resource_id"
    authz_ui_page ||--o{ authz_ui_page : "parent_page_id"
    authz_ui_page ||--o{ authz_ui_descriptor : "page_id"

    %% Discovery (V047)
    authz_mask_function ||--o{ authz_discovery_rule : "suggested_mask_fn"

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
   │ (+clearance│                      └──────────┬───────────┘
   │  +job_level│                                 │
   └──────┬─────┘                      ┌──────────┴───────────┐
          │                            │                      │
          ▼                            ▼                      ▼
 ┌──────────────────┐      ┌──────────────────────┐ ┌────────────────┐
 │authz_role_       │      │authz_pool_credentials│ │authz_data_     │
 │  permission      │      └──────────────────────┘ │  source        │
 │ (role→action→    │                               │ (PG/GP hosts)  │
 │  resource)       │                               └────────────────┘
 └──┬──────────┬────┘
    │          │
    ▼          ▼
┌──────────┐ ┌──────────────┐     ┌───────────────┐
│authz_    │ │authz_resource│────→│authz_resource  │ (self-ref: parent)
│ action   │ └──────┬───────┘     └───────────────┘
└──────────┘        │
                    │  (target)
          ┌─────────┼──────────────────────┐
          ▼         │                      ▼
 ┌─────────────────────┐      ┌──────────────────────┐
 │authz_composite_action│      │authz_ui_page         │
 │ (L3 approval flows) │      │ (Config-SM pages)    │
 └──────────────────────┘      └──────────┬───────────┘
                                          │ (self-ref: parent_page)
                                          ▼
                                ┌──────────────────────┐
                                │authz_ui_page (child) │
                                └──────────────────────┘

          ┌──────────────┐      ┌────────────────────┐
          │ authz_policy │─────→│authz_policy_version│
          │ (ABAC L1-L3) │      └────────────────────┘
          └──────┬───────┘
                 │
                 ▼
       ┌──────────────────────┐
       │authz_policy_         │
       │  assignment          │   ┌─────────────────────────┐
       │ (role/dept/user/...) │   │authz_data_classification│
       └──────────────────────┘   │ (sensitivity levels)    │
                                  └─────────────────────────┘
       ┌────────────────────────┐
       │authz_clearance_mapping │ (job_level → clearance)
       └────────────────────────┘

    ═════════════ Ops / Audit ═════════════
    ┌───────────────┐  ┌─────────────────┐  ┌─────────────────────┐
    │authz_sync_log │  │authz_audit_log  │  │authz_admin_audit_log│
    │ (sync status) │  │ (partitioned)   │  │ (admin operations)  │
    └───────────────┘  │ (decision trail)│  └─────────────────────┘
                       └─────────────────┘

    ═══════════ Business Data (bottom-up) ═══════════
    External data lives in registered sources (authz_data_source). Tables/columns
    are materialized as authz_resource rows via Discover → Suggest → Approve
    (V046 lifecycle). The ER doesn't enumerate them — they're runtime-created.
```

## Table Count Summary (post-V050)

| Category | Tables | Description |
|----------|--------|-------------|
| Core RBAC | 4 | subject, role, action, resource (+V046 lifecycle_state) |
| Assignment | 3 | subject_role, role_permission, group_member |
| Policy | 6 | policy, policy_version, policy_assignment, composite_action, mask_function, data_classification |
| Discovery | 1 | discovery_rule (+V047 ${subject.x} templates) |
| Data Source & Config | 4 | data_source, ui_page (+V038 handler_name), ui_descriptor (+V048 status), clearance_mapping |
| Path C Pool | 3 | pool_profile, pool_assignment, pool_credentials |
| Ops | 3 | sync_log, audit_log (TimescaleDB hypertable), admin_audit_log (+V049 actor_type/agent_id/consent_given) |
| **Total** | **24** | Control plane only — business data lives in external sources (see authz_data_source) |

## Recent migrations (V038 → V050)

| Migration | Schema impact |
|-----------|---------------|
| V038 | `authz_ui_page.handler_name` — ConfigEngine dispatch key |
| V042 | `authz_resource.resource_type` adds `dag` |
| V043 | `authz_ui_descriptor` seeds `modules_home:functions` sub-tab |
| V046 | Bottom-up lifecycle: `authz_resource.lifecycle_state` + `discovered_at` / `_by_scan_id` + `approved_by` / `_at` |
| V047 | `authz_discovery_rule.suggested_filter_template` rewritten to `${subject.x}` (app-layer resolution) |
| V048 | `authz_ui_descriptor.status` / `derived_at` / `derived_from` — schema-driven descriptor lineage |
| V049 | `authz_admin_audit_log` adds `actor_type` / `agent_id` / `model_id` / `consent_given` (Constitution §9.7) |
| V050 | `audit_home.handler_name='audit_home_handler'`, `fn_ui_page` gated on `is_active OR handler_name IS NOT NULL` |
