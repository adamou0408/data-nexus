#!/bin/bash
set -e

# ============================================================
# Phison Data Nexus — Database Initialization
# Creates two databases:
#   nexus_authz — AuthZ policy store (authz_* tables, PG functions)
#   nexus_data  — Business data (lot_status, sales_order, RLS)
# ============================================================

# ─── 1. Create nexus_data database ───
echo "Creating nexus_data database..."
psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT 1 FROM pg_database WHERE datname='nexus_data'" | grep -q 1 \
  || psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "CREATE DATABASE nexus_data OWNER $POSTGRES_USER;"

# ─── 2. Run authz migrations (nexus_authz) ───
echo "Running authz migrations on nexus_authz..."
for f in /docker-entrypoint-initdb.d/migrations/V*.sql; do
    if [ -f "$f" ]; then
        echo "  Applying $(basename $f)..."
        psql -U "$POSTGRES_USER" -d nexus_authz -f "$f"
    fi
done

# ─── 3. Run data migrations (nexus_data) ───
echo "Running data migrations on nexus_data..."
for f in /docker-entrypoint-initdb.d/migrations/data/V*.sql; do
    if [ -f "$f" ]; then
        echo "  Applying $(basename $f) to nexus_data..."
        psql -U "$POSTGRES_USER" -d nexus_data -f "$f"
    fi
done

# ─── 4. Seed authz data ───
echo "Seeding authz data..."
for f in /docker-entrypoint-initdb.d/seed/*.sql; do
    if [ -f "$f" ]; then
        echo "  Seeding $(basename $f)..."
        psql -U "$POSTGRES_USER" -d nexus_authz -f "$f"
    fi
done

# ─── 5. Seed business data ───
echo "Seeding business data..."
for f in /docker-entrypoint-initdb.d/seed/data/*.sql; do
    if [ -f "$f" ]; then
        echo "  Seeding $(basename $f) into nexus_data..."
        psql -U "$POSTGRES_USER" -d nexus_data -f "$f"
    fi
done

echo "Database initialization complete (nexus_authz + nexus_data)."
