# Oracle Direct Path — Deprecation / Migration Survey

**Generated**: 2026-05-04 (post oracle-direct spike)
**Trigger**: `POST /api/data-query/oracle-direct` lands and supersedes parts of legacy Oracle handling
**Scope**: read-only survey, no code changes

---

## 1. Direct replacements (redundant once oracle-direct is adopted)

| Location | Status | Reason |
|---|---|---|
| `services/authz-api/src/routes/oracle-exec.ts` (full file, 130 lines) | **Replace** | Scalar function call fully covered by oracle-direct `oracle_kind: 'function_scalar'`, with the additional benefit of explicit `oracle_owner` (vs hard-coded `oracle_connection.user`) |
| `services/authz-api/src/index.ts` (import + route mount of `oracleExecRouter`) | **Remove** | Drops once route file is removed |
| `apps/authz-dashboard/src/api.ts:358` (`oracleExec` client wrapper) | **Replace** | New `api.oracleDirectQuery` already added alongside (P2 done). Existing callers migrate at their own pace |

## 2. Migration required (attribute schema change)

| Location | Change | Reason |
|---|---|---|
| `services/authz-api/src/routes/datasource.ts:817-823` (Oracle scan attribute build) | Replace `oracle: true` flag with `available_targets: ['oracle_direct']` + `oracle_owner` + `oracle_object` + `oracle_kind: 'function_scalar'` | New oracle-direct route validates these four attrs; legacy `oracle: true` won't satisfy it |
| Existing seeded `authz_resource` rows with `attributes.oracle = true` | Backfill via SQL migration | Otherwise they 400 against new path. **Need to query prod first** to know whether any exist — currently CDC isn't running so likely none |
| `services/authz-api/src/routes/oracle-exec.ts:46` resource_id convention `function:${cdc_target_schema}.${name}` | New convention `function:${oracle_owner_lower}.${name}` | Resource ID should reflect Oracle source schema, not PG-side replica schema |

## 3. Stays as-is

| Location | Reason |
|---|---|
| `services/authz-api/src/db.ts:178` (`getOracleConnection`) | Connection factory; both legacy and new path use it |
| `services/authz-api/src/lib/db-driver.ts` (whole file) | New driver, used only by oracle-direct |
| `oracle_connection` JSONB column on `authz_data_source` | Connection metadata, both paths read it |
| `cdc_target_schema` column | Future CDC replica routing — independent track |
| `services/authz-api/src/routes/datasource.ts:199-209` (Oracle CDC schema bootstrap) | Belongs to CDC pipeline, not query path |
| `services/authz-api/src/routes/datasource.ts:491-520` (Oracle test connection) | Connection-test endpoint, both paths benefit |

## 4. Risks / open questions

- **Legacy attribute exposure**: any deployed `authz_resource` row with `attributes.oracle = true` will fail oracle-direct validation. Need a one-time backfill SQL once we count how many such rows exist.
- **Resource ID conflict**: if an Oracle function was discovered before this change with `function:${cdc_target_schema}.${name}` and is rediscovered after with `function:${oracle_owner_lower}.${name}`, both rows will live side-by-side until one is deleted. Discovery code should detect and clean up.
- **`oracle-exec` callers outside the dashboard repo**: search found only one frontend caller; if external integrations exist they'll break on hard removal.

## 5. Recommended order (flat, no phase anchors)

1. **Now** — oracle-direct route landed, frontend client added (alongside legacy). Spike validation on PS55 is the next gate.
2. **After spike validates with real PS55 data** — extend discovery scan in `datasource.ts:766-845` to write the new attribute schema. Have it write **both** old (`oracle: true`) and new (`available_targets`, `oracle_owner`, etc.) for one release window so any legacy reader doesn't break.
3. **Migration SQL** — backfill any existing legacy rows with new attrs. One-shot script under `database/seed/` or a numbered migration if it touches schema.
4. **Frontend cutover** — replace remaining `api.oracleExec` callers with `api.oracleDirectQuery`.
5. **Drop legacy** — delete `routes/oracle-exec.ts`, drop the route mount, remove `api.oracleExec` from frontend, drop `oracle: true` writer from discovery.

Step 1 is done. Step 2-5 unblock once Adam confirms spike returns real rows from PS55.
