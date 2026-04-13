# ============================================================
# Phison Data Nexus — Makefile
# ============================================================

COMPOSE := docker compose -f deploy/docker-compose/docker-compose.yml
PSQL    := $(COMPOSE) exec -T postgres psql -U nexus_admin -d nexus_authz

COMPOSE_LDAP := docker compose -f deploy/docker-compose/docker-compose.yml -f deploy/docker-compose/docker-compose.ldap.yml
COMPOSE_METABASE := docker compose -f deploy/docker-compose/docker-compose.yml -f deploy/docker-compose/docker-compose.metabase.yml
COMPOSE_ALL := docker compose -f deploy/docker-compose/docker-compose.yml -f deploy/docker-compose/docker-compose.ldap.yml -f deploy/docker-compose/docker-compose.metabase.yml

.PHONY: help up down restart status logs \
        db-reset db-psql db-migrate db-seed db-shell \
        verify clean dev dev-api dev-ui \
        up-ldap down-ldap ldap-up ldap-down ldap-sync \
        metabase-up metabase-down up-all down-all clean-all

# ── Help ─────────────────────────────────────────────────────

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ── Docker Compose ───────────────────────────────────────────

up: ## Start all services (PG + Redis)
	$(COMPOSE) up -d
	@echo "Waiting for PostgreSQL..."
	@$(COMPOSE) exec -T postgres sh -c 'until pg_isready -U nexus_admin -d nexus_authz; do sleep 1; done'
	@echo "Ready."

down: ## Stop all services
	$(COMPOSE) down

restart: down up ## Restart all services

status: ## Show service status
	$(COMPOSE) ps

logs: ## Tail service logs (ctrl+c to stop)
	$(COMPOSE) logs -f

logs-pg: ## Tail PostgreSQL logs only
	$(COMPOSE) logs -f postgres

logs-redis: ## Tail Redis logs only
	$(COMPOSE) logs -f redis

# ── Database ─────────────────────────────────────────────────

db-psql: ## Open interactive psql session
	$(COMPOSE) exec postgres psql -U nexus_admin -d nexus_authz

db-shell: ## Open shell inside postgres container
	$(COMPOSE) exec postgres sh

db-migrate: ## Run all migration files manually
	@for f in database/migrations/V*.sql; do \
		echo "Applying $$(basename $$f)..."; \
		$(PSQL) -f /docker-entrypoint-initdb.d/migrations/$$(basename $$f); \
	done
	@echo "Migrations complete."

db-seed: ## Run dev seed data
	$(PSQL) -f /docker-entrypoint-initdb.d/seed/dev-seed.sql
	@echo "Seed data loaded."

db-reset: ## Destroy volume and recreate everything from scratch
	$(COMPOSE) down -v
	$(MAKE) up
	@echo "Database reset complete."

db-tables: ## List all authz tables
	@$(PSQL) -c "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'authz_%' ORDER BY 1;"

db-roles: ## List all authz roles
	@$(PSQL) -c "SELECT role_id, display_name, is_system FROM authz_role ORDER BY role_id;"

db-users: ## List all authz subjects
	@$(PSQL) -c "SELECT subject_id, subject_type, display_name FROM authz_subject ORDER BY subject_id;"

# ── Verification ─────────────────────────────────────────────

verify: ## Run Milestone 1 verification tests
	bash scripts/verify-milestone1.sh

verify-path-c: ## Run Path C verification (PG roles + RLS + pgbouncer)
	bash scripts/verify-path-c.sh

# ── Quick Queries (dev convenience) ──────────────────────────

db-sync-grants: ## Run authz_sync_db_grants() to sync PG roles/grants from SSOT
	@$(PSQL) -c "SELECT * FROM authz_sync_db_grants();"
	@echo "DB grants synced."

db-pgbouncer-config: ## Generate pgbouncer config from SSOT
	@$(PSQL) -c "SELECT authz_sync_pgbouncer_config('postgres', 5432, 'nexus_data');"

db-pathc-psql: ## Connect as a Path C role (usage: make db-pathc-psql ROLE=nexus_pe_ro PASS=dev_pe_pass)
	@PGPASSWORD=$(PASS) psql -h localhost -p 5432 -U $(ROLE) -d nexus_data

db-data-psql: ## Open interactive psql to nexus_data (business DB)
	$(COMPOSE) exec postgres psql -U nexus_admin -d nexus_data

logs-pgbouncer: ## Tail pgbouncer logs
	$(COMPOSE) logs -f pgbouncer

q-resolve: ## Resolve permissions for PE SSD user
	@$(PSQL) -c "SELECT jsonb_pretty(authz_resolve('test_pe_ssd', ARRAY['PE_SSD'], '{\"product_line\": \"SSD-Controller\"}'::jsonb));"

q-check: ## Run sample authz_check queries
	@echo "PE reads lot_tracking:"
	@$(PSQL) -c "SELECT authz_check('test_pe_ssd', ARRAY['PE_SSD'], 'read', 'module:mrp.lot_tracking');"
	@echo "PE reads unit_price (denied):"
	@$(PSQL) -c "SELECT authz_check('test_pe_ssd', ARRAY['PE_SSD'], 'read', 'column:lot_status.unit_price');"
	@echo "SALES reads unit_price:"
	@$(PSQL) -c "SELECT authz_check('test_sales', ARRAY['SALES_TW'], 'read', 'column:lot_status.unit_price');"

q-filter: ## Show RLS filter for PE SSD
	@$(PSQL) -c "SELECT authz_filter('test_pe_ssd', '{\"product_line\": \"SSD-Controller\"}'::jsonb, 'table:lot_status', 'A');"

q-web-acl: ## Resolve web ACL for admin
	@$(PSQL) -c "SELECT jsonb_pretty(authz_resolve_web_acl('sys_admin', ARRAY[]::TEXT[]));"

# ── Development Servers ──────────────────────────────────────

dev: up dev-api dev-ui ## Start everything (PG + Redis + API + UI)

dev-api: ## Start authz-api server (port 3001)
	cd services/authz-api && npm run dev

dev-ui: ## Start dashboard UI dev server (port 5173)
	cd apps/authz-dashboard && npm run dev

install: ## Install all npm dependencies
	cd services/authz-api && npm install
	cd services/identity-sync && npm install
	cd apps/authz-dashboard && npm install

# ── LDAP ─────────────────────────────────────────────────────

up-ldap: ## Start all services including LDAP
	$(COMPOSE_LDAP) up -d
	@echo "Waiting for PostgreSQL..."
	@$(COMPOSE_LDAP) exec -T postgres sh -c 'until pg_isready -U nexus_admin -d nexus_authz; do sleep 1; done'
	@echo "Waiting for OpenLDAP..."
	@$(COMPOSE_LDAP) exec -T openldap sh -c 'ldapsearch -x -H ldap://localhost -b "dc=phison,dc=com" -D "cn=admin,dc=phison,dc=com" -w nexus_ldap_dev "(objectClass=organization)" > /dev/null 2>&1'
	@echo "All services ready. phpLDAPadmin: http://localhost:8090"

down-ldap: ## Stop all services including LDAP
	$(COMPOSE_LDAP) down

ldap-up: ## Start only LDAP containers
	$(COMPOSE_LDAP) up -d openldap phpldapadmin
	@echo "OpenLDAP: ldap://localhost:389  |  phpLDAPadmin: http://localhost:8090"

ldap-down: ## Stop only LDAP containers
	$(COMPOSE_LDAP) stop openldap phpldapadmin

ldap-sync: ## Run LDAP → DB sync
	cd services/identity-sync && npx tsx src/ldap-sync.ts

ldap-search: ## Search LDAP directory (quick verify)
	$(COMPOSE_LDAP) exec openldap ldapsearch -x -H ldap://localhost -b "dc=phison,dc=com" -D "cn=admin,dc=phison,dc=com" -w nexus_ldap_dev "(objectClass=groupOfNames)" cn member

# ── Metabase BI ─────────────────────────────────────────────

metabase-up: ## Start Metabase BI (http://localhost:3100)
	$(COMPOSE_METABASE) up -d metabase
	@echo "Metabase starting at http://localhost:3100 (may take 1-2 min on first boot)"

metabase-down: ## Stop Metabase
	$(COMPOSE_METABASE) stop metabase

up-all: ## Start everything (PG + Redis + LDAP + Metabase)
	$(COMPOSE_ALL) up -d
	@echo "All services starting..."
	@echo "  Dashboard:    http://localhost:5173"
	@echo "  API:          http://localhost:3001"
	@echo "  Metabase:     http://localhost:3100"
	@echo "  phpLDAPadmin: http://localhost:8090"

down-all: ## Stop everything
	$(COMPOSE_ALL) down

# ── Cleanup ──────────────────────────────────────────────────

clean: ## Stop services and remove volumes
	$(COMPOSE) down -v
	@echo "Cleaned."

clean-ldap: ## Stop all services including LDAP and remove volumes
	$(COMPOSE_LDAP) down -v
	@echo "Cleaned (including LDAP volumes)."

clean-all: ## Stop ALL services and remove ALL volumes
	$(COMPOSE_ALL) down -v
	@echo "Cleaned (all services + volumes)."
