# Phison Data Nexus

Unified authorization service platform for Phison Electronics' internal data center. Enforces access control across three paths:

- **Path A**: Config-as-State-Machine UI (metadata-driven)
- **Path B**: Traditional web pages (API/SQL with AuthZ middleware)
- **Path C**: Direct DB connections (PG native GRANT + RLS + pgbouncer)

## Tech Stack

- **Backend**: Node.js (TypeScript), Express API
- **Database**: PostgreSQL 16 + TimescaleDB, Docker Compose
- **Frontend**: React + Vite + Tailwind
- **Auth**: LDAP (OpenLDAP for POC) / Keycloak, custom AuthZ service
- **BI**: Metabase (self-service analytics via Path C)

## Project Structure

```
data-nexus/
├── .claude/                   # Agent definitions + tactical sub-plans
├── apps/authz-dashboard/      # React dashboard (port 13173)
├── services/
│   ├── authz-api/             # Express API (port 13001)
│   └── identity-sync/         # LDAP → DB sync service
├── database/
│   ├── migrations/            # V001-V091 sequential SQL migrations (incl. TimescaleDB)
│   ├── migrations/data/       # Business DB migrations
│   └── seed/                  # Dev seed data
├── deploy/
│   ├── docker-compose/        # PG 16 + Redis 7 + pgbouncer + Metabase + LDAP
│   └── ldap/seed/             # LDAP seed LDIF files
├── docs/                      # Architecture, progress, standards, constitution
└── Makefile                   # Run `make help` for all commands
```

## Quick Start

Local-process dev (recommended for hot-edit ergonomics):

```bash
make up          # Start PG + Redis + pgbouncer
make db-reset    # Initialize databases (nexus_authz + nexus_data)
make dev         # Start API (port 13001) + UI (port 13173)
make metabase-up # Start Metabase BI (port 3100)
make help        # Show all available commands
```

Containerized dev (full stack, bind-mount HMR — see `DEV-DOCKER-V01`):

```bash
make dev-docker  # PG + Redis + API + UI all in containers
make logs-docker # Tail authz-api-dev + dashboard-dev logs
```

## Documentation

| Doc | Purpose |
|-----|---------|
| `ONBOARDING.md` | Admin/user walkthrough — start here for the dashboard tour |
| `docs/PROGRESS.md` | Project progress (state SSOT — read first every session) |
| `docs/phison-data-nexus-architecture-v2.4.md` | Full architecture spec |
| `docs/architecture-diagram.md` | Component / data-flow diagrams |
| `docs/api-reference.md` | API + dashboard route reference |
| `docs/config_driven_ui_requirements.md` | Config-Driven UI (Path A) spec |
| `docs/er-diagram.md` | Database ER diagram |
| `docs/constitution.md` | Agent safety rules (binding when contributing via AI agents) |
| `docs/backlog-tech-debt.md` | Tech debt tracker |
| `docs/wishlist-features.md` | Parked features / future scope |
| `docs/nexus-startup-guide.md` | Local dev environment setup |
| `CLAUDE.md` | Project context for Claude Code agents |

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0).
