# Permission Default-Allow Pilot — Report

> **Status:** 🟡 TEMPLATE — implementation ACs (1.x + X.1/X.2/X.3) shipped 2026-04-27.
> **Pending:** real 2-week pilot run measurements (this file is the harness; numbers fill in after pilot).
> **Plan:** `.claude/plans/v3-phase-1/permission-default-allow-pilot-plan.md`
> **Owner:** Adam · **Pilot driver:** TBD

---

## 1. Pilot scope (planned)

| Item | Decision |
|------|----------|
| Pilot datasource | `ds:_____` (TBD — Adam to nominate; rec. one BI-facing schema with ≥30 tables) |
| `default_l0_policy` flip date | `YYYY-MM-DD` |
| Roll-back date (if abort) | `YYYY-MM-DD` |
| Pilot duration | 2 weeks |
| Sample size | _N_ users across _M_ roles (target: ≥1 PE_* role + ≥1 SALES_* role + ≥1 BI/分析師 group) |
| Deny-list at start | V062 30 patterns + any L1/L2 carve-outs (list source: `SELECT … FROM authz_policy WHERE created_by IN ('seed-V062', …)`) |

---

## 2. Target metrics (from plan §1)

| Metric | Baseline (pre-pilot) | Plan target | Measured | Δ vs baseline | Pass? |
|--------|----------------------|-------------|----------|---------------|-------|
| New-DB onboarding end-to-end | 5–10 working days | 0.5–1 day (**−90%**) | _TBD_ | _TBD_ | ☐ |
| AUTHZ_ADMIN hours / month | 80–160 hr | **−85%** | _TBD_ | _TBD_ | ☐ |
| BI ad-hoc data coverage | ~30% of tables | **80%** | _TBD_ | _TBD_ | ☐ |
| Policy rows per new DB | 150–200 | not measured (informational) | _TBD_ | — | n/a |

**Measurement methods (fill in before pilot starts):**
- Onboarding time: timestamp from registration ticket open → first successful query, per onboarding case during pilot. Capture `n` ≥ 3 to compute median.
- AUTHZ_ADMIN hours: weekly self-report from AUTHZ_ADMIN(s), subtracting unrelated work. Compare 2 weeks pre-pilot vs 2 weeks pilot.
- BI coverage: `count(*) FROM authz_resource WHERE resource_type='table' AND attributes->>'data_source_id'='<pilot_ds>' AND authz_check('<bi_user>', ARRAY['<bi_role>'], 'read', resource_id)='t'` divided by total tables. Run for ≥3 representative BI users.

---

## 3. Safety / compliance signals

| Signal | Source | Threshold | Observed | Pass? |
|--------|--------|-----------|----------|-------|
| Unauthorised-access attempts on deny-listed columns | `authz_audit_log` WHERE result='deny' AND resource matches V062 patterns | _TBD by Adam_ | _TBD_ | ☐ |
| New `authz_policy` deny suggestions emitted by engine during pilot | `count` from `authz_policy` WHERE `suggested_by_rule IS NOT NULL AND status='pending_review' AND effect='deny' AND suggested_at >= pilot_start` | informational | _TBD_ | n/a |
| Operator approval rate of deny suggestions | approved / total emitted (PATCH `/api/discover/suggestions/:id` to status='active' or rejected) | informational | _TBD_ | n/a |
| 漏失（false-allow that should have been deny） | manual review of pilot users' top-50 viewed resources by 法遵 reviewer | **0 critical** | _TBD_ | ☐ |
| `pg_default_acl` symmetry on rollback drill | run `make verify-phase1` mid-pilot | C1=3, C2=0 | (verify-phase1 14/14 already passing 2026-04-27) | ✓ |

**Critical-deny incident protocol:** any 漏失 finding involving SOX / PII / IP triggers immediate `UPDATE authz_data_source SET default_l0_policy='deny' WHERE source_id='<pilot_ds>'` + 24-hour post-mortem before resuming pilot.

---

## 4. NPS / qualitative

| Audience | Question | Score (1–10) | Open comment |
|----------|----------|--------------|--------------|
| BI 分析師 (n=_TBD_) | "Did permission friction decrease this pilot?" | _TBD_ | _TBD_ |
| AUTHZ_ADMIN (n=_TBD_) | "Did your weekly ticket queue feel smaller?" | _TBD_ | _TBD_ |
| 法遵/內稽 (n=_TBD_) | "Are you comfortable extending default-allow beyond the pilot?" | _TBD_ | _TBD_ |

---

## 5. Decision matrix (fill at pilot end)

| Outcome | Trigger | Next action |
|---------|---------|-------------|
| **GO** to Phase 2 (expand to next datasource) | All 3 plan §1 targets within ±20%, **AND** zero critical 漏失, **AND** 法遵 NPS ≥ 7 | Open scoping ticket for next pilot datasource; schedule G2 alignment review |
| **HOLD** (extend pilot 2 more weeks) | Targets borderline OR NPS 5–6 OR ≥1 non-critical 漏失 with mitigation in flight | Document gap; iterate on V062 deny patterns; rerun verify-phase1 |
| **ROLLBACK** | Any critical 漏失 OR 法遵 NPS < 5 OR explicit business veto | `UPDATE … SET default_l0_policy='deny'` + run `authz_sync_db_grants()` (V063 symmetric REVOKE); post-mortem; archive plan as paused |

---

## 6. Implementation status (filled at template creation)

| AC | Status | Evidence |
|----|--------|----------|
| 1.1 `default_l0_policy` column | ✓ | V059 |
| 1.2 resource→datasource mapping | ✓ | `authz_resource.attributes->>'data_source_id'` convention used by V060/V064 |
| 1.3 invert `authz_resolve()` | ✓ | V060 |
| 1.4 invert `authz_check()` (+ batch single path) | ✓ | V060 |
| 1.5 deny-suggestion approval loop enforces | ✓ | V064 + engine `effect='deny'` + `/discover/suggestions` PATCH; verify-phase1 cell B7 |
| 1.6 `authz_sync_db_grants()` per-profile branch | ✓ | V063 |
| 1.7 rollback symmetry (`pg_default_acl` drains to 0) | ✓ | V063 + verify-phase1 cell C2 |
| X.1 12-cell regression matrix + L1/L2/L3 | ✓ (14/14) | `scripts/verify-phase1-default-allow.sh`, `make verify-phase1` |
| X.2 docs (api-reference + architecture-diagram + constitution Article 2 amendment v2.1) | ✓ | commits `eea5f4a` (api/arch) + constitution v2.1 (2026-04-27) |
| X.3 PROGRESS.md log | ✓ | commit `a6aab3a` |
| X.4 pilot report | 🟡 TEMPLATE | this file |

**Open items not gated by code:**
- V062 30 deny patterns still owe **法遵 / 內稽 + Adam dual sign-off** before any prod-bound flip.
- AC-2.1 BI sandbox schema name **owed by Adam** (was the natural pilot candidate).
- Single-source path of `authz_check_batch()` widened by V060/V064; multi-resource batch query NOT yet widened — Phase 2 follow-up if pilot telemetry shows the gap matters (V064 header notes).

---

## 7. Sign-off

| Role | Name | Date | Decision |
|------|------|------|----------|
| Data Nexus owner | Adam | _TBD_ | _GO / HOLD / ROLLBACK_ |
| 法遵 reviewer | _TBD_ | _TBD_ | _approve / objection_ |
| 內稽 reviewer | _TBD_ | _TBD_ | _approve / objection_ |
| AUTHZ_ADMIN representative | _TBD_ | _TBD_ | _representative comment_ |
