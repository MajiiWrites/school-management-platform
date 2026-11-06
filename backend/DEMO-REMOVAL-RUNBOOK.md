# Demo Removal — Live Execution Runbook

**Status: CODE READY, LIVE DELETION NOT YET DONE.**
**Decision:** 2026-11-06 22:53 PKT — remove the demo account; the live site must be
completely empty. Demo school: **"Demo Public School"**, slug `demo-public-school`,
admin `demo@school.pk` / `Demo1234!` (25 students, classes 1-A / 5-A / 6-B, fees,
templates, notifications).

**ORDER MATTERS — do the steps in this exact order:**

1. **DELETE the demo school from the live Render database FIRST** (this runbook, §2).
2. **THEN push the code changes** (seed-off) to GitHub `main` (§4). Pushing
   `render.yaml` triggers a Render auto-redeploy.
3. **THEN verify live** (§5) and redeploy the frontend on Vercel (new build picks up
   the mock-credential change only if mock mode is ever used; the login page
   itself never showed a demo hint — see §6).

> ⚠️ **Why delete first:** the seed is idempotent (upserts) — a redeploy before
> deletion would NOT duplicate anything, but it **WILL re-create the demo school
> if it was already deleted**. The code in this repo now has seeding OFF
> (`SEED_ON_BOOT` removed from `render.yaml`, entrypoint opt-in only), so a
> redeploy AFTER deletion is safe and will not re-seed. A redeploy BEFORE the
> code push (old `render.yaml` still has `SEED_ON_BOOT=true`) would re-seed the
> demo school if it had been deleted. **Delete → push → verify. Never push
> before deleting.**

## 1. What the code changes already do (staged locally, NOT yet pushed)

- `render.yaml` — `SEED_ON_BOOT` env entry **removed entirely** (was `"true"`).
- `docker-compose.yml` — `SEED_ON_BOOT: ${SEED_ON_BOOT:-false}` (was `:-true`); header
  comment updated (no demo login; seeding off by default).
- `backend/docker-entrypoint.sh` — seeding runs ONLY when `SEED_ON_BOOT` is
  explicitly `"true"`. (This was already the logic; now documented as default-off
  with a "never enable on live" warning. No logic change was needed.)
- `backend/.env.example` — new `SEED_ON_BOOT=false` entry, marked local-dev only.
- `.env.example` — `SEED_ON_BOOT=true` → `false`, comment: "demo seeding is off;
  never enable on the live site".
- Docs — demo credentials removed from `docs/README.md`, `docs/SETUP.md`,
  `docs/TEST-CHECKLIST.md`, `docs/DEPLOYMENT.md`, root `README.md`,
  `frontend/README.md`. `backend/prisma/README.md` keeps the seeded credentials
  but is now headed **LOCAL DEV ONLY — never seed on the live site**.
- `frontend/src/lib/mock.ts` — mock login changed from the demo credentials to
  local-only mock credentials `admin@mock.local` / `Mock1234!` (mock mode only,
  `VITE_MOCK_API=true`; the live site never uses mock mode).
- `backend/prisma/seed.ts` — **kept as-is** for local dev (do not delete).
- `contracts/STRUCTURE.md:56` — still names the demo credentials: it is the
  internal build contract describing what the seed creates, not a user-facing
  page. Left intentionally; update it only if the seed itself changes.
- `frontend/src/pages/Auth.tsx` — **no demo hint was present** (verified by grep
  and full read 2026-11-06). Nothing to remove there.

`npm run build` passes in `backend/` and `frontend/` after these edits
(verified 2026-11-06 — see §5 note).

## 2. LIVE DATABASE DELETION (parent executes — no live DB access from the agent VM)

The agent VM has **no live Render `DATABASE_URL`**: `.deploy-secrets` holds only
Render app secrets (no `DATABASE_URL`), and `~/workspace/tmp/qa.env` is LOCAL QA
only (points at `localhost`) — it must NOT be used for this. `psql` exists on the
VM but there is nothing live to connect to.

### 2a. Get a live database shell (pick one)

- **Render dashboard → school-management-db → "psql" / Connect** (external
  connection string), **or**
- **Render dashboard → school-management-api service → Shell tab** (runs inside
  the service; `DATABASE_URL` is already set there — run `psql "$DATABASE_URL"`).

### 2b. Verify FIRST — read-only (never skip this)

```sql
SELECT count(*) FROM schools;
SELECT id, slug, name FROM schools;
SELECT count(*) FROM users;
SELECT count(*) FROM students;
```

Expected before deletion: **1 school** (`slug = 'demo-public-school'`,
name `Demo Public School`), **1 admin user** (`demo@school.pk`), **25 students**.
If you see any OTHER school, **STOP** — do not run the delete; report back.

### 2c. Delete ONLY the demo school (one statement)

```sql
DELETE FROM schools WHERE slug = 'demo-public-school';
```

**Cascade coverage (verified against `backend/prisma/schema.prisma`):** every
tenant table has `school_id` FK to `schools` with `ON DELETE CASCADE`, so this
single delete removes the school + users, classes, students, attendance
(days/records/teacher), fee structures/records/vouchers, message templates /
queues / deliveries, SMS devices, holidays, sessions, promotions, leave,
OCR uploads, audit log, notifications, roles, approval requests, deleted
records, change log, exams, grading scales, result sheets/results, timetable,
staff (+ assignments/salaries), expenses, announcements, events, certificates,
datesheets, account-deletion requests and backups. Two child tables have no
direct `school_id` but cascade through their parent: `attendance_records`
(via `attendance_day_id` / `student_id`) and `message_deliveries`
(via `queue_id`). No table is left orphaned.

Two `Restrict` FKs are safe in the same statement: `students.class_id` and
`promotions.from_class_id / to_class_id` — Postgres deletes the referencing
rows in the same cascade, so the delete succeeds.

**Record the row counts** the `DELETE` reports (or run the counts below first
and note them — they are the deletion evidence).

### 2d. Verify AFTER — all must be zero / fail

```sql
SELECT count(*) FROM schools;    -- expect 0
SELECT count(*) FROM users;      -- expect 0
SELECT count(*) FROM students;   -- expect 0
SELECT count(*) FROM classes;    -- expect 0
SELECT count(*) FROM fee_records;-- expect 0
SELECT count(*) FROM message_templates; -- expect 0
SELECT count(*) FROM notifications;     -- expect 0
```

Then, from any terminal (no DB access needed):

```bash
curl -s https://school-management-api-g191.onrender.com/health
# expect {"ok":true,...} HTTP 200

curl -s -X POST https://school-management-api-g191.onrender.com/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"demo@school.pk","password":"Demo1234!"}'
# expect HTTP 401 (demo login MUST fail). Pre-deletion baseline (2026-11-06):
# /health 200, demo login returned 200 + JWT. After deletion it must be 401.
```

## 3. Fresh-signup sanity check (after deletion + redeploy)

Sign up a brand-new school on the live site → dashboard must show **zero**
students, zero classes, zero fees — a completely empty school. This proves the
site is empty-by-default, not just demo-free.

## 4. Push the code changes (AFTER §2 deletion is confirmed)

From the agent VM (or any machine with the repo + the GitHub snapshot-push
procedure in `/opt/hatch/connectors/github/references/snapshot-push.md`):

```bash
github push-files --owner MajiiWrites --repo school-management-platform \
  --branch main --message "Remove demo account: SEED_ON_BOOT off, demo hint/creds removed (Phase 6A)" \
  --source-dir /home/hatch/workspace/school-management-platform \
  --paths-file /home/hatch/workspace/tmp/smp-paths-text.txt
```

- The manifest `~/workspace/tmp/smp-paths-text.txt` already lists the full repo
  snapshot; regenerate it first if files were added since
  (`git -C <source-dir> ls-files --cached --others --exclude-standard -z -- .`
  with the sync-record exclusions from the procedure).
- After a confirmed push, append the returned SHA to the sync record
  `~/workspace/school-management-platform.muse-github-snapshot-sync.json`
  (entry shape: owner/repo/branch/source_dir/commit_sha/paths).
- **This push triggers a Render auto-redeploy** (intended — it applies
  `SEED_ON_BOOT` removal). Because deletion (§2) already happened and the new
  code never seeds, the redeploy cannot re-create the demo school.
- Then redeploy the frontend on Vercel (or let its GitHub auto-deploy run) so
  the live login page build matches the pushed code.

## 5. Live verification checklist (after §2 + §4)

- [ ] `GET /health` → 200.
- [ ] Demo login → **401** (was 200 + JWT before deletion).
- [ ] Live DB counts: schools = 0, users = 0, students = 0.
- [ ] Login page shows **no demo hint** (it never did — verified in source;
      confirm on the live Vercel page after its redeploy).
- [ ] Fresh signup → empty school (zero data).
- [ ] `npm run build` passes in `backend/` and `frontend/` (verified locally
      before push).

## 6. What was NOT done (and who must do it)

- **Live DB deletion** — NOT done; no live `DATABASE_URL` is reachable from the
  agent VM. **Parent (or an agent with Render dashboard access) must run §2.**
- **GitHub push** — NOT done; held deliberately per the delete-first ordering
  (§4). **Parent approves + runs after §2.**
- **Vercel redeploy / live login-page check** — NOT done; separate step after
  the push. **Parent runs; do not claim it done until the live page is fetched
  and checked.**
- **Android APK / email-verification decision** — out of scope for this removal;
  still open from the main program.
