# Subdag Versioning — Design Note (R3)

> **Status:** Design exploration. **Not** a build plan.
> **Scope:** Schema/runtime options for handling subdag changes after parents have embedded them. Picks a near-term Phase A and parks Phase B until evidence demands it.
> **Author:** Adam (tech-lead self-sign per `feedback_tech_lead_governance`)
> **Date:** 2026-05-01

---

## 1. Why this doc exists

DAG-SUBDAG-EMBED-V01 (`.claude/plans/v3-phase-1/dag-subdag-embed-v01-plan.md`) shipped with publish-time inline expansion: when parent DAG **P** embeds child **C**, the publish step copies C's frozen `dag_snapshot` nodes into P's snapshot under prefixed IDs. The runtime never re-resolves C — P is fully self-contained.

This works today, but raises a follow-up question once subdags get adopted:

> **What happens when C is re-published with breaking changes? How do parent authors find out, and what should the system do?**

Today the answer is: **silently nothing**. P keeps running its old inlined copy. The system has no visibility into "P is on a stale C". This doc lays out the options.

We are deliberately **not** building anything from this doc yet — Phase 1 is pure-additive (`feedback_no_phase_anchor`) and subdags are still pre-adoption. The doc exists so when the first "wait, my subdag changed and my parent didn't update" support ticket lands, we already have the call made.

---

## 2. Current state (read-only summary)

Citations included so future-you can check claims without re-spelunking:

| Concern | Where it lives | Notes |
|---|---|---|
| Subdag node in author-time DAG | `services/authz-api/src/routes/dag.ts` POST `/save` | Nodes with `type:'subdag'` carry `data.resource_id = 'published_dag:dag:<child>'` |
| Publish-time inline expansion | `services/authz-api/src/lib/dag-subdag-resolver.ts` | Fetches child snapshot, prefixes node IDs, drops child sinks, demotes unselected `user_input_params` to `bound_params` |
| Frozen snapshot storage | `database/migrations/V086__dag_publish.sql` | `authz_ui_page.dag_snapshot` (JSONB), `authz_ui_page.embedded_subdags` (JSONB array of child RIDs) |
| Inverse lookup | `services/authz-api/src/routes/dag.ts` GET `/published/:rid/embedders` | Returns parent pages whose `dag_snapshot.embedded_subdags @> [rid]` |
| Authz transitive check | `dag-subdag-resolver.ts` | Parent's author needs `read` on `published_dag:<rid>` at publish time |
| Audit trail | `audit_log` table | DAG_PUBLISH actions record `context.embedded_subdag_rids` |
| Existing version field | `authz_resource.attributes.version` (int, client-managed) | Used by save/edit; **does not propagate to embed wiring** |

**What does NOT exist** (gap surface for this doc):

- No subdag-specific version column or history table.
- Parent → child reference always resolves to the live `published_dag:<rid>` at publish — no version pin.
- No "child changed since you embedded it" signal for parent authors.
- No drift query, no re-publish nudge UI.
- Re-publishing a child **does not** retroactively touch parents — they keep their inlined copy, and discover staleness only by manual re-publish + diff.

> **Quiet good news** — because parents inline the child at publish, "version drift" only matters for *parents that re-publish*. A parent that never republishes runs forever on its embedded copy. That's actually closer to "Option A: snapshot-at-publish" already, just without the visibility tooling.

---

## 3. The problem, framed

We have three actors, two operations, and one source of confusion.

**Actors:** child author (publishes C), parent author (embeds C in P, publishes P), runtime user (runs P).
**Operations:** publish-C, publish-P.
**Confusion:** "I (parent author) re-published P. Did I just pick up C's breaking change? Does my form still work? Did the column I bound to get renamed?"

**Three failure modes** the design has to cover:

1. **Silent breakage on re-publish** — parent re-publishes for an unrelated reason; child's renamed column silently changes form schema or SQL bindings. Parent ships broken.
2. **Stale-but-fine drift** — child fixed a bug. Parent doesn't know. Parent's users see the old buggy behavior indefinitely.
3. **Forced upgrade** — child author wants every parent to migrate (security, compliance). No mechanism today to nudge or enforce.

---

## 4. Options

### Option A — Snapshot-at-publish + drift visibility (recommended Phase A)

**What it is:** Keep the current "publish inlines child" model. Add a **drift signal**: parent stores a hash of the child snapshot it inlined; child's current snapshot hash is compared on demand; if different, parent's published page is flagged as "child has changed".

**Schema changes:** None required (hash can live inside existing `authz_ui_page.embedded_subdags` JSONB — change the array element shape from `<rid>` to `{rid, child_snapshot_hash}`).

**New endpoints:**
- `GET /published/:rid/drift` → for each `embedded_subdags[]` entry, compute current child hash, return `{rid, embedded_at_hash, current_hash, drifted: bool, child_updated_at}`.
- (Optional) `GET /drift/all-mine` → all pages I authored that have drift, for a curator dashboard badge.

**UI:**
- DagTab: subdag node Inspector shows a yellow "child has been updated since you published — re-publish to pick up changes" badge when drifted.
- Modules tree: page row shows a small dot if drift detected (mirrors fn-quality dots from FN-QUALITY-LINT-V02).

**Pros:**
- **Zero migration.** Hash field added to existing JSONB shape.
- **No new concepts.** "Re-publish to pick up changes" matches the mental model already used for child publish.
- **Inverse already there** — the embedders endpoint can be reused to spam "your children embed this stale copy" notifications to parents from a child publish event.

**Cons:**
- Doesn't let a parent author **pin** to a known-good past version. Once you re-publish, you get the latest C, period.
- No way to keep running an old C if the new C is broken (other than restoring from audit log).
- Hash comparison has to be deterministic — needs a canonical JSON serializer (or just hash `dag_snapshot::text` after `pg_jsonb_pretty`-style normalization).

**Maintenance cost:** Low. ~150 LoC backend, ~80 LoC frontend, no migration, no history table to vacuum.

### Option B — Per-publish version table + explicit pin

**What it is:** Every `dag_snapshot` publish writes to `authz_dag_snapshot_history(rid, version_number, snapshot, published_at, published_by)` (mirror of `authz_policy_version` from V006). Parent stores `{rid, pinned_version}` in its snapshot. Pinning a child means the parent always inlines that exact historical version, even if C has been re-published.

**Schema changes:**
- New table `authz_dag_snapshot_history` (~ same shape as `authz_policy_version`).
- `authz_ui_page.embedded_subdags[]` element shape becomes `{rid, version_number}`.

**New endpoints:**
- `GET /published/:rid/versions` — list versions of a child.
- `POST /published/:rid/pin-in/:parent` — flip a parent's embed from "live" to "pinned at vN".
- Plus the same drift visibility as Option A (now expressed as "you're pinned at v3, current is v5").

**UI:**
- Subdag Inspector: "Track latest" toggle vs. "Pin to vN" dropdown.
- Page detail: "Pinned: C v3 (current: v5) — review changes".

**Pros:**
- **Real version control.** Parent authors can stage upgrades. Old C stays runnable.
- **Audit-clean** — every snapshot survives, vs. today where re-publish overwrites.
- Mirrors `authz_policy_version` precedent — the team already understands this model.

**Cons:**
- Migration + history table + retention policy (vacuum old versions? all the way back to v1?).
- **UX surface explodes.** Two extra concepts (version, pin) per subdag. Parent authors must understand semver-style mental models. For Phase 1's small subdag user base, this is overbuild.
- Storage growth — every publish snapshots ~10–100 KB of JSONB. Only matters at scale, but worth noting.

**Maintenance cost:** Medium-high. Migration, history retention rules, pin-vs-live UI, version dropdowns.

### Option C — Inline `attributes.version` from existing `authz_resource`

**What it is:** Use the existing `authz_resource.attributes.version` integer (already incremented by client on save). Parent stores `{rid, version}` at embed time; resolver at parent re-publish refuses to inline if `version` mismatches without explicit upgrade.

**Why this looks tempting:** No new tables.

**Why it falls apart on inspection:**
- `attributes.version` tracks **author-time saves**, not publishes. C might be on `attributes.version = 47` but the published snapshot is from save #42. They are not the same axis.
- No history is kept; if you "pin to v42" but the saved DAG has moved on, there's no v42 snapshot to recover.
- Effectively reduces to Option A with a redundant integer.

**Maintenance cost:** Low (no schema change), but **buys nothing real** — discount.

### Option D — Do nothing, document the footgun

**What it is:** Leave the system as-is. Document in the DagTab help and DAG-SUBDAG-EMBED-V01 plan that re-publishing a parent picks up the latest child, period.

**Pros:** Zero work. No new code paths to break.
**Cons:** Every "why did my page break after re-publish?" support ticket is a manual reverse-engineering job.
**Maintenance cost:** Zero engineering, non-zero support cost as adoption grows.

---

## 5. Recommendation

**Go with Option A in Phase A.** Build B only if/when one of these triggers fires:

- ≥ 2 production subdag-embedding pages exist and a child has shipped a breaking change that broke a parent.
- A compliance/security requirement demands "old version must keep running until migrated by date X".
- Curator survey reports drift-anxiety as a top friction point.

**Reasoning** (against Adam's stated heuristic — user-friendly + low-maintenance):

- **User-friendly:** A drift badge + "re-publish to pick up changes" is one concept. Versions + pins is three concepts (version, pin, upgrade). For an audience that hasn't yet adopted subdags at scale, the simpler model is the kinder one.
- **Low-maintenance:** Option A is a hash field + one endpoint + one UI badge. Option B is a migration, a retention policy, two endpoints, two UI widgets, and an upgrade flow. ~5× the surface for value most users won't need.
- **Reversible:** Option A doesn't paint us into a corner. The hash-in-JSONB approach can be migrated to a real version_number later by reading the `published_at` timestamps and back-filling — or just by saying "v0 = whatever was inlined at the moment we turn on B".
- **Anti-phase anchor:** This is pure-additive. We don't need a Phase 1.5 or "subdag v2" gate. Ship A when there's first evidence of need, defer B until B's evidence arrives.

---

## 6. If we ship Option A — concrete shape

This section is reference for the eventual implementor. **Not a commit-ready spec.**

### 6.1 Snapshot hash

- Add helper in `dag-subdag-resolver.ts`: `hashSnapshot(snapshot: object): string` — canonical JSON (sorted keys) → SHA-256 hex (first 16 chars is plenty for collision avoidance at our scale).
- At parent publish, after inlining, write `embedded_subdags[i] = {rid, child_snapshot_hash}`.
- Backwards-compatible read: existing `embedded_subdags` arrays are bare strings; treat missing hash as `null` and surface as "drift unknown" in UI (not "drifted" — important distinction, mirrors fn-quality "no entry = no badge").

### 6.2 Drift endpoint

```
GET /api/dag/published/:parent_rid/drift
→ { embedded: [{rid, embedded_at_hash, current_hash, drifted, child_updated_at}] }
```

One DB roundtrip — `JOIN authz_ui_page child ON child.published_dag_id = embedded.rid`, compute hash of `child.dag_snapshot`. Cache opportunistically (snapshot rarely changes; hash is deterministic).

### 6.3 UI surface

- **Subdag Inspector panel** in DagTab: red exclamation icon on the resource_id dropdown when drifted; tooltip explains "child re-published since you embedded — re-publish to pick up changes".
- **Page row in Modules tree**: small amber dot (same dot as fn-quality, different color) when any embedded subdag is drifted. Click → opens the drift detail.
- **Curator dashboard tile** (deferred, only if drift becomes common): "Pages with drifted subdags: N" — uses `GET /drift/all-mine`.

### 6.4 Notification hook (deferred)

When child re-publishes, the route already records audit. Cheap follow-up: write a `notification` row for each parent author whose page embeds the child. **Skip until anyone asks.**

---

## 7. Open questions

- **Hash stability under JSONB key reorder.** PG's JSONB normalizes keys. Cast to `text` directly may differ across PG versions. Use a Node-side canonical serializer to stay version-agnostic — cheap.
- **Hash sensitivity to non-semantic changes.** Whitespace in a SQL string changes hash but not behavior. Acceptable false-positive rate? Yes for Phase A — better noisy than silently broken.
- **Drift across data_source_id changes.** Already prevented at publish (Fork D in V01 plan); no design action needed.
- **Cyclic embeds.** V01 plan (Fork F, ID prefixing) prevents publish-time cycles. Drift detection inherits this — no new exposure.
- **Authz on drift endpoint.** Should require `read` on parent page (same as snapshot-meta endpoint). Trivial.

---

## 8. Decision log entry (for plan-v3-phase-1.md once acted on)

> *Skeleton — fill in when this is actually picked up.*
>
> - **Option chosen:** A (snapshot-at-publish + drift visibility).
> - **Rejected:** B (deferred — overbuilds for current adoption); C (no real value); D (deferred default if A also doesn't ship).
> - **Trigger to revisit B:** [first concrete drift incident]
> - **Pages touched:** `dag-subdag-resolver.ts`, `dag.ts` routes, `DagTab.tsx`, `ModulesTab.tsx`.

---

## 9. References

- DAG-SUBDAG-EMBED-V01 plan: `.claude/plans/v3-phase-1/dag-subdag-embed-v01-plan.md`
- Subdag resolver: `services/authz-api/src/lib/dag-subdag-resolver.ts`
- DAG routes: `services/authz-api/src/routes/dag.ts`
- Publish migration: `database/migrations/V086__dag_publish.sql`
- Versioning prior art (policy): `database/migrations/V006__policy_version_table.sql`
- Smoke seed (for hashing test inputs later): `database/seed/_test_subdag_embed_smoke.sql`
