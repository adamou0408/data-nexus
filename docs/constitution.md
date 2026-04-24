# Agent Constitution — Data Nexus

> **Status**: Active (v2.0 ratified 2026-04-24; v1.0 ratified 2026-04-20)
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

## Article 9 — AI Agent 操作規範 (AI Agent Operations)

> **Ratified 2026-04-24** via Article 8 procedure (8 sub-articles approved individually).
> Source draft: `.claude/plans/v3-phase-1/constitution-ai-chapter-draft.md`.
> Aligned with `docs/plan-v3-phase-1.md` §2.4 / §2.5 / §2.6 / §2.7 / §2.8.

### 9.1 範圍 (Scope)

本章節 binding 於下列 AI 代理：

- 內部 LLM-powered agents（Tier 2/3 wizard 的 in-context AI、中央 chat 助理、
  side-panel 建議卡片產生器）
- Claude Code 及其 sub-agents
- 任何透過 LLM adapter 層（LiteLLM 或等價）存取 `authz_resource`、
  `authz_data_source`、或其下游資源資料的自動化流程

AI 代理操作 `authz_data_source` 時，**同時受 Article 1–7 約束**；本章節為 AI
獨有的額外規範，兩者衝突時以較嚴格者為準。

**範圍外（不受 Article 9 拘束）：** 確定性 (deterministic) 引擎，包括
Discover detection engine、schema-driven UI auto-generator、scheduled
identity-sync jobs。這些走既有 code-review + Article 1–7 路徑即可。

### 9.2 讀取權限 (Read Authorization)

**原則：使用者看不到 = AI 也看不到。**

- 所有 AI 讀取動作（SELECT、schema 檢索、sample query、embedding / retrieval
  index 查詢）**MUST** 以呼叫使用者身分通過 `authz_resolve(user)`，取得的
  subset 即為 AI 可見資料上限。
- AI **MUST NOT** 列舉、暗示、或於 prompt 上下文中洩漏使用者無權存取的
  resource_id、column、schema、dashboard、saved query。
- Retrieval / embedding index **MUST** 於建構時即依 authz subject 分片；
  不得以 post-filter 遮蔽作為唯一防線。
- 違反本條視同 Article 6 定義的 `agent_unauthorized` 事件。

### 9.3 寫入權限 (Write Authorization)

所有 AI 發起的寫入類動作 —— DDL、DML、`authz_resource` 增修刪、模組啟停、
dashboard / saved query 發布、`business_term` 變更、DB 連線改動 —— **MUST**
走 sandbox → diff → 人類審核 → blessed 的四段式流程：

1. AI 於使用者個人 sandbox 產出 artifact，**絕不**直接對 shared / production
   schema 套用。
2. 系統產生 diff（before/after），以人類可讀形式呈現（SQL、JSON patch、
   或 UI mock）。
3. 使用者（或 artifact 指定的 reviewer）以 UI 明確點按核可。
4. 核可後才寫入 blessed 區。Article 6 audit 格式同步記錄 `consent_given`。

**禁止**：AI auto-apply、silent write、以「低風險」或「高信賴度」為由繞過
人類審核。Phase 2 若評估放寬，**MUST** 透過 Article 8 再次修訂本條。

> **與 Article 1 的關係：** Article 1 列為「agents may CRUD freely」的表
> （`authz_resource` / `authz_role_permission` 等）在 **AI 寫入路徑** 改為
> 需經本條四段式流程；人類工程師直接 commit 走 code review 的路徑不受影響。

### 9.4 AI 產物生命週期 (AI Artifact Lifecycle)

AI 產出的 SQL、dashboard、Tier 2/3 artifact、`business_term` proposal 等
一律走三狀態 lifecycle：

| 狀態 | 可見範圍 | 誰可轉入 |
|------|----------|----------|
| `sandbox` | 僅 artifact owner | AI 自動生成即為此狀態 |
| `under_review` | owner + 指派 reviewer | owner 明確送審 |
| `blessed` | 依 authz_resolve 的對應讀取範圍 | blessing 權責角色（`business_term` 為 DBA 角色；dashboard 為資料域 owner） |

- 每個 artifact **MUST** 有單一 `owner_user_id`；AI 不可作為 owner。
- `blessed` artifact 不得被 AI 直接改寫；任何修改重啟本流程（sandbox →
  review → blessed）。
- Deprecation 走 plan §2.6 兩級級聯（有狀態 30 天 sandbox + owner 通知）。

### 9.5 Canvas 互動 (Canvas Interaction)

AI 改動使用者 canvas（Tier 1 dashboard、Tier 2 wizard、Tier 3 Query Tool UI
狀態）的**唯一合法路徑**：

1. AI 於側欄列出 1–3 個建議卡片（suggestion card），每張卡片含明確意圖
   描述與 preview。
2. 使用者按下 ✓（接受）才套用；按 ✗（駁回）或不動作即不套用。
3. 套用後 canvas **不留 AI 標記**（與手動操作視覺一致）。

禁止：
- 中央 chat 介面直接改動 canvas 狀態
- In-context 按鈕跳過 suggestion card 直接 mutate
- 無使用者互動的自動建議 auto-apply
- 以連續彈窗「nag」使用者接受

### 9.6 PII / Prompt Log

- LLM 服務的 log **MUST NOT** 留存 raw prompt 或 raw model output；僅留
  prompt hash（SHA-256）、metadata（model id, timestamp, token count,
  latency）、及 SLO 相關 metric。
- 使用者能取得的資料範圍已由 §9.2 約束；prompt 中不得夾帶 authz_resolve
  subset 以外的資料。
- 每季至少一次由 Data Nexus owner 抽查 LLM log sample（hash、metadata），
  確認無 raw payload 外洩；抽查結果記入 `authz_audit`。
- 違反本條視為合規事故，**MUST** 立即通報使用者並暫停該 AI 功能線。

### 9.7 Audit Log

- 所有 AI 動作（讀取、寫入 proposal、suggestion card 呈現與使用者決策、
  artifact 狀態轉移、model swap、SLO 違反）**MUST** 記入 `authz_audit`，
  格式對齊 Article 6。
- AI 相關 audit row **永不刪除**，亦不套用 TimescaleDB compression 導致
  個別 row 無法還原的 retention policy。
- Audit row 欄位擴充：
  - `actor_type`: `ai_agent | human | system`
  - `agent_id`: LLM adapter 指派的 agent identifier
  - `model_id`: 當下使用的模型 identifier
  - `consent_given`: `human_explicit | human_via_suggestion_card | agent_auto_read | agent_unauthorized`
- Plan §2.6 級聯動作（無狀態取消、有狀態 30 天 sandbox）同樣以 audit row 留存。
- **配套 migration（待開）：** 加上述四欄至 `authz_audit`，backfill 既有 row
  為 `actor_type='human'`。

### 9.8 模型更換 (Model Swap)

LLM 服務替換或升級底層模型時，**MUST**：

1. 至少提前 5 個工作日於 audit 紀錄通知。
2. 重跑現行 eval set（text-to-SQL 200 筆 + embedding retrieval set），達到
   plan §2.8 SLO（accuracy ≥ 85%、recall@10 ≥ 0.90、p99 latency ≤ 3s SQL
   gen / ≤ 500ms embedding）。
3. 任一 SLO fail → **拒收**，回退上一版模型；Data Nexus owner 保留 AI
   功能線的緊急停用權。
4. 通過 SLO 的新模型上線時，於 `authz_audit` 留 `model_swap` event，並於
   使用者中央 chat 以一次性 banner 告知。

Eval set 每季增補 20–50 筆（plan §2.8）；model swap 時以最新 eval set 為準，
不得挑舊版 eval set 以利結果。

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

**For AI-originated operations (LLM-powered agents, suggestion cards, in-context AI):**

```
Is this an AI write (DDL / DML / authz_resource / module / business_term / connection)?
  ├─ No (read-only)  → §9.2 authz_resolve(user) gate; never auto-apply
  └─ Yes             → §9.3 four-step: sandbox → diff → human ✓ → blessed
                       (no auto-apply path, even for "high confidence")
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 2.0 | 2026-04-24 | Added Article 9 (AI Agent Operations, 8 sub-articles). Ratified via Article 8 procedure with all 8 sub-articles approved as-is. Source: `.claude/plans/v3-phase-1/constitution-ai-chapter-draft.md`. Configures sandbox→diff→approve baseline for future AI features (Q1 2027), aligned with bottom-up Discover/Pending Review/schema-driven UI patterns shipped 2026-04. Companion `authz_audit` migration (actor_type / agent_id / model_id / consent_given columns) pending. |
| 1.0 | 2026-04-20 | Initial ratification. Scope: `authz_data_source` only. |
