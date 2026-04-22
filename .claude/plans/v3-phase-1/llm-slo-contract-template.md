# LLM Team SLO Contract Template (Gate G3)

- **Owner:** Adam
- **Status:** STUB (template; sign 2026-09 after eval set 200/200 complete)
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §6.2 (Gate G3), [`eval-set-collection-plan.md`](./eval-set-collection-plan.md)
- **Effective:** signed 2026-09 → measured at G3 (2027-03)

---

## Purpose

A written contract between Data Nexus team (us) and the LLM team (them) on what "good enough to demo" means for the AI features. Without this, G3 turns into vibes. With this, we have a number to point at when scope creeps or quality slips.

The contract is enforced by our 200-pair eval set. They can train on whatever they want. We measure on the held-out set.

---

## Parties

- **Data Nexus team** (Owner: Adam Ou): defines SLO, owns eval set, runs scoring harness
- **LLM team** (Owner: TBD): delivers model + serving infra (vLLM + LiteLLM + BGE-M3 + pgvector wiring)

## Service description

The LLM team commits to deliver a deployable inference stack that, given:
- a natural-language question (Mandarin or English)
- the user's authz context (subject_id + visible resources)
- access to the semantic layer (`business_term` blessed terms)

produces:
- a SQL query that answers the question against authorized resources only
- top-K retrieval hits over `authz_resource` for "what data should I look at"

## SLO commitments (measured on the 200-pair Phase 1 eval set)

| Metric | Target | Measurement | Cadence |
|--------|--------|-------------|---------|
| **Text-to-SQL accuracy** | ≥ 85% | Result-set match (shape + row count + sampled values) on held-out 200 | Run by Data Nexus team monthly from 2026-10 |
| **Recall @ 10 (retrieval)** | ≥ 0.90 | Gold business_term or resource appears in top-10 hits | Same |
| **p99 latency — SQL gen** | ≤ 3s | Per call, end-to-end from API ingress | Continuous, via prod metrics |
| **p99 latency — embedding** | ≤ 500ms | Per call | Continuous |
| **Authz safety** | 100% | Generated SQL never returns rows outside the user's authorized scope (verified by replaying SQL through `authz_filter()`) | Per-eval-run |

## Out of scope (Phase 1)

- Multi-turn conversation memory beyond single canvas session
- Fine-tuning on production user logs (PII / governance not ready)
- Image / chart generation (handled by Tier 2 wizard, not LLM)
- SQL writes / mutations (read-only)

## Eval cadence

- **2026-10 onwards:** Data Nexus team runs the 200-pair eval set monthly, posts scores to a shared dashboard
- **2027-01:** First "must-pass" run. If < 80% on text-to-SQL, escalate to LLM team lead + raise risk
- **2027-03 (G3):** SLO must be GREEN to ship Q2 2027 demo with AI as primary surface

## Failure handling

- Single missed monthly run: flag in joint sync, no escalation
- Two consecutive missed runs: LLM team owes a remediation plan in writing
- G3 not green by 2027-03: AI demoted from demo primary surface; demo focuses on Tier 2 + Tier 3

## Change control

- Eval set changes (add / remove pairs) require both parties' sign-off
- Quarterly augmentation (+20-50 pairs) is pre-approved per `eval-set-collection-plan.md`
- LLM team can request specific pair patterns for training; Data Nexus team holds 50 pairs as held-out for final score

## Comms

- Joint sync: bi-weekly, 30 min, Adam + LLM team lead
- Score dashboard: shared link (TBD)
- Incidents (model regression > 5pp drop): same-day Slack ping + post-mortem within 48h

---

## STUB — to be filled at sign time (2026-09)

- LLM team lead name + escalation chain
- Compute budget commitments (GPU hours / month for serving)
- Cost ceiling per inference call ($)
- IP / data ownership clauses (do they retain model? do we?)
- Termination / handover clauses if LLM team is reorged
- Joint roadmap items beyond G3 (Phase 2 features?)

## Sign-off

- [ ] Data Nexus team (Adam): ____________________
- [ ] LLM team lead: ____________________
- [ ] Date: ____________________
