# v3 Phase 1 — Sub-Plans Index

**Master plan:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md)

**Phase 1 owner:** Adam Ou (adam_ou@aixmoment.com)
**Demo target:** Q2 2027 (2027-05 ± 2 週)
**Runway:** 2026-05 → 2027-05

This directory holds the implementation sub-plans that decompose the master Phase 1 plan. Each sub-plan has its own owner, status, and acceptance criteria. The master plan remains the SSOT for scope / gates / timeline; sub-plans are how we actually deliver.

---

## Sub-Plans

| File | Purpose (1-line) |
|------|------------------|
| [`m4-prod-ready-tracker.md`](./m4-prod-ready-tracker.md) | M4 production-ready work items + weekly checkbox grid (gate G1) |
| [`tier2-pm-hiring-plan.md`](./tier2-pm-hiring-plan.md) | Two Tier 2 sub-PM JD, hiring timeline, plan B internal-promote |
| [`tier2-analytics-wizard-plan.md`](./tier2-analytics-wizard-plan.md) | Tier 2 分析 wizard MVP (Q4 2026), ECharts + semantic layer + authz |
| [`tier2-admin-form-wizard-plan.md`](./tier2-admin-form-wizard-plan.md) | Tier 2 admin 表單模式 (Q1 2027) replacing Path A, includes G2 pilot gate |
| [`tier3-query-tool-plan.md`](./tier3-query-tool-plan.md) | Tier 3 Query Tool (Q2 2027) — SQL editor + AI 輔助 + 歷史記錄 |
| [`tier1-dashboard-engine-plan.md`](./tier1-dashboard-engine-plan.md) | Tier 1 自建 dashboard engine (Q2 2027) — minimal scope, Phase 2 fallback |
| [`ai-sidepanel-plan.md`](./ai-sidepanel-plan.md) | AI 側欄 UX (Q1 2027) — 建議卡片 + 中央 chat + sandbox/blessed workflow |
| [`eval-set-collection-plan.md`](./eval-set-collection-plan.md) | LLM eval set 200 筆 collection (Q3 2026 start, Q4 2026 delivery) |
| [`dependency-cascade-plan.md`](./dependency-cascade-plan.md) | 依賴清查級聯 schema (`resource_cascade_policy`) + 30-day sandbox workflow |
| [`path-a-inventory.md`](./path-a-inventory.md) | Path A surviving screens/descriptors inventory *(owned by another agent — see file for status)* |
| [`constitution-ai-chapter-draft.md`](./constitution-ai-chapter-draft.md) | Constitution AI chapter draft (Article 8 revision) *(owned by another agent — see file for status)* |
| [`two-tier-platform-model.md`](./two-tier-platform-model.md) | Tier A (平台) vs Tier B (應用) 切分 + 4 platform primitive backlog (help_text / saved_view / feedback / subscription) |
| [`migration-drafts/`](./migration-drafts/) | V044 `authz_resource` semantic layer + V045 `resource_cascade_policy` migration SQL drafts *(ready-for-DBA, 2026-04-23)* |
| [`m4-go-live-runbook.md`](./m4-go-live-runbook.md) | Gate G1 cutover runbook + rollback procedure (2026-09 go-live) |
| [`g2-pilot-recruitment.md`](./g2-pilot-recruitment.md) | Gate G2 pilot recruitment funnel + exit criteria (3-5 pilots × 2 weeks) |
| [`tier2-onboarding-guide.md`](./tier2-onboarding-guide.md) | Tier 2 sub-PM week-1 onboarding playbook (2026-08) |
| [`llm-slo-contract-template.md`](./llm-slo-contract-template.md) | Gate G3 LLM team SLO contract template (sign 2026-09) |
| [`design-mining-vision.md`](./design-mining-vision.md) | Data Mining Engine long-term vision *(GATED — Phase 2+, moved from `docs/` 2026-04-22)* |
| [`doc-reorg-proposal.md`](./doc-reorg-proposal.md) | Doc architecture reorg proposal (executed 2026-04-22, historical) |

---

## Status Table

| Sub-plan | Owner | Status | Target |
|----------|-------|--------|--------|
| m4-prod-ready-tracker | SRE | STUB | Q3 2026 (G1) |
| tier2-pm-hiring-plan | TBD (Adam + HR) | STUB | 2026-04 JD out / 2026-08 onboard |
| tier2-analytics-wizard-plan | Tier 2 sub-PM A | STUB | Q4 2026 alpha |
| tier2-admin-form-wizard-plan | Tier 2 sub-PM B | STUB | Q4 2026 alpha / Q1 2027 migration |
| tier3-query-tool-plan | TBD | STUB | Q2 2027 |
| tier1-dashboard-engine-plan | TBD | STUB | Q2 2027 (G4) |
| ai-sidepanel-plan | TBD | STUB | Q1 2027 |
| eval-set-collection-plan | TBD (Adam + DBA + PM) | STUB | Q3 2026 → Q4 2026 |
| dependency-cascade-plan | TBD (backend) | schema-draft-ready (V045 SQL + plan; DBA review) | Q3 2026 |
| path-a-inventory | Explore agent → Adam to validate | ready-for-review | input to Q4 2026 / Q1 2027 |
| constitution-ai-chapter-draft | Drafting agent → Adam | ready-for-review (Article 8 amendment) | merge before Q1 2027 |
| two-tier-platform-model | Adam | draft (2026-04-26) | foundation — gates UI 提案 Q3 2026 起 |
| migration-drafts/V044 (business_term) | Drafting agent → DBA | ready-for-DBA (open Qs resolved 2026-04-23: TEXT confirmed, V030 collision out-of-scope) | apply Q3 2026 |
| migration-drafts/V045 (resource_cascade_policy) | Drafting agent → DBA | ready-for-DBA (drafted 2026-04-23, authz_audit_log reuse) | apply Q3 2026 after V044 |
| m4-go-live-runbook | SRE | STUB | 2026-09 (G1) |
| g2-pilot-recruitment | sub-PM B (TBD) | STUB | 2026-12 (G2) |
| tier2-onboarding-guide | Adam | STUB (template ready) | 2026-08 onboard |
| llm-slo-contract-template | Adam | STUB (template) | 2026-09 sign, 2027-03 G3 |
| design-mining-vision | — | GATED (Phase 2+) | post-Milestone 0 |
| doc-reorg-proposal | Adam | executed 2026-04-22 | historical |

**Status legend:** STUB → draft → in-progress → ready-for-review → approved

---

## Milestone Gates (from master plan §6.2)

- **G1 (2026-09):** M4 prod-ready 上線 → unlocks AI / Smart Analyst 2.0
- **G2 (2026-12):** Tier 2 admin 表單 alpha 跑過 3-5 個 pilot ≥ 2 週主動使用 → unlocks Path A migration
- **G3 (2027-03):** LLM SLO 簽契約達成 → AI 可列為 demo 主軸
- **G4 (2027-04):** Tier 1 自建引擎能 render 至少 1 個業務 dashboard 端到端 → demo 內容

---

## Conventions

- Every sub-plan starts with: Title / Owner / Status / Linked from / STUB-to-be-filled section.
- Sub-plan updates should bump the status table in this README in the same commit.
- Acceptance criteria must map back to master plan success metrics (§6.1) where possible.
