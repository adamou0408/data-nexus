#!/bin/bash
set -e

echo "Running migrations in order..."
for f in /docker-entrypoint-initdb.d/migrations/V*.sql; do
    if [ -f "$f" ]; then
        echo "  Applying $(basename $f)..."
        psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f "$f"
    fi
done

echo "Running seed data..."
for f in /docker-entrypoint-initdb.d/seed/*.sql; do
    if [ -f "$f" ]; then
        echo "  Seeding $(basename $f)..."
        psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f "$f"
    fi
done

echo "Database initialization complete."
