# V044 Semantic Layer Migration — Design Notes

**Status:** READY-FOR-DBA — open Qs resolved 2026-04-23, awaiting DBA sign-off to move into `database/migrations/`.
**Companion SQL:** `V044__authz_resource_business_term.sql`
**Plan reference:** `docs/plan-v3-phase-1.md` §2.7 "Semantic layer 生命週期"
**Date drafted:** 2026-04-22 · **Reviewed:** 2026-04-23 (Adam)

---

## Open Qs resolved (2026-04-23)

1. **`owner_user_id` type:** confirmed **TEXT** (not BIGINT). Every subject FK in the codebase (V002 authz_subject_role, V004 authz_db_pool_assignment, V018 authz_group_member, V020 authz_data_source) uses `TEXT REFERENCES authz_subject(subject_id)`. Switching one column to BIGINT would split the identity model. Drafter made the right call.
2. **V-number collision:** V043 is the current latest (`V043__module_functions_descriptor.sql`). V044 is free. The pre-existing `V030__timescaledb_audit_hypertable.sql` + `V030__view_function_discovery.sql` collision is an independent latent bug (see new backlog item ARCH-01-FU-3 area + needs its own `MIG-01` track). Not a V044 blocker.
3. **Deprecated rows clearing `blessed_at`/`blessed_by`:** drafter flagged this is probably too strict (loses audit history). **Decision:** keep it strict for v1 (audit lives in `authz_audit_log`, not on the row). Revisit if DBA review surfaces a concrete use case for row-level historical bless metadata.

**Approved by:** Adam (pending DBA counter-sign on column types + CHECK semantics).

---

## 1. V-number choice

- Latest committed migration at draft time: `V043__module_functions_descriptor.sql`
- There is a pre-existing V-number collision at `V030` (`V030__timescaledb_audit_hypertable.sql` and `V030__view_function_discovery.sql`). The operator applying this draft MUST verify the current latest V-number before renaming/moving this file into `database/migrations/`. If another migration lands first, bump to the next free V-number.

## 2. Design decisions

### 2.1 Extend `authz_resource` vs new `bi_semantic_model` table

Locked by §1.2 of the Phase 1 plan: "新建獨立 `bi_semantic_model` 表" is explicitly scope-out. Justifications that apply here:

- Authz already resolves visibility on `authz_resource` (`authz_resolve()`). Putting the business term on the same row means "使用者看不到 = AI 也看不到" (§2.3) comes for free — no separate join/authz layer to maintain.
- Tier 2/3 wizard "只顯 blessed" becomes a single predicate on the row the wizard already has in hand.
- Dependency cascade (§2.6) already walks `authz_resource`; putting terms on the same row means cascade semantics don't need a second code path.

### 2.2 CHECK vs `CREATE TYPE ... AS ENUM`

Chosen: CHECK.

- V001 reserves enums for values that have never churned (`authz_effect`, `authz_granularity`, `policy_status`, etc.). `policy_status` is the only one shaped like a lifecycle and it is still enum — but it predates the hot-iterating portions of the codebase.
- V042 added a new `resource_type` value ('dag') via `ALTER TABLE ... DROP CONSTRAINT ... ADD CONSTRAINT`. That's the project's current pattern for lifecycle fields that might grow.
- `ALTER TYPE ... ADD VALUE` is transactional-hostile (cannot be rolled back inside a transaction in older Postgres, and can't reorder). Lifecycle fields that still see churn are cheaper with CHECK.

### 2.3 `owner_user_id` type — `TEXT` instead of requested `BIGINT`

**Judgement call, flag for reviewer.** The task brief specified `BIGINT`, but every other user/subject FK in the codebase points at `authz_subject(subject_id)` which is `TEXT PRIMARY KEY` (see V002). V020 already uses `owner_subject TEXT REFERENCES authz_subject(subject_id)`. Using `BIGINT` here would create a new user-identity model only for this column, which defeats the "extend `authz_resource`" decision.

If the reviewer wants `BIGINT`, we need a separate migration/refactor across `authz_data_source.owner_subject`, `authz_subject_role.subject_id`, etc. — that's a larger architectural change, out of scope.

The column name `owner_user_id` is kept (rather than `owner_subject_id`) because the plan explicitly names it. Could be renamed in review if consistency with V020 is preferred.

### 2.4 NULL semantics

`status IS NULL` means "this authz_resource row is NOT participating in the semantic layer." Existing rows stay NULL; no forced default. This keeps the migration backfill-free for ~all existing `module` / `page` / `column` / `dag` rows.

### 2.5 Blessed-name uniqueness

Partial unique index `WHERE status = 'blessed'`. Draft / deprecated rows can collide on `business_term` — that's expected during rename and re-bless cycles. Only one *active* blessed term per name.

## 3. Audit trigger

No generic audit trigger added. The project has two adjacent patterns:

- `V006` — `authz_policy_version` + `trg_policy_versioning` snapshots `OLD` on every update. Clean pattern, but specific to `authz_policy`.
- `V034` — `trg_resource_change` already exists on `authz_resource` but only does `pg_notify` for cache invalidation, not persistent audit.
- `V005` / `V011` — `authz_audit_log` + `authz_audit_batch_insert()` — app-layer audit pipeline.

**Recommendation:** route mutations should emit audit events through the existing `authz_audit_log` pipeline with `action='semantic_term_draft|under_review|blessed|deprecated'`. A DB-level version table (mirroring V006) can come later if app-layer audit proves insufficient. Documented in the SQL header; not implemented in this migration.

## 4. Rollback plan

Clean rollback because every change is additive:

```sql
-- Reverse order of creation:
DROP INDEX IF EXISTS idx_authz_resource_owner_user;
DROP INDEX IF EXISTS idx_authz_resource_status;
DROP INDEX IF EXISTS idx_authz_resource_business_term;
DROP INDEX IF EXISTS idx_authz_resource_blessed_term_unique;

ALTER TABLE authz_resource DROP CONSTRAINT IF EXISTS authz_resource_blessed_fields_check;
ALTER TABLE authz_resource DROP CONSTRAINT IF EXISTS authz_resource_semantic_status_check;

ALTER TABLE authz_resource
    DROP COLUMN IF EXISTS blessed_by,
    DROP COLUMN IF EXISTS blessed_at,
    DROP COLUMN IF EXISTS status,
    DROP COLUMN IF EXISTS owner_user_id,
    DROP COLUMN IF EXISTS formula,
    DROP COLUMN IF EXISTS definition,
    DROP COLUMN IF EXISTS business_term;
```

Losing data on rollback is acceptable during Phase 1 iteration — no production rows will use these columns before the feature goes through G2 gate (see Phase 1 plan §6.2).

## 5. Data backfill strategy

**Existing rows:** leave `status = NULL` (means "not a semantic-layer term"). Do NOT set `status = 'draft'` by default — that would silently flood the "my drafts" view of every owner.

**Promoting a row into the semantic layer** (post-migration, via API):

1. Set `business_term`, `definition`, optional `formula`
2. Set `owner_user_id` = the subject making the request
3. Set `status = 'draft'`
4. `blessed_at` / `blessed_by` stay NULL until DBA blesses

**Promoting to blessed** (DBA-only per plan §2.7):

1. Verify `business_term` is not already used by another blessed row (partial unique index enforces)
2. Update: `status='blessed'`, `blessed_at=now()`, `blessed_by=<dba subject>`
3. Emit `authz_audit_log` with `action='semantic_term_blessed'`

**Deprecation:**

1. `status='deprecated'` clears uniqueness lock on `business_term`
2. `blessed_at` / `blessed_by` must be reset to NULL (enforced by `authz_resource_blessed_fields_check`). *Reviewer note: this may be too strict — we might want to keep the historic blessed_by for audit. Flag for discussion. If that's wanted, the CHECK should allow `(status IN ('blessed','deprecated') AND blessed_by IS NOT NULL)`.*

## 6. Consumer updates (application layer)

Routes under `services/authz-api/src/routes/` that must be updated once migration lands:

| Route | Change |
|-------|--------|
| `modules.ts` | Module GET/list endpoints expose authz_resource rows — add new columns to response DTO (surface `business_term`, `status` at minimum). |
| `discover.ts` | Resource discovery / schema walker — include semantic term fields so dashboard and wizard can surface them. |
| `dag.ts` | DAG nodes are authz_resource rows (V042); DAG editor may want `business_term` for node labels. |
| `data-query.ts` | Tier 3 Query Tool — needs a new endpoint or query param to list `status='blessed'` terms for autocomplete. |
| `matrix.ts` | Permission matrix view — optionally column for `status` / `owner_user_id` so admins can see blessed terms at a glance. |
| `config-snapshot.ts` / `config-bulk.ts` | Config-SM snapshot/bulk operations iterate authz_resource — include the new columns in snapshots so replay preserves them. |

**New endpoints likely needed** (not in existing routes):

- `POST /semantic-terms` (draft / propose)
- `PATCH /semantic-terms/:id` (update definition/formula; status transitions)
- `POST /semantic-terms/:id/bless` (DBA-only)
- `POST /semantic-terms/:id/deprecate`
- `GET /semantic-terms?status=blessed` (wizard autocomplete)

These probably belong in a new `routes/semantic-terms.ts` file so concerns stay separated from the generic `modules.ts` CRUD.

**Dashboard updates** (`apps/authz-dashboard/src/components/`):

- New "Semantic Terms" tab / panel on the relevant admin page
- Tier 2 wizard: autocomplete on `business_term` for blessed terms
- Tier 3 Query Tool: sidebar showing blessed terms + their `formula`

## 7. Schema gaps discovered while drafting

1. **V030 V-number collision** already exists (`V030__timescaledb_audit_hypertable.sql` vs `V030__view_function_discovery.sql`). Flyway-style migrators typically fail on duplicate V-numbers; worth confirming the migrator tolerates this before shipping V044.
2. **No generic audit trigger on `authz_resource`** — only pg_notify (V034). Any mutation history has to be reconstructed from `authz_audit_log` written by the app layer. If Phase 1 wants "每次變動都記" (plan §2.7) at the DB level, we need a V006-style version table for `authz_resource`.
3. **Subject identity inconsistency risk** — the drafting brief asked for `BIGINT owner_user_id`, but all existing subject references use `TEXT`. There's no current `users` table with integer PK; if one is being introduced in Phase 1 it is not in any committed migration up to V043.
4. **`formula` column is free-form text** — no validation here. The wizard / AI layer is responsible for parsing and safe-executing. Worth noting this is a trust-boundary concern (AI writing formula → must go through sandbox per plan §2.5).
