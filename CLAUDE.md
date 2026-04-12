# CLAUDE.md — Phison Data Nexus

## Project Overview

Phison Data Nexus (`phison-data-nexus`) is an authorization service platform for Phison Electronics' internal data center. It provides a unified AuthZ layer enforcing access control across three paths:

- **Path A**: Config-as-State-Machine UI (metadata-driven)
- **Path B**: Traditional web pages (API/SQL with AuthZ middleware)
- **Path C**: Direct DB connections (PG native GRANT + RLS)

## Tech Stack

- **Backend**: Node.js (TypeScript), npm scope `@nexus/*`
- **Database**: PostgreSQL 16 (primary), with adapter abstraction for MySQL/MongoDB/MSSQL
- **Cache**: Redis (L1) + session cache (L2)
- **Monorepo**: Nx or Turborepo
- **Deployment**: Kubernetes via Helm chart (`nexus-platform`), Docker Compose for local dev
- **Auth**: LDAP/Keycloak for AuthN, custom AuthZ service for authorization

## Project Structure

```
data-nexus/
├── apps/
│   └── authz-dashboard/       # React + Vite + Tailwind dashboard (port 5173)
│       └── src/
│           ├── AuthzContext.tsx # AuthzProvider + useAuthz/useAuthzCheck hooks
│           ├── api.ts          # API client with auth header support
│           └── components/     # 7 tab components (Resolve/Check/Matrix/RLS/Pool/Browser/Audit)
├── services/
│   └── authz-api/             # Express API wrapping PG functions (port 3001)
│       └── src/
│           ├── routes/         # resolve, check, filter, matrix, rls-simulate, browse, pool
│           ├── middleware/     # authz.ts (requireAuth/requireRole/requirePermission)
│           └── audit.ts       # Buffered audit log writer
├── database/
│   ├── migrations/            # V001-V019 sequential SQL migrations
│   └── seed/                  # Dev seed data (19 groups, 18 users, 16 roles, 40+ resources)
├── deploy/
│   ├── docker-compose/        # PG 16 + Redis 7 + OpenLDAP local dev stack
│   └── ldap/seed/             # LDAP seed LDIF files (groups + people + membership)
├── docs/                      # Architecture docs & startup guide
│   ├── PROGRESS.md            # Living progress tracker (SSOT for project status)
│   └── standards/             # Dev standards, security rules, known risks
├── scripts/                   # Utility scripts (verify-milestone1.sh)
└── Makefile                   # Dev commands (make up/dev/verify/clean)
```

## Key Docs

- `docs/PROGRESS.md` — **Read this first every session.** Living progress tracker (SSOT for what's done/remaining)
- `docs/phison-data-nexus-architecture-v2.4.md` — Full architecture spec (SSOT for design decisions)
- `docs/nexus-startup-guide.md` — 4-milestone execution plan (local setup → production-ready)
- `docs/backlog-tech-debt.md` — Known issues & tech debt items
- `docs/standards/` — Dev standards, security rules, known risks

## Database Migrations

| File | Content |
|------|---------|
| V001 | ENUM types |
| V002 | Core tables (subject, resource, action, role, permission, subject_role) |
| V003 | Policy tables (policy, composite_action, mask_function registry) |
| V004 | Path C pool tables (pool_profile, pool_assignment, pool_credentials) |
| V005 | Sync & audit tables + indexes |
| V006 | Policy version table + auto-version trigger |
| V007 | Core functions (_authz_resolve_roles, authz_check, authz_filter, authz_check_from_cache) |
| V008 | Path A: authz_resolve() |
| V009 | Path B: authz_resolve_web_acl() |
| V010 | Path C: authz_sync_db_grants(), authz_sync_pgbouncer_config() |
| V011 | Audit batch insert function |
| V012 | Cache invalidation triggers (LISTEN/NOTIFY) |
| V013 | Base seed data (roles, actions, mask function registry) |
| V014 | Sample lot_status + sales_order data |
| V015 | SSOT: _authz_pool_ssot_denied_columns(), v_pool_ssot_check view, updated sync |
| V016 | Column mask PG functions (fn_mask_full/partial/hash/range) |
| V017 | Fix authz_filter() resource_condition data_domain matching |
| V018 | Group membership table (authz_group_member) + authz_resolve_user_groups() |
| V019 | Path C native RLS (PG roles, GRANT, RLS policies on lot_status/sales_order) |

## API Endpoints

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| GET | /healthz | Health check | Public |
| POST | /api/resolve | authz_resolve() — Path A config | Public |
| POST | /api/resolve/web-acl | authz_resolve_web_acl() — Path B | Public |
| POST | /api/check | authz_check() — single permission | Public |
| POST | /api/check/batch | Batch permission check | Public |
| POST | /api/filter | authz_filter() — RLS clause | Public |
| GET | /api/matrix | Permission matrix (role x resource) | Public |
| POST | /api/rls/simulate | RLS simulation with column masks | Public |
| GET | /api/browse/* | Browse subjects/roles/resources/policies/actions/audit-logs | Public |
| GET/POST/PUT/DELETE | /api/pool/* | Pool CRUD + sync operations | ADMIN/AUTHZ_ADMIN/DBA |

## Dashboard Tabs

| Tab | Description | Visibility |
|-----|-------------|------------|
| Permission Resolver | authz_resolve() with L0/L1/L2/L3 display | All users |
| Permission Checker | Single + batch authz_check() | All users |
| Permission Matrix | Role x Resource grid | All users |
| RLS Simulator | Side-by-side data comparison with column mask/deny | All users |
| Pool Management | Path C pool profiles, assignments, credentials, sync | Admin only |
| Data Browser | Browse SSOT tables (subjects, roles, resources, policies) | All users |
| Audit Log | Query audit log with filters | Admin only |

## Development Milestones

> Detailed status in `docs/PROGRESS.md` (the SSOT). Summary below:

1. **AuthZ runs locally** (Week 1-2): ✅ Complete
2. **First page is permission-aware** (Week 3-4): ✅ Complete
3. **All three paths enforced** (Week 5-8): 🟡 In Progress (LDAP done, API middleware done, Path C done, admin CRUD remaining)
4. **Production-ready** (Week 9-12): ❌ Not started

## SSOT Principles

- All permissions flow from `authz_role_permission` and `authz_policy` tables
- Path C pool denied_columns derived from SSOT via `_authz_pool_ssot_denied_columns()`
- `v_pool_ssot_check` view detects drift between static and SSOT-derived config
- Column mask rules in L2 policies, enforced by actual PG mask functions
- Cache invalidation triggers on policy/permission/role changes
- Audit logging via buffered `authz_audit_batch_insert()`

## Core Concepts

- **SSOT**: All permissions defined in `authz_role_permission` and `authz_policy` tables
- **authz_resolve()**: PG function that resolves permissions for a given user/resource
- **Config-SM**: Config-as-State-Machine pattern driving UI rendering and data filtering
- **RLS**: Row-Level Security for Path C enforcement
- **L0-L3**: Permission granularity levels (functional → data domain → row/column → composite actions)

## Conventions

- Language: TypeScript for all backend services
- Database migrations: sequential numbered SQL files (V001-V0xx)
- API style: RESTful, JSON
- Auth headers: X-User-Id, X-User-Groups (simulated for POC)
- Testing: unit + integration tests required for AuthZ logic
- Commit messages: concise, descriptive (English)

## Commands

```bash
# Start PG + Redis
make up

# Reset database (destroy + recreate)
make db-reset

# Start API server (port 3001)
make dev-api

# Start dashboard UI (port 5173)
make dev-ui

# Start everything
make dev

# Run Milestone 1 verification
make verify

# Interactive psql
make db-psql

# Quick queries
make q-resolve    # Resolve PE SSD user
make q-check      # Sample authz_check queries
make q-filter     # RLS filter for PE SSD
make q-web-acl    # Web ACL for admin
```
