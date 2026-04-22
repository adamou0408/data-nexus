# Tier 3 — Query Tool Plan

- **Owner:** TBD (backend + frontend, reports to Adam)
- **Status:** STUB
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §2.2, §3 Q2 2027
- **Target:** Q2 2027 demo

---

## Purpose

SQL 高手 (DBA / 資料工程師) 的自由查詢介面。自由 SQL + AI 輔助 + 歷史記錄。與 Tier 1/2 共用 design system、semantic layer、authz。

---

## Goals (draft)

1. 免工單即可查 authz 內的資料
2. AI 輔助寫 / 修 / 優化 SQL（in-context augmentation）
3. 歷史紀錄 + 分享 + 收藏
4. 真實 SQL pattern → 餵回 eval set 與 semantic layer

## SQL Editor Choice

**Proposed:** Monaco editor (VS Code core)
- Pros: syntax highlight, autocomplete, multi-cursor, familiar
- Integrate `pg` grammar + blessed `business_term` completion
- Alternative: CodeMirror 6 (lighter) — decide in scoping phase

## AI Augmentation Integration Points

- 「幫我加 group by」「幫我選圖表」「解釋這段 SQL」按鈕
- In-context buttons write to central chat history (per master plan §2.4 半連結)
- Read-only AI ops auto-execute; write ops → sandbox review (per §2.5)
- Schema visibility filtered by `authz_resolve(user)`

## History / Sharing Features

- Auto-save every execution with result metadata (row count, duration, status)
- Tag / name / star saved queries
- Share query (read-only link; recipient authz applied — they may see fewer rows)
- Saved SQL function 是「有狀態物件」→ 停用時走 30 天 sandbox workflow (§2.6)

## AuthZ Injection

- Query parsed → resource references extracted → `authz_check` per resource
- Row-filter policies auto-appended to WHERE (RLS where available)
- Explain plan shows injected predicates so SQL 高手 understand scope
- Result set further filtered by column-level authz

## Acceptance Criteria (draft)

- Q2 2027: 10+ DBA / engineer users active
- AI augmentation success rate ≥ 85% (reuses eval set SLO)
- Query share round-trip respects authz (no leakage)
- History search p99 < 300ms

---

## STUB — to be filled

- Monaco vs CodeMirror decision record
- SQL parser / authz injection strategy (parse vs proxy vs view-layer)
- Result-set caching strategy
- Export (CSV / XLSX) authz + PII guard
- Team / folder organization for saved queries
- Deprecation / cascade for saved queries on data-source retirement
- Telemetry: query latency, failure reason codes, AI-assist accept rate
