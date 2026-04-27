# Legacy / opt-in seed scripts

Files in this directory are **NOT auto-loaded** at container init.

`deploy/docker-compose/init-db.sh:36-41` uses a non-recursive glob:

```bash
for f in /docker-entrypoint-initdb.d/seed/*.sql; do ...
```

Subdirectories like `_demo/` are skipped. Apply manually only when needed.

## Files

- `pg_k8cluster-scenario.sql` — original Tiptop ERP module-mapping scenario.
  Targets the placeholder `ds:pg_k8cluster` (not a real DS). Superseded by
  the real Greenplum `ds:pg_k8` registration flow + dashboard module
  mapping. Do not re-apply on top of `ds:pg_k8` — would collide with the
  user-created `module:pg_tiptop_v1`.
- `ui-config-seed.sql` — 8 Path A demo pages (lot_explorer, lot_detail,
  test_results, sales_orders, npi_checklist, quality_reports, rma_records,
  price_book). All bind to mock modules (`module:mrp.*` / `module:sales.*` /
  `module:quality.*`) that were removed during the 2026-04-27 mock cleanup.
  Reapply only after recreating those mock modules.

## Manual apply

```bash
make psql-authz < database/seed/_demo/pg_k8cluster-scenario.sql
make psql-authz < database/seed/_demo/ui-config-seed.sql
```
