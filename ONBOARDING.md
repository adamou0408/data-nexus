# Data Nexus — Admin Onboarding Guide

## Quick Start

### 1. Start the Dev Environment

```bash
make up          # Start PostgreSQL + Redis + PgBouncer
make dev-api     # Start API server (http://localhost:3001)
make dev-ui      # Start Dashboard UI (http://localhost:5173)

# Or all at once:
make dev
```

### 2. Open the Dashboard

Go to **http://localhost:5173**

### 3. Select a User

Use the **user selector** at the bottom of the sidebar. Start with `sys_admin` to see all admin features.

| User | Role | Description |
|------|------|-------------|
| `sys_admin` | ADMIN, AUTHZ_ADMIN | System administrator (full access) |
| `wang_pe` | PE | Product engineer |
| `chen_sales` | SALES | Sales |
| `liu_qa` | QA | Quality assurance |
| `lin_op` | OP | Operations |
| `chang_vp` | VP | VP / Management |

---

## Suggested Exploration Path

### Step 1: Understand Your Permissions

- **My Permissions** — View your resolved L0-L3 permission config
- **Permission Matrix** — See all roles x resources in a grid

### Step 2: Feel the Difference Between Roles

Switch to `wang_pe` in the sidebar. Notice:
- Admin-only tabs disappear (Check, RLS, Functions, Raw Tables, Browser, Pool, Audit)
- Overview shows fewer permissions and accessible resources

Switch back to `sys_admin` to continue.

### Step 3: Test Permissions

- **Permission Tester** (Check) — Test if any user can perform any action on any resource
- **RLS Simulator** — Side-by-side comparison of what two users see in the same table

### Step 4: Manage Entities (CRUD)

Open **Entity Browser** to manage the core authorization objects:

| Tab | What It Manages |
|-----|----------------|
| Subjects | Users and groups — assign/revoke roles |
| Roles | Roles — attach permissions to resources |
| Resources | Protected objects (modules, tables, columns, APIs) |
| Policies | ABAC policies — RLS rules, data masking, conditions |
| Actions | Defined actions (read, write, execute, approve, etc.) |

### Step 5: Explore Data

- **Data Explorer** (Tables) — Config-SM driven dynamic UI (Path A experience)
- **Raw Tables** — Direct table view with column access indicators (visible / masked / denied)

### Step 6: Review Audit Logs

- **Audit Log** — Two modes:
  - Access Audit: who accessed what, when, allowed/denied
  - Admin Audit: who changed what configuration

---

## Core Concepts

### Permission Levels (L0-L3)

| Level | Scope | Example |
|-------|-------|---------|
| L0 | Functional access | "PE can access module `mrp.lot_tracking`" |
| L1 | Row-level (RLS) | "PE can only see rows where `product_line = 'SSD-Controller'`" |
| L2 | Column masking | "PE cannot see `unit_price` — it gets masked" |
| L3 | Composite actions | "`approve` = read + write + execute" |

### Three Enforcement Paths

All paths are controlled by the same SSOT (Single Source of Truth):

| Path | Channel | How It Works |
|------|---------|-------------|
| A | Config-SM UI | Metadata-driven pages — UI renders based on permission config |
| B | Web API | Express middleware checks `authz_check()` before serving data |
| C | Direct DB | PostgreSQL native `GRANT` + RLS policies via PgBouncer |

### Key Database Functions

| Function | Purpose |
|----------|---------|
| `authz_resolve(user, groups, context)` | Resolve full L0-L3 permissions |
| `authz_check(user, groups, action, resource)` | Single permission check (boolean) |
| `authz_filter(user, context, resource, path)` | Generate RLS WHERE clause |
| `authz_resolve_web_acl(user, groups)` | Resolve UI navigation ACL |

---

## Common Admin Tasks

### Add a new user
1. Entity Browser > Subjects > Create
2. Fill in subject_id, display_name, department
3. Assign roles via the role assignment panel

### Grant a role access to a resource
1. Entity Browser > Roles > Select role > Permissions
2. Add permission: pick resource + action + effect (allow/deny)

### Set up row-level filtering
1. Entity Browser > Policies > Create
2. Set policy type, target role, RLS expression (e.g. `product_line = 'SSD-Controller'`)
3. Assign the policy to specific role-resource pairs

### Verify a permission change
1. Permission Tester > Enter user, action, resource > Check
2. RLS Simulator > Compare before/after with two users

---

## Service Ports

| Service | Port | URL |
|---------|------|-----|
| Dashboard UI | 5173 | http://localhost:5173 |
| AuthZ API | 3001 | http://localhost:3001 |
| PostgreSQL | 5432 | `psql -h localhost -U nexus_admin -d nexus_authz` |
| PgBouncer | 6432 | Connection pooler for Path C |
| Redis | 6379 | Cache layer |
| phpLDAPadmin | 8090 | http://localhost:8090 (requires `make up-ldap`) |
| Metabase BI | 3100 | http://localhost:3100 (requires `make metabase-up`) |

---

## Useful Make Commands

```bash
make help             # Show all available commands
make db-reset         # Destroy and recreate database from scratch
make db-seed          # Load dev seed data
make verify           # Run Milestone 1 verification tests
make verify-path-c    # Run Path C verification (RLS + PG roles)
make q-resolve        # Quick-check: resolve permissions for PE user
make q-check          # Quick-check: sample authz_check queries
make ldap-sync        # Sync LDAP directory to database
```
