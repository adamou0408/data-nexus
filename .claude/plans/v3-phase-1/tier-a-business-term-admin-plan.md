---
status: DRAFT
owner: Adam (executor)
created: 2026-04-29
sequenced from: tier-a-primitives-roadmap.md §3.4 (C primitive — gate-prep, not C itself)
---

# BIZ-TERM-V01 — Business Term Admin Tab

## Why this exists (and isn't called "C")

Roadmap §3.4 puts **C — business_term-driven column mask 自動化** behind a gate: `blessed_term ≥ 10`. V044 schema landed 2026-04-26 with **zero API and zero UI** — to bless terms today, Adam writes raw SQL.

This sub-plan **closes that schema-without-tooling gap**, not C itself. C ships when blessed_term ≥ 10 (per roadmap). Whether Adam actually fills terms (and how fast) depends on his own bless cadence — this plan only removes the SQL-typing friction.

**Honesty on framing:** This is a 4th option not on the PROGRESS.md line 61 named candidate list (which were: A4 named-consumer / C blessed_term ≥ 10 itself). It is gate-*preparation* tooling, picked because both named candidates are gated on signals Adam must generate externally, while this is pure-software pure-additive. Surfacing this explicitly so Adam can redirect if he prefers the named candidates wait.

## Scope

In-scope (v1):
- Admin-only UI listing rows in `authz_resource` where `status` is set OR `business_term` is set (i.e. all rows participating in the semantic layer).
- Inline edit: `business_term`, `definition`, `formula`, `owner_subject_id`.
- Lifecycle transitions: `draft → under_review → blessed → deprecated` via row-level buttons.
- Status filter (draft/under_review/blessed/deprecated/null=all-with-term).
- Audit log: `tier_a_business_term_create / update / transition_<status>`.
- Reuse FEEDBACK-V01 / SAVED-VIEW-V01 admin pattern (router under `requireRole`, Govern section, admin-only tab).

Out-of-scope (deferred):
- "Promote a non-semantic resource into the semantic layer" picker (in v1 the user types resource_id directly or uses an existing draft).
- Bulk import (CSV / paste-N-rows).
- Cross-resource term consolidation / merge.
- Column-mask wiring (that's C itself — gated on blessed_term ≥ 10).

## Schema

**No new migration.** Reuses V044 columns on `authz_resource`:
- `business_term TEXT` (unique when status='blessed' via partial index)
- `definition TEXT`
- `formula TEXT`
- `owner_subject_id TEXT REFERENCES authz_subject(subject_id)`
- `status TEXT CHECK IN (draft, under_review, blessed, deprecated)`
- `blessed_at TIMESTAMPTZ`
- `blessed_by TEXT REFERENCES authz_subject(subject_id)`

**Constraint we MUST honor (V044 §3):**
- `status='blessed'` → `blessed_at` AND `blessed_by` both NOT NULL
- `status='draft' | 'under_review' | NULL` → `blessed_at` AND `blessed_by` MUST be NULL
- `status='deprecated'` → bless fields free (preserved as audit history)

API has to set/clear bless fields atomically with status transitions.

## API

Mount: `app.use('/api/business-term', requireRole('ADMIN','AUTHZ_ADMIN'), businessTermRouter)`.

| Method | Path | Behavior |
|---|---|---|
| GET | `/` | List rows where `business_term IS NOT NULL OR status IS NOT NULL`. Optional `?status=` filter. ORDER BY `status NULLS LAST, business_term`. LIMIT 500. |
| GET | `/:resource_id` | Single row by `resource_id`. 404 if not found. |
| PATCH | `/:resource_id` | Update `business_term`, `definition`, `formula`, `owner_subject_id`. Does NOT change status (use transition endpoint). |
| POST | `/:resource_id/transition` | Body: `{ status: 'draft' \| 'under_review' \| 'blessed' \| 'deprecated' }`. Atomically sets/clears bless fields per V044 invariants: bless on `blessed`, leave on `deprecated`, clear on `draft|under_review`. |

Validation:
- `business_term`: 1–200 chars when present.
- `definition` / `formula`: ≤ 4000 chars when present.
- `owner_subject_id`: must exist in `authz_subject`.
- Transition to `blessed` requires `business_term` set on the row (otherwise 422 "business_term required for bless").
- Transition reuses input status validator + executes the bless-field rule server-side (no client trust).

Audit (`logAdminAction`):
- `tier_a_business_term_update` on PATCH (with diff details optional)
- `tier_a_business_term_transition_<new_status>` on transition
- `actor_type='human'`

## UI

`apps/authz-dashboard/src/components/BusinessTermsTab.tsx`:
- Header: "Business Terms" + reload button
- Filter row: status pills (Draft / Under review / Blessed / Deprecated / All)
- Table columns: resource_id (mono) / term / definition (truncated) / status badge / owner / blessed_at / actions
- Row actions: Edit (opens modal) + transition buttons (next-state suggestions per current status; deprecated row only shows "Restore to draft")
- Edit modal: term + definition (textarea) + formula (textarea) + owner_subject_id (text input, future autocomplete)
- Empty state with hint pointing to "no semantic-layer rows yet — create draft via SQL or via Discover Tab" (Discover Tab integration is v2)

Layout integration:
- Add `'business-terms'` to TabId union
- Add to **Govern** section (admin-only, `g b` shortcut)
- Add to App.tsx `adminTabs` array

## Authz model

- Pure admin (`ADMIN` / `AUTHZ_ADMIN`). No row-level scoping — all admins see all rows.
- SYSADMIN bypass (per V066) handled by `requireRole`.
- Editing other users' owned terms is allowed for admins (this is curator workflow, not personal sandbox).

## Acceptance Criteria

- AC-1: Empty `business-term` tab loads (no rows yet) with empty state.
- AC-2: Adam edits 1 row's `business_term`, definition, formula via modal → PATCH → row reloads with new values.
- AC-3: Adam transitions a row draft → under_review → blessed; blessed_at/blessed_by populated automatically; partial unique index prevents duplicate blessed term name.
- AC-4: Adam transitions blessed → deprecated; blessed_at/blessed_by preserved (audit history).
- AC-5: Non-admin user gets 403 on all `/api/business-term/*` routes.
- AC-6: Audit log has `tier_a_business_term_*` rows for create/update/transition.
- AC-7: tsc clean both services.
- AC-8: Browser round-trip — caveat-acknowledged per `feedback_ui_verification` (component+hook+wire complete + tsc clean is sufficient for commit; Adam verifies in browser).

**Definition of done:** AC-1..AC-7 pass on smoke test. AC-8 caveat noted in commit body.

## Caveats / Notes

- **Not a migration** — V044 is sufficient. If we discover a missing column later, that's a follow-up.
- **No PATCH on resource_id** (resource_id is identity).
- **Transition endpoint is the only path that touches `status / blessed_at / blessed_by`** to keep V044 invariants centralized.
- **`owner_subject_id` autocomplete deferred** to v2 (free-text + FK validation in v1).
- **Discover Tab integration deferred** — Curator clicks "promote to semantic layer" from Discover row in a future sprint.
- **`formula` safety:** Grep confirmed zero consumer code as of 2026-04-29 (`services/authz-api/src/`, `apps/authz-dashboard/src/` both empty for `formula`; only V044 own definition in `database/`). `formula` is presently descriptive-only metadata — V044 §6 comment says "Resolved server-side; not trusted input" but no resolver exists yet. **If an executor is later added (CTE materializer / dynamic SQL / view generator), this admin tab becomes a sensitive surface** and needs hardening: SQL keyword rejection, allowlist syntax, or v2 admin-double-confirm. Until then, free-text edit is acceptable. Commit body must call this out.
- **AI scope honesty:** This is the 4th Tier A primitive worked in a single session (HELP-TEXT / SAVED-VIEW / FEEDBACK incl. INBOX-FU / now BIZ-TERM-V01). Pure-additive momentum is real but Adam's review queue is finite — surfacing for visibility, not asking permission.
- **`blessed_by` canonicalization:** Server canonicalizes `X-User-Id: sys_admin` → `blessed_by: 'user:sys_admin'` because `authz_resource.blessed_by` FKs to `authz_subject.subject_id` which uses the `user:`-prefixed canonical form (per `_authz_resolve_roles`). If userId already contains `:` it's passed through unchanged. Smoke test asserts this behavior.

## Status

| Date | Status | Note |
|------|--------|------|
| 2026-04-29 | DRAFT | Initial plan |
| 2026-04-29 | DONE | API + UI + smoke (12/12 pass) shipped. AC-1..AC-7 ✅; AC-8 caveat per `feedback_ui_verification` (Adam to verify in browser). Dev-server tsx-watch reload was unreliable on Windows during smoke validation — used a temp instance on port 13099; user may need to restart the long-running dev server to pick up the new routes. |

## Handoff Log

| Date | From → To | Status | Note |
|------|-----------|--------|------|
| 2026-04-29 | Adam | DRAFT | Initial draft based on roadmap §3.4 gate-prep framing |
