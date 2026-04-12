# API & Dashboard Reference

> Maintained here. CLAUDE.md points to this file.

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
| GET | /api/datasources | List registered data sources | ADMIN/AUTHZ_ADMIN/DBA |
| POST | /api/datasources | Register new data source (with connection test) | ADMIN/AUTHZ_ADMIN/DBA |
| PUT | /api/datasources/:id | Update data source connection info | ADMIN/AUTHZ_ADMIN/DBA |
| DELETE | /api/datasources/:id | Deactivate data source | ADMIN/AUTHZ_ADMIN/DBA |
| POST | /api/datasources/:id/test | Test data source connection | ADMIN/AUTHZ_ADMIN/DBA |
| POST | /api/datasources/:id/discover | Discover schema → auto-create resources | ADMIN/AUTHZ_ADMIN/DBA |
| GET | /api/datasources/:id/tables | List tables in data source | ADMIN/AUTHZ_ADMIN/DBA |

Source: `services/authz-api/src/routes/`

## Dashboard Tabs

| Tab | Description | Visibility |
|-----|-------------|------------|
| Overview | System stats + quick navigation | All users |
| Permission Resolver | authz_resolve() with L0/L1/L2/L3 display | All users |
| Permission Checker | Single + batch authz_check() | All users |
| Permission Matrix | Role x Resource grid | All users |
| RLS Simulator | Side-by-side data comparison with column mask/deny | All users |
| Workbench | Live data with column visibility + RLS applied | All users |
| Pool Management | Path C pool profiles, assignments, credentials, sync | Admin only |
| Data Browser | Browse SSOT tables (subjects, roles, resources, policies) | All users |
| Audit Log | Query audit log with filters | Admin only |

Source: `apps/authz-dashboard/src/components/`

## Auth Headers (POC)

```
X-User-Id: user:wang_pe
X-User-Groups: group:PE_SSD,group:RD_FW   (optional — auto-resolved from DB if omitted)
```
