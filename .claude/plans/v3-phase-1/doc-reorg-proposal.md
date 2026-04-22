# Doc Architecture Reorg — Proposal

- **Status:** Ready-for-review
- **Audited:** 2026-04-22 (Explore agent + manual verification)
- **Linked from:** `CLAUDE.md` "Where Things Live" + `docs/design-v3-phase-1.md`
- **Implementation effort:** ~3-4 hours after Adam answers discussion points (§6)

---

## 1. Full Inventory

### `docs/` (18 files, ~610 KB)

| File | Lines | Purpose | Routed in CLAUDE.md? |
|------|-------|---------|---------------------|
| `api-reference.md` | ~290 | API + dashboard tab reference | ✅ |
| `architecture-diagram.md` | ~480 | System / data-flow diagrams | ✅ |
| `backlog-tech-debt.md` | ~830 | Tech debt log (P0-P3) | ✅ |
| `config_driven_ui_requirements.md` | ~754 | Path A / Config-SM detailed spec | ❌ orphan (now added) |
| `constitution.md` | ~257 | Agent binding rules | ✅ |
| `design-data-mining-engine.md` | ~570 | Data Mining thin-slice plan (Q3 2026) | ✅ |
| `design-data-mining-vision.md` | ~1458 | Data Mining vision (gated by Milestone 0) | ✅ |
| `design-v3-phase-1.md` | ~360 | **Phase 1 master plan (active SSOT)** | ✅ |
| `er-diagram.md` | ~510 | DB ER diagram | ✅ |
| `nexus-startup-guide.md` | ~490 | Local dev / startup guide | ❌ orphan (now added) |
| `phison-data-nexus-architecture-v2.4.md` | ~3934 | Foundational architecture spec | ✅ |
| `plan-bottom-up-ux-refactor.md` | ~190 | Bottom-up UX refactor plan | ❌ orphan (now added with status pending) |
| `plan-business-db-separation.md` | ~590 | ARCH-01 plan — **STATUS STALE** (see R4) | ❌ orphan (now added with note) |
| `postgresql-dba-skillmap.md` | ~1280 | DBA hiring / skills doc | ❌ orphan (now added) |
| `PROGRESS.md` | ~520 | Progress tracker (state SSOT) | ✅ |
| `requirements_spec.md` | ~510 | **DEPRECATED 2026-04-22** | ✅ marked deprecated |
| `testing-guide.md` | ~310 | Testing guide | ❌ orphan (now added) |
| `wishlist-features.md` | ~860 | Feature wishlist | ✅ |

### `.claude/plans/v3-phase-1/` (12 files + drafts dir)

All freshly scaffolded 2026-04-22, see `.claude/plans/v3-phase-1/README.md` for index.

### `.claude/agents/` (16 role files, 1 README)

Agent role definitions — Bucket: RULES.

### Root

- `CLAUDE.md` — project routing rules for Claude Code

---

## 2. Redundancy / Overlap

### R1. Architecture spec duplication

- `phison-data-nexus-architecture-v2.4.md` (3934 lines, foundational)
- `config_driven_ui_requirements.md` (754 lines, Path A detail)

Both define Config-SM, L0-L3, SSOT. Reader can't tell which wins.

**Fix:** v2.4 = canonical foundation. config-driven-ui = appendix. Add cross-link banner at top of config-driven-ui pointing to v2.4 §X for Config-SM core; v2.4 references config-driven-ui as "Path A detail spec". Both stay in `docs/`.

### R2. Data Mining doc gating confusion

- `design-data-mining-vision.md` (1458 lines, gated by "Milestone 0 user validation" — Q4 2026+)
- `design-data-mining-engine.md` (569 lines, Q3 2026 thin-slice executable)

Both in `docs/` as if equal-weight. Vision is aspirational, engine is committed.

**Fix:** Move vision → `.claude/plans/v3-phase-1/design-mining-vision.md` with "GATED — Milestone 0 entry criteria" banner. Keep engine in `docs/` (active design).

### R3. Deprecated `requirements_spec.md` still in live docs

Marked DEPRECATED 2026-04-22 but sits next to active design docs. Mental noise.

**Fix:** Move → `.claude/plans/_ARCHIVED/requirements_spec-v1-deprecated-20260422.md`. Add link from `design-v3-phase-1.md` Section 7. Stop listing in CLAUDE.md "Where Things Live".

### R4. ARCH-01 plan status contradiction (CRITICAL — verified)

- `docs/plan-business-db-separation.md` line 6: `**狀態**：規劃中（未開始實作）`
- `docs/backlog-tech-debt.md` line 36: `ARCH-01　Business Database 獨立分離 — **狀態**：已完成`
- `docs/PROGRESS.md` lines 90-93: 4 ARCH-01 sub-items all checked `[x]`

Plan file is stale. Either it never got updated when work shipped, or the work isn't actually deployed.

**Fix (pending Adam confirm — see Q1 §6):** If deployed → update plan file to "完成 (2026-04-12)" + archive. If not deployed → fix backlog + PROGRESS.

---

## 3. Gaps (Missing Critical Docs)

| ID | Doc | For | Lines | Owner |
|----|-----|-----|-------|-------|
| G1 | `m4-go-live-runbook.md` | Gate G1 execution (M4 prod 2026-09) | ~150 | SRE |
| G2 | `g2-pilot-recruitment.md` | Gate G2 execution (3-5 pilots × 2 weeks) | ~100 | sub-PM B |
| G3 | `tier2-onboarding-guide.md` | Two new sub-PM hires onboard 2026-08 | ~100 | Adam |
| G4 | `llm-slo-contract-template.md` | Gate G3 LLM SLO contract template | ~80 | Adam |
| G5 | `phase-2-preview.md` (optional) | Stakeholder visibility on Phase 2 boundaries | ~80 | Adam |

All proposed for `.claude/plans/v3-phase-1/` (or `.claude/plans/` root for G5).

---

## 4. Naming / Filing Inconsistency

| Issue | Affected | Fix |
|-------|----------|-----|
| `design-v3-phase-1.md` is a **plan**, not a design spec | `docs/design-v3-phase-1.md` | Rename → `docs/plan-v3-phase-1.md`. Update ~10 cross-links |
| `requirements_spec.md` uses underscores; rest of `docs/` uses hyphens | `docs/requirements_spec.md` | Will be archived per R3 |
| `postgresql-dba-skillmap.md` is hiring/HR content | `docs/postgresql-dba-skillmap.md` | Move → `.claude/agents/dba-guardian-hiring.md` |
| `plan-bottom-up-ux-refactor.md` orphan | `docs/plan-bottom-up-ux-refactor.md` | Verify still active; route or archive |
| `nexus-startup-guide.md` is dev-onboarding | `docs/nexus-startup-guide.md` | Stays in `docs/`, route in CLAUDE.md (DONE 2026-04-22) |
| `testing-guide.md` is dev convention | `docs/testing-guide.md` | Move → `docs/standards/testing-guide.md` |

---

## 5. Proposed Target Architecture

```
RULES (how to behave) — change rarely, formal review
├── CLAUDE.md                                   project routing
├── docs/constitution.md                        agent binding rules (Article 8)
├── docs/standards/                             coding / migration / testing
│   └── testing-guide.md                        (moved from docs/)
└── .claude/agents/                             agent role definitions
    └── dba-guardian-hiring.md                  (moved from docs/postgresql-dba-skillmap.md)

PLANS (what to do) — change as scope evolves
├── docs/plan-v3-phase-1.md                     (renamed from design-v3-phase-1.md)
├── docs/phison-data-nexus-architecture-v2.4.md  foundational architecture
├── docs/config_driven_ui_requirements.md       Path A detail (appendix to v2.4)
├── docs/api-reference.md
├── docs/architecture-diagram.md
├── docs/er-diagram.md
├── docs/design-data-mining-engine.md           Q3 2026 thin slice
├── docs/nexus-startup-guide.md                 dev onboarding
├── .claude/plans/v3-phase-1/                   tactical sub-plans (12 + G1-G5 new)
├── .claude/plans/phase-2-preview.md            (optional, see §6 Q2)
└── .claude/plans/_ARCHIVED/                    deprecated + completed plans
    ├── requirements_spec-v1-deprecated-20260422.md
    └── plan-business-db-separation-completed-20260412.md (if confirmed)

STATE (where we are) — change weekly
├── docs/PROGRESS.md                            milestone tracker
├── docs/backlog-tech-debt.md                   tech debt log
└── docs/wishlist-features.md                   feature wishlist (Phase 2+)
```

### File Movements (10 ops)

| # | Op | From | To | Risk |
|---|----|------|----|----|
| 1 | Rename | `docs/design-v3-phase-1.md` | `docs/plan-v3-phase-1.md` | Low (cross-links) |
| 2 | Move | `docs/requirements_spec.md` | `.claude/plans/_ARCHIVED/...` | Low |
| 3 | Move | `docs/design-data-mining-vision.md` | `.claude/plans/v3-phase-1/...` | Low |
| 4 | Move | `docs/postgresql-dba-skillmap.md` | `.claude/agents/dba-guardian-hiring.md` | Low |
| 5 | Move | `docs/testing-guide.md` | `docs/standards/testing-guide.md` | Low |
| 6 | Update or move | `docs/plan-business-db-separation.md` | Mark complete + archive **OR** reconcile | **Need Adam (Q1)** |
| 7 | Verify | `docs/plan-bottom-up-ux-refactor.md` | Active? Archive or route. | **Need Adam (Q5)** |
| 8 | Cross-link | `docs/config_driven_ui_requirements.md` | Header banner pointing to v2.4 | Low |
| 9 | Cross-link | `docs/phison-data-nexus-architecture-v2.4.md` | Reference config-driven-ui as Path A detail | Low |
| 10 | CLAUDE.md routing | (post-moves) | Sync routing table to final structure | Low |

---

## 6. Discussion Points for Adam

### Q1. ARCH-01 status contradiction (P0 — clearest fix)

Backlog + PROGRESS say done, plan doc says 規劃中. **Is `nexus_authz` + `nexus_data` Docker split actually deployed in dev?**

- **YES** → I update plan to "完成 (2026-04-12)" + archive
- **NO** → fix backlog + PROGRESS to match reality

### Q2. Phase 2 preview doc — create now or defer?

- **Now** (~80 lines): stakeholder visibility, frames Phase 1 boundaries
- **Defer** until 2027-06 post-Phase-1

### Q3. Architecture spec positioning

`v2.4` (3934 lines) vs `config_driven_ui_requirements.md` (754 lines). Treat v2.4 = canonical, config-driven-ui = appendix? Or equal-weight?

### Q4. Data Mining vision gating

When does "Milestone 0 user validation" trigger? Move vision to `.claude/plans/v3-phase-1/` now (mark gated), or leave in `docs/`?

### Q5. Bottom-up UX refactor plan still active?

`docs/plan-bottom-up-ux-refactor.md` orphan. Active or superseded by Phase 1?

### Q6. Tier 2 onboarding guide — write now or after candidates picked?

15 min now (template) vs wait until July 2026. Recommend now.

### Q7. `design-` vs `plan-` rename

Rename `design-v3-phase-1.md` → `plan-v3-phase-1.md`? (~10 cross-link updates).

### Q8. `testing-guide.md` move

Move `docs/testing-guide.md` → `docs/standards/testing-guide.md`? (Aligns with bucket convention).

---

## 7. Implementation Order (after Adam answers)

1. **Now (autonomous, low-risk DONE 2026-04-22):** Added 6 missing docs to CLAUDE.md routing
2. **After Q1:** Reconcile ARCH-01 (1 file edit + maybe archive)
3. **After Q3-Q5, Q7-Q8:** Execute file movements (10 ops above)
4. **After Q2/Q6:** Create new docs (G1-G5)
5. **Final:** Update CLAUDE.md "Where Things Live" with final structure + remove "(待定)" notes
