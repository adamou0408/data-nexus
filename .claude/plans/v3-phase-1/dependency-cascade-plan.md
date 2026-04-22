# 依賴清查級聯 Plan

- **Owner:** TBD (backend)
- **Status:** STUB
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §1.1, §2.6, §3 Q3 2026
- **Target:** Schema + cleanup jobs Q3 2026 基座

---

## Purpose

當模組 / DB / resource 停用時，級聯處理下游依賴。**無狀態自動取消，有狀態 30 天 sandbox + owner 通知。** 所有級聯動作永久留 audit log。

---

## `resource_cascade_policy` Table Schema (draft)

```sql
CREATE TABLE resource_cascade_policy (
  id                  BIGSERIAL PRIMARY KEY,
  resource_type       TEXT NOT NULL,      -- 'dashboard', 'saved_query', 'api_route', 'retrieval_index', ...
  resource_id         TEXT NOT NULL,
  depends_on_type     TEXT NOT NULL,      -- 'data_source', 'authz_resource', 'module', ...
  depends_on_id       TEXT NOT NULL,
  cascade_mode        TEXT NOT NULL,      -- 'stateless_auto' | 'stateful_sandbox_30d'
  owner_user_id       TEXT,
  notified_at         TIMESTAMPTZ,
  sandbox_enter_at    TIMESTAMPTZ,
  sandbox_expire_at   TIMESTAMPTZ,
  archived_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON resource_cascade_policy (depends_on_type, depends_on_id);
CREATE INDEX ON resource_cascade_policy (cascade_mode, sandbox_expire_at);
```

(Draft — final schema lives in `migration-drafts/`, owned by another agent.)

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

- `cascade_scan_job` — cron, scans on upstream disable events and populates sandbox flags
- `cascade_notify_job` — cron (daily), sends owner reminders
- `cascade_archive_job` — cron (hourly), archives expired sandboxes
- `cascade_restore_api` — RESTful endpoint for owner-initiated restore (with audit)

## Acceptance Criteria (draft)

- Q3 2026: schema + stateless_auto cascade live
- Q4 2026: stateful_sandbox_30d + notifications live
- Audit log 100% coverage of cascade events
- No orphan references after cascade (integrity test)

---

## STUB — to be filled

- Migration SQL draft (coordinate with `migration-drafts/`)
- Job scheduling detail (worker / cron cadence / concurrency)
- Notification template copy (zh / en)
- Extension-request approval workflow
- UI: owner's "my dependents at risk" dashboard
- Test matrix (all resource type × cascade mode combinations)
