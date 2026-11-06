# Roles & Security — Phase 6D (2026-11-06)

Completion notes for Phase 6D: rate-limit verification, automatic per-school
backup, session timeout, and the Security frontend. The 6A hardening module
(`backend/src/modules/hardening/**`) was NOT edited — 6D extends it via new
files that call its exported helpers (`exportSchoolData`, `setupTwofa` /
`verifyTwofaSetup` / `disableTwofa`, `listBackups`, …). No schema or
migration change was made.

## 1. Rate limiting — VERIFIED (one gap fixed)

Limiters live in `backend/src/middleware/rateLimit.ts` (express-rate-limit
v7, in-memory store, per-IP). All three were already in place; verification
is by the new tests in
`backend/src/modules/security/__tests__/rate-limit.test.ts` (real routes
over HTTP, fake DB).

| Limiter | Window | Limit | Applied to |
|---|---|---|---|
| `apiLimiter` | 15 min | 300 req / IP | every `/api/*` route (`app.ts`) |
| `authLimiter` | 15 min | 20 attempts / IP | `POST /auth/signup`, `/verify-email`, `/login`, `/2fa/login`, `/forgot-password`, `/reset-password` — **and `/refresh` (6D fix, see below)** |
| `publicLinkLimiter` | 10 min | 120 req / IP | public teacher-link `GET /t/:token` + `POST /t/:token/submit` |

**Gap found and fixed:** `POST /auth/refresh` was the only auth endpoint
without `authLimiter` (it had only the loose 300/15-min `apiLimiter`).
`backend/src/modules/auth/routes.ts` now applies `authLimiter` to
`/refresh`. Refresh tokens are random 128-bit JWTs, so this was defence in
depth, not an active exploit — but the refresh endpoint is also the
session-timeout enforcement point, so it belongs under the strict limiter.

**Response:** `429` with the envelope `{ok:false, error:{code:
'RATE_LIMITED', message:'Too many …'}}` plus `RateLimit-*` draft-7
headers (`standardHeaders: 'draft-7'`, no legacy headers). The limit is per
IP across ALL auth endpoints sharing the one `authLimiter` instance — 20
failed logins exhaust the quota for password resets from the same IP too,
by design.

**Tests (all passing):** login with wrong passwords → `401` × 20 then
`429` (body code `RATE_LIMITED`); refresh → `200` × 20 then `429`;
`apiLimiter` → `200` × 300 then `429`.

## 2. Automatic per-school backup

**Job:** `backend/src/jobs/backup.ts` — `runSchoolBackup(db, school)` +
`runNightlyBackups(db)`. Registered in `backend/src/jobs/registry.ts` as
`school_backup`, cron `0 2 * * *` (02:00 UTC nightly), via the same
`runJobForSchool` / `runJobForAllSchools` machinery as the other jobs
(one school's failure never blocks the others; run state in
`GET /jobs/status`).

**What it does, per school:**
1. Exports the school's full data with the 6A `exportSchoolData` helper —
   the exact same shape as `POST /export/all` (41 tables incl.
   `attendance_records` / `message_deliveries` via parents, users scrubbed
   of password/token hashes and `totpSecretEnc`, **phones FULLY decrypted**
   — it is the school's own backup). The export's audit row is attributed
   to the school's first admin (a system job has no user of its own; if a
   school somehow has no admin, the nil UUID is used and the audit write
   logs the failure instead of breaking the backup).
2. Writes `backend/backups/<school-slug>/<YYYY-MM-DD>.json` (school-local
   date; same-day re-runs overwrite the file — it is a full snapshot either
   way). Base dir overridable with `BACKUP_DIR` (absolute, or relative to
   `backend/`); tests pass `baseDir` directly.
3. Writes a `school_backups` row (`school_id`, `file_ref` =
   `backups/<slug>/<date>.json`, `size_bytes`, `created_at`). The schema
   has **no `status` column** — a row existing means the backup succeeded;
   a failed run writes no row (the failure lands in the job run records +
   server log instead).

**Endpoints:**
- `POST /backups/run` (admin) — new, in
  `backend/src/modules/security/routes.ts`, mounted at `/api/v1` in
  `app.ts` (6D block). Runs this school's backup now; returns
  `{ran, school, file, sizeBytes, tables, exportedAt}`. Audit-logged as
  `backup.run_manual`.
- `GET /backups` (admin) — already existed in the hardening routes; 6D
  verified it works (scoped to the caller's school) and did NOT duplicate
  it. Covered in `security-6d.test.ts` via `listBackups`.

**⚠️ Ephemeral-disk caveat — read this before relying on the job:** on the
Render free tier the local disk does **not** survive a redeploy or
restart, so a nightly file under `backend/backups/` is NOT a durable
backup by itself. The durable copy is the admin's manual export
(`POST /export/all` → download the JSON and keep it somewhere safe, or the
Security page → Data & privacy → Download full export). The nightly job
exists so a recent copy is always on the server to grab, and so the
`school_backups` log shows backup health. On a host with a persistent disk
(or with `BACKUP_DIR` pointed at mounted storage) the files do survive.
`backend/backups/` is gitignored (the files contain decrypted parent
phones — never commit them).

**Manual run:** `npx tsx src/jobs/run-manual.ts school_backup --school=<slug|id>`.

## 3. Restore procedure

Script: `backend/src/jobs/restore-backup.ts` (run with `npx tsx`).

```
# Dry run first (default): validates the file, pre-checks unique collisions,
# prints the per-table row counts it WOULD restore. Writes nothing.
npx tsx src/jobs/restore-backup.ts backend/backups/alpha-school/2026-11-06.json

# Actually restore (DATABASE_URL points at the target DB):
npx tsx src/jobs/restore-backup.ts backend/backups/alpha-school/2026-11-06.json --apply [--slug=<new-slug>]
```

**The script never overwrites the source school.** It restores the backup
as a NEW school (new id, new slug — default `<slug>-restored-<yyyymmdd>`,
all row ids remapped, FKs and JSONB payloads remapped by the same
whole-file UUID replacement, inserts in FK-safe order). That makes a
restore verifiable without touching live data.

**Before restoring, know:**
- Restore is meant for disaster recovery (the source school is gone) or a
  scratch database. Three columns are globally unique — `users.email`,
  `message_queue.dedupe_key`, `sms_devices.device_id` — so restoring
  alongside the still-existing source school fails on collision. The
  dry-run pre-checks all three and `--apply` refuses while any collide.
- Restored users get a **random unusable password hash** (the export
  deliberately scrubs `passwordHash` / token hashes / `totpSecretEnc`) and
  `totpEnabled` is forced OFF. Every restored login must use “Forgot
  password” to set a new password, then re-enable 2FA if wanted.
- `school_backups` rows are NOT restored (the new school starts a fresh
  backup log; the nightly job writes its own rows).
- `fee_records.status` is a GENERATED column — it is stripped before
  insert and Postgres recomputes it from the amounts.
- Restored phones stay encrypted exactly as exported — the same
  `PHONE_ENC_KEY` must be in effect or they will not decrypt.
- Steps after `--apply`: log in as the school's admin via “Forgot
  password”, verify the dashboard counts match the backup, re-enable 2FA,
  and either keep the restored school as the live one (update DNS/links) or
  treat it as a verification copy and delete it.

## 4. Session timeout

**Setting:** `session_timeout_minutes` in `schools.settings` — default
**120**, allowed **15–1440** (integer minutes). Added to
`SETTING_KEYS` + validation + defaults in
`backend/src/modules/admin/service.ts` (minimal additive change; the
settings service was otherwise untouched) and to the `SchoolSettings`
type in `backend/src/jobs/common.ts`. Editable in Settings → School &
SMS (admin) and via `PATCH /settings`.

**Server enforcement** (`backend/src/modules/auth/service.ts`
`refreshTokens`, new `resolveSessionTimeoutMinutes` helper): there is no
server-side session store (stateless JWTs, per HARDENING.md), so the
check uses the refresh token's `iat`. The refresh token is re-issued on
every successful refresh, so its `iat` is the last activity the server has
seen — and the frontend only calls `/refresh` when the user actually makes
a request (lazy refresh on 401 in `frontend/src/lib/api.ts`), so a refresh
genuinely means “the user was active”. If `now − iat >
session_timeout_minutes`, the refresh is rejected with `401`
`{code:'SESSION_EXPIRED', message:'Session expired due to inactivity —
please sign in again'}` (new `ApiError.sessionExpired`, `lib/errors.ts`).
Access tokens still live 15 min (`config.accessTokenTtlSeconds`); the
15-minute minimum exists because a shorter timeout would log out users
who are actively working (their access token outlives the timeout).

**Frontend** (`frontend/src/components/IdleTimeout.tsx`, mounted in
`Layout` for authed users only):
- Reads the school's timeout from `GET /settings` (readable by every
  authed role); falls back to 120 when unavailable.
- Any pointer / key / scroll / touch activity resets the idle clock.
- **Warns 2 minutes before** with a modal (“Still there? … you will be
  signed out in M:SS”) — “Stay signed in” resets the clock, “Sign out
  now” signs out immediately.
- On expiry: signs out, sets the `smp_session_expired` flag, navigates to
  `/login`, where the login page shows “Your session ended because you
  were inactive for a while. Please sign in again — your data is safe.”
- If the server rejects a refresh with `SESSION_EXPIRED` first (e.g. an
  old tab), `lib/api.ts` sets the same flag, dispatches the
  `smp:session-expired` window event, and `AuthContext` signs the user out
  wherever they are.

**Not built (deliberate):** `GET /auth/sessions` / `DELETE
/auth/sessions/:id` from the v2 contract list. With stateless JWTs there
is no server-side session to list or revoke — the idle-timeout contract
is fully covered by the refresh-`iat` check + the idle modal. A
server-side session store would be a separate design decision (and a new
table), not a 6D gap.

**Tests:** `security-6d.test.ts` — fresh refresh succeeds; a 3-hour-old
token is rejected with `SESSION_EXPIRED` under the 120-min default; a
30-min-old token is rejected (and a 10-min-old one accepted) with the
school setting at 15; `resolveSessionTimeoutMinutes` clamps 5→15,
2000→1440, non-numbers→120.

## 5. Security frontend — UI map

Page: `frontend/src/pages/Security.tsx`, route `/security` (admin-only
via `RequireAdmin` in `App.tsx`; nav entry “Security” in `Layout`,
admin only). Every tab uses existing 6A/auth endpoints; no new backend
auth endpoints were created.

| Tab | UI | Endpoints used |
|---|---|---|
| Two-factor auth | Status badge (On/Off); setup shows the secret + otpauth URL (copy buttons — no QR library is bundled, so manual entry) and a 6-digit code field → verify; disable asks for the account password behind a ConfirmDialog. | `GET /auth/me` (totp_enabled), `POST /auth/2fa/setup`, `POST /auth/2fa/verify` (code + secret fallback), `POST /auth/2fa/disable` |
| Roles & permissions | Permission matrix (resources × roles × view/create/update/delete/approve/export checkboxes; admin cells locked — the backend refuses admin revokes); create-Principal form (email + temporary password, ConfirmDialog); logins list with role + email-verified badges. | `GET /roles/permissions`, `PATCH /roles/permissions`, `GET /users`, `POST /users/principals` |
| Data & privacy | Password-confirmed full export download (Blob, `school-export-<date>.json`); password-confirmed deletion-request filing; requests list with status badge + status dropdown (ConfirmDialog on change). | `POST /export/all`, `POST /account/delete-request`, `GET /account/delete-requests`, `PATCH /account/delete-requests/:id` |
| Login alerts | List of `login_alert` notifications (title/body/time, Mark read); empty state when none. | `GET /notifications?limit=100` (filtered client-side to `type === 'login_alert'`), `POST /notifications/:id/read` |
| Backups | Nightly-job explainer incl. the ephemeral-disk caveat; “Run a backup now” (ConfirmDialog); history list (`file_ref`, size, time) with empty state + CTA. | `GET /backups`, `POST /backups/run` |

**Rules honoured:** every query scoped by the JWT `school_id`; admin-only
pages (`RequireAdmin` + server-side `requireAdmin`); `autocomplete="off"`
on every data-entry input (credential fields keep `current-password` /
`new-password` per the frontend-hardening convention); `ConfirmDialog`
for every destructive action (disable 2FA, create Principal, export,
deletion request, status change, run backup); empty states with a
call-to-action on every list; phone crypto untouched.

## 6. Files changed (6D)

**Backend**
- `backend/src/middleware/rateLimit.ts` — unchanged (verified as-is).
- `backend/src/modules/auth/routes.ts` — `authLimiter` added to
  `POST /auth/refresh` (the one gap).
- `backend/src/lib/errors.ts` — `SESSION_EXPIRED` error code (401).
- `backend/src/lib/tokens.ts` — `RefreshPayload.iat` (for the idle check).
- `backend/src/modules/auth/service.ts` — idle-timeout enforcement in
  `refreshTokens`, `resolveSessionTimeoutMinutes` + constants,
  `totp_enabled` added to `toPublicUser` (the Security page needs it).
- `backend/src/modules/admin/service.ts` — `session_timeout_minutes`
  setting key + validation (15–1440) + default 120 (minimal additive
  change only).
- `backend/src/jobs/common.ts` — `session_timeout_minutes` in
  `SchoolSettings` + `settingsOf` default.
- `backend/src/jobs/backup.ts` — **new**: `runSchoolBackup`,
  `runNightlyBackups`, `resolveBackupDir`, `backupFileRef`.
- `backend/src/jobs/registry.ts` — `school_backup` job (`0 2 * * *`).
- `backend/src/jobs/restore-backup.ts` — **new**: restore-as-new-school
  script (dry-run default, `--apply`).
- `backend/src/jobs/run-manual.ts` — job-name comment updated.
- `backend/src/modules/security/routes.ts` — **new**: `POST /backups/run`.
- `backend/src/modules/security/__tests__/fake-db-6d.ts` — **new** fake DB.
- `backend/src/modules/security/__tests__/rate-limit.test.ts` — **new**.
- `backend/src/modules/security/__tests__/security-6d.test.ts` — **new**.
- `backend/src/app.ts` — 6D mount block for `securityRouter` (append-only).
- `.gitignore` — `backend/backups/` (decrypted phones — never commit).
- `backend/src/modules/security/SECURITY-6D.md` — this file.

**Frontend**
- `frontend/src/pages/Security.tsx` — **new** (5 tabs, see §5).
- `frontend/src/components/IdleTimeout.tsx` — **new** (warning modal +
  auto sign-out).
- `frontend/src/components/Layout.tsx` — Security nav item (admin) +
  `<IdleTimeout />` mount.
- `frontend/src/App.tsx` — `/security` route (admin-only, 6D block).
- `frontend/src/auth/AuthContext.tsx` — `sessionExpired` state +
  `SESSION_EXPIRED` event listener; login/signup clear the flag.
- `frontend/src/lib/api.ts` — refresh parses `SESSION_EXPIRED`,
  sets the flag + dispatches the event.
- `frontend/src/lib/types.ts` — `User.totp_enabled`,
  `SchoolSettings.session_timeout_minutes`.
- `frontend/src/pages/Auth.tsx` — login page shows the
  session-expired banner.
- `frontend/src/pages/Settings.tsx` — session-timeout field.

**Contracts**
- `contracts/API.md` — “6D additions” section appended (see below in that file).

## 7. Verification

- `npx tsc --noEmit` (backend): **0 errors** (verified twice at the end
  of the 6D pass; mid-pass it transiently showed errors in other agents'
  in-flight 6B/6C modules, which those agents fixed — none were in 6D
  files).
- `npx vitest run` (backend): **19 files, 293 tests, all pass** — incl.
  12 new 6D tests (3 rate-limit + 9 backup/session/2FA/backups-run).
  NOTE (19:25 PKT re-run, after midnight PKT): 3 tests in OTHER phases'
  files now fail — `jobs.test.ts` (pending-attendance dedupe,
  teacher-reminder dedupe) and `cross-tenant.test.ts` (dashboard present
  count). These are pre-existing date-boundary flaws in those tests, not
  6D regressions: the fake DB stamps `createdAt` with wall-clock now
  (2026-11-07 PKT) while the job `now` is fixed at 2026-11-06, so the
  same-day dedupe (`notifyOnce` / `queueRowExistsToday`) misses, and the
  dashboard test mixes UTC `today` with PKT `todayInTz`. They passed at
  18:57 PKT (still Nov 6 PKT) with all 6D changes in place and broke
  with no code change in between — only the clock crossing midnight PKT.
  The fix belongs to the jobs/isolation owners (stamp the fake's
  `createdAt` from the injected `now`, or date the tests relative to
  real now); 6D did not touch `notifyOnce`, `queueRowExistsToday`,
  `getDashboard`, `localDateString`, or those fakes.
- Frontend `npm run build` (`tsc -b && vite build`): **clean**.
- Live-DB smoke: see §8.

## 8. Live-DB smoke (scratch DB only — live DB never touched)

No Postgres existed on this VM at the start (`pg_ctlcluster` absent, no
`pg_ctl` anywhere, apt has no package lists — `apt-get update` hung).
PostgreSQL 16.4 was built from source into `~/workspace/tmp/pg16` (kept
there as scratch tooling for later QA; the ~1 GB source/build tree was
removed) and run as user `nobody` on port 5433 (Postgres refuses to run
as root, and `chown` to another uid fails in this user namespace — the
data dir was created BY `nobody` inside a world-writable parent instead).
Scratch DBs `school_6d_smoke` + `school_6d_restore` only; `prisma migrate
deploy` (4 migrations) + `prisma db seed`; API on :4123 with scratch
`DATABASE_URL` and `BACKUP_DIR=/tmp/smp-6d-backups`. All scratch state
(server, Postgres, both DBs, backup files) was removed afterwards.

**Smoke result: 22/22 checks PASS** (script run 2026-11-06 ~19:19 PKT):
- Signup → verify-email → duplicate signup 409.
- **Rate limit (live):** 25 wrong-password logins → 18×401 then 7×429
  (signup + verify had already consumed 2 of the shared 20 auth
  attempts — the shared-instance behaviour, confirmed); 429 body carries
  `code: 'RATE_LIMITED'`.
- Login returns tokens; `GET /auth/me` includes `totp_enabled: false`.
- `GET /roles/permissions` 200, `PATCH /roles/permissions` 200,
  `POST /users/principals` 201.
- `POST /backups/run` 200 → file
  `backups/smoke-test-school/2026-11-07.json` (8,718 bytes, 41 tables,
  school-local date) + `GET /backups` lists the row.
- `PATCH /settings {session_timeout_minutes: 15}` 200; a refresh token
  with `iat` 30 min old → `401 {code:'SESSION_EXPIRED'}`; a fresh
  refresh → 200.
- **2FA round-trip:** setup → verify (otplib code) → login returns
  `needs_2fa` → `POST /auth/2fa/login` 200 → disable 200.
- `POST /export/all` 200; `POST /account/delete-request` 201, listed as
  `pending`; `GET /jobs/status` lists `school_backup`.

**Restore script (live):**
- Dry-run on the real backup file: per-table counts printed
  (users 2, templates 6, audit_logs 5, role_permissions 1, …), both
  `users.email` collisions warned, nothing written, exit 0.
- `--apply` against the same DB: refused with “Refusing --apply with
  unresolved unique collisions…”, 0 schools restored.
- `--apply` into an empty migrated DB: **restore succeeded** — school
  live as `smoke-test-school-restored-20261106`, 2 users (both
  `totp_enabled=false`, `email_verified` preserved), 6 templates,
  5 audit logs — verified with `psql`.
