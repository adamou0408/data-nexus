# Keycloak SSO Setup — Data Nexus

> **Status:** additive scaffolding complete 2026-04-29 · LDAP federation + dashboard wiring pending
> **Realm:** `data-nexus` on `http://192.168.40.60:8080`
> **Linked from:** [`.claude/plans/v3-phase-1/m4-keycloak-sso-plan.md`](../.claude/plans/v3-phase-1/m4-keycloak-sso-plan.md) · [`m4-prod-ready-tracker.md`](../.claude/plans/v3-phase-1/m4-prod-ready-tracker.md) item #3

This runbook documents the Keycloak realm scaffolding for Data Nexus and the
manual steps required to finish wiring (LDAP bind, dashboard frontend, token
proof). The scaffolding itself was created via Keycloak admin API on 2026-04-29.

---

## What was already created (2026-04-29)

| Object | Identifier | Purpose |
|--------|-----------|---------|
| Realm | `data-nexus` | Phison Data Nexus user pool |
| Client | `authz-dashboard` | Public SPA, PKCE S256, redirect to `localhost:13173/*`. Includes `audience-authz-api` and `groups` protocol mappers. |
| Client | `authz-api` | Bearer-only resource server (token-validation target) |
| Realm roles | `SYSADMIN`, `ADMIN`, `AUTHZ_ADMIN`, `BI_USER`, `ETL_SVC` | Mirror `authz_role.role_id` rows |
| LDAP federation | `825c766f-…` (corporate AD) | Read-only user federation; ~3000 users imported via fullSync |
| User | `adam_ou` (LDAP-federated, SYSADMIN) | Real corporate identity (歐瀝元, adam_ou@phison.com); password validated against AD |

Dev backend env vars are now templated in `.env.example` (block "JWT/OIDC").

---

## Step 1 — Login (no password setup needed)

`adam_ou` is now a **LDAP-federated** user (corporate AD identity, post-2026-04-29
migration: local placeholder deleted → fullSync imported the real LDAP entry).

- Username: `adam_ou`
- Email: `adam_ou@phison.com` (from LDAP)
- Password: **corporate AD password** — never set in Keycloak, validated against
  LDAP every login
- Realm role: `SYSADMIN` (assigned to the federated user 2026-04-29)

To obtain a token via browser PKCE flow, just open the dashboard
(`http://localhost:13173/`) — it auto-redirects to Keycloak login.

For raw smoke tests via `password` grant, temporarily enable **Direct Access
Grants** on the `authz-dashboard` client, then:

```bash
curl -s -X POST http://192.168.40.60:8080/realms/data-nexus/protocol/openid-connect/token \
  -d "client_id=authz-dashboard" \
  -d "grant_type=password" \
  -d "username=adam_ou" \
  -d "password=<corporate-AD-password>" \
  -d "scope=openid"
```

Disable Direct Access Grants again once smoke testing finishes — production
flow is browser PKCE only.

## Step 2 — Wire authz-api JWT validation

The repo-root `.env` (gitignored) was created 2026-04-29 with the three JWT
vars already populated for the `data-nexus` realm:

```
JWT_ISSUER=http://192.168.40.60:8080/realms/data-nexus
JWT_AUDIENCE=authz-api
JWT_JWKS_URI=http://192.168.40.60:8080/realms/data-nexus/protocol/openid-connect/certs
```

Loading mechanism: `services/authz-api/package.json` `dev` script uses
`tsx watch --env-file-if-exists=../../.env` (Node 22+ native flag). No dotenv
package needed. Frontend (`apps/authz-dashboard/.env.local`) is read natively
by Vite.

Restart `authz-api` (`make dev-api` or `cd services/authz-api && npm run dev`).
The middleware (`services/authz-api/src/middleware/jwt.ts`) now validates
Bearer tokens via JWKS (RS256). The `X-User-Id` header fallback remains active
for smoke scripts that don't log in — backwards compatible.

Verify:

```bash
TOKEN=<paste from Step 1 curl response>
curl -H "Authorization: Bearer $TOKEN" http://localhost:13001/api/whoami
# Expect: 200 with subject derived from token claims
```

## Step 3 — LDAP federation (manual, requires bind credentials)

LDAP bind credentials are secret and must not pass through Claude. Configure
via the Keycloak Admin Console:

1. Open `http://192.168.40.60:8080/admin/master/console/#/data-nexus/user-federation`
2. Click **Add LDAP provider** → use the same connection settings as the
   `edgepolicy` realm (Phison corporate AD/LDAP)
3. Recommended values (mirror edgepolicy where possible):
   - **Vendor:** Active Directory (or OpenLDAP, depending on edgepolicy's choice)
   - **Connection URL:** (corporate LDAP URL — same as edgepolicy)
   - **Bind DN / Bind credential:** (corporate service account — same as edgepolicy)
   - **Users DN:** (same as edgepolicy)
   - **Username LDAP attribute:** `sAMAccountName` (AD) or `uid` (OpenLDAP)
   - **Edit mode:** READ_ONLY
   - **Sync registrations:** OFF
4. Save → **Synchronize all users**

After sync, configure **Mappers** → **group-ldap-mapper** so LDAP groups
appear as Keycloak groups (and flow into the `groups` claim via the
`authz-dashboard` protocol mapper).

> **Decision deferred:** whether to point at corporate LDAP (real Phison
> employees) or local docker OpenLDAP (`ldap://localhost:389`, current dev
> fixtures). The original task says "reference edgepolicy" → corporate LDAP.
> See sub-plan §3 for impact on `dev-seed.sql` mock users.

## Step 4 — Dashboard frontend wiring ✅ (2026-04-29)

Implemented. The dashboard now auto-redirects unauthenticated users to the
Keycloak login page when `VITE_KEYCLOAK_*` env vars are set in
`apps/authz-dashboard/.env.local`; falls back to the legacy X-User-Id user
picker when unset (preserves current dev workflow when Keycloak is offline).

Files:

- `apps/authz-dashboard/src/lib/keycloak.ts` — Keycloak SPA helper (init,
  PKCE S256, auto-refresh 30s before expiry, profile from token claims)
- `apps/authz-dashboard/src/main.tsx` — async bootstrap awaits
  `initKeycloak()` before `ReactDOM.render` so the redirect happens first
- `apps/authz-dashboard/src/api.ts` — Bearer-first auth header, X-User-Id
  fallback retained
- `apps/authz-dashboard/src/AuthzContext.tsx` — auto-login from
  `tokenParsed.preferred_username` + `realm_access.roles` + `groups` claim;
  logout routes through `keycloak.logout()` when SSO active
- `apps/authz-dashboard/src/vite-env.d.ts` — VITE_* env typings

Smoke test:

```bash
cd apps/authz-dashboard && npm run dev
# Open http://localhost:13173/ → should bounce to Keycloak login
# After successful login → dashboard renders, all API calls carry Bearer token
```

To temporarily disable SSO and use the legacy picker, comment out the
`VITE_KEYCLOAK_*` lines in `apps/authz-dashboard/.env.local` and restart Vite.

## Step 5 — Mock user cleanup (destructive — defer until Step 4 proven)

Once browser login flow works end-to-end for adam_ou, then cleanup:

- `database/seed/dev-seed.sql`: remove `user:sys_admin`, `user:tsai_bi`,
  `svc:etl_pipeline` rows (and dependent role/group rows)
- `deploy/ldap/seed/02-people.ldif` and `03-groups.ldif`: remove all entries
  (or remove the entire local OpenLDAP federation if going corporate-only)
- Smoke scripts: replace fixed `X-User-Id: sys_admin` with token-bearing flow

> **DO NOT** execute Step 5 in the same session as the additive scaffolding.
> Authz_subject rows are protected by `docs/constitution.md` §1; cleanup
> needs explicit consent in its own turn.

---

## Rollback

If anything in this scaffolding misbehaves:

```bash
# 1. Tear down realm (admin/admin against the master realm)
TOKEN=$(curl -s -X POST http://192.168.40.60:8080/realms/master/protocol/openid-connect/token \
  -d "grant_type=password&client_id=admin-cli&username=admin&password=admin" | jq -r .access_token)
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  http://192.168.40.60:8080/admin/realms/data-nexus

# 2. Unset JWT_ISSUER in services/authz-api/.env → middleware reverts to X-User-Id mode
# 3. No DB changes were made — authz_subject untouched
```

The realm is fully isolated from `edgepolicy` / `edgepolicy-test`; deletion
has zero impact on other Phison services sharing the same Keycloak instance.
