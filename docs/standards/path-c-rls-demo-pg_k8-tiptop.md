# Path C RLS Demo — Targeting `ds:pg_k8` / schema `tiptop`

**Status**: Active reference (replaces the old `lot_status` / `sales_order` POC fixtures)
**Last updated**: 2026-05-04 (ARCH-02 cleanup)

## Why this doc exists

Pre-ARCH-02 the Path C native-RLS demo (PG `CREATE POLICY` + `pg_has_role` based predicates) operated on two synthetic tables — `lot_status` and `sales_order` — that lived in `nexus_data.public`. Those fixtures and the 12 sibling mock tables (`cp_ft_result`, `wip_inventory`, `reliability_report`, `rma_record`, `price_book`, `npi_gate_checklist`, `yield_events`, `lot_status_history`, `lot_daily_flow`, `v_lot_status_pe`, `v_lot_status_sales`, `yield_daily_trend`) were dropped in:

- `database/migrations/data/V008__drop_demo_business_tables.sql` (nexus_data side)
- `database/migrations/V090__drop_mock_resource_bindings.sql` (authz bindings + nexus_authz residue)

Going forward, Path C demos point at the real Phison Greenplum warehouse:

| field | value |
|---|---|
| `data_source_id` | `ds:pg_k8` |
| `db_type` | `greenplum` (PG-wire compatible) |
| `host` | `192.168.199.72` |
| `port` | `30000` |
| `database_name` | `dc` |
| `connector_user` | `gpadmin` |
| `connector_password` | `<set in .env.local — NEVER commit>` |
| `schemas` | `["tiptop"]` |

Bootstrapped by `database/seed/dev-seed.sql` (cosmetic columns only — host/port/user/schemas are managed by Adam via dashboard per Article 8 of `docs/constitution.md`).

## Picking a demo table

The historical demo predicate (`pg_has_role(current_user, 'pe_role', 'MEMBER')` denying SSD product line columns) was tied to `lot_status`. To repeat that on `tiptop`, pick **any small read-only fact table** with a categorical column we can use as the partitioning predicate. Candidates Adam can choose from at demo time (TBD):

- `<TIPTOP_TEST_TABLE>` — placeholder. Replace with the actual table name (e.g. `tiptop.imaaa_t`, `tiptop.bomma_t`) before running the demo.
- The categorical predicate column likewise becomes `<TIPTOP_PRED_COL>`.

> TODO (Adam): pick the demo table once the AuthZ → tiptop read role is provisioned on Greenplum. Update this file's placeholders + any SQL snippet shipped to ops.

## RLS demo skeleton (template — fill placeholders)

```sql
-- Create read-scoped role
CREATE ROLE IF NOT EXISTS pathc_demo_pe;

-- Enable RLS on the chosen table
ALTER TABLE tiptop.<TIPTOP_TEST_TABLE> ENABLE ROW LEVEL SECURITY;

-- Policy: PE role only sees rows where <TIPTOP_PRED_COL> = 'SSD'
CREATE POLICY tiptop_demo_pe ON tiptop.<TIPTOP_TEST_TABLE>
    FOR SELECT
    TO pathc_demo_pe
    USING (<TIPTOP_PRED_COL> = 'SSD');
```

## What the dashboard / API expect

Once the demo table is registered as an `authz_resource` with `data_source_id = 'ds:pg_k8'`, the following routes will work without any further change:

- `GET  /api/browse/tables?data_source_id=ds:pg_k8` — list tiptop tables
- `GET  /api/browse/tables/<TIPTOP_TEST_TABLE>?data_source_id=ds:pg_k8` — column metadata
- `POST /api/rls/simulate { table: '<TIPTOP_TEST_TABLE>', data_source_id: 'ds:pg_k8' }`
- `GET  /api/data-explorer?data_source_id=ds:pg_k8` — Data Explorer UI

`data_source_id` is now mandatory on every query path (ARCH-02). Calling these routes without it returns HTTP 400.

## Audit trail

- 2026-05-04 — ARCH-02: mock fixtures removed, doc retargets demo to `ds:pg_k8` / `tiptop`.
- (pre) — `lot_status` + `sales_order` POC fixtures used. See git history of `database/migrations/data/V001__business_tables.sql` and `V003__remaining_business_tables.sql`.
