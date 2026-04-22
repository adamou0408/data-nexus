# Agent Constitution — Data Nexus

> **Status**: Active (ratified 2026-04-20)
> **Scope**: Binding on all AI agents operating in this repository
> **Override**: Only via explicit human instruction *in the same conversation turn*

---

## Preamble

This constitution governs how autonomous agents (Claude Code, sub-agents, automated
scripts that call the agent API) may interact with user-provided database
connections. The goal is to balance **development convenience** with **protection
of user-owned infrastructure**.

The core tension: agents need to experiment freely (build prototypes, debug issues,
run migrations), but must not silently mutate or destroy connections that belong
to the user's real environments (production, staging, or their personal DBs).

---

## Article 1 — Protected Scope

The following resources are subject to this constitution:

**`authz_data_source`** — the table storing external database connection records.

Specifically, each row in `authz_data_source` is classified as either:

### Class A — Human-Provided (protected)
A row is Class A if **any** of the following hold:
- The `source_id` does **not** start with `ds:_test_` or `ds:_agent_`, **OR**
- The `host` is **not** in `{localhost, 127.0.0.1, postgres, ::1}` and not a
  Docker internal network (`172.17.0.0/16`, `172.18.0.0/16`), **OR**
- The `owner_subject` is a real human subject (not `agent`, `test`, `system`), **OR**
- The agent is uncertain about classification (default is Class A)

### Class B — Agent-Created (unprotected)
A row is Class B only if **all** of the following hold:
- `source_id` starts with `ds:_test_` or `ds:_agent_`, **AND**
- `host` is `localhost`, `127.0.0.1`, `postgres` (Docker service name), `::1`, or
  a Docker internal network IP, **AND**
- The agent created this row in the current or a prior session for its own
  testing purposes

**Resources explicitly NOT protected by this constitution** (agents may CRUD freely):
- `authz_db_pool_profile` (pool profiles)
- `authz_resource` (modules/tables/columns registry)
- `authz_role_permission` (permission matrix)
- `authz_role`, `authz_subject`, `authz_action`
- Materialized views, functions, triggers
- Migration files (`database/migrations/`)
- All frontend code, backend code, config files

These other resources follow normal software engineering practices (code review,
testing, commit discipline) but do not require per-operation consent.

---

## Article 2 — Operations Requiring Human Consent

For **Class A** rows in `authz_data_source`, the following operations require
**explicit human consent in the same conversation turn**:

| Operation | Consent Required? |
|-----------|-------------------|
| `DELETE FROM authz_data_source WHERE ...` | ✅ Yes |
| `UPDATE ... SET is_active = FALSE` (soft delete) | ✅ Yes |
| `UPDATE ... SET host = ...` | ✅ Yes |
| `UPDATE ... SET port = ...` | ✅ Yes |
| `UPDATE ... SET database_name = ...` | ✅ Yes |
| `UPDATE ... SET connector_user = ...` | ✅ Yes |
| `UPDATE ... SET connector_password = ...` | ✅ Yes |
| `UPDATE ... SET schemas = ...` | ✅ Yes |
| `UPDATE ... SET oracle_connection = ...` | ✅ Yes |
| Calling `decrypt()` on `connector_password` to reveal plaintext | ✅ Yes |

**Operations that do NOT require consent** (agent may proceed freely):

| Operation | Reason |
|-----------|--------|
| `SELECT` / listing / reading | read-only, no state change |
| `UPDATE ... SET display_name = ...` | cosmetic label |
| `UPDATE ... SET description = ...` | cosmetic label |
| Connection test (`SELECT 1`) | read-only probe |
| Running Discovery (writes to `authz_resource`, not `authz_data_source`) | derived action |
| `UPDATE ... SET last_synced_at = ...` | metadata housekeeping |
| `INSERT` a new row at user's request | user is creating, not mutating |
| Re-running a migration | idempotent by design |

---

## Article 3 — Definition of "Explicit Consent"

**Consent means**: The user has, *in the same conversation turn* (or a clearly
linked immediate prior turn), stated approval using natural language that
unambiguously targets the operation.

Examples of valid consent:
- ✅ "Yes, delete ds:prod_oracle"
- ✅ "Go ahead and update the credentials for pg_k8"
- ✅ "OK, rotate the password"
- ✅ Clicking "Confirm" in a UI dialog surfaced by the agent

Examples **NOT** valid as consent:
- ❌ General authorization ("you can do whatever you need")
- ❌ Consent from a prior session
- ❌ Agent inferring approval from context ("probably they meant…")
- ❌ Silence after the agent announces intent
- ❌ Consent for operation X being extended to operation Y on the same row

---

## Article 4 — Agent-Created Test Data (Class B)

Agents MAY freely CRUD Class B rows, subject to four rules:

### Rule 4.1 — Naming prefix (mandatory)
Agent-created `source_id` MUST start with `ds:_test_` or `ds:_agent_`.
Example: `ds:_test_pg_greenplum_probe`, `ds:_agent_discovery_check`.

### Rule 4.2 — Localhost/Docker only (mandatory)
Agent-created rows MUST have `host` set to one of:
`localhost`, `127.0.0.1`, `postgres` (Docker service name), `::1`, or an IP in
`172.17.0.0/16` / `172.18.0.0/16`.
Pointing a Class B row at a user-provided external IP is prohibited.

### Rule 4.3 — Announce before create (mandatory)
Before inserting a Class B row, the agent MUST tell the user in the conversation,
using roughly this format:

> I'll create a temporary datasource `ds:_test_xxx` pointing at localhost
> for testing purposes. I'll clean it up before the end of this conversation.

### Rule 4.4 — Cleanup before session end (mandatory)
Before the conversation ends (or whenever the test is no longer needed), the
agent MUST either:
- Delete the Class B row it created, or
- Ask the user "should I keep `ds:_test_xxx` or remove it?"

At session start, if the agent finds orphaned `ds:_test_*` / `ds:_agent_*` rows
from a prior session, it SHOULD ask the user whether to clean them up.

---

## Article 5 — The Consent Request Template

When the agent needs to perform an Article 2 operation on a Class A row, it MUST
surface the request using this structure:

```
⚠️ Consent requested

Target:     authz_data_source.source_id = '<source_id>'
Operation:  <DELETE | UPDATE host | UPDATE credentials | ...>
Before:     <current value, or null for DELETE>
After:      <new value, or DELETED>
Why:        <one-sentence reason>

Proceed? (Y / N)
```

The agent MUST NOT execute the operation until it receives an affirmative answer
in the same turn.

---

## Article 6 — Audit Trail

All Class A mutations MUST be logged via `logAdminAction` with:

```typescript
{
  userId: <the human user's id>,
  action: 'UPDATE_DATASOURCE' | 'DELETE_DATASOURCE',
  resourceType: 'data_source',
  resourceId: <source_id>,
  details: {
    consent_given: 'human_explicit',      // or 'agent_auto' for Class B
    operation_description: <string>,
    before: <prev value>,
    after: <new value>,
  }
}
```

Violations (Class A mutation without `consent_given = 'human_explicit'`) MUST be
logged with `consent_given = 'agent_unauthorized'` and reported to the user
immediately.

---

## Article 7 — Ambiguity and Escape Hatches

### Rule 7.1 — Default to Class A
If classification is unclear, treat as Class A and require consent.

### Rule 7.2 — User-initiated bulk operations
If the user says something like "clean up all my test datasources", the agent
should:
1. List what would be affected (both Class A candidates and Class B)
2. Confirm before executing
3. Only delete the set the user explicitly confirms

### Rule 7.3 — Emergency operations
There is no "emergency" exception. If agent believes an urgent action is needed
(e.g., connection string leaked), it MUST surface the issue and wait for consent,
not act unilaterally.

### Rule 7.4 — Agent-to-agent delegation
A parent agent delegating to a sub-agent MUST include the consent requirement
in the sub-agent's prompt. Sub-agents do not inherit the parent's "trusted"
status; each operation is judged on its own merit.

---

## Article 8 — Amendment Procedure

This constitution is a living document. To amend:

1. Agent proposes the change in conversation with the human user.
2. User approves or rejects each article individually.
3. Approved changes are committed to this file with a version bump and ratified
   date.
4. `CLAUDE.md` reference is updated if needed.
5. Auto-memory feedback entry is updated to reflect the latest version.

No agent may amend this constitution without explicit human approval.

---

## Appendix A — Quick Reference

**Before touching `authz_data_source`, ask:**

1. Is this row's `source_id` starting with `ds:_test_` or `ds:_agent_`? → maybe Class B
2. Is `host` in `{localhost, 127.0.0.1, postgres, ::1}` or Docker internal? → maybe Class B
3. **Both yes** → Class B, proceed freely (follow Article 4)
4. **Either no** → Class A, apply Article 2 rules

**The two-question consent check:**

```
Is the operation in Article 2's "requires consent" table?
  ├─ No  → proceed
  └─ Yes → Is the row Class A?
           ├─ No (Class B) → proceed (follow Article 4)
           └─ Yes → use Article 5 template, wait for explicit consent
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-04-20 | Initial ratification. Scope: `authz_data_source` only. |
