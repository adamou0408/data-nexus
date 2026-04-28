# NPI Gate Sign-off — First Composite-Action Dogfood

- **Planner Owner:** Adam (this session, Claude Opus 4.7)
- **Executor Owner:** same (single-session sprint)
- **Status:** READY-FOR-REVIEW
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) — Q3 2026 platform primitives
- **Target:** Q3 2026 (M4 base layer dogfood)
- **Created:** 2026-04-28
- **Last updated:** 2026-04-28

---

## 1. Problem / Why

`authz_composite_action` has been declared since V003 but never had a runtime — the wishlist tagged this as **W-MGR-03** ("composite_action is an empty shell"). The four-stage NPI gate sign-off (G0 → G1 → G2 → G3 → G4 with PE → QA → VP chain) is the first internal Phison process complex enough to need both a state machine AND a chained approval, so it is the natural first dogfood for the workflow primitive that closes that gap.

The same sprint also stress-tests three Tier-B primitives that the Phase 1 master plan calls out as platform requirements:

- `entity_kind` — semantic classifier on top of `resource_type` so workflow / lifecycle code can target a class of resources without code change.
- `lifecycle_definition` / `lifecycle_instance` — generic state machine layer.
- `workflow_request` / `workflow_approval_record` — runtime that turns `composite_action` into a real request/approve/reject loop.

Shipping all four in a single vertical proves the primitives compose; the lessons are then portable to RMA, lot-hold, and price-book approval verticals later in Phase 1.

---

## 2. Scope

**In scope (delivered this sprint):**

- [x] `V072` rename `gate_color` UI tokens + `npi_gate_checklist.gate_phase` from `Gx_*` to `NPI_Gx_*` (namespace prefix so future verticals don't collide).
- [x] `V073` `authz_entity_kind` registry + nullable `authz_resource.entity_kind` FK.
- [x] `V074` `authz_lifecycle_definition` + `authz_lifecycle_instance`.
- [x] `V075` `authz_workflow_request` + `authz_workflow_approval_record` (with `dogfood_self_chained` flag).
- [x] `V076` NPI vertical seed: `entity_kind='npi_material'`, `module:mrp.npi.gate_signoff` resource, `npi_gate_lifecycle` definition, four `npi_advance_*` composite_actions, PE/QA/VP × `approve` role_permissions.
- [x] `V077` Adam-multi-role dogfood personas (`user:adam_npi_pe|qa|vp|pm`).
- [x] `V078` `npi_gate_console` page registration + PE/QA/VP × `read` role_permissions.
- [x] `services/authz-api/src/routes/workflow.ts` — `/api/workflow/{request, pending, :id, :id/approve, :id/reject}`.
- [x] `apps/authz-dashboard/src/components/NpiGateConsoleTab.tsx` — Path A handler driving the runtime.
- [x] `data/V003` edited in-place to seed `npi_gate_checklist` with `NPI_G*` names; `data/V007` renames any pre-existing rows on `nexus_data`.
- [x] E2E walkthrough verified: PM submits → PE → QA → VP → `lifecycle_instance.current_state` advances.

**Out of scope (Phase 1 backlog or later):**

- Discovery endpoint for composite_actions (the NPI console hardcodes the four `npi_advance_*` policies).
- Per-transition chain divergence (V076 currently uses the same `PE → QA → VP` for all four; the spec note says Curators can swap later).
- Cron-based expiry sweep on `authz_workflow_request.status='pending' AND expires_at < now()`. Today expiry is checked lazily on decision attempts.
- Material picker against `cimzr067` (Tiptop ERP). Page accepts a free-text `subject_id` so dogfood doesn't depend on Oracle CDC.
- Rich audit / metrics views for workflow throughput.

---

## 3. Design / Approach

### Layered map

```
+--------------------------------------------------------+
|  Path A handler  NpiGateConsoleTab          (apps/...) |
|     ↑ workflowSubmit / workflowApprove / workflowReject |
+----+---------------------------------------------------+
     |
+----v---------------------------------------------------+
|  /api/workflow/* router                                |
|   • authz_check(actor, target_action, target_resource) |
|   • next-step role match against approval_chain[step]  |
|   • on final approve → upsert lifecycle_instance       |
+----+---------------------------------------------------+
     |
+----v------------------+   +-------------------------+
| authz_workflow_request|   | authz_lifecycle_instance|
| authz_workflow_record |   | authz_lifecycle_def'n   |
+-----------------------+   +-------------------------+
     |
+----v-----------------------------+
| authz_composite_action  (V003)   |  (spec only — no runtime before V075)
| authz_role_permission   (V002)   |  ← still the SSOT for authz_check
+----------------------------------+
```

### Hot-path discipline

`authz_check` / `authz_resolve` continue to read **only** `authz_role_permission` + `authz_policy`. The new tables (`entity_kind`, `lifecycle_*`, `workflow_*`) sit beside the permission graph, never inside it. This is enforced by:

- explicit comments on each table,
- the workflow router calling `authz_check(actor, target_action, target_resource)` rather than introducing a new SQL function,
- no `authz_check` rewrite in V073-V076.

### Key decisions

| Decision | Choice | Reason |
|----------|--------|--------|
| Why one `composite_action` per gate transition (4 rows) instead of one row with embedded transition list | Four rows, identical chain today | Lets Curators set per-transition chains later (e.g. G3→G4 mass-prod escalation) without schema change. Storage cost is negligible. |
| `lifecycle_instance` not read by `authz_check` | Off-hot-path | Permission stays "can role R do action A on resource X". Lifecycle gating is a layer on top, in the workflow router. |
| Requester needs `target_action` permission too | Yes | Workflow expresses "I could do this — I just want extra eyes." Bridges no permission gaps. Documented in V075 header. (The `adam_npi_pm` persona therefore can't submit; we use `adam_npi_pe` who already has PE role.) |
| `dogfood_self_chained` boolean on `approval_record` | Yes | Single-person dogfood loops should be filterable from production audits. PE-as-requester step 0 will set this TRUE. **Caveat:** the requester-must-have-`target_action` rule above means production NPI step-0 (PE files → PE approves) will *also* be flagged self_chained, so the flag's "filter dogfood out of audit" purpose is partially defeated for this vertical. Data is correct; trust the flag for *who acted twice*, not for *was this a dogfood loop*. Re-evaluate when a vertical with requester ≠ chain[0] (e.g. RMA where Sales files / QA approves) lands. |
| `subject_id` is text, not FK | Free text | Business keys are heterogeneous (material number, RMA id, lot id). FK would couple the runtime to one ERP table. |
| `npi_gate_checklist` lives on `nexus_data` (authoritative) and `nexus_authz` (vestigial) | Edit `data/V003` in place + add `data/V007` rename | Cheaper than untangling V021's POC duplicate. The page query reads from `nexus_data`. |
| Hardcode the four `npi_advance_*` policies in the console FE | Yes (V1) | Discovery endpoint is genuinely useful but adds an endpoint + a generic "policy picker" UX. Defer until a 2nd vertical lands and forces the abstraction. |
| Renaming `gate_color` tokens / `gate_phase` to `NPI_*` | Yes (V072 + data/V003 + data/V007) | First vertical claims the namespace. Second vertical (RMA, lot-hold) will use its own prefix and not collide with `Gx`. |

### Open questions

- [ ] Should the requester gate use a dedicated `request` action instead of reusing `approve`? Today's choice (reuse `approve`) means the requester must already be authorized to perform the underlying action. That works for "extra eyes" workflows but blocks pure "submit-only" personas like a PM who has no `approve` rights. — owner: Adam, decision deferred until a non-NPI vertical needs the distinction.
- [ ] Expiry sweep: cron job vs lazy-on-touch (current). Cron is cleaner but adds a moving part. — owner: Adam, defer until first prod incident or a workflow gets stuck pending.

---

## 4. End-to-end dogfood walkthrough

The console at `/` → "NPI Gate Sign-off" lets Adam play all four roles by switching the **X-User-Id** header (the dashboard's user switcher does this). Below is the equivalent curl recipe — both flows hit the same endpoints.

### 0. Apply migrations (once)

```bash
make db-migrate                       # nexus_authz: V072..V078
# nexus_data: data/V003 (NPI_*) is part of init-db.sh on fresh install;
# for an existing dev DB, V007 brings it into line:
docker exec docker-compose-postgres-1 \
  psql -U nexus_admin -d nexus_data \
  -f /docker-entrypoint-initdb.d/migrations/data/V007__npi_gate_phase_rename.sql
```

### 1. PM-style submission (uses adam_npi_pe — see "requester needs approve" decision above)

```bash
curl -s -X POST http://localhost:13001/api/workflow/request \
  -H "Content-Type: application/json" -H "X-User-Id: adam_npi_pe" \
  -d '{"policy_name":"npi_advance_g0_to_g1","subject_id":"MAT-DOGFOOD-001","request_reason":"E2E walkthrough"}'
# → { request_id, status: 'pending', approval_chain: [PE,QA,VP], preconditions: {from:NPI_G0,to:NPI_G1} }
```

### 2. Chain step 0 — PE

```bash
curl -X POST http://localhost:13001/api/workflow/$REQ/approve \
  -H "X-User-Id: adam_npi_pe" -H "Content-Type: application/json" -d '{"note":"PE step 0"}'
# → dogfood_self_chained: true (PE is also the requester)
#   request_status: 'pending'
```

### 3. Chain step 1 — QA

```bash
curl -X POST http://localhost:13001/api/workflow/$REQ/approve \
  -H "X-User-Id: adam_npi_qa" -H "Content-Type: application/json" -d '{"note":"QA step 1"}'
```

### 4. Chain step 2 — VP (final, lifecycle advance)

```bash
curl -X POST http://localhost:13001/api/workflow/$REQ/approve \
  -H "X-User-Id: adam_npi_vp" -H "Content-Type: application/json" -d '{"note":"VP final"}'
# → request_status: 'approved'
#   lifecycle_advanced: { lifecycle_id: npi_gate_lifecycle, from: NPI_G0_concept, to: NPI_G1_feasibility }
```

### 5. Verify lifecycle row

```sql
SELECT subject_id, current_state, last_actor, last_action
  FROM authz_lifecycle_instance
 WHERE subject_id = 'MAT-DOGFOOD-001';
-- MAT-DOGFOOD-001 | NPI_G1_feasibility | adam_npi_vp | npi_advance_g0_to_g1
```

### Negative cases verified in this session

| Case | Expected | Observed |
|------|----------|----------|
| Re-approve after `status='approved'` | 409 Conflict | ✅ |
| Approve step 0 as VP (role mismatch) | 403 with explicit `step 0 expects role PE` detail | ✅ |
| Submit as `adam_npi_pm` (no PE/QA/VP) | 403 from `authz_check` | ✅ |
| `GET /api/workflow/:id` after approval | full row with `records[]` and `status` | ✅ |
| `GET /api/workflow/pending` after final approve | excludes the now-approved request | ✅ |

---

## 5. Acceptance criteria

- [x] `authz_check` does not read any of `entity_kind` / `lifecycle_*` / `workflow_*`. (Verified by grepping V073-V076 for `authz_check` definitions — no rewrites.)
- [x] Submitting an `npi_advance_g0_to_g1` request and then approving as PE / QA / VP advances `lifecycle_instance.current_state` to `NPI_G1_feasibility` exactly once.
- [x] Wrong-role and re-approve attempts produce explicit 403/409 responses with audit deny rows.
- [x] Page card visible in `fn_ui_root` for any user who carries PE, QA, or VP role; not visible for users who carry none of them.
- [x] All migrations re-applied idempotently on the existing dev DB without errors (V076/V077/V078 use `ON CONFLICT DO UPDATE`).

---

## 6. Risks / known gaps

- **Requester semantics are coarse.** `authz_check(actor, target_action, target_resource)` on the request endpoint means a pure submitter persona can't file. NPI's PE-as-submitter happens to align; future verticals may need a dedicated `request` / `submit` action.
- **No expiry sweep.** Pending requests past `expires_at` only flip to `expired` on a decision attempt. Until first incident or a workflow report hits a long-pending request, this is fine.
- **FE policy menu hardcoded.** A second vertical will trigger the discovery endpoint refactor (`GET /api/workflow/policies?entity_kind=...`).
- **`npi_gate_checklist` on `nexus_authz` is vestigial** but not dropped. V021's `CREATE TABLE IF NOT EXISTS` left it behind. Drop migration deferred — table is unread by the page handler.

---

## 7. Follow-ups (separate tasks, not blocking READY-FOR-REVIEW)

1. Add `/api/workflow/policies` discovery endpoint and replace the FE hardcode.
2. Add a pg_cron expiry sweep (`UPDATE authz_workflow_request SET status='expired' WHERE status='pending' AND expires_at < now()`).
3. Drop the vestigial `nexus_authz.npi_gate_checklist` table once we're sure no Path B page reads it.
4. Decide on a dedicated `request` / `submit` action for the next vertical and back-port to NPI if the policy menu wants pure-PM submitters.
