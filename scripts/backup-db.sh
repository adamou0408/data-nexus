#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# scripts/backup-db.sh
# Dump nexus_authz + nexus_data to host's backups/ directory.
# Uses pg_dump custom format (-Fc) — TimescaleDB 2.x compatible.
# Retains last N (default 7) per database.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
RETAIN_COUNT="${BACKUP_RETAIN_COUNT:-7}"
DBS=(nexus_authz nexus_data)

COMPOSE=(docker compose -f "$ROOT_DIR/deploy/docker-compose/docker-compose.yml")

mkdir -p "$BACKUP_DIR"

# Sanity: container running?
if ! "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx postgres; then
  echo "✗ postgres container not running. Start with 'make up' first." >&2
  exit 1
fi

for DB in "${DBS[@]}"; do
  OUT="$BACKUP_DIR/${DB}-${TIMESTAMP}.dump"
  echo "→ Dumping $DB → $(basename "$OUT")"
  "${COMPOSE[@]}" exec -T postgres pg_dump -U nexus_admin -Fc -d "$DB" > "$OUT"
  SIZE="$(du -h "$OUT" | cut -f1)"
  echo "  ✓ $SIZE"
done

# Retain last N per DB (sort by mtime, drop the rest)
for DB in "${DBS[@]}"; do
  # shellcheck disable=SC2012
  ls -1t "$BACKUP_DIR/${DB}-"*.dump 2>/dev/null | tail -n +$((RETAIN_COUNT + 1)) | while read -r OLD; do
    rm -v "$OLD"
  done
done

echo "✓ Backup complete (retained last $RETAIN_COUNT per DB in $BACKUP_DIR)"
