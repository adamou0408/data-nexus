# CLAUDE.md — Phison Data Nexus

## Project Overview

Phison Data Nexus is an authorization service platform for Phison Electronics' internal data center. Unified AuthZ layer enforcing access control across three paths:

- **Path A**: Config-as-State-Machine UI (metadata-driven)
- **Path B**: Traditional web pages (API/SQL with AuthZ middleware)
- **Path C**: Direct DB connections (PG native GRANT + RLS)

## Tech Stack

- **Backend**: Node.js (TypeScript), npm scope `@nexus/*`
- **Database**: PostgreSQL 16 + TimescaleDB (hypertables, compression, continuous aggregates), Docker Compose for local dev
- **Frontend**: React + Vite + Tailwind (port 13173)
- **Auth**: LDAP (OpenLDAP for POC) / Keycloak for AuthN, custom AuthZ service

## Project Structure

```
data-nexus/
├── .claude/
│   ├── agents/                # 16 agent role definitions (see README.md inside)
│   └── plans/                 # Implementation plans (Oracle CDC)
├── apps/authz-dashboard/      # React dashboard (port 13173)
├── services/
│   ├── authz-api/             # Express API (port 13001)
│   └── identity-sync/         # LDAP → DB sync service
├── database/
│   ├── migrations/            # V001-V030 sequential SQL migrations (incl. TimescaleDB)
│   └── seed/                  # Dev seed data
├── deploy/
│   ├── docker-compose/        # TimescaleDB/PG 16 (15432) + Redis 7 (16379) + OpenLDAP
│   └── ldap/seed/             # LDAP seed LDIF files
├── docs/                      # See "Where Things Live" below
└── Makefile                   # Run `make help` for all commands
```

## Milestones

> SSOT: `docs/PROGRESS.md` (read first every session)

1. **AuthZ runs locally**: ✅ Complete
2. **First page is permission-aware**: ✅ Complete
3. **All three paths enforced**: ✅ Complete (LDAP, middleware, Path C, admin CRUD, external sync, Config-SM, Metabase BI)
4. **Production-ready**: 🟡 In Progress
   - Infrastructure: SEC-06 secrets, Redis cache, Helm chart, LDAP CronJob, Keycloak SSO
   - Feature: Data Mining module, Metabase BI self-service, Policy Simulator
   - Planned: Oracle 19c CDC support (design complete, 7 steps)
5. **AI Agent Integration** (Smart Analyst 2.0): ⏳ Blocked on M4 go-live

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

## Agent Constitution (binding)

**Before modifying or deleting any user-provided row in `authz_data_source`,
agents MUST obtain explicit human consent in the same conversation turn.**

- **Protected**: rows in `authz_data_source` that are NOT agent-created test data.
- **Consent required for**: DELETE, soft-delete (is_active=FALSE), and UPDATE to
  any identity field (host, port, database_name, connector_user,
  connector_password, schemas, oracle_connection).
- **Free to mutate**: display_name, description, last_synced_at (cosmetic/metadata).
- **Agent-created test data**: must use `ds:_test_*` / `ds:_agent_*` prefix AND
  point at localhost/Docker only AND be cleaned up before session end.

Full rules: **`docs/constitution.md`** (must-read for any agent touching datasource operations).

## Where Things Live

| What | Where | When to update |
|------|-------|----------------|
| Agent constitution (binding) | `docs/constitution.md` | When safety rules change (requires user approval per Article 8) |
| Progress & migrations | `docs/PROGRESS.md` | After completing features or adding migrations |
| API & dashboard reference | `docs/api-reference.md` | After adding routes or tabs |
| Architecture spec | `docs/phison-data-nexus-architecture-v2.4.md` | Architecture decisions |
| Architecture diagrams | `docs/architecture-diagram.md` | After structural changes (new paths, services, or DB splits) |
| ER diagram | `docs/er-diagram.md` | After DB schema changes |
| Tech debt & backlog | `docs/backlog-tech-debt.md` | When discovering issues |
| Feature requests | `docs/wishlist-features.md` | When receiving requirements |
| Data Mining plan | `docs/design-data-mining-engine.md` | When implementing data mining features |
| Data Mining vision | `docs/design-data-mining-vision.md` | When trigger conditions are met (see §附錄D) |
| Agent roles & principles | `.claude/agents/README.md` | When onboarding agents or adding departments |
| Oracle CDC plan | `.claude/plans/` | When implementing Oracle support |
| Dev standards | `docs/standards/` | When rules change |
| Available commands | `make help` | When adding Makefile targets |
| Claude Code permissions | `.claude/settings.local.json` | When needing new allow patterns |
