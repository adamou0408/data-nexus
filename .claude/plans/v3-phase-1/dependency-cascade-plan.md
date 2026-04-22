# 依賴清查級聯 Plan

- **Owner:** TBD (backend)
- **Status:** schema-draft-ready (2026-04-23) — SQL in `migration-drafts/V045__resource_cascade_policy.sql`, awaiting DBA review
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §1.1, §2.6, §3 Q3 2026
- **Target:** Schema + cleanup jobs Q3 2026 基座

---

## Purpose

當模組 / DB / resource 停用時，級聯處理下游依賴。**無狀態自動取消，有狀態 30 天 sandbox + owner 通知。** 所有級聯動作永久留 audit log。

---

## `resource_cascade_policy` Table Schema

Companion SQL: **[`migration-drafts/V045__resource_cascade_policy.sql`](./migration-drafts/V045__resource_cascade_policy.sql)** (ready-for-DBA, 2026-04-23).

Schema summary (full draft in the SQL file):

- PK: `cascade_id BIGSERIAL`
- Dependent: `(resource_type, resource_id)` — TEXT tuple, no FK (cross-store: authz_resource + BI artifacts)
- Upstream: `(depends_on_type, depends_on_id)` — TEXT tuple
- `cascade_mode` — CHECK in (`stateless_auto`, `stateful_sandbox_30d`)
- `owner_user_id TEXT REFERENCES authz_subject(subject_id)` (TEXT per V044 resolution)
- Sandbox state: `notified_at` / `sandbox_enter_at` / `sandbox_expire_at` / `archived_at` — all NULL until cascade fires
- CHECK invariant: `stateless_auto` rows never populate sandbox fields; `stateful_sandbox_30d` rows satisfy `expire > enter`
- UNIQUE edge: `(resource_type, resource_id, depends_on_type, depends_on_id)` prevents duplicate declarations
- Indexes: upstream scan, owner-facing "my at-risk", expired-sandbox archiver
- `updated_at` trigger (project convention)

Audit events flow to the existing `authz_audit_log` pipeline (V005 + V011) with `action_id='cascade_*'` — no new audit table.

## 無狀態 vs 有狀態 Examples

| 類型 | 範例 | Cascade mode |
|------|------|--------------|
| 無狀態 | Path A 遺表項目 | `stateless_auto` |
| 無狀態 | Path B API route | `stateless_auto` |
| 無狀態 | AI retrieval index | `stateless_auto` |
| 無狀態 | scheduled job | `stateless_auto` |
| 有狀態 | 使用者存的 dashboard | `stateful_sandbox_30d` |
| 有狀態 | saved SQL function | `stateful_sandbox_30d` |
| 有狀態 | Tier 2 / Tier 3 artifact | `stateful_sandbox_30d` |

## 30-Day Sandbox Workflow

1. Upstream resource disabled → cascade trigger scans `resource_cascade_policy`
2. For each `stateful_sandbox_30d` dependent: flag sandbox, stamp `sandbox_enter_at`, `sandbox_expire_at = now + 30d`
3. Email / Slack / in-app notify `owner_user_id` (preview of affected viewers + alternatives if any)
4. Owner options within 30 days:
   - Migrate to a different resource
   - Request extension (with justification) — approval by Adam / DBA gatekeeper
   - Accept archival
5. At expiry → archive (`archived_at`), data retained but read-only; access denied except via explicit restore

## Owner Notification

- Channel: email + in-app banner on next login; optional Slack/Teams bridge
- Content: what was disabled, list of impacted viewers, migration suggestions, sandbox expiry date
- Reminder cadence: T+0, T+14, T+27

## Audit Log Format

- Append-only; never deleted (master plan §2.6)
- Per event: `{ts, actor, action: disable|cascade_flag|notify|migrate|archive|restore, resource_type, resource_id, depends_on, reason}`
- Retention: forever (regulatory / accountability)

## Backend Jobs Needed

| Job | Cadence | Concurrency | Trigger |
|-----|---------|-------------|---------|
| `cascade_scan_job` | event-driven (listens for `authz_resource` / `authz_data_source` is_active=FALSE + authz_module disable events) | 1 (single writer) | pg_notify hook on source-of-truth update |
| `cascade_notify_job` | daily 09:00 Asia/Taipei | 1 | cron |
| `cascade_archive_job` | hourly :05 | 1 | cron, idempotent |
| `cascade_restore_api` | on-demand | HTTP | `POST /cascade/:cascade_id/restore` — authz `cascade:restore` action on dependent resource, emits audit |

Notes:
- All jobs idempotent; `updated_at` trigger catches redundant writes.
- Scan job uses `FOR UPDATE SKIP LOCKED` on the edge index so concurrent cascades don't re-flag.
- Notify + archive jobs are single-instance via advisory lock (`pg_try_advisory_lock`) to survive duplicate cron triggers in HA.

## Acceptance Criteria (draft)

- Q3 2026: schema + stateless_auto cascade live
- Q4 2026: stateful_sandbox_30d + notifications live
- Audit log 100% coverage of cascade events
- No orphan references after cascade (integrity test)

---

## Remaining — to be filled

- Notification template copy (zh / en)
- Extension-request approval workflow (who approves, max extension, per-resource-type policy)
- UI: owner's "my dependents at risk" dashboard (authz-dashboard tab, uses `idx_resource_cascade_policy_owner_active` index)
- Test matrix (all resource type × cascade mode combinations)
- Populate initial edges: how are `(resource, depends_on)` tuples seeded? Auto-discovery from Path A descriptors + manual declaration for BI artifacts?
