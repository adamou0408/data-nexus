# Production Deployment Checklist

**Scope:** Phison Data Nexus services going live to a non-dev environment.
**Owner:** SRE + DBA, signed off by Adam Ou.
**Linked from:** `docs/backlog-tech-debt.md` SEC-06, `.claude/plans/v3-phase-1/m4-prod-ready-tracker.md`.

This list is the gate between "works on docker-compose" and "live for end users." Every item must be ticked before flipping DNS / opening LDAP to real users.

---

## 1. Secrets & Encryption (SEC-06)

- [ ] **`ENCRYPTION_KEY`** set to a unique 64-char hex value per environment.
  Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
  Stored in: K8s Secret / Vault, **never** in git. Without this, `crypto.ts:getKey()` will throw at boot when `NODE_ENV=production`.
- [ ] **`DB_PASSWORD`** rotated off `nexus_dev_password`. AuthZ store user (`nexus_admin`) repointed to the new credential.
- [ ] **`LDAP_BIND_PASSWORD`** rotated off `nexus_ldap_dev`. Identity-sync service can bind successfully against prod LDAP with the new value.
- [ ] **`PG_PASSWORD`** for identity-sync set; matches the AuthZ store credential the sync writes through.
- [ ] **PgBouncer userlist** (`deploy/docker-compose/pgbouncer/userlist.txt` or its prod equivalent) holds MD5 hashes, not plaintext (SEC-06c, deferred — track separately when migrating off compose).
- [ ] `.env` files **not** present in image layers. Confirm with `docker history` or `helm template | grep -i password`.
- [ ] No secret values present in git history (`git log -p` audit), or rotated if present.

## 2. Database

- [ ] PostgreSQL 16 + TimescaleDB extension installed and version-pinned.
- [ ] Both `nexus_authz` and `nexus_data` databases exist (ARCH-01 split). `make verify` passes against the cluster.
- [ ] All migrations applied in order. `database/migrations/V001..V0xx` and `database/migrations/data/V001..V00x` reach HEAD.
- [ ] Path C native PG roles created with non-default passwords (`nexus_pe_ro`, `nexus_sales_ro`, `nexus_bi_ro`, `nexus_etl_rw`, `nexus_admin_full`). V019 dev passwords (`dev_pe_pass` etc.) rotated.
- [ ] Backup/restore drill executed against `nexus_authz` and `nexus_data` (separate dumps; cross-DB references are app-layer only).
- [ ] `authz_audit_log` retention policy decided and enforced (currently append-only forever per master plan §2.6 — confirm storage budget).

## 3. AuthN / AuthZ Wiring

- [ ] Keycloak (or chosen OIDC provider) realm provisioned. JWT issuer, audience, JWKS URI configured via env.
- [ ] `optionalJWT` middleware actually enforcing in prod (i.e., `JWT_ISSUER` set). Header-based `X-User-Id` dev fallback rejected for non-loopback requests.
- [ ] LDAP CronJob scheduled for identity-sync; first run reconciled cleanly with no orphan subjects.
- [ ] `authz_resolve()` smoke test for at least one ADMIN, one PE, one Sales, one BI user — output matches expected L0-L3 grid.

## 4. Service Boot & Health

- [ ] `services/authz-api` boots with `NODE_ENV=production`. `validateProductionEnv()` and `verifyCryptoKey()` both log success.
- [ ] `/healthz` returns 200 from outside the cluster.
- [ ] `services/identity-sync` ran at least one full LDAP → DB sync against the prod directory; `authz_subject` row count matches LDAP head count ± expected delta.
- [ ] PgBouncer reachable on its prod port; the 5 Path C role connection strings tested via `scripts/verify-path-c.sh` (override `DB_HOST` / `DB_PORT` / `PGBOUNCER_PORT`).
- [ ] Redis (cache) reachable; eviction policy + max memory set; first cache hit observed in logs.

## 5. Observability

- [ ] Audit log shipper (Fluent Bit / Vector) tailing `authz_audit_log` writes to the central log store.
- [ ] Application logs captured (stdout) — no secrets in log lines (grep for `password=`, `ENCRYPTION_KEY`, `Bearer `).
- [ ] Metrics endpoint exposed if Prometheus scraping is in scope; dashboard imported (Grafana board pending — track in m4 SRE work).
- [ ] Alert on: 5xx spike, deny-rate spike, identity-sync failure, `authz_audit_log` write lag.

## 6. Data Source Connections

- [ ] Every row in `authz_data_source` has `connector_password` re-encrypted under the **prod** `ENCRYPTION_KEY` (not the dev fallback). Verified by `verifyCryptoKey()` self-check + a manual `decrypt()` of one row.
- [ ] Network egress allow-listed for each remote DB host listed in `authz_data_source`.
- [ ] Read-only roles on remote DBs created and tested before any pool sync runs.

## 7. Final Pre-Flight

- [ ] `make verify` and `make verify-path-c` both green against the prod cluster (with appropriate env overrides).
- [ ] Rollback plan written in `.claude/plans/v3-phase-1/m4-go-live-runbook.md` and reviewed by SRE.
- [ ] On-call rotation defined; pager / Slack channel mapped.
- [ ] Adam (or delegated approver) signs the cutover ticket.

---

## Appendix — Where the secrets live in code

| Secret | Code location | Default (dev only) |
|--------|---------------|-------------------|
| `ENCRYPTION_KEY` | `services/authz-api/src/lib/crypto.ts` `getKey()` | deterministic hex (throws in prod) |
| `DB_PASSWORD` | `services/authz-api/src/db.ts:14` | `nexus_dev_password` |
| `LDAP_BIND_PASSWORD` | `services/identity-sync/src/ldap-sync.ts:12` | `nexus_ldap_dev` |
| `PG_PASSWORD` | `services/identity-sync/src/ldap-sync.ts:22` | `nexus_dev_password` |
| Path C role passwords | `database/migrations/V019__path_c_native_rls.sql` | `dev_*_pass` |
| PgBouncer auth | `deploy/docker-compose/pgbouncer/userlist.txt` | plaintext (SEC-06c) |

Update this table whenever a new secret is introduced anywhere in the stack.
