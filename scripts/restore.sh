#!/bin/bash
# School Management Platform — database restore
# Usage:
#   scripts/restore.sh backups/school-YYYYMMDD-HHMM.sql.gz
#
# What it does (Docker setup):
#   1. stops the api container (so it releases pooled connections),
#   2. drops + recreates the database,
#   3. restores the dump,
#   4. restarts the api container (migrations run on boot).
# WARNING: this DESTROYS the current database. The backup file itself is
# never modified. If the dump is from another server, make sure the target
# server has the SAME PHONE_ENC_KEY — encrypted parent phone numbers only
# decrypt under the key that encrypted them.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -ne 1 ]; then
  echo "Usage: $0 backups/school-YYYYMMDD-HHMM.sql.gz" >&2
  exit 1
fi
DUMP="$1"
[ -f "$DUMP" ] || { echo "ERROR: file not found: $DUMP" >&2; exit 1; }

if [ -f .env ]; then set -a; . ./.env; set +a; fi
DB_USER="${POSTGRES_USER:-school}"
DB_NAME="${POSTGRES_DB:-school}"

read -r -p "This will DESTROY the current '$DB_NAME' database and restore from $DUMP. Type YES to continue: " CONFIRM
[ "$CONFIRM" = "YES" ] || { echo "Aborted."; exit 1; }

echo "[restore] stopping api..."
docker compose stop api

echo "[restore] recreating database $DB_NAME..."
docker compose exec -T postgres psql -U "$DB_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$DB_NAME\";" -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\";"

echo "[restore] restoring dump..."
gunzip -c "$DUMP" | docker compose exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 -q

echo "[restore] restarting api (migrations run on boot)..."
docker compose start api
echo "[restore] done. Check health: curl http://localhost:4000/health"
