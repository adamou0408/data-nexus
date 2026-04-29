#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# scripts/restore-db.sh
# Restore a pg_dump (custom format) into nexus_authz or nexus_data.
# TimescaleDB-aware: uses timescaledb_pre_restore() / _post_restore().
#
# Usage: scripts/restore-db.sh <db_name> <dump_file>
#   ex:  scripts/restore-db.sh nexus_authz backups/nexus_authz-20260429-120000.dump
# ─────────────────────────────────────────────────────────────
set -euo pipefail

DB="${1:-}"
DUMP="${2:-}"

if [[ -z "$DB" || -z "$DUMP" ]]; then
  echo "Usage: $0 <db_name> <dump_file>" >&2
  echo "  db_name: nexus_authz | nexus_data" >&2
  exit 1
fi

if [[ ! -f "$DUMP" ]]; then
  echo "✗ Dump file not found: $DUMP" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE=(docker compose -f "$ROOT_DIR/deploy/docker-compose/docker-compose.yml")
PSQL_ADMIN=("${COMPOSE[@]}" exec -T postgres psql -U nexus_admin -d postgres)
PSQL_DB=("${COMPOSE[@]}" exec -T postgres psql -U nexus_admin -d "$DB")

if ! "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx postgres; then
  echo "✗ postgres container not running. Start with 'make up' first." >&2
  exit 1
fi

cat <<EOF
⚠️  About to RESTORE database '$DB' from:
    $DUMP

This will DROP and recreate '$DB'. All current data in that DB will be lost.
Press Enter to continue, Ctrl+C to abort.
EOF
read -r

echo "→ Dropping & recreating $DB"
"${PSQL_ADMIN[@]}" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"$DB\" WITH (FORCE);"
"${PSQL_ADMIN[@]}" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$DB\";"

echo "→ Pre-restore: install timescaledb + freeze hypertable mechanics"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -c "CREATE EXTENSION IF NOT EXISTS timescaledb;"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -c "SELECT timescaledb_pre_restore();"

echo "→ Restoring dump (this may take a while)"
"${COMPOSE[@]}" exec -T postgres pg_restore -U nexus_admin -d "$DB" --no-owner --no-acl < "$DUMP" || {
  echo "⚠️  pg_restore reported errors (often harmless: duplicate role/extension). Continuing post-restore."
}

echo "→ Post-restore: re-enable hypertable mechanics"
"${PSQL_DB[@]}" -v ON_ERROR_STOP=1 -c "SELECT timescaledb_post_restore();"

echo "✓ Restore complete: $DB"
