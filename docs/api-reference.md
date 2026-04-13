# API & Dashboard Reference

> Maintained here. CLAUDE.md points to this file.
> Last updated: 2026-04-14

## API Endpoints

### Core AuthZ (public)

| Method | Path | Description |
|--------|------|-------------|
| GET | /healthz | Health check |
| POST | /api/resolve | authz_resolve() — Path A config (L0-L3) |
| POST | /api/resolve/web-acl | authz_resolve_web_acl() — Path B middleware |
| POST | /api/check | authz_check() — single permission check |
| POST | /api/check/batch | Batch permission check |
| POST | /api/filter | authz_filter() — RLS WHERE clause generation |
| GET | /api/matrix | Permission matrix (role x resource grid) |
| POST | /api/rls/simulate | RLS simulation with column masks |
| GET | /api/rls/data | Raw table data (for RLS comparison) |

### Config-Driven UI Engine (requireAuth)

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/config-exec/root | Root card grid — module cards filtered by user permissions |
| POST | /api/config-exec | Execute page by page_id — data + masks + filters |

### Browse — Read (public)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/browse/subjects | List subjects with roles |
| GET | /api/browse/subjects/profiles | User profiles for login selector |
| GET | /api/browse/roles | List roles with assignment/permission counts |
| GET | /api/browse/roles/:id/permissions | Role permissions |
| GET | /api/browse/resources | List resources (optional ?type= filter) |
| GET | /api/browse/resources/unmapped | Unmapped table resources by data source |
| GET | /api/browse/resources/mapped | Mapped table resources by data source |
| GET | /api/browse/resources/:tableId/columns-classified | Column classifications for a table |
| GET | /api/browse/policies | List ABAC policies |
| GET | /api/browse/policies/:id/assignments | Policy assignments |
| GET | /api/browse/actions | List active actions |
| GET | /api/browse/batch-checks | Batch check results for a user |
| GET | /api/browse/action-items | Admin action items (SSOT drift, credential rotation, etc.) |
| POST | /api/browse/data-explorer | Data explorer with access control + masks |
| GET | /api/browse/tables | List business data tables |
| GET | /api/browse/tables/:table | Table schema + sample data |
| GET | /api/browse/functions | List PG functions |
| GET | /api/browse/audit-logs | Access audit log (authz_audit_log) |
| GET | /api/browse/admin-audit | Admin operations audit log (authz_admin_audit_log) |
| GET | /api/browse/classifications | Data classification levels |
| GET | /api/browse/clearance-mappings | Job level to clearance mappings |
| GET | /api/browse/role-pool-map | Dynamic role to pg_role mapping |

### Browse — Admin Mutations (requireRole: ADMIN, AUTHZ_ADMIN)

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/browse/subjects | Create subject |
| PUT | /api/browse/subjects/:id | Update subject |
| DELETE | /api/browse/subjects/:id | Deactivate subject |
| POST | /api/browse/subjects/:id/groups | Add subject to group |
| DELETE | /api/browse/subjects/:id/groups/:gid | Remove from group |
| POST | /api/browse/subjects/:id/roles | Assign role |
| DELETE | /api/browse/subjects/:id/roles/:rid | Remove role |
| POST | /api/browse/roles | Create role |
| PUT | /api/browse/roles/:id | Update role |
| DELETE | /api/browse/roles/:id | Deactivate role |
| POST | /api/browse/roles/:id/permissions | Add permission |
| DELETE | /api/browse/roles/:id/permissions/:pid | Remove permission |
| PUT | /api/browse/roles/:id/clearance | Update security clearance + job level |
| POST | /api/browse/resources | Create resource |
| PUT | /api/browse/resources/:id | Update resource |
| DELETE | /api/browse/resources/:id | Deactivate resource |
| PUT | /api/browse/resources/bulk-parent | Bulk table-to-module mapping |
| PUT | /api/browse/resources/:id/classify | Set/remove data classification |
| POST | /api/browse/policies | Create policy |
| PUT | /api/browse/policies/:id | Update policy |
| DELETE | /api/browse/policies/:id | Deactivate policy |
| POST | /api/browse/policies/:id/assignments | Create policy assignment |
| DELETE | /api/browse/policy-assignments/:id | Delete policy assignment |
| POST | /api/browse/actions | Create action |
| PUT | /api/browse/actions/:id | Update action |
| DELETE | /api/browse/actions/:id | Deactivate action |

### Pool Management (requireRole: ADMIN, AUTHZ_ADMIN, DBA)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/pool/profiles | List pool profiles |
| GET | /api/pool/profiles/:id | Single profile |
| POST | /api/pool/profiles | Create profile |
| PUT | /api/pool/profiles/:id | Update profile |
| DELETE | /api/pool/profiles/:id | Delete profile |
| GET | /api/pool/profiles/:id/assignments | Profile assignments |
| POST | /api/pool/assignments | Create assignment |
| DELETE | /api/pool/assignments/:id | Deactivate assignment |
| POST | /api/pool/assignments/:id/reactivate | Reactivate assignment |
| GET | /api/pool/credentials | List credentials |
| POST | /api/pool/credentials | Create credential |
| DELETE | /api/pool/credentials/:pg_role | Deactivate credential |
| POST | /api/pool/credentials/:pg_role/reactivate | Reactivate credential |
| POST | /api/pool/credentials/:pg_role/rotate | Rotate password |
| GET | /api/pool/uncredentialed-roles | Roles without credentials |
| POST | /api/pool/sync/grants | Sync DB grants to SSOT |
| POST | /api/pool/sync/pgbouncer | Generate pgbouncer config |
| POST | /api/pool/sync/pgbouncer/apply | Apply + reload pgbouncer |
| POST | /api/pool/sync/external-grants | Sync grants to remote DBs |
| POST | /api/pool/sync/external-grants/drift | Detect SSOT drift vs remote |
| GET | /api/pool/metabase-connections | Metabase connection configs |

### Data Source Management (requireRole: ADMIN, AUTHZ_ADMIN, DBA)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/datasources | List data sources |
| GET | /api/datasources/lifecycle-summary | Lifecycle phases summary |
| GET | /api/datasources/:id | Single data source |
| POST | /api/datasources | Register + connection test |
| PUT | /api/datasources/:id | Update connection info |
| DELETE | /api/datasources/:id | Deactivate |
| DELETE | /api/datasources/:id/purge | Purge discovered resources |
| POST | /api/datasources/:id/test | Test connection |
| POST | /api/datasources/:id/discover | Discover schema + auto-create resources |
| GET | /api/datasources/:id/schemas | Available schemas |
| GET | /api/datasources/:id/tables | Tables in data source |
| GET | /api/datasources/:id/lifecycle | Lifecycle phases detail |

Source: `services/authz-api/src/routes/` (10 route files)

## Route Architecture

```
index.ts
├── /api/resolve        → resolve.ts           (public)
├── /api/check          → check.ts             (public)
├── /api/filter         → filter.ts            (public)
├── /api/matrix         → matrix.ts            (public)
├── /api/rls            → rls-simulate.ts      (public)
├── /api/browse         → browse-read.ts       (public — all GET + data-explorer)
├── /api/browse         → browse-admin.ts      (requireRole ADMIN/AUTHZ_ADMIN — all mutations)
├── /api/config-exec    → config-exec.ts       (requireAuth)
├── /api/pool           → pool.ts              (requireRole ADMIN/AUTHZ_ADMIN/DBA)
└── /api/datasources    → datasource.ts        (requireRole ADMIN/AUTHZ_ADMIN/DBA)
```

## Dashboard Tabs

| Tab ID | Component | Description | Visibility |
|--------|-----------|-------------|------------|
| overview | OverviewTab | System stats, action items, quick actions | All users |
| resolve | ResolveTab | authz_resolve() L0-L3 display | All users |
| matrix | MatrixTab | Role x Resource permission grid | All users |
| tables | ConfigEngine | Config-SM data explorer (Path A) | All users |
| metabase | MetabaseTab | Metabase BI integration hub | All users |
| check | CheckTab | Single + batch permission tester | Admin only |
| rls | RlsTab | Side-by-side RLS comparison | Admin only |
| functions | FunctionsTab | PG function browser | Admin only |
| raw-tables | TablesTab | Raw table schema + sample data | Admin only |
| browser | BrowserTab | CRUD for subjects/roles/resources/policies/actions | Admin only |
| pool | PoolTab | Data source lifecycle + pool profiles/credentials/sync | Admin only |
| audit | AuditTab | Access audit + admin audit logs | Admin only |

Source: `apps/authz-dashboard/src/components/` (14 component files)

## Auth Headers (POC)

```
X-User-Id: sys_admin                          (bare ID, no 'user:' prefix)
X-User-Groups: AUTHZ_ADMINS,PE_SSD            (optional — auto-resolved from DB if omitted)
```

Note: `_authz_resolve_roles()` prepends `user:` internally, so headers use bare IDs.
