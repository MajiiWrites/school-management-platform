#!/usr/bin/env bash
# Section 11 scheduled-job live check (agent S11).
# Fresh scratch DB, seed, real server: create a draft scheduled 1h ahead,
# approve-send it (status 'scheduled' + approved request), then run the
# scheduled_messages job with --at 2h ahead and verify queue rows appear.
# A second run must be a no-op (idempotent).
set -euo pipefail
DB=school_s11_job
PORT=4128
export DATABASE_URL="postgresql://postgres:smoke-pw@localhost:5432/${DB}?schema=public"
export PHONE_ENC_KEY="$(python3 -c 'import base64,os;print(base64.b64encode(os.urandom(32)).decode())')"
export JWT_SECRET=smoke-secret JWT_REFRESH_SECRET=smoke-refresh-secret
export SMS_DEVICE_SECRET=smoke-device-secret
cd "$(dirname "$0")/../../.."

PSQL=(sudo -n -u postgres psql -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -c "DROP DATABASE IF EXISTS ${DB}" >/dev/null
"${PSQL[@]}" -c "CREATE DATABASE ${DB}" >/dev/null
npx prisma migrate deploy >/dev/null 2>&1
npx prisma db seed >/dev/null 2>&1
echo "[job-smoke] scratch DB + seed done"

setsid env PORT=$PORT npx tsx src/server.ts > /tmp/s11-job-server.log 2>&1 &
SRV=$!
trap 'kill -- -$SRV 2>/dev/null; sudo -n -u postgres psql -q -c "DROP DATABASE IF EXISTS '"${DB}"'" >/dev/null 2>&1 || true' EXIT
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 && break; sleep 1; done

B="http://127.0.0.1:${PORT}/api/v1"
TOKEN=$(curl -sf -X POST "$B/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"demo@school.pk","password":"Demo1234!"}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["access"])')
H=(-H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json')

NOW=$(python3 -c 'from datetime import datetime,timedelta,timezone; print((datetime.now(timezone.utc)+timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"))')
AT=$(python3 -c 'from datetime import datetime,timedelta,timezone; print((datetime.now(timezone.utc)+timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ"))')
DRAFT=$(curl -sf -X POST "${B}/messages/drafts" "${H[@]}" -d "{\"recipient_type\":\"all_parents\",\"body\":\"Job check {student_name}.\",\"scheduled_for\":\"$NOW\"}")
DRAFT_ID=$(echo "$DRAFT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["draft"]["id"])')
echo "[job-smoke] draft $DRAFT_ID scheduled for $NOW"
SEND=$(curl -sf -X POST "${B}/messages/drafts/${DRAFT_ID}/approve-send" "${H[@]}" -d '{}')
echo "[job-smoke] approve-send: $(echo "$SEND" | python3 -c 'import json,sys; d=json.load(sys.stdin)["data"]; print("scheduled=" + str(d.get("scheduled")))')"
BEFORE=$(curl -sf "${B}/messages/log?type=custom&limit=100" "${H[@]}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["total"])')
echo "[job-smoke] queue rows before job: $BEFORE"
OUT=$(DATABASE_URL="$DATABASE_URL" PHONE_ENC_KEY="$PHONE_ENC_KEY" npx tsx src/jobs/run-manual.ts scheduled_messages --school=demo-public-school --at="$AT" 2>&1 | tail -5)
echo "[job-smoke] run-manual output: $OUT"
AFTER=$(curl -sf "${B}/messages/log?type=custom&limit=100" "${H[@]}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["total"])')
echo "[job-smoke] queue rows after job: $AFTER"
OUT2=$(DATABASE_URL="$DATABASE_URL" PHONE_ENC_KEY="$PHONE_ENC_KEY" npx tsx src/jobs/run-manual.ts scheduled_messages --school=demo-public-school --at="$AT" 2>&1 | tail -3)
echo "[job-smoke] second run output: $OUT2"
AFTER2=$(curl -sf "${B}/messages/log?type=custom&limit=100" "${H[@]}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["total"])')
echo "[job-smoke] queue rows after 2nd run: $AFTER2"

if [ "$BEFORE" = "0" ] && [ "$AFTER" -gt 0 ] && [ "$AFTER" = "$AFTER2" ]; then
  echo "[job-smoke] PASS (sent $AFTER rows when due; second run no-op)"
else
  echo "[job-smoke] FAIL (before=$BEFORE after=$AFTER after2=$AFTER2)"
  exit 1
fi
