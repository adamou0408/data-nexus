# ============================================================
# Phison Data Nexus — Makefile
# ============================================================

COMPOSE := docker compose -f deploy/docker-compose/docker-compose.yml
PSQL    := $(COMPOSE) exec -T postgres psql -U nexus_admin -d nexus_authz

.PHONY: help up down restart status logs \
        db-reset db-psql db-migrate db-seed db-shell \
        verify clean dev dev-api dev-ui

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

# ── Quick Queries (dev convenience) ──────────────────────────

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
	cd apps/authz-dashboard && npm install

# ── Cleanup ──────────────────────────────────────────────────

clean: ## Stop services and remove volumes
	$(COMPOSE) down -v
	@echo "Cleaned."
