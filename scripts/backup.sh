#!/bin/bash
# School Management Platform — database backup
# Usage:
#   scripts/backup.sh [backup-dir]        # default dir: ./backups
#   DATABASE_URL=... scripts/backup.sh    # without Docker: pg_dump straight from DATABASE_URL
#
# What it does: dumps the Postgres database to a gzipped file
#   backups/school-YYYYMMDD-HHMM.sql.gz
# and deletes backups older than 7 days. Run it from cron (see below).
# Cron example (daily 02:00):
#   0 2 * * * cd /opt/school-management-platform && ./scripts/backup.sh >> /var/log/school-backup.log 2>&1
# Restore: see scripts/restore.sh
set -euo pipefail
cd "$(dirname "$0")/.."

# Load .env if present (for POSTGRES_USER / POSTGRES_DB / DATABASE_URL).
if [ -f .env ]; then set -a; . ./.env; set +a; fi

BACKUP_DIR="${1:-./backups}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M)"
FILE="$BACKUP_DIR/school-$STAMP.sql.gz"

if docker compose ps postgres >/dev/null 2>&1; then
  echo "[backup] dumping via docker compose (postgres service)..."
  docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-school}" -d "${POSTGRES_DB:-school}" | gzip > "$FILE"
elif [ -n "${DATABASE_URL:-}" ]; then
  echo "[backup] dumping via DATABASE_URL..."
  pg_dump "$DATABASE_URL" | gzip > "$FILE"
else
  echo "[backup] ERROR: no running compose postgres and no DATABASE_URL set." >&2
  exit 1
fi

# Retention: keep 7 days.
find "$BACKUP_DIR" -name 'school-*.sql.gz' -mtime +7 -delete

echo "[backup] written: $FILE ($(du -h "$FILE" | cut -f1))"
