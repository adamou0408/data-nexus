# M4 Keycloak SSO — Sub-plan

- **Owner:** authz-api (additive code) + Adam (LDAP bind, password set)
- **Status:** S1 additive scaffolding ✅ 2026-04-29 · S2 LDAP federation ✅ Adam-set 2026-04-29 · S3 dashboard wiring ✅ 2026-04-29 · S4 partial: local `adam_ou` retired in favor of LDAP-federated entry (歐瀝元) ✅ 2026-04-29 · `sys_admin` user removed via V083 realm sync ✅ 2026-04-29 · `tsai_bi` retained as V083 BI_USER test fixture (no longer S4 cleanup target) · remaining S4 (`X-User-Id` smoke-script migration, `extractUser` fallback removal) 🔴 gated on full e2e login proof
- **Linked from:** [`m4-prod-ready-tracker.md`](m4-prod-ready-tracker.md) item #3 · runbook [`docs/keycloak-setup.md`](../../../docs/keycloak-setup.md)
- **Hard gate:** M4 prod-ready (G1, 2026-09)
- **Blast radius:** 57 `X-User-Id` occurrences across 33 files; ~12 smoke scripts depending on now-V083 fixtures (`auth_admin_test` / `steward_test` / `tsai_bi` / `etl_pipeline`)

---

## Why a sub-plan

CLAUDE.md anti-phase rule says "most work is pure-additive." Keycloak SSO is
the exception: it crosses identity, audit, smoke tests, and the constitution's
authz_subject protection. A sub-plan exists so the destructive cleanup (Stage 4)
is gated on additive proof (Stage 1–3), not bundled into one big PR.

## Stages

### S1 — Additive scaffolding ✅ done 2026-04-29

- Keycloak realm `data-nexus` on `http://192.168.40.60:8080`
- Clients: `authz-dashboard` (public PKCE) + `authz-api` (bearer-only)
- Realm roles: SYSADMIN, ADMIN, AUTHZ_ADMIN, BI_USER, ETL_SVC
- User: `adam_ou` (SYSADMIN, no credential — Adam sets via UI)
- `.env.example`: JWT_ISSUER / JWT_AUDIENCE / JWT_JWKS_URI templated for backend; VITE_KEYCLOAK_* for dashboard
- Backend already 90% Keycloak-ready: `services/authz-api/src/middleware/jwt.ts` decodes RS256 JWTs with JWKS caching, falls back to `X-User-Id` when `JWT_ISSUER` unset

**No destructive changes.** No DB rows, no LDIF, no removed routes. Reverting is `DELETE /admin/realms/data-nexus` + unset env var.

### S2 — LDAP federation 🟡 Adam-driven

Bind credentials are secret → must be entered via Keycloak Admin Console UI by
Adam. Sandbox correctly blocks me from reading edgepolicy realm config. Two
sub-decisions:

| # | Decision | Default | Rationale |
|---|----------|---------|-----------|
| 1 | Federate corporate LDAP (same as edgepolicy) **vs.** local docker OpenLDAP | corporate (matches user request "reference edgepolicy") | Required for "real users only, mock removed" goal |
| 2 | Sync mode | READ_ONLY · sync registrations OFF | Data Nexus does not own corporate identity |

Outcome of S2: `adam_ou` (and any other federated user) can browser-login at
`http://192.168.40.60:8080/realms/data-nexus/account` and obtain tokens.

### S3 — Dashboard frontend wiring ✅ done 2026-04-29

Deliverable D2 implemented:

- `apps/authz-dashboard/src/lib/keycloak.ts` — SPA helper (PKCE S256, auto-refresh, profile from token claims)
- `src/main.tsx` — async bootstrap awaits `initKeycloak()` so unauthenticated users redirect to Keycloak login before React mounts
- `src/api.ts` — Bearer-first; `X-User-Id` fallback retained for dev when env vars unset
- `src/AuthzContext.tsx` — auto-login from `tokenParsed.preferred_username` + `realm_access.roles` + `groups`; logout routes through `keycloak.logout()`
- `src/vite-env.d.ts` — VITE_* typings

`tsc -b && vite build` clean. Smoke: `cd apps/authz-dashboard && npm run dev`,
visit `localhost:13173/` → bounces to Keycloak login → returns with Bearer
token attached to all `/api/*` calls.

### S4 — Destructive cleanup 🔴 gated on S2 + S3 proof

Only execute *after* adam_ou e2e login proven via S3 dashboard:

- ~~Remove dev-seed mock-user rows~~ — superseded by V083 (2026-04-29):
  `auth_admin_test` / `steward_test` / `tsai_bi` / `etl_pipeline` are now the
  active 4-role test fixtures. `sys_admin` was deleted from Keycloak during
  V083 sync. No further dev-seed cleanup needed.
- Remove `deploy/ldap/seed/02-people.ldif` + `03-groups.ldif` (or repurpose
  to point at corporate LDAP, depending on S2 decision)
- Replace `X-User-Id: sys_admin` in smoke scripts with token-bearing flow
  (substitute the V083 test users where role-specific fixtures are needed)
- Remove `extractUser` `X-User-Id` fallback in `services/authz-api/src/middleware/authz.ts`

**Constitutional consent required:** `docs/constitution.md` §1 protects
`authz_subject` rows. S4 needs explicit "yes please remove these 4 rows" turn
from Adam.

## Acceptance criteria

- **S1:** ✅ realm responds to `/realms/data-nexus/.well-known/openid-configuration`; backend boots with `JWT_ISSUER` set without errors
- **S2:** Adam logs in at `/realms/data-nexus/account` with corporate creds; users sync visible in admin console
- **S3:** Dashboard renders Keycloak login button; after login, `whoami` returns adam_ou's token claims; `X-User-Id` fallback still works when env vars unset
- **S4:** V083 retired the mock-user removal scope; remaining: smoke scripts migrated to token flow; `extractUser` fallback removed; `grep -r "X-User-Id" services/ | wc -l` = 0

## Rollback per stage

| Stage | Rollback |
|-------|----------|
| S1 | `DELETE /admin/realms/data-nexus` + revert `.env.example` |
| S2 | Disable LDAP provider in Keycloak admin UI |
| S3 | Unset `VITE_KEYCLOAK_*` env → dashboard skips Keycloak init |
| S4 | Re-run `make seed` (mock users restored) — **only if S4 PR is single commit** |

## Risk notes

- Shared Keycloak instance with edgepolicy: realm scoping isolates us, but
  admin/admin creds are universal. Don't run destructive admin API calls
  without realm filter.
- 57 `X-User-Id` call sites: don't bulk-rewrite. JWT path is additive — both
  modes coexist until S4.
- adam_ou subject_id mismatch: Keycloak `preferred_username='adam_ou'` but
  `authz_subject.subject_id='user:adam_ou'`. Confirmed concern but not
  blocking S1 (token decode works); resolution lives in S3 wiring (either
  prefix in `extractUser` or in `authz_check` SQL).

## Timeline target

- S1: ✅ 2026-04-29
- S2: Adam-paced (1 evening of UI clicks once corporate LDAP creds in hand)
- S3: 1–2 dev sessions
- S4: 1 dev session, separate turn from S3
- Buffer to G1 (2026-09): ~4 months, well within budget
