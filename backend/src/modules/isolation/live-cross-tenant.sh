#!/usr/bin/env bash
# Live-DB cross-tenant probe (ISOLATION-AUDIT 2026-11-06).
#
# Runs the SAME probes as backend/src/modules/isolation/__tests__/cross-tenant.test.ts
# against a REAL local Postgres (cluster 16 main) using the REAL service
# functions + the REAL Prisma messaging/OCR adapters — but ONLY on a scratch
# database (`school_isolation_probe`) created for this run and dropped at the
# end. It NEVER touches the live Render database:
#   - DATABASE_URL is constructed here, pointing at 127.0.0.1 only;
#   - the script refuses to run if $DATABASE_URL already points at a
#     non-local host (e.g. *.onrender.com) — the live DB must never be a
#     probe target;
#   - the probe role is created for this run only and dropped afterwards.
#
# Usage:  bash backend/src/modules/isolation/live-cross-tenant.sh
#   (from the repo root, or anywhere — the script cds to backend/ itself)
# Exit: 0 = all live probes passed; 1 = a probe failed or setup failed.
# Requirements: local Postgres 16 cluster running; `sudo -n -u postgres psql`
#   must work (admin for role/DB creation); node + backend deps installed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$BACKEND_DIR"

SCRATCH_DB="school_isolation_probe"
PROBE_ROLE="isolation_probe"
PROBE_PASS="probe-only-local-password"
export DATABASE_URL="postgresql://${PROBE_ROLE}:${PROBE_PASS}@127.0.0.1:5432/${SCRATCH_DB}"
# Fixed test phone key (AES-256-GCM, 32 bytes base64) so seeded phones decrypt.
# Generated once per run and shared by the seed + probe processes.
if [ -z "${PHONE_ENC_KEY:-}" ]; then
  export PHONE_ENC_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")"
fi
export NODE_ENV="${NODE_ENV:-development}"

# --- Safety guard: never run against a remote / live database -------------
if [ -n "${LIVE_DATABASE_URL:-}" ]; then
  echo "REFUSING: LIVE_DATABASE_URL is set — live probes never run against it." >&2
  exit 1
fi
case "${DATABASE_URL}" in
  *onrender.com*|*render.com*|*amazonaws.com*|*supabase.co*)
    echo "REFUSING: DATABASE_URL points at a remote host: ${DATABASE_URL}" >&2
    exit 1
    ;;
esac

PSQL_ADMIN=(sudo -n -u postgres psql -v ON_ERROR_STOP=1 -q)
if ! "${PSQL_ADMIN[@]}" -tAc 'SELECT 1' >/dev/null 2>&1; then
  echo "ERROR: cannot run 'sudo -n -u postgres psql' — Postgres admin is unavailable." >&2
  echo "Start cluster 16 main (pg_lsclusters) and ensure passwordless sudo to the postgres user." >&2
  exit 1
fi

cleanup() {
  echo "--- cleaning up scratch database + probe role ---"
  "${PSQL_ADMIN[@]}" -c "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\"" >/dev/null 2>&1 || true
  "${PSQL_ADMIN[@]}" -c "DROP ROLE IF EXISTS \"${PROBE_ROLE}\"" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "--- creating scratch database '${SCRATCH_DB}' + probe role ---"
"${PSQL_ADMIN[@]}" -c "DROP DATABASE IF EXISTS \"${SCRATCH_DB}\"" >/dev/null
"${PSQL_ADMIN[@]}" -c "DROP ROLE IF EXISTS \"${PROBE_ROLE}\"" >/dev/null
"${PSQL_ADMIN[@]}" -c "CREATE ROLE \"${PROBE_ROLE}\" LOGIN PASSWORD '${PROBE_PASS}'" >/dev/null
"${PSQL_ADMIN[@]}" -c "CREATE DATABASE \"${SCRATCH_DB}\" OWNER \"${PROBE_ROLE}\"" >/dev/null

echo "--- applying Prisma migrations to the scratch DB ---"
npx prisma migrate deploy

echo "--- seeding two live schools ---"
SEED_JSON="$(npx tsx src/modules/isolation/live-seed.ts)"
echo "seeded: ${SEED_JSON}"

echo "--- running live cross-tenant probes ---"
npx tsx src/modules/isolation/live-probe.ts "${SEED_JSON}"
