# Phison Data Nexus — Progress Tracker

> Last updated: 2026-04-12

## Milestone 1: AuthZ Runs Locally — DONE (2026-04-11)

- [x] Docker Compose (PG 16 + Redis 7)
- [x] DB migrations V001-V016
- [x] `authz_resolve()`, `authz_check()`, `authz_filter()` PG functions
- [x] Dev seed data (PE_SSD, SALES_TW, BI_USER, SYS_ADMIN)
- [x] `make verify` passes
- [x] Makefile dev workflow

## Milestone 2: First Page Is Permission-Aware — IN PROGRESS

- [x] Express API service (`services/authz-api`, port 3001)
  - Routes: resolve, check, filter, browse, matrix, pool, rls-simulate
- [x] React dashboard (`apps/authz-dashboard`, port 5173)
  - Tabs: Resolve, Check, Browser, Matrix, Pool, RLS Simulator, Audit Log
- [x] SSOT-driven pool denied_columns (V015)
- [x] L2 column masks + L0 column deny in RLS Simulator
- [ ] RLS filters data on actual workbench page (not just simulator)
- [ ] Column masking applied in real query results

## Milestone 3: All Three Paths Enforced — NOT STARTED

- [ ] Path B Express middleware wired to real routes
- [ ] Path C pgbouncer pool profiles + `authz_sync_db_grants()`
- [ ] Audit logging on all enforcement points
- [ ] AuthZ Admin basic CRUD pages

## Milestone 4: Production-Ready — NOT STARTED

- [ ] Redis L1 cache layer
- [ ] Helm chart + K8s deployment
- [ ] Policy Simulator + Impact Analysis
- [ ] LDAP sync
