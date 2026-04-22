# M4 Production-Ready Tracker

- **Owner:** SRE
- **Status:** partial — SEC-06 code-layer ✅ (2026-04-23); other 4 items STUB
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

## Per-Item Status

### 1. SEC-06 — Production secrets

- **Code-layer status:** ✅ complete 2026-04-23 (commit `ff7982a`).
  - 06a `crypto.ts` `getKey()` refuses to boot in `NODE_ENV=production` without `ENCRYPTION_KEY`
  - 06b `.env.example` at repo root
  - 06d `.gitignore` covers `*.pem`, `*.key`, `*.p12`, `*.pfx`, `secrets/`, `.secrets/`
  - 06e `authz-api/index.ts` `validateProductionEnv()` before `app.listen`
  - 06f `docs/deployment-checklist.md`
- **Infra-layer status:** ⏳ pending SRE
  - 06c pgbouncer userlist MD5 hash + password rotation (needs maintenance window)
  - External-secrets or Vault wiring for K8s
  - Key rotation runbook (encryption-key + DB passwords)
- **Acceptance criteria:**
  - staging: pod crash-loops with clear message when `ENCRYPTION_KEY` unset ✅ (code enforces)
  - staging: `/healthz` 200 after secrets supplied via K8s Secret
  - prod: all four required env vars sourced from external secret manager (not K8s Secret literal)
- **Rollback plan:** revert commit `ff7982a` + `docker-compose down` → previous startup still worked with dev fallback. No data migration involved.

### 2–5. Helm / Keycloak / LDAP CronJob / Redis — STUB

- Per-item owner name / backup owner
- Per-item acceptance criteria (staging check + prod check)
- Per-item rollback plan
- Cross-cut: observability (metrics/logs/alerts), runbook link, on-call rotation
- G1 exit checklist

---

## Success Metric (master plan §6.1)

- Q3 2026: ≥ 80% complete
- Q4 2026: 100% complete
