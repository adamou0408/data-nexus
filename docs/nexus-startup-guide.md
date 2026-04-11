# Phison Data Nexus — Project Startup Guide

## How to Read This Guide

The architecture document (v2.3) is the **complete blueprint**. This guide is the **construction sequence** — what to build first, what to defer, and what to hand to other engineers/LLMs.

---

## Execution Strategy: 4 Milestones

```
Milestone 1 (Week 1-2): "AuthZ runs locally"
  → PostgreSQL + schema + seed data + authz_resolve() works
  → docker-compose up → can query permissions via psql

Milestone 2 (Week 3-4): "First page is permission-aware"
  → authz-service REST API running
  → One workbench page renders with visible_when from resolved config
  → RLS filters data, column masking works

Milestone 3 (Week 5-8): "All three paths enforced"
  → Path B middleware wired
  → Path C pool profiles + pgbouncer working
  → Audit logging active
  → AuthZ Admin basic CRUD pages

Milestone 4 (Week 9-12): "Production-ready"
  → Redis cache layer
  → Helm chart + K8s deployment
  → Policy Simulator + Impact Analysis
  → LDAP sync
```

---

## Milestone 1: AuthZ Runs Locally (Week 1-2)

### Step 1.1: Docker Compose for Local Development

```yaml
# deploy/docker-compose/docker-compose.yml

services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: nexus_authz
      POSTGRES_USER: nexus_admin
      POSTGRES_PASSWORD: nexus_dev_password
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ../../database/migrations:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U nexus_admin -d nexus_authz"]
      interval: 5s
      timeout: 3s
      retries: 10

  # Redis for L1 cache (Milestone 4, but include now to avoid re-architecture)
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s

volumes:
  pgdata:
```

### Step 1.2: First Migration — Core Schema

Take the SQL from architecture doc Section II and save as migration files.

The architecture document contains the full DDL. Split it into ordered migration files:

```
database/migrations/
├── V001__enums.sql                    ← authz_effect, authz_granularity, mask_type, etc.
├── V002__core_tables.sql              ← authz_subject, authz_resource, authz_action,
│                                        authz_role, authz_role_permission, authz_subject_role
├── V003__policy_tables.sql            ← authz_policy, authz_composite_action, authz_mask_function
├── V004__pool_tables.sql              ← authz_db_pool_profile, authz_db_pool_assignment,
│                                        authz_pool_credentials
├── V005__sync_audit_tables.sql        ← authz_sync_log, authz_audit_log (partitioned), indexes
├── V006__policy_version_table.sql     ← authz_policy_version + auto-version trigger (from §16.7)
├── V007__core_functions.sql           ← _authz_resolve_roles, authz_check, authz_filter,
│                                        authz_check_from_cache
├── V008__path_a_resolve.sql           ← authz_resolve()
├── V009__path_b_resolve.sql           ← authz_resolve_web_acl()
├── V010__path_c_sync.sql             ← authz_sync_db_grants(), authz_sync_pgbouncer_config()
├── V011__audit_batch.sql              ← authz_audit_batch_insert()
├── V012__cache_notify_triggers.sql    ← authz_notify_change() + triggers on 3 tables
└── V013__seed_data.sql                ← roles, actions, mask functions, authz_admin self-registration
```

**Where to get the SQL**: Every line of SQL is already in the architecture document:
- V001-V005: Section II (§2.1 - §2.5)
- V006: Section XVI (§16.7 COMP-2)
- V007-V011: Section III (§3.1 - §3.6)
- V012: Section XV (§15.3 Cache Invalidation)
- V013: Section IX (§9.3 Self-Registration) + Section II (§2.2 action INSERT + §2.3 mask_function INSERT)

### Step 1.3: Seed Data

```sql
-- database/seed/dev-seed.sql
-- Development personas for testing

-- LDAP groups (simulated)
INSERT INTO authz_subject (subject_id, subject_type, display_name, attributes) VALUES
    ('group:PE_SSD',    'ldap_group', 'PE - SSD Team',   '{"product_line": "SSD-Controller", "site": "HQ"}'),
    ('group:PE_NAND',   'ldap_group', 'PE - NAND Team',  '{"product_line": "NAND-Controller", "site": "HQ"}'),
    ('group:PM_SSD',    'ldap_group', 'PM - SSD Team',   '{"product_line": "SSD-Controller"}'),
    ('group:SALES_TW',  'ldap_group', 'Sales - Taiwan',  '{"region": "TW"}'),
    ('group:BI_TEAM',   'ldap_group', 'BI Team',         '{}'),
    ('group:DBA_TEAM',  'ldap_group', 'DBA Team',        '{}');

-- Dev test users
INSERT INTO authz_subject (subject_id, subject_type, display_name, attributes) VALUES
    ('user:test_pe_ssd',    'user', 'Test PE (SSD)',    '{"product_line": "SSD-Controller"}'),
    ('user:test_pm_ssd',    'user', 'Test PM (SSD)',    '{"product_line": "SSD-Controller"}'),
    ('user:test_sales',     'user', 'Test Sales',       '{"region": "TW"}'),
    ('user:test_bi',        'user', 'Test BI User',     '{}'),
    ('user:test_admin',     'user', 'Test Admin',       '{}');

-- Role assignments for test users
INSERT INTO authz_subject_role (subject_id, role_id, granted_by) VALUES
    ('user:test_pe_ssd',  'PE',          'dev_seed'),
    ('user:test_pm_ssd',  'PM',          'dev_seed'),
    ('user:test_sales',   'SALES',       'dev_seed'),
    ('user:test_bi',      'BI_USER',     'dev_seed'),
    ('user:test_admin',   'ADMIN',       'dev_seed'),
    ('user:test_admin',   'AUTHZ_ADMIN', 'dev_seed'),
    ('group:PE_SSD',      'PE',          'dev_seed'),
    ('group:PM_SSD',      'PM',          'dev_seed'),
    ('group:SALES_TW',    'SALES',       'dev_seed'),
    ('group:BI_TEAM',     'BI_USER',     'dev_seed'),
    ('group:DBA_TEAM',    'DBA',         'dev_seed');

-- Sample resources (MRP module)
INSERT INTO authz_resource (resource_id, resource_type, parent_id, display_name) VALUES
    ('module:mrp',                  'module', NULL,                'MRP System'),
    ('module:mrp.lot_tracking',     'module', 'module:mrp',       'Lot Tracking'),
    ('module:mrp.yield_analysis',   'module', 'module:mrp',       'Yield Analysis'),
    ('table:lot_status',            'table',  'module:mrp.lot_tracking',  'Lot Status Table'),
    ('column:lot_status.unit_price','column', 'table:lot_status',         'Unit Price'),
    ('column:lot_status.customer',  'column', 'table:lot_status',         'Customer Name');

-- L0 permissions
INSERT INTO authz_role_permission (role_id, action_id, resource_id, effect) VALUES
    ('PE',    'read',  'module:mrp.lot_tracking',   'allow'),
    ('PE',    'write', 'module:mrp.lot_tracking',   'allow'),
    ('PE',    'read',  'module:mrp.yield_analysis', 'allow'),
    ('PM',    'read',  'module:mrp.lot_tracking',   'allow'),
    ('PM',    'read',  'module:mrp.yield_analysis', 'allow'),
    ('SALES', 'read',  'module:mrp.lot_tracking',   'allow'),
    ('ADMIN', 'read',  'module:mrp',                'allow'),
    ('ADMIN', 'write', 'module:mrp',                'allow'),
    -- Column-level deny (default deny unit_price, allow for SALES/ADMIN)
    ('PE',    'read',  'column:lot_status.unit_price', 'deny'),
    ('SALES', 'read',  'column:lot_status.unit_price', 'allow'),
    ('ADMIN', 'read',  'column:lot_status.unit_price', 'allow');

-- L1 ABAC policy
INSERT INTO authz_policy (
    policy_name, description, granularity, effect, status,
    applicable_paths, subject_condition, resource_condition,
    rls_expression, created_by
) VALUES (
    'pe_ssd_data_scope',
    'PE of SSD line can only see SSD data',
    'L1_data_domain', 'allow', 'active',
    '{A,B,C}',
    '{"role": ["PE"], "product_line": ["SSD-Controller"]}',
    '{"resource_type": "table", "data_domain": ["lot"]}',
    'product_line = ''SSD-Controller''',
    'dev_seed'
);
```

### Step 1.4: Verify It Works

```bash
# Start the stack
cd deploy/docker-compose
docker-compose up -d

# Wait for healthy
docker-compose exec postgres pg_isready

# Run migrations (manual for now, Flyway later)
for f in ../../database/migrations/V*.sql; do
    echo "Running $f..."
    docker-compose exec -T postgres psql -U nexus_admin -d nexus_authz < "$f"
done

# Run dev seed
docker-compose exec -T postgres psql -U nexus_admin -d nexus_authz \
    < ../../database/seed/dev-seed.sql

# ============================================
# TEST: Does authz_resolve work?
# ============================================
docker-compose exec postgres psql -U nexus_admin -d nexus_authz -c "
    SELECT jsonb_pretty(
        authz_resolve('test_pe_ssd', ARRAY['PE_SSD'], '{\"product_line\": \"SSD-Controller\"}'::jsonb)
    );
"

# Expected: JSON with resolved_roles=['PE'], L0_functional with mrp modules,
#           L1_data_scope with rls_expression, L2_column_masks

# ============================================
# TEST: Does authz_check work?
# ============================================
docker-compose exec postgres psql -U nexus_admin -d nexus_authz -c "
    SELECT authz_check('test_pe_ssd', ARRAY['PE_SSD'], 'read', 'module:mrp.lot_tracking');
    -- Expected: true

    SELECT authz_check('test_pe_ssd', ARRAY['PE_SSD'], 'read', 'column:lot_status.unit_price');
    -- Expected: false (PE denied on unit_price)

    SELECT authz_check('test_sales', ARRAY['SALES_TW'], 'read', 'column:lot_status.unit_price');
    -- Expected: true (SALES allowed on unit_price)
"

# ============================================
# TEST: Does authz_resolve_web_acl work?
# ============================================
docker-compose exec postgres psql -U nexus_admin -d nexus_authz -c "
    SELECT jsonb_pretty(
        authz_resolve_web_acl('test_admin', ARRAY['AUTHZ_ADMINS'])
    );
"

echo "✅ Milestone 1 complete: AuthZ runs locally"
```

**Milestone 1 完成標準**：三個 TEST 都回傳預期結果。

---

## Milestone 2: First Permission-Aware Page (Week 3-4)

### Step 2.1: authz-service REST API

```
services/authz-service/
├── package.json          ← express, pg, node-casbin
├── Dockerfile
└── src/
    ├── index.js          ← Express server, port 8080
    ├── db.js             ← PG connection pool
    ├── api/
    │   ├── resolve.js    ← POST /api/authz/resolve
    │   ├── check.js      ← POST /api/authz/check
    │   └── health.js     ← GET /healthz/ready
    └── middleware/
        └── auth.js       ← Extract user from JWT/session
```

Minimum viable endpoints:

```javascript
// POST /api/authz/resolve
// Body: { user_id, groups, attributes }
// Returns: resolved permission config JSON

// POST /api/authz/check
// Body: { user_id, groups, action, resource }
// Returns: { allowed: true/false }

// GET /healthz/ready
// Returns: 200 if DB connected
```

### Step 2.2: packages/authz-client

```typescript
// packages/authz-client/src/react-authz-provider.tsx
// Wraps the resolved config in React Context
// Components use useAuthz() hook to check permissions

import { createContext, useContext, useEffect, useState } from 'react';

const AuthzContext = createContext(null);

export function AuthzProvider({ children }) {
    const [config, setConfig] = useState(null);

    useEffect(() => {
        fetch('/api/authz/resolve', {
            method: 'POST',
            body: JSON.stringify({ /* from session */ })
        })
        .then(r => r.json())
        .then(setConfig);
    }, []);

    return <AuthzContext.Provider value={config}>{children}</AuthzContext.Provider>;
}

export function useAuthzCheck(action, resource) {
    const config = useContext(AuthzContext);
    if (!config) return false;
    return config.L0_functional.some(
        p => (p.action === action || p.action === '*') &&
             (p.resource === resource || p.resource === '*')
    );
}
```

### Step 2.3: First Workbench Page with visible_when

```jsx
// apps/workbench/src/modules/mrp/lot-detail.jsx
import { useAuthzCheck } from '@nexus/authz-client';

export function LotDetail({ lot }) {
    const canSeePrice = useAuthzCheck('read', 'column:lot_status.unit_price');
    const canWrite    = useAuthzCheck('write', 'table:lot_status');

    return (
        <div>
            <h2>Lot: {lot.lot_id}</h2>
            <p>Product Line: {lot.product_line}</p>
            <p>Grade: {lot.grade}</p>

            {canSeePrice
                ? <p>Unit Price: {lot.unit_price}</p>
                : <p>Unit Price: ****</p>
            }

            {canWrite && <button onClick={handleEdit}>Edit</button>}
        </div>
    );
}
```

**Milestone 2 完成標準**：test_pe_ssd 登入看到 lot 資料但 unit_price 被遮罩，test_sales 登入看到 unit_price。

---

## Milestone 3 & 4: Summary

| Milestone | Key Deliverables | Guide |
|-----------|-----------------|-------|
| 3 (Week 5-8) | Path B middleware, Path C pgbouncer, AuthZ Admin CRUD, audit logging | Architecture doc §4.2 (Path B middleware code), §4.3 (pgbouncer config), §11 (CRUD API list) |
| 4 (Week 9-12) | Redis cache, Helm charts, Policy Simulator, LDAP sync | Architecture doc §15.3 (cache), §14 (K8s), §10.2 (Simulator), §9.3 (LDAP) |

---

## How to Use the Architecture Document with Other LLMs

The architecture document has a built-in **Transferable Mega-Prompt** (Section VII). Here's how to use it:

### Scenario 1: "Help me build the authz-service REST API"

```
Prompt to send:

[Paste Section VII mega-prompt]

Now implement the authz-service as a Node.js Express application.
Requirements:
- POST /api/authz/resolve → calls authz_resolve() PG function
- POST /api/authz/check → calls authz_check() PG function
- POST /api/authz/filter → calls authz_filter() PG function
- GET /healthz/ready → checks DB connection + Casbin loaded
- Use pg connection pool
- Include error handling and request logging
- Production-ready, not illustrative
```

### Scenario 2: "Help me build the AuthZ Admin Permission Matrix"

```
Prompt to send:

[Paste Section VII mega-prompt]

Now implement the Permission Matrix React component described in the architecture.
Requirements:
- Rows = roles (from GET /api/authz/roles)
- Columns = resources (from GET /api/authz/resources?type=module)
- Cells = action checkboxes (R/W/A/E/H) with 3 states: allow/deny/inherited
- Path filter dropdown (A/B/C/All)
- Click toggles allow, shift+click toggles deny
- Calls POST /api/authz/permissions to save changes
- Use React + Tailwind, production-ready
```

### Scenario 3: "Help me write the Helm chart"

```
Prompt to send:

[Paste Section VII mega-prompt]

Now create the Helm umbrella chart for K8s deployment.
Reference the K8s topology in the architecture (authz-service 3 replicas,
pgbouncer 2 replicas, PostgreSQL StatefulSet, CronJobs for sync/identity-sync).
Include: HPA, PDB, NetworkPolicy, health probes, External Secrets references.
Follow the values hierarchy: values.yaml (defaults) + values-dev.yaml + values-production.yaml.
```

### Scenario 4: "Review my implementation for security gaps"

```
Prompt to send:

[Paste Section VII mega-prompt]

Here is my implementation of [paste code].
Review it against the Production Weakness Analysis in the architecture:
- Does it address SEC-1 (minimal client config)?
- Does it address SEC-2 (ADMIN role split)?
- Does it address SEC-3 (session variable spoofing)?
- Does it address DATA-1 (policy conflicts)?
Point out any gaps and suggest fixes aligned with the architecture.
```

---

## What NOT to Build Yet

| Don't Build Now | Why | When |
|----------------|-----|------|
| Casbin sidecar pattern | Centralized pattern works fine until > 500 users | Milestone 4+ |
| Multi-DB adapters (MySQL, MSSQL) | Only needed when non-PG target databases exist | When required |
| AI Agent chain authorization | Agent layer is Phase 2 of overall data center plan | After Milestone 4 |
| Policy conflict detector | Need real policies first to have conflicts | After 3+ months of policy accumulation |
| Break-glass emergency procedure | Needs operational maturity first | After production launch |

---

## Day 1 Checklist

```
□ 1. Create GitHub/GitLab repo: phison-data-nexus
□ 2. Run Phase 0 init script (directory structure + git init)
□ 3. Copy architecture doc to docs/architecture.md
□ 4. Copy this startup guide to docs/startup-guide.md
□ 5. Create docker-compose.yml (Step 1.1)
□ 6. Extract SQL from architecture doc into database/migrations/V001-V013
□ 7. Create dev-seed.sql (Step 1.3)
□ 8. docker-compose up && run migrations && run seed
□ 9. Run the three verification queries (Step 1.4)
□ 10. First commit: "feat: authz schema + core functions + dev seed"

→ Milestone 1 checkpoint: authz_resolve() returns correct JSON ✅
→ Next: build authz-service REST API (Milestone 2, Step 2.1)
```
