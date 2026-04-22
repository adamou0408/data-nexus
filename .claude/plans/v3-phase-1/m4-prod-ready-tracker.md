# M4 Production-Ready Tracker

- **Owner:** SRE
- **Status:** STUB
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §3 Q3 2026, §6.2 Gate G1
- **Deadline:** 2026-09 (Gate G1 — blocks AI / Smart Analyst 2.0 unlock)

---

## Purpose

Track the five M4 production-ready work items to go-live by end of Q3 2026. M4 is **minimal freeze** — only prod-readiness, no new features.

---

## Work Items (5)

| # | Item | Owner | Depends on |
|---|------|-------|------------|
| 1 | **SEC-06 secrets** (Vault / external-secrets) | SRE | — |
| 2 | **Helm chart** for authz-api / identity-sync / dashboard | SRE | — |
| 3 | **Keycloak SSO** (replace `X-User-Id` header) | SRE + authz-api | SEC-06 |
| 4 | **LDAP CronJob** (replace local identity-sync cadence) | SRE + identity-sync | Helm chart |
| 5 | **Redis cache** for authz_resolve hot paths | authz-api | Helm chart |

---

## Weekly Checkbox Grid — STUB, to be filled

> Update weekly in sync with `docs/PROGRESS.md`. Mark `[x]` when item completes gate for that week (design / impl / staging / prod).

| Week | SEC-06 | Helm | Keycloak | LDAP Cron | Redis |
|------|--------|------|----------|-----------|-------|
| W01 (2026-05-04) | [ ] | [ ] | [ ] | [ ] | [ ] |
| W02 | [ ] | [ ] | [ ] | [ ] | [ ] |
| W03 | [ ] | [ ] | [ ] | [ ] | [ ] |
| W04 | [ ] | [ ] | [ ] | [ ] | [ ] |
| W05 | [ ] | [ ] | [ ] | [ ] | [ ] |
| W06 | [ ] | [ ] | [ ] | [ ] | [ ] |
| W07 | [ ] | [ ] | [ ] | [ ] | [ ] |
| W08 (alpha, 2026-07) | [ ] | [ ] | [ ] | [ ] | [ ] |
| W09 | [ ] | [ ] | [ ] | [ ] | [ ] |
| W10 | [ ] | [ ] | [ ] | [ ] | [ ] |
| W11 | [ ] | [ ] | [ ] | [ ] | [ ] |
| W12 | [ ] | [ ] | [ ] | [ ] | [ ] |
| W13 | [ ] | [ ] | [ ] | [ ] | [ ] |
| W14 | [ ] | [ ] | [ ] | [ ] | [ ] |
| W15 | [ ] | [ ] | [ ] | [ ] | [ ] |
| W16 (prod, 2026-09) | [ ] | [ ] | [ ] | [ ] | [ ] |

---

## STUB — to be filled

- Per-item owner name / backup owner
- Per-item acceptance criteria (staging check + prod check)
- Per-item rollback plan
- Cross-cut: observability (metrics/logs/alerts), runbook link, on-call rotation
- G1 exit checklist

---

## Success Metric (master plan §6.1)

- Q3 2026: ≥ 80% complete
- Q4 2026: 100% complete
