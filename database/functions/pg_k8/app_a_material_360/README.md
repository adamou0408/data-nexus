# App A — 料號 360° (Material 360°)

Target DB: **pg_k8** (192.168.199.72:30000/dc)

## Deployment contract (enforced in every file)

1. `SECURITY INVOKER` — native PG permissions cascade through
2. `STABLE` / `IMMUTABLE` where possible — only Action functions are `VOLATILE`
3. Return column names preserve source column names (`tc_ima001`, not `material_no`) so
   future post-filter masking can map back to source policy
4. Function header comment declares `@inputs` lineage for the metadata engine

## Files

| Layer | File | Kind | Volatility |
|-------|------|------|-----------|
| L1 | 01_fn_material_lookup.sql | query | STABLE |
| L1 | 02_fn_material_search.sql | query | STABLE |
| L2 | 03_fn_material_by_family.sql | query | STABLE |
| L2 | 04_fn_material_by_type.sql | query | STABLE |
| L3 | 05_fn_material_full_trace.sql | query | STABLE |
| L3 | 06_fn_material_substitution_map.sql | query | STABLE |
| L4 | 07_fn_material_quality_card.sql | report | STABLE |
| L4 | 08_fn_material_attr_sync.sql | action | VOLATILE |

## How to deploy

1. Open Data Nexus Dashboard → Query Tool → **Author** mode
2. Pick data source = `pg_k8`
3. Paste file contents → **Validate** → **Deploy**
4. Function auto-registers in `authz_resource` with ADMIN execute grant
