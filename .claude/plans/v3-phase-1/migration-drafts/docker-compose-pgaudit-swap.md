---
name: docker-compose pgaudit swap
description: Companion to V057 — base image swap to bundle pgaudit + pg_cron, plus shared_preload_libraries config
status: PROPOSED — needs Adam to apply (touches shared dev infra)
type: migration-notes
---

# docker-compose.yml swap for pgaudit + pg_cron (V057 prereq)

**Status:** PROPOSED. Executor session has NOT applied this — image swap forces every dev to `docker compose pull` ~1.5 GB and restart their local stack, so it needs Adam's go-ahead.

**Decision lineage:** 2026-04-27 Adam picked option A (`timescale/timescaledb-ha:pg16`) over custom Dockerfile / fluent-bit sidecar. See plan §AC-0.2.

---

## 1. Image swap

```diff
 services:
   postgres:
-    image: timescale/timescaledb:latest-pg16
+    image: timescale/timescaledb-ha:pg16
     environment:
       POSTGRES_DB: nexus_authz
       POSTGRES_USER: nexus_admin
       POSTGRES_PASSWORD: nexus_dev_password
     ports:
       - "15432:5432"
     volumes:
       - pgdata:/var/lib/postgresql/data
       - ../../database/migrations:/docker-entrypoint-initdb.d/migrations:ro
       - ../../database/seed:/docker-entrypoint-initdb.d/seed:ro
       - ./init-db.sh:/docker-entrypoint-initdb.d/00-init-db.sh:ro
       - ./pg_hba_custom.conf:/var/lib/postgresql/pg_hba.conf:ro
     command: [
       "postgres",
       "-c", "hba_file=/var/lib/postgresql/pg_hba.conf",
+      "-c", "shared_preload_libraries=timescaledb,pgaudit,pg_cron",
+      "-c", "cron.database_name=nexus_authz",
+      "-c", "pgaudit.log=read",
+      "-c", "pgaudit.log_catalog=off",
+      "-c", "pgaudit.log_relation=on",
+      "-c", "pgaudit.log_parameter=off",
+      "-c", "log_destination=csvlog",
+      "-c", "logging_collector=on",
+      "-c", "log_directory=/var/lib/postgresql/data/pg_log",
+      "-c", "log_filename=postgresql-%Y-%m-%d_%H%M%S.log",
+      "-c", "log_rotation_age=1h",
+      "-c", "log_rotation_size=0"
     ]
```

### Why each setting
- `shared_preload_libraries`: pgaudit + pg_cron must load at server start — both refuse to be loaded later.
- `cron.database_name`: pg_cron schedules live in this DB only; we keep it on `nexus_authz` next to authz_audit_log_path_c.
- `pgaudit.log=read`: capture SELECT and READ-class statements. Path C scope per plan §3.3 — we do not need WRITE/DDL audit (Path A/B already covers those).
- `pgaudit.log_relation=on`: emit one row per relation referenced (so 3-table joins → 3 audit rows). Required to get table-level granularity downstream.
- `pgaudit.log_parameter=off`: do NOT log bind parameters — they may contain PII / business identifiers (Adam to confirm if regulator demands it; otherwise off is the conservative default).
- `log_destination=csvlog` + `logging_collector=on`: PG writes structured CSV that V058 cron can `COPY FROM`. Plain `stderr` would force regex parsing.
- `log_rotation_age=1h`: hourly rotation gives the cron a clean "yesterday's file is final, parse it" boundary.

---

## 2. Apply order (no automation — human must run)

1. `cd deploy/docker-compose && docker compose down` *(stops postgres + pgbouncer + redis cleanly)*
2. Apply the diff above to `docker-compose.yml`.
3. `docker compose pull postgres` *(downloads ~1.5 GB; expect 5-15 min on slow networks)*
4. `docker compose up -d`
5. Wait for postgres healthcheck → green (`docker compose ps`).
6. Apply migration:
   ```bash
   docker exec -i docker-compose-postgres-1 psql -U nexus_admin -d nexus_authz \
     < .claude/plans/v3-phase-1/migration-drafts/V057__pgaudit_path_c.sql
   ```
7. Verify:
   ```bash
   docker exec docker-compose-postgres-1 psql -U nexus_admin -d nexus_authz \
     -c "SELECT extname, extversion FROM pg_extension WHERE extname IN ('pgaudit','pg_cron');"
   ```
   Both must appear with non-NULL version.
8. Tail csvlog to confirm pgaudit is emitting:
   ```bash
   docker exec docker-compose-postgres-1 ls -la /var/lib/postgresql/data/pg_log/
   ```
9. After verification, **promote** `V057__pgaudit_path_c.sql` to `database/migrations/` and commit.

---

## 3. Risks / known gotchas

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| pgdata volume reuse — old PG cluster files might not load on `-ha` image variant | Low (same major version pg16) | If startup fails, `docker compose down -v` resets the volume; data is recreated from `migrations/` + `seed/` on next up |
| Other dev breaks: someone pulls master and `docker compose up` without re-pulling | Med | Surface in CHANGELOG / Slack at the time of merge; healthcheck failure will surface fast |
| pgaudit volume — `pgaudit.log=read` on a busy dev box can produce GB/day | Low (dev) → Med (prod) | Dev: log_rotation handles it. Prod: tune `log=read` to specific roles via `pgaudit.role`. Out of Phase 0 scope. |
| pg_cron blocks on `nexus_authz` only | Low | Acceptable — Path C audit lives here regardless |
| HA image quirks (init scripts, default user) | Low | TimescaleDB docs confirm POSTGRES_DB / POSTGRES_USER honored on `-ha` variant |

---

## 4. Rollback

```bash
docker compose down
# revert docker-compose.yml diff
docker compose up -d
docker exec ... psql -c "DROP TABLE authz_audit_log_path_c CASCADE; DROP EXTENSION pg_cron; DROP EXTENSION pgaudit;"
```

V058 ingest cron (when it lands) must be dropped first (`SELECT cron.unschedule(...)`).

---

## 5. Cross-link

- Plan: `permission-default-allow-pilot-plan.md` §AC-0.2 + §5 P0-G
- V057 SQL: `./V057__pgaudit_path_c.sql`
- V058 cron (next): not yet drafted — depends on V057 landing
