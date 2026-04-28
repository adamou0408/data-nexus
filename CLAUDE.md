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
│   ├── agents/                # 16 agent role definitions + dba-guardian-hiring
│   └── plans/
│       ├── v3-phase-1/        # Active sub-plans index (README.md inside)
│       └── _ARCHIVED/         # Deprecated docs (e.g., requirements_spec v1)
├── apps/authz-dashboard/      # React dashboard (port 13173)
├── services/
│   ├── authz-api/             # Express API (port 13001)
│   └── identity-sync/         # LDAP → DB sync service
├── database/
│   ├── migrations/            # sequential SQL migrations (V001+, incl. TimescaleDB)
│   └── seed/                  # Dev seed data
├── deploy/
│   ├── docker-compose/        # TimescaleDB/PG 16 (15432) + Redis 7 (16379) + OpenLDAP
│   └── ldap/seed/             # LDAP seed LDIF files
├── docs/                      # See "Where Things Live" below
└── Makefile                   # Run `make help` for all commands
```

## Status

> **State SSOT:** `docs/PROGRESS.md` (read first every session — *what's active this sprint*)
> **Long-term reference:** `docs/plan-v3-phase-1.md` (don't structure new work from this — sprint is the unit)

**Done foundations:** AuthZ runs locally · permission-aware UI · all three paths enforced (LDAP, middleware, Path C, admin CRUD, external sync, Config-SM, Metabase BI). Detail in `docs/PROGRESS.md`.

**Active work:** see `docs/PROGRESS.md` *This Sprint* section. Don't re-derive sprint scope from this file.

**Hard gates to protect** (one-way doors — *only these* warrant phase-style guarding):
- **M4 prod-ready go-live** (SEC-06 / Helm / Keycloak / LDAP Cron / Redis) — blocks Smart Analyst 2.0 / AI Agent integration. Tracker: `.claude/plans/v3-phase-1/m4-prod-ready-tracker.md`.
- **Path A → Tier 2 admin form migration** — irreversible; only open after Tier 2 alpha self-validates ≥ 1 business workflow.
- **Demo target:** 2027-05.

**Deferred / parked:** Oracle 19c CDC (designed, not yet impl). Detail: `docs/wishlist-features.md`.

> ⚠️ **Anti-phase anchor:** Do **not** structure new work around quarterly buckets, "Phase 1.5/2", or extrapolated gate language unless it touches a hard gate above. Most work is pure-additive — just write the next migration / route / page. Sprint-level decisions live in `docs/PROGRESS.md`.

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

**Routing convention** — 3 buckets:
- **Rules** (how to behave): `CLAUDE.md` / `docs/constitution.md` / `.claude/agents/` / `docs/standards/`
- **Plans** (what to do): `docs/plan-v3-phase-1.md` (master) + `.claude/plans/v3-phase-1/*.md` (tactical)
- **State** (where we are): `docs/PROGRESS.md` / `docs/backlog-tech-debt.md` / `docs/wishlist-features.md`

| What | Where | When to update |
|------|-------|----------------|
| Long-term track reference | `docs/plan-v3-phase-1.md` | When a hard gate above changes, or architectural decision lands |
| Tactical sub-plans (per-feature) | `.claude/plans/v3-phase-1/` (+ README.md index) | Per sub-plan owner |
| Agent constitution (binding) | `docs/constitution.md` | When safety rules change (Article 8 amendment) |
| Progress & milestones | `docs/PROGRESS.md` | Weekly |
| API & dashboard reference | `docs/api-reference.md` | After adding routes or tabs |
| Architecture spec (foundational) | `docs/phison-data-nexus-architecture-v2.4.md` | Architecture decisions (pre-Phase-1 baseline) |
| Architecture diagrams | `docs/architecture-diagram.md` | After structural changes |
| ER diagram | `docs/er-diagram.md` | After DB schema changes |
| Tech debt & backlog | `docs/backlog-tech-debt.md` | When discovering issues |
| Feature requests / parked work | `docs/wishlist-features.md` | When receiving requirements outside current sprint scope |
| Data Mining plan | `docs/design-data-mining-engine.md` | When implementing data mining features |
| Data Mining vision | `.claude/plans/v3-phase-1/design-mining-vision.md` | When trigger conditions are met |
| Agent roles & principles | `.claude/agents/README.md` | When onboarding agents |
| Dev standards | `docs/standards/` | When rules change |
| Claude toolkit (memory/skills/agents) usage | `docs/standards/claude-toolkit-usage.md` | When workflow changes, or 半年 review |
| Local dev setup / startup | `docs/nexus-startup-guide.md` | When dev workflow changes |
| Testing guide | `docs/standards/testing-guide.md` | When test conventions change |
| Path A / Config-SM detail spec | `docs/config_driven_ui_requirements.md` (appendix to v2.4) | When Config-SM rules change |
| DBA hiring / skillmap | `.claude/agents/dba-guardian-hiring.md` | When DBA hiring criteria change |
| Cross-Source Discovery Tab plan (active) | `docs/plan-cross-source-discovery-tab.md` | When Discover Tab scope changes |
| ARCH-01 (business DB separation) plan | `docs/plan-business-db-separation.md` (狀態：實作完成,待 dev 部署 — see PROGRESS.md ARCH-01) | After ARCH-01 deployed in dev |
| Available commands | `make help` | When adding Makefile targets |
| Claude Code permissions | `.claude/settings.local.json` | When needing new allow patterns |
| ~~`docs/requirements_spec.md`~~ | **ARCHIVED 2026-04-22** — moved to `.claude/plans/_ARCHIVED/requirements_spec-v1-deprecated-20260422.md`. Active SSOT: `docs/plan-v3-phase-1.md` | — |
| **Doc reorg proposal (executed 2026-04-22)** | `.claude/plans/v3-phase-1/doc-reorg-proposal.md` | Historical — reorg complete |
