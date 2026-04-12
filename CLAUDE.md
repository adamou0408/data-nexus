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
│   └── authz-dashboard/       # React + Vite verification dashboard (port 5173)
├── services/
│   └── authz-api/             # Express API wrapping PG functions (port 3001)
├── database/
│   ├── migrations/            # V001-V014 sequential SQL migrations
│   └── seed/                  # Dev seed data (test users, resources, policies)
├── deploy/
│   └── docker-compose/        # PG 16 + Redis 7 local dev stack
├── docs/                      # Architecture docs & startup guide
├── scripts/                   # Utility scripts (verify-milestone1.sh)
└── Makefile                   # Dev commands (make up/dev/verify/clean)
```

## Key Architecture Docs

- `docs/phison-data-nexus-architecture-v2.4.md` — Full architecture spec (AuthZ service design, schema, three access paths, performance analysis, production readiness)
- `docs/nexus-startup-guide.md` — 4-milestone execution plan (local setup → production-ready)

## Development Milestones

1. **AuthZ runs locally** (Week 1-2): PG schema + seed data + `authz_resolve()` via docker-compose
2. **First page is permission-aware** (Week 3-4): REST API + workbench page with RLS
3. **All three paths enforced** (Week 5-8): Path B/C + audit logging + Admin CRUD
4. **Production-ready** (Week 9-12): Redis cache + Helm/K8s + Policy Simulator + LDAP sync

## Core Concepts

- **SSOT**: All permissions defined in `authz_role_permission` and `authz_policy` tables
- **authz_resolve()**: PG function that resolves permissions for a given user/resource
- **Config-SM**: Config-as-State-Machine pattern driving UI rendering and data filtering
- **RLS**: Row-Level Security for Path C enforcement

## Conventions

- Language: TypeScript for all backend services
- Database migrations: sequential numbered SQL files
- API style: RESTful
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

# Run Milestone 1 verification
make verify

# Interactive psql
make db-psql
```
