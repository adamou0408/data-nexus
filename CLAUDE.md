# CLAUDE.md — Phison Data Nexus

## Project Overview

Phison Data Nexus is an authorization service platform for Phison Electronics' internal data center. Unified AuthZ layer enforcing access control across three paths:

- **Path A**: Config-as-State-Machine UI (metadata-driven)
- **Path B**: Traditional web pages (API/SQL with AuthZ middleware)
- **Path C**: Direct DB connections (PG native GRANT + RLS)

## Tech Stack

- **Backend**: Node.js (TypeScript), npm scope `@nexus/*`
- **Database**: PostgreSQL 16, Docker Compose for local dev
- **Frontend**: React + Vite + Tailwind (port 5173)
- **Auth**: LDAP (OpenLDAP for POC) / Keycloak for AuthN, custom AuthZ service

## Project Structure

```
data-nexus/
├── apps/authz-dashboard/      # React dashboard (port 5173)
├── services/
│   ├── authz-api/             # Express API (port 3001)
│   └── identity-sync/         # LDAP → DB sync service
├── database/
│   ├── migrations/            # V001-V029 sequential SQL migrations
│   └── seed/                  # Dev seed data
├── deploy/
│   ├── docker-compose/        # PG 16 + Redis 7 + OpenLDAP
│   └── ldap/seed/             # LDAP seed LDIF files
├── docs/                      # See "Where Things Live" below
└── Makefile                   # Run `make help` for all commands
```

## Milestones

> Detail: `docs/PROGRESS.md` (SSOT — read first every session)

1. **AuthZ runs locally**: ✅ Complete
2. **First page is permission-aware**: ✅ Complete
3. **All three paths enforced**: ✅ Complete (LDAP, middleware, Path C, admin CRUD, external sync, Config-SM, Metabase BI)
4. **Production-ready**: 🟡 In Progress (Redis cache, Helm chart, Policy Simulator, Keycloak SSO remaining)

## Core Concepts

- **SSOT**: All permissions from `authz_role_permission` + `authz_policy` tables. Detail: architecture doc §1
- **authz_resolve()**: PG function resolving L0-L3 permissions for a user
- **L0-L3**: Functional → data domain → row/column → composite actions
- **Config-SM**: Config-as-State-Machine pattern driving UI rendering
- **Three Paths**: Every permission change must consider Path A, B, and C impact

## Conventions

- Language: TypeScript (all backend). PL/pgSQL for DB functions
- Migrations: sequential `V001-V0xx` SQL files
- API: RESTful JSON. Auth via `X-User-Id` / `X-User-Groups` headers (POC)
- Commit messages: concise, descriptive (English)
- Commands: run `make help` for full list

## Where Things Live

| What | Where | When to update |
|------|-------|----------------|
| Progress & migrations | `docs/PROGRESS.md` | After completing features or adding migrations |
| API & dashboard reference | `docs/api-reference.md` | After adding routes or tabs |
| Architecture spec | `docs/phison-data-nexus-architecture-v2.4.md` | Architecture decisions |
| Architecture diagrams | `docs/architecture-diagram.md` | After structural changes (new paths, services, or DB splits) |
| ER diagram | `docs/er-diagram.md` | After DB schema changes |
| Tech debt & backlog | `docs/backlog-tech-debt.md` | When discovering issues |
| Feature requests | `docs/wishlist-features.md` | When receiving requirements |
| Dev standards | `docs/standards/` | When rules change |
| Available commands | `make help` | When adding Makefile targets |
| Claude Code permissions | `.claude/settings.local.json` | When needing new allow patterns |
