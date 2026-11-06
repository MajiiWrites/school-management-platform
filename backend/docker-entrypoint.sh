#!/bin/sh
# API container entrypoint: apply migrations, optionally seed demo data,
# then start the server. Migrations are idempotent; the seed is idempotent
# (upserts), so re-running this container is safe.
set -e

echo "[entrypoint] applying database migrations..."
npx prisma migrate deploy

if [ "$SEED_ON_BOOT" = "true" ]; then
  echo "[entrypoint] seeding demo data (SEED_ON_BOOT=true)..."
  npx prisma db seed || echo "[entrypoint] WARNING: seed failed — continuing to boot"
fi

echo "[entrypoint] starting API..."
exec node dist/server.js
