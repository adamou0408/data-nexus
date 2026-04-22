# M4 Production Go-Live Runbook (Gate G1)

- **Owner:** SRE
- **Status:** STUB
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §6.2 (Gate G1), [`m4-prod-ready-tracker.md`](./m4-prod-ready-tracker.md)
- **Target date:** 2026-09 (Gate G1 exit criterion)
- **Scope:** First production deployment of Data Nexus AuthZ to Phison internal data center

---

## Purpose

Step-by-step runbook for the M4 go-live cutover. This is the playbook that the on-call SRE follows the day we flip prod traffic to the new authz service. Bugs cost us a week. Mistakes cost us a quarter.

The point of this doc: nobody invents the cutover sequence at 2 AM. Everything is decided, dry-run, signed off, before go-live night.

---

## Pre-flight (T-2 weeks)

- [ ] M4 tracker `.claude/plans/v3-phase-1/m4-prod-ready-tracker.md` shows ≥ 95% green
- [ ] Helm chart deployed to **staging** mirror (real LDAP, real PG, real Redis)
- [ ] Smoke test suite green for 7 consecutive days on staging
- [ ] Keycloak SSO end-to-end verified (login → resolve → check → page render)
- [ ] LDAP CronJob running on staging schedule for ≥ 14 days, drift report = 0
- [ ] Redis cache hit rate ≥ 90% on staging steady-state
- [ ] SEC-06 secrets pulled from prod secret store (no .env files in image)
- [ ] Backup + restore drill done on staging PG (RPO ≤ 5 min, RTO ≤ 30 min)
- [ ] Three-paths smoke (Path A wizard, Path B page, Path C psql) all green on staging
- [ ] On-call rotation set, paging rules tested, escalation tree printed

## T-3 days

- [ ] Freeze authz_role_permission / authz_policy edits in dev (announce in #data-nexus)
- [ ] Snapshot prod-equivalent dataset, replay against staging, diff checks 0
- [ ] All P0 / P1 from `docs/backlog-tech-debt.md` closed or explicitly waived (sign-off below)
- [ ] Comms draft: announcement, FAQ, rollback notice, status page entry

## T-1 day

- [ ] Final go / no-go meeting (Adam + SRE lead + DBA lead + Security)
- [ ] Maintenance window announced (T-12h, T-1h reminders)
- [ ] Rollback build tagged + cached on prod node
- [ ] Replay staging green-suite one final time

## Go-live night (T-0)

```
T-0       Enter maintenance mode (banner up, read-only API)
T+5min    Snapshot prod PG (label: m4-cutover-{date})
T+10min   Apply migrations V001-V044 (idempotent rerun safe)
T+25min   Helm upgrade nexus-platform → M4 chart
T+30min   Smoke test: /healthz, /api/resolve sample user, /api/check sample resource
T+35min   Open traffic to 10% of dashboard users (canary via ingress)
T+45min   Watch error rate + p99 latency + Redis cache hit rate (target: same as staging)
T+60min   If green → 100%. If red → rollback (see below)
T+75min   Exit maintenance mode, drop banner
```

## Rollback procedure

Trigger: any of error rate > 1%, p99 > 2× baseline, three-paths smoke fails, security incident.

```
1. Helm rollback: helm rollback nexus-platform <previous-revision>
2. Restore PG from snapshot if migrations broke schema
3. Re-enter maintenance banner
4. Post-mortem within 48h (write to docs/PROGRESS.md "Phase 1 incidents" section)
```

## Sign-off (required before go-live)

- [ ] SRE lead: ____________________
- [ ] DBA lead: ____________________
- [ ] Security: ____________________
- [ ] Adam (Phase 1 owner): ____________________

---

## STUB — to be filled

- Exact Helm values for prod (resource limits, replicas, HPA targets)
- Prod-specific secret names + paths in vault
- Concrete LDAP bind DN + group search base for Phison prod
- PG instance sizing decision (single instance vs primary+replica for M4)
- Network policy / firewall rules for prod cluster
- Monitoring dashboards: link Grafana panels for authz QPS, p99, cache hit rate
- Paging rules: PagerDuty escalation policy ID
- Communications: who emails whom when prod is up

## Acceptance criteria (Gate G1)

- M4 deployed to prod, observed for ≥ 14 days with no P0 incident
- Three paths green in prod
- Smart Analyst 2.0 work unblocked (Milestone 5 entry)
