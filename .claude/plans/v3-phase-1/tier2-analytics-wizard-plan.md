# Tier 2 — 分析 Wizard MVP Plan

- **Owner:** Tier 2 sub-PM A (TBD — see [`tier2-pm-hiring-plan.md`](./tier2-pm-hiring-plan.md))
- **Status:** STUB
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §2.2, §3 Q4 2026
- **Target:** Q4 2026 alpha (內部 pilot ≥ 5 個使用者)

---

## Purpose

Deliver the Tier 2 分析模式 wizard — PM / 分析師 drag-and-drop 維度/度量/filter → 視覺化 (ECharts)。共用 semantic layer + authz，與 Tier 2 admin 表單模式共用 tech lead。

---

## Goals (draft)

1. 拖拉建 chart / pivot / heatmap with zero SQL knowledge required
2. 所有 field 來自 `authz_resource` blessed `business_term`（semantic layer）
3. authz 自動注入 — 使用者看不到的 field 在 picker 隱藏
4. 儲存為 dashboard / share（權限注入）

## User Stories (draft)

- As a PM, I can drag "Revenue" and "Region" onto a chart and see a bar chart filtered by my authz
- As an analyst, I can save a pivot and share it with team X
- As a viewer, a dashboard redacts fields I don't have access to without breaking layout

## Wire-frame Ideas (textual)

- Left panel: blessed fields tree (grouped by `business_term.domain`)
- Center: drop zones — Rows / Columns / Values / Filters
- Right: chart type picker + format panel
- Top: save / share / AI 側欄 toggle

## Tech Stack

- shadcn/ui + Tailwind + Phison theme tokens
- Apache ECharts (line / bar / pivot / heatmap first, SPC Phase 2)
- Backend: reuse authz-api; new `/v3/analytics/query` endpoint that compiles wizard state → SQL w/ authz inject

## Interactions with Semantic Layer

- Only `status = blessed` fields shown in picker
- Draft fields visible in sandbox mode only
- Field metadata (definition / formula / owner) shown on hover

## AuthZ Injection Points

- Field list: `authz_resolve(user)` filters `authz_resource` rows
- Query compile: append row filters from `authz_policy` L2 / L3
- Share: share only possible to users whose authz strictly subsets current user's

## Acceptance Criteria (draft)

- ≥ 5 internal alpha users in Q4 2026
- ≥ 15 users by Q1 2027, ≥ 30 by Q2 2027
- 4 chart types (line / bar / pivot / heatmap) functional
- Dashboard save / share / authz-filter round-trip works

## Rough Week-by-Week Schedule (placeholder)

| Weeks | Focus |
|-------|-------|
| W1-2 | Scoping + design review with sub-PM A |
| W3-4 | Field picker + authz integration |
| W5-6 | Drop zones + query compile |
| W7-8 | ECharts line / bar |
| W9-10 | Pivot + heatmap |
| W11-12 | Save / share / dashboard shell |
| W13 | Alpha cut |

---

## STUB — to be filled

- Detailed wireframes (Figma link)
- Query compile DSL spec
- Data-volume perf targets
- Telemetry instrumentation plan
- Integration with AI 側欄 (delegated to [`ai-sidepanel-plan.md`](./ai-sidepanel-plan.md))
- Testing strategy (unit + e2e + user testing with pilots)
