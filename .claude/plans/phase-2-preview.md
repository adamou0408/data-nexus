# Phase 2 Preview (Post-Demo, 2027-06+)

- **Owner:** Adam
- **Status:** STUB (preview — locks after Phase 1 demo)
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../docs/plan-v3-phase-1.md) Appendix A
- **Purpose:** Stakeholder visibility on what's NOT in Phase 1 so we do not fight scope creep

---

## Why this doc exists

Every month someone asks "why isn't X in Phase 1?" The honest answer is "because Phase 1 already has a year of critical-path work and X is not what makes the demo land." This doc collects those Xs with a public "Phase 2 candidate" label. Keeps Phase 1 focused, keeps stakeholders heard, keeps the backlog honest.

This is NOT a plan. It is a parking lot with structure. Phase 2 gets planned after the Q2 2027 demo, with new data from how Phase 1 actually landed.

---

## Phase 2 candidates

### Infrastructure / platform

- **Oracle 19c CDC** — design complete (`.claude/plans/`), implementation deferred. Trigger: customer demand for Oracle data source in production.
- **Multi-region / DR** — Phase 1 is single-region Phison internal. Trigger: uptime SLO commitment to internal customers.
- **External tenant support** — Phase 1 is Phison-only. Trigger: Phison Electronics sibling companies adopt Nexus.
- **Policy simulator v2** — Phase 1 has `policy-simulate` API, Phase 2 adds UI + diff + what-if workflow.

### AI / Smart Analyst

- **Smart Analyst 2.0 agent framework** — blocked on M4 go-live (Gate G1). Phase 2 builds the multi-agent workflow on top of Phase 1 LLM foundation.
- **Fine-tuning on prod logs** — requires PII / governance pipeline. Phase 2.
- **Multi-turn conversation memory** — Phase 1 is single-canvas. Phase 2 adds session memory + named threads.
- **Image / chart gen via LLM** — Phase 1 has chart by wizard. Phase 2 tries LLM-generated chart specs.

### BI / data mining

- **Data Mining Engine full vision** — `.claude/plans/v3-phase-1/design-mining-vision.md` GATED. Trigger: Milestone 0 user validation on Phase 1 Tier 2.
- **Scheduled reports + alerts** — Phase 1 is on-demand. Phase 2 adds cron + Slack / email delivery.
- **Cross-datasource joins** — Phase 1 is per-datasource. Phase 2 adds federated query via semantic layer.

### Tier 1 dashboard engine

- **Full dashboard editor parity with Metabase** — Phase 1 renders 1 business dashboard end-to-end (G4). Phase 2 expands to general-purpose editor.
- **Public dashboard sharing + embed** — Phase 2 if internal customer demand warrants.

### Governance / security

- **Field-level PII masking policy engine** — Phase 1 has resource-level. Phase 2 adds column-level dynamic mask rules.
- **Approval workflows for sensitive queries** — Phase 2 (currently handled by operational process).

---

## What moves to Phase 2 from Phase 1 if we slip

If Phase 1 is under pressure, these get cut first (in order):

1. Tier 1 自建 dashboard engine (G4 optional surface — Metabase fallback)
2. AI 側欄 sandbox → blessed workflow polish (ship basic, polish Phase 2)
3. eval set augmentation beyond 200 (200 is the contract; +20/qtr is nice-to-have)

These do NOT get cut:
- M4 prod-ready (blocks everything downstream)
- Tier 2 admin form + Path A kill (G2, scope discipline)
- LLM SLO signed (G3, demo credibility)

---

## Rough Phase 2 shape (TBD after demo)

- **Scope lock:** 2027-06, one month post-demo, informed by demo feedback
- **Runway:** ~12 months estimated (2027-06 → 2028-06)
- **Tier 2+ team:** the two sub-PMs hired 2026-08 lead Phase 2 tracks
- **Likely anchor:** Smart Analyst 2.0 (the original reason Nexus exists) + customer-driven data sources

---

## STUB — to be filled post-demo

- Demo feedback themes
- Customer priority list (what internal users asked for most in Phase 1)
- Team capacity + hiring needs for Phase 2
- Budget envelope
