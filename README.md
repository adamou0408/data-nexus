# Phison Data Nexus

Unified authorization service platform for Phison Electronics' internal data center. Enforces access control across three paths:

- **Path A**: Config-as-State-Machine UI (metadata-driven)
- **Path B**: Traditional web pages (API/SQL with AuthZ middleware)
- **Path C**: Direct DB connections (PG native GRANT + RLS + pgbouncer)

## Tech Stack

- **Backend**: Node.js (TypeScript), Express API
- **Database**: PostgreSQL 16, Docker Compose
- **Frontend**: React + Vite + Tailwind
- **Auth**: LDAP (OpenLDAP for POC), custom AuthZ service
- **BI**: Metabase (self-service analytics via Path C)

## Project Structure

```
data-nexus/
├── apps/authz-dashboard/      # React dashboard (port 5173)
├── services/
│   ├── authz-api/             # Express API (port 3001)
│   └── identity-sync/         # LDAP → DB sync service
├── database/
│   ├── migrations/            # V001-V024 sequential SQL migrations
│   ├── migrations/data/       # Business DB migrations (V001-V004)
│   └── seed/                  # Dev seed data
├── deploy/
│   ├── docker-compose/        # PG 16 + Redis 7 + pgbouncer + Metabase
│   └── ldap/seed/             # LDAP seed LDIF files
└── docs/                      # Architecture, progress, standards
```

## Quick Start

```bash
make up          # Start PG + Redis + pgbouncer
make db-reset    # Initialize databases (nexus_authz + nexus_data)
make dev         # Start API (port 3001) + UI (port 5173)
make metabase-up # Start Metabase BI (port 3100)
make help        # Show all available commands
```

## Documentation

| Doc | Purpose |
|-----|---------|
| `docs/PROGRESS.md` | Project progress (SSOT) |
| `docs/phison-data-nexus-architecture-v2.4.md` | Full architecture spec |
| `docs/config_driven_ui_requirements.md` | Config-Driven UI spec |
| `docs/er-diagram.md` | Database ER diagram |
| `docs/backlog-tech-debt.md` | Tech debt tracker |

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0).
