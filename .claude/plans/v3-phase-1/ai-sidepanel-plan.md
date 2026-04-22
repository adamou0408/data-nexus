# AI 側欄 UX Plan

- **Owner:** TBD (frontend + backend jointly)
- **Status:** STUB
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §2.4 (AI UX 雙軌), §2.5 (AI Authz), §3 Q1 2027
- **Target:** Q1 2027 alpha — AI 側欄 + 中央 chat 共用

---

## Purpose

AI 助理的 UX 與 authz 落地。**唯一改 canvas 路徑：** 側欄 1-3 個建議卡片 → 使用者按 ✓。中央 chat 純 Q&A，不直接改 canvas。

---

## Suggestion Card Component Spec

- Compact card — 標題 + 1-3 行說明 + diff preview + `✓` / `✗`
- `✓` commits to canvas; `✗` dismisses (logged)
- Max 3 cards visible; overflow goes into history
- No "AI" badge on canvas after accept (master plan §2.4)

## Central Chat Design

- Docked right side; collapsible
- Q&A + 建議 SQL / module (read-only responses)
- In-context augmentation button clicks echo into chat history (master plan §2.4 半連結)
- Cannot mutate canvas from chat — must flow through suggestion card

## In-Context Augmentation Buttons

- Tier 2 wizard buttons: "幫我加 group by" / "幫我選圖表"
- Tier 3 Query Tool buttons: "優化這段 SQL" / "解釋 explain plan" / "幫我寫 WHERE"
- Each button click → LLM call → emits suggestion card(s) into side panel
- Writes to chat history are 半連結 only (not command channel)

## LLM Adapter

**Proposed:** LiteLLM (OSS proxy, model-agnostic)
- Pros: swap models via SLO契約 without code change; retry / quota / logging
- Alternative: 自建 thin adapter if LLM team prefers native client
- Owner negotiation with LLM team (master plan §2.3) during scoping

## Sandbox / Review / Blessed Workflow for AI Artifacts

(Per master plan §2.5)

| Action type | Flow |
|-------------|------|
| **讀取** (SELECT, schema, sample) | `authz_resolve(user)` → 自動執行 |
| **寫入** (DDL, DML, module CRUD, DB 連線改動) | Sandbox → diff → human review → `blessed` → execute |
| **AI 產物 → 全公司** | User sandbox → business_term / dashboard blessing 流程 |
| **Audit log** | All AI actions logged, never deleted |

## PII Hashing Strategy

- `authz_check` inheritance — 使用者看不到的 AI 也看不到 (master plan §2.3)
- Prompt → hash any field-value, LLM team stores hash-only logs (master plan §2.1 resource sovereignty)
- Regular spot-audit of LLM logs (master plan §5 PII risk mitigation)
- Hashing salt rotated quarterly (TBD)

## Acceptance Criteria (draft)

- Q1 2027: Side panel + chat operational in Tier 2 wizard + Tier 3 Query Tool
- Suggestion card accept rate logged; target ≥ 50% accept
- 0 PII leak incidents in audit review
- G3 (2027-03): LLM SLO 契約達成 → AI 可列 demo 主軸

---

## STUB — to be filled

- Wireframes (side panel layout, card states, chat UI)
- LiteLLM vs native adapter decision record
- Suggestion card schema (diff format, rollback affordance)
- PII hash spec (which fields, algorithm, salt rotation)
- Telemetry (accept rate, suggestion latency, cost per session)
- Audit log schema for AI actions
- Dogfood plan with Adam + DBA + 1 PM before alpha
