# Tier 2 — Admin 表單模式 Plan (Path A 辦死)

- **Owner:** Tier 2 sub-PM B (TBD — see [`tier2-pm-hiring-plan.md`](./tier2-pm-hiring-plan.md))
- **Status:** STUB
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §1.1, §2.2, §3 Q4 2026 / Q1 2027, §6.2 Gate G2
- **Target:** Q4 2026 alpha → Gate G2 (2026-12) → Q1 2027 migration 開跑

---

## Purpose

Replace Path A (Config-as-State-Machine) with a Tier 2 admin 表單 wizard. One-way door — **gate-gated** by G2 (3-5 pilot users × 2 weeks active usage).

---

## Goals (draft)

1. Replace all surviving Path A descriptors with wizard-built admin forms
2. CRUD + 審核流程 wired into authz + audit log
3. Migration tool that reads existing Config-SM descriptors and emits wizard state draft
4. Zero admin workflow regression during pilot

## Reference: Path A Inventory

See [`path-a-inventory.md`](./path-a-inventory.md) (owned by another agent) for the full list of surviving Path A screens / descriptors to migrate. Migration scope = that inventory minus anything flagged `deprecate-only`.

## Mapping Strategy (descriptor → form schema)

- Read existing Config-SM JSON descriptor
- Map fields → form schema primitives (text / number / select / relation / date)
- Preserve state-machine transitions as wizard review steps
- Generate migration draft → sub-PM B reviews & polishes
- Old Path A stays read-only during transition until migration target validated

## State Machine Editor UX Notes

- Visual: states as nodes, transitions as edges
- Each transition has optional approval step (審核流程)
- Role-based transition guards derived from authz
- Preview mode shows "as user X" to verify authz injection

## G2 Pilot Gate Criteria (from master plan)

- 3-5 pilot users
- ≥ 2 weeks 主動使用（not passive / not one-off）
- 使用者自發回來用 (retention > usage-mandated)
- Pass → open Path A migration
- Fail → Path A stays alive, iterate

## Acceptance Criteria (draft)

- Q4 2026: ≥ 3 pilot workflows running ≥ 2 weeks with active return
- Q1 2027: G2 pass, migration begins
- Q2 2027: Path A fully retired (master plan §6.1 指標)
- Zero P1 regressions during migration

---

## STUB — to be filled

- Per-descriptor mapping rules catalog
- Rollback plan if a migration breaks a workflow
- Pilot recruitment & criteria
- Approval-flow authz model
- Migration tool CLI spec (reads Config-SM → emits wizard JSON)
- Coordination plan with Tier 2 analytics wizard (shared tech lead)
- Decommission plan for Path A code paths post-migration
