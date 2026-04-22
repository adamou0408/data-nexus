# Tier 2 sub-PM Onboarding Guide

- **Owner:** Adam
- **Status:** STUB (template ready for 2026-08 onboard)
- **Linked from:** [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) §4, [`tier2-pm-hiring-plan.md`](./tier2-pm-hiring-plan.md)
- **Used by:** sub-PM A (分析 wizard) + sub-PM B (admin 表單 + Path A migration), onboard 2026-08

---

## Purpose

Two new Tier 2 sub-PMs land 2026-08 on the critical path to demo. They have ~9 months from onboard to Q2 2027 demo. Every week of unclear orientation costs schedule. This is the playbook that gets them productive in week 2 instead of week 5.

---

## Week 1 — Foundations

### Day 1 (Mon)

- 1:1 with Adam (90 min): roadmap, Phase 1 gates, what success looks like
- Read the canon (~3h, in this order):
  1. [`docs/plan-v3-phase-1.md`](../../../docs/plan-v3-phase-1.md) — master plan
  2. [`docs/constitution.md`](../../../docs/constitution.md) — agent + human binding rules
  3. [`docs/phison-data-nexus-architecture-v2.4.md`](../../../docs/phison-data-nexus-architecture-v2.4.md) §1-3 — three paths, L0-L3, SSOT
  4. [`docs/PROGRESS.md`](../../../docs/PROGRESS.md) — current state
- Slack join: `#data-nexus`, `#data-nexus-alerts`, `#phison-bi-pilot`

### Day 2 (Tue)

- Pair with backend lead 2h: walk through `services/authz-api/src/routes/`
  - Focus: `/api/resolve`, `/api/check`, `/api/filter`, `/api/datasources`, `/api/pool`
- Pair with frontend lead 2h: walk through `apps/authz-dashboard/src/components/`
  - Focus: `ConfigEngine.tsx` (Path A runtime), `Layout.tsx` (tab system), TablesPanel
- Local dev: `make up && make verify` runs green

### Day 3 (Wed)

- DBA walk-through 2h: ER diagram, `authz_resource`, `authz_role_permission`, `authz_policy`
- Read `database/migrations/V001-V044` headers (skim names, deep-read V020/V022/V044)
- Pair-debug one open backlog item from `docs/backlog-tech-debt.md` to learn the loop

### Day 4 (Thu)

- Sub-PM A only: read [`tier2-analytics-wizard-plan.md`](./tier2-analytics-wizard-plan.md), draft questions list for Adam
- Sub-PM B only: read [`tier2-admin-form-wizard-plan.md`](./tier2-admin-form-wizard-plan.md) + [`path-a-inventory.md`](./path-a-inventory.md) + [`g2-pilot-recruitment.md`](./g2-pilot-recruitment.md)
- Both: shadow a real Path A admin user for 1 hour (sub-PM B must do this)

### Day 5 (Fri)

- Retro 1:1 with Adam (60 min): what's confusing, what's missing
- Identify first deliverable (scoping doc) — due end of week 4
- Set weekly cadence: Adam 1:1 (Wed 30 min), tech lead sync (Mon 15 min)

## Week 2-4 — First Deliverable

Each sub-PM writes a scoping doc (~5-8 pages) for their surface:

**Sub-PM A — 分析 wizard scoping**
- User personas (analyst, manager, exec)
- Top 10 questions they want to ask the system
- 3 reference dashboards (existing BI tool screenshots + critique)
- ECharts component inventory needed
- Authz integration plan (how does L0-L3 gate which charts render)
- Open questions for Adam / DBA / LLM team

**Sub-PM B — admin 表單 scoping**
- Path A inventory delta (what's left after `path-a-inventory.md`)
- Form mode descriptor format (extends or replaces `authz_ui_page`?)
- Migration sequence: which descriptor first, which last, what the cutover looks like
- Pilot recruitment status (intake from `g2-pilot-recruitment.md`)
- Risk register for the migration

Review with Adam end of week 4. From week 5: build mode.

## Access checklist (HR / IT pre-onboard)

- [ ] Phison email
- [ ] LDAP account in `phison-data-nexus-team` group
- [ ] GitHub access to `phison-data-nexus` repo (write)
- [ ] Linear / Jira project access
- [ ] Metabase / dashboard access (read all, write own folder)
- [ ] Staging cluster kubectl context
- [ ] VPN / Phison internal network
- [ ] Laptop provisioned with Docker, Node 20, Postgres 16 client

## Success at 30 days

- Scoping doc filed and reviewed
- Local dev fully working, can ship a tiny PR (typo fix counts) merged
- Has met everyone they need: Adam, tech lead, DBA lead, SRE lead, LLM team contact, 1+ pilot user
- Has a written opinion on the top 1 risk in their surface

## Success at 90 days

- First feature shipped to staging
- Owns weekly status update in `docs/PROGRESS.md` for their surface
- Has run at least one user research session (sub-PM A: with analysts; sub-PM B: with pilots)

---

## STUB — to be filled at hire time

- Hire-specific HR forms / onboarding paperwork pointers
- Comp + equity grant details
- Buddy assignment (peer outside reporting line)
- First-month feedback form template
