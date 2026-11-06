# Phase 7 — Live Migration Plan (School Management Platform v2)

**Status: PREPARED ONLY — do NOT execute any step until the morning tap.**
Prepared 2026-11-07 ~00:40 PKT by agent P7-INT. Predecessor: `backend/DEMO-REMOVAL-RUNBOOK.md`
(code-side demo removal done; live deletion still pending). Full verification:
`docs/PHASE7-INTEGRATION-REPORT.md` (tsc 0 errors, vitest 294/294, frontend build clean,
scratch-DB smoke 51/51).

## Order — this exact sequence, no shortcuts

### 1. Delete the demo school from the LIVE Render database FIRST
- **Why first:** the code currently live on Render still has `SEED_ON_BOOT=true` in
  `render.yaml`. A redeploy before deletion would re-seed the demo school if it had
  already been deleted. Delete → push → verify. Never push before deleting.
- **How:** Render dashboard → `school-management-db` → psql / Connect, **or**
  `school-management-api` service → Shell tab (`DATABASE_URL` already set there).
- **Verify first (read-only, never skip):**
  ```sql
  SELECT count(*) FROM schools;
  SELECT id, slug, name FROM schools;
  SELECT count(*) FROM users;
  SELECT count(*) FROM students;
  ```
  Expected before deletion: **1 school** (`slug = 'demo-public-school'`,
  name `Demo Public School`), **1 admin user** (`demo@school.pk`), **25 students**.
  If any OTHER school is present, **STOP** — do not run the delete; report back.
- **Delete** (exact SQL in `backend/DEMO-REMOVAL-RUNBOOK.md` §2c — cascade-deletes
  the school and all its rows):
  ```sql
  DELETE FROM schools WHERE slug = 'demo-public-school';
  ```
- **Verify after:** all four counts above are **0**; demo login returns **401**.

### 2. Push to GitHub `main`
- Push manifest: `~/workspace/tmp/smp-paths-text.txt` — **276 files, verified identical
  to a full-tree listing** (excludes `node_modules/`, `.git/`, `dist/`, `backend/backups/`,
  `uploads/`, `.env`). It includes everything the old (empty) manifest missed:
  `backend/DEMO-REMOVAL-RUNBOOK.md`, `frontend/vercel.json`, all new modules
  (sessions, exams, timetable, staff, results, expenses, announcements, events,
  certificates, notifications, security, messaging §11), all 4 migrations, docs.
- **Local-git caveat:** this VM's clone has **no git history and no remote configured**
  (`git log` → "no commits yet"; the last pushed commit `6962d9c4` is not present
  locally). The push must therefore go through the established GitHub push path
  (MCP push-files / parent-handled approvals) using the manifest as the file list —
  do NOT try a plain `git push` from this clone; it has nothing to push from.
- Pushing `render.yaml` (with `SEED_ON_BOOT` removed) triggers the Render
  auto-redeploy. **Back up the live DB first** (free Postgres expires 2026-12-06;
  `scripts/backup.sh`).

### 3. Render auto-redeploy runs `prisma migrate deploy`
- Applies, in order: `20261106120000_init` (already applied),
  `20261106230000_v2_schema`, `20261106231000_v2_messages`,
  `20261106232000_v2_queue_custom_type`. Verified on scratch DB 2026-11-07:
  all 4 applied, `migrate status` up to date.
- **No seed runs on live:** `SEED_ON_BOOT` is removed from `render.yaml`;
  root `.env.example` and `backend/.env.example` both say `SEED_ON_BOOT=false`
  (local-dev only); `docker-compose.yml` defaults to `false`; the entrypoint only
  seeds when explicitly `SEED_ON_BOOT=true`. A redeploy after deletion is safe
  and will **not** re-create the demo school.
- Watch the Render deploy log for migration success; a failed migration blocks the
  deploy — do not retry blindly, read the log first.

### 4. Vercel redeploy (frontend, file-upload path)
- Per `docs/VERCEL_DEPLOY_RUNBOOK.md` (file-upload deploy, same as the 6A-3 deploy).
- `frontend/vercel.json` (SPA fallback rewrites → `/index.html`) **must** be included
  in the upload — without it, deep links (`/login`) return Vercel 404.
- Verify the deploy is READY before moving to step 5.

### 5. Live verification checklist
- [ ] `GET https://school-management-api-g191.onrender.com/health` → **200**
      (allow ~50–75s for the free-tier cold start on first request).
- [ ] Login page loads at `https://school-management-platform-majiicrafts.vercel.app/login`
      (200, no Vercel 404 on a direct URL open).
- [ ] Fresh signup works and the new school is **completely empty**
      (0 classes, 0 students, 0 fee records).
- [ ] Demo login (`demo@school.pk` / `Demo1234!`) → **401**.
- [ ] Smoke of the new features on live: sessions CRUD, exams + datesheet,
      timetable, staff + payroll, results manual entry, custom-message
      template/draft/preview, fee voucher, expenses, certificates,
      `POST /backups/run`, `GET /jobs/status` lists `school_backup` and
      `scheduled_messages`.
- [ ] `GET /backups` shows the nightly-job log; confirm the free-Postgres
      expiry date (2026-12-06) and the backup routine.

## Rollback notes
- If the Render deploy fails on migration: read the deploy log; the migrations are
  additive-only, so the pre-deploy DB state is intact — fix forward, do not hand-edit
  the live schema. If the frontend deploy fails: the previous Vercel deployment
  stays live; re-upload with `vercel.json` included.
- If the demo school reappears after deploy: seeding ran — check `SEED_ON_BOOT`
  on the Render service env vars (it must be absent) and re-delete per step 1,
  then report it; do not just delete and move on.
