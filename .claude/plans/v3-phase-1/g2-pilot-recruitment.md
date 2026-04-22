# G2 Pilot Recruitment Plan (Tier 2 Admin Form Mode)

- **Owner:** Tier 2 sub-PM B (TBD — see `tier2-pm-hiring-plan.md`)
- **Status:** STUB
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §6.2 (Gate G2), [`tier2-admin-form-wizard-plan.md`](./tier2-admin-form-wizard-plan.md)
- **Target:** Q4 2026 alpha → 2026-12 G2 sign-off (3-5 pilots × 2 weeks active use)

---

## Purpose

Without 3-5 real admin users actively using the new Tier 2 form mode for ≥ 2 weeks, we cannot kill Path A. This doc is how we find, onboard, and observe those pilots. Drop the ball here and we ship a beautiful new wizard that nobody has stress-tested, and Path A migration slips into 2027.

---

## Target pilot profile

| Trait | Required | Why |
|-------|----------|-----|
| Real admin work weekly | YES | Drive-by users will not catch edge cases |
| Currently uses Path A | YES | Provides direct comparison + migration credibility |
| Different domains (≥ 3) | YES | Avoids domain-specific UX bias |
| Willing to file bugs | YES | Silent users = no signal |
| 2 weeks dedicated use | YES | <2 weeks = honeymoon effect, no drift |

## Recruitment funnel (target: 8 invited → 5 confirmed → ≥ 3 fully active)

- [ ] List current Path A active admins (query audit_log: distinct users in path=A admin actions, last 30d)
- [ ] Filter: domain coverage (3+ domains), weekly cadence, manager approval
- [ ] sub-PM B 1:1 each candidate: explain pilot, time commitment (~30 min/day for 2 weeks), sign-up
- [ ] Confirm 5 pilots + 1-2 backup
- [ ] Kickoff session (1h): tour, login, support channel, weekly retro schedule

## Pilot loop (2 weeks per cohort)

| Week | Activity |
|------|----------|
| W1 Mon | Onboard, walk through 1 real task end-to-end |
| W1 daily | Slack channel for questions, sub-PM B watches, fixes blocking bugs same-day |
| W1 Fri | Mid-pilot retro (15 min, structured: 1 thing that worked / 1 thing that broke) |
| W2 daily | Pilot uses form mode for all admin tasks; sub-PM B logs friction |
| W2 Fri | Final retro + survey (NPS, "would you keep using?", switch-back signal) |

## G2 exit criteria (must hit ALL)

- [ ] ≥ 3 of 5 pilots actively used form mode for ≥ 10 of 14 days (audit log evidence)
- [ ] ≥ 3 say "yes I would keep using this over Path A" in survey
- [ ] All P0 / P1 bugs from pilot logged in backlog and ≥ 80% closed
- [ ] No P0 incident caused by form mode that broke a pilot's actual work
- [ ] sub-PM B + Adam sign-off doc filed in `docs/PROGRESS.md` Phase 1 gates section

## Anti-patterns (do not let these happen)

- "Soft pilots" — friends of sub-PM who use it once and say it's fine
- Hidden bug list — any bug not in backlog does not exist for retro purposes
- Cherry-picked tasks — pilots must use form mode for **all** their admin work, not the easy ones
- Skipping the survey — survey is the artifact, not vibes

---

## STUB — to be filled

- Concrete pilot user list (after sub-PM B onboarded, 2026-08+)
- Survey questions (NPS + 5 task-specific Likert items)
- Slack channel name + paging path for blocking bugs
- Compensation / recognition for pilots (small thanks: lunch / swag / shoutout)
- Cohort sequencing (one cohort of 5 vs two cohorts of 3? Recommend one cohort, parallel observation easier)
