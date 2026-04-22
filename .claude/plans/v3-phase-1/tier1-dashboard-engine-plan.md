# Tier 1 — 自建 Dashboard Engine Plan

- **Owner:** TBD (frontend lead, reports to Adam)
- **Status:** STUB
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §2.2, §3 Q2 2027, §5 (high-risk), §6.2 Gate G4
- **Target:** Q2 2027 demo (at least 1 KPI dashboard rendering end-to-end)

---

## Purpose

業務主管 dashboard — 讀取為主，filter + card + chart 組合。Phase 1 **自建** (master plan locked decision).

---

## Risk Acknowledgement (per master plan §5)

> "Tier 1 自建 scope 過大 — 機率高，影響 Q2 2027 demo."

**Locked decision:** Keep self-build.

**Fallback option (per §5):** Tier 1 temporarily renders via Tier 2 wizard-built dashboards; the real Tier 1 engine ships in Phase 2. Gate G4 protects demo — if G4 not met by 2027-04, demo swaps in the fallback. Do **not** use the fallback as an excuse to relax self-build discipline; target G4 pass.

## Minimal Scope (engine MVP)

1. **Filter bar** — global filter (date, region, etc.) propagating to all cards
2. **Card grid** — responsive, drag-to-reorder
3. **Chart slots** — consume ECharts configs from Tier 2 save format (or same DSL)
4. **AuthZ injection** — each card's query runs through `authz_resolve(user)` before executing; missing-authz cards show "no access" placeholder, not empty
5. Read-only Phase 1 — no drill-down / cross-filter (那是 Phase 2 深化)

## Target Demo Dashboards (2-3 KPIs)

*(TBD with 業務 owner)*

- **D1:** [STUB — e.g. monthly 營收 vs 預算]
- **D2:** [STUB — e.g. 產線 OEE 趨勢]
- **D3:** [STUB — optional stretch]

## Acceptance Criteria

- G4 (2027-04): ≥ 1 dashboard renders end-to-end with live data through engine
- Q2 2027 demo: 2-3 KPI dashboards live
- No Tier 2 wizard-dependency at runtime (Tier 1 engine owns render)
- AuthZ injection: 0 leakage in security review

---

## STUB — to be filled

- Engine architecture (SSR vs CSR, data refresh cadence)
- Filter propagation spec
- Card schema (matches Tier 2 save format? separate?)
- Layout persistence (per-user vs published-global)
- Performance target (p99 load < ?)
- Fallback trigger criteria + ship-checklist for Phase 2 fallback
- Owner negotiation with 業務 owners for the 3 KPI dashboards
- Relation with AI 側欄 (optional for Tier 1 — decide)
