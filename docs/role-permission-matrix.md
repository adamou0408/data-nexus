# Role / Permission Matrix — Data Nexus

> **Status:** Active 2026-04-29
> **Implements:** V083 migration · Keycloak `data-nexus` realm roles · `apps/authz-dashboard` sidebar gate
> **Linked from:** [`CLAUDE.md`](../CLAUDE.md) `Where Things Live` · [`database/seed/dev-seed.sql`](../database/seed/dev-seed.sql) · [`apps/authz-dashboard/src/components/Layout.tsx`](../apps/authz-dashboard/src/components/Layout.tsx)

This is the **design SSOT** for Data Nexus role / sidebar / API gating. The
runtime SSOT is the database (`authz_role` + `authz_role_permission`) — this
document mirrors that for human review.

Roles align 1:1 with the sidebar information architecture
(Ingest → Catalog → Govern → Consume → Observe). Each role owns 1–2 stages with
no overlap, except `SYSADMIN` (god-mode) and the `Consume` stage (open to all
authenticated users).

---

## Roles (5)

| Role | 中文 | Owns | One-line |
|------|------|------|----------|
| `SYSADMIN` | 系統管理員 | All stages (god-mode) | Bootstrap / emergency override. Allow-side short-circuit (V066), explicit deny still wins. 1–2 holders. |
| `AUTHZ_ADMIN` | 權限治理員 | Govern (Subjects/Roles/Actions/Policies) + Audit (read+write) | Decides "who can log in / who sees what". Touches identity & policy. |
| `DATA_STEWARD` | 資料管家 | Ingest + Catalog + Curator (Business Terms / AI Providers / Feedback Inbox) + Audit (read-only) | Decides "how data is organized, what business terms mean". Touches catalog & curation. |
| `BI_USER` | BI 使用者 | Consume | Default authenticated user. Read modules / run queries / submit feedback / save views. |
| `ETL_SVC` | 服務帳號 | (no sidebar) | Pipeline write APIs only. No browser login. |

**Removed in V083:**
- `ADMIN` — ambiguous: split into `AUTHZ_ADMIN` (governance) + `DATA_STEWARD` (data ops)
- `DBA` — was dead role (group binding existed, no `authz_role_permission` rows)

---

## Sidebar Tab Matrix

Legend: ✅ R/W · 🟢 read-only · ❌ hidden · ⚡ god-mode auto

| Stage | Tab | SYSADMIN | AUTHZ_ADMIN | DATA_STEWARD | BI_USER | ETL_SVC |
|-------|-----|:--------:|:-----------:|:------------:|:-------:|:-------:|
| — | Overview | ⚡ | ✅ | ✅ | ✅ | ❌ |
| Ingest | Sources | ⚡ | ❌ | ✅ | ❌ | ❌ |
| Ingest | Discover | ⚡ | ❌ | ✅ | ❌ | ❌ |
| Catalog | Resources | ⚡ | 🟢 | ✅ | ❌ | ❌ |
| Catalog | Modules | ⚡ | 🟢 | ✅ | 🟢 | ❌ |
| Catalog | Raw Tables | ⚡ | ❌ | ✅ | ❌ | ❌ |
| Govern | Subjects | ⚡ | ✅ | ❌ | ❌ | ❌ |
| Govern | Roles | ⚡ | ✅ | ❌ | ❌ | ❌ |
| Govern | Actions | ⚡ | ✅ | ❌ | ❌ | ❌ |
| Govern | Policies | ⚡ | ✅ | ❌ | ❌ | ❌ |
| Govern | Business Terms | ⚡ | 🟢 | ✅ | 🟢 | ❌ |
| Govern | AI Providers | ⚡ | ❌ | ✅ | ❌ | ❌ |
| Consume | My Permissions | ⚡ | ✅ | ✅ | ✅ | ❌ |
| Consume | Data Explorer | ⚡ | ✅ | ✅ | ✅ | ❌ |
| Consume | Query Tool | ⚡ | ✅ | ✅ | ✅ | ❌ |
| Consume | Flow Composer | ⚡ | ✅ | ✅ | ✅ | ❌ |
| Consume | Metabase BI | ⚡ | ✅ | ✅ | ✅ | ❌ |
| Observe | Audit Log | ⚡ | ✅ | 🟢 | ❌ | ❌ |
| Observe | Feedback Inbox | ⚡ | ❌ | ✅ | ❌ | ❌ |

Frontend gate (`apps/authz-dashboard/src/components/Layout.tsx`) uses a
`requires?: 'authzAdmin' | 'steward' | 'admin'` flag per nav item:
- `'authzAdmin'` → SYSADMIN | AUTHZ_ADMIN (Govern: Subjects/Roles/Actions/Policies)
- `'steward'`    → SYSADMIN | DATA_STEWARD (Ingest, Catalog Raw Tables, AI Providers, Feedback Inbox, Sources, Discover)
- `'admin'`      → either of the above (Resources, Audit Log)
- (no flag)      → all authenticated users (Overview, Modules, Business Terms, Consume tabs)

`AuthzContext` exposes `isAuthzAdmin` / `isSteward` / `isAdmin` booleans.
SYSADMIN passes everything via the `is_sysadmin` sidecar from `authz_resolve()` (V066).

---

## Admin API Matrix

| API | SYSADMIN | AUTHZ_ADMIN | DATA_STEWARD | BI_USER | ETL_SVC |
|-----|:--------:|:-----------:|:------------:|:-------:|:-------:|
| `/api/resolve` `/api/check` `/api/filter` | ⚡ | ✅ | ✅ | ✅ | ✅ |
| `/api/matrix` (R/W permission matrix) | ⚡ | ✅ | ❌ | ❌ | ❌ |
| `/api/admin/audit-logs` | ⚡ | ✅ | 🟢 | ❌ | ❌ |
| `/api/admin/subjects` `/api/admin/roles` (CRUD) | ⚡ | ✅ | ❌ | ❌ | ❌ |
| `/api/admin/data-source` (CRUD) | ⚡ | ❌ | ✅ | ❌ | ❌ |
| `/api/admin/modules` `/api/admin/business-terms` | ⚡ | ❌ | ✅ | ❌ | ❌ |
| `/api/feedback` (submit) | ⚡ | ✅ | ✅ | ✅ | ❌ |
| `/api/feedback/inbox` (curator triage) | ⚡ | ❌ | ✅ | ❌ | ❌ |
| `/api/etl/*` (pipeline write) | ⚡ | ❌ | ❌ | ❌ | ✅ |

---

## Test Users (Keycloak `data-nexus` realm)

For dev-time role validation. Local Keycloak users (no LDAP federation),
all share dev-only password — see password manager / `scripts/reset-keycloak-test-creds.ps1`.
**Never reuse this password outside dev.**

| Username | Realm Roles | `authz_subject` row | Validates |
|----------|-------------|---------------------|-----------|
| `adam_ou` (LDAP-federated) | `SYSADMIN` | `user:adam_ou` | god-mode (sidebar all visible) |
| `auth_admin_test` | `AUTHZ_ADMIN` | `user:auth_admin_test` | Govern (Subjects/Roles/Actions/Policies) + Audit visible; Ingest/Catalog/Curator hidden |
| `steward_test` | `DATA_STEWARD` | `user:steward_test` | Ingest + Catalog + Business Terms + AI Providers + Feedback Inbox visible; Govern hidden |
| `tsai_bi` | `BI_USER` | `user:tsai_bi` | Only Consume + Overview + Modules visible |
| `etl_pipeline` | `ETL_SVC` | `svc:etl_pipeline` | No sidebar (service account; backend write API only) |

---

## Change Procedure

1. Edit this document (the design).
2. Write a new migration `V0XX__role_permissions_<slug>.sql` mirroring the diff (e.g., V083 for the 2026-04-29 5-role consolidation).
3. Update `database/seed/dev-seed.sql` so dev re-init matches.
4. Update `apps/authz-dashboard/src/components/Layout.tsx` if sidebar gating changes.
5. Update Keycloak realm via admin API (or document manual steps).
6. Run typecheck + Vite build smoke.
7. Verify each test user reaches the expected matrix above.

Roles must remain ≤6 in count. If a 7th is proposed, first attempt to merge
with an existing role; YAGNI > granularity until a real workflow demands it.
