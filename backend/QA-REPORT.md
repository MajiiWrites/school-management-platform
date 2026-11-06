# QA Report — School Management Platform (Phase 4)

**Date:** 2026-11-06 (Fri) · **QA agent:** Phase 4 QA/Security · **Repo:** `~/workspace/school-management-platform`
**Verdict: ALL ACCEPTANCE CRITERIA PASS on a live database.** Final live run: **66 PASS / 0 FAIL**.
Four real bugs were found live and fixed during this pass (see §5); the suite was re-run green after each fix.

## 1. Environment (live, not mocked)

| Item | Evidence |
|---|---|
| PostgreSQL | 16.15, cluster `16 main` on :5432, DB `school_qa`, role `qa`. Reinstalled via apt after a mid-QA VM restart wiped all apt packages (workspace persisted). |
| Seed | `npx tsx prisma/seed.ts` (also `prisma db seed` after fix §5.5): Demo Public School, 25 students (5-A: 7 present / 2 absent on 2026-11-05), 23 unpaid / 2 paid fee records, 6 message templates. |
| API | `node dist/server.js` on :4000, `NODE_ENV=development`, env file `~/workspace/tmp/qa.env`. |
| OCR engine | Tesseract 5.3.4, languages `eng osd urd` — reinstalled from cached debs after the VM restart (`liblept5` + `libgif7` deps). |
| E2E harness | `~/workspace/tmp/qa-e2e.sh`, log `~/workspace/tmp/qa-e2e.log` (66 PASS / 0 FAIL on the final run). |
| Static checks | `npm run build` (tsc) **0 errors** · `npx vitest run` **80/80 pass** (8 files) · OCR tsx harness **27/27 pass** · OCR e2e **1/1 pass** · OCR smoke **PASS** · frontend `npm run build` **ok** (363 kB JS, 590 ms). |

## 2. Acceptance criteria — per-criterion result

| # | Criterion | Result | Evidence (final live run) |
|---|---|---|---|
| 1 | Admin signs up, adds classes, uploads a list photo, reviews OCR output, saves students | **PASS** | Signup 201 → verify 200 → login returns token. Class 2-A created 201; duplicate 409. OCR fixture upload 201, **12 rows extracted** from the real fixture image (`sample-list.png`, raw text reads "Class 5-A — Student List"); confirm saved **8**, skipped duplicates **4**; re-confirm saved **0**, skipped **12**; non-image upload 400. |
| 2 | Teacher link marks attendance with no login; portal updates with absent counts | **PASS** | `GET /t/:token` 200 without auth (12 students, `already_submitted=false`). Submit 201: present 9, absent 3, drafted 1. Double-submit 409. Link page then `already_submitted=true`. Dashboard: submitted 1, pending 0, **absent 3, present 9**. |
| 3 | Absent messages ONLY to absent parents, ONLY after admin approval | **PASS** | Pending approval contained exactly **1 draft — Bilal QA** (absent, valid phone). NO draft for Chanda (opted out), Dania (no phone), Ehsan (invalid phone). Approve → `approved: 1`; re-approve → `approved: 0` (idempotent). Device poll then returned the Bilal message only. `sms/status`: `queuedCount 1, pendingApprovalCount 0`. |
| 4 | Fee marked paid is excluded from 1st-of-month reminders | **PASS** | Monthly job (`--at 2026-11-02`, demo school): **created 21, skipped_paid 2, skipped_opt_out 1, skipped_no_phone 1** — exact. DB check: 21 `fee_reminder` rows; none for the 2 paid students (Ali Hamza, Zoya Malik), none for opt-out (Mahnoor Akhtar) or no-phone (Maryam Khan). QA school job: S1+S2 paid → 0 reminders. Job re-run → `ran:false, reason:already-ran-this-month`. |
| 5 | Teacher absence triggers no messages | **PASS** | Mark teacher absent 201 → `message_queue` count unchanged (30 → 30). |
| 6 | Every send is logged with status | **PASS** | Message log lists the approved message; device delivery report → status `sent` (200); `messages/log?status=sent` shows it. Audit log contains `attendance.submit`, `fee.pay`, `message.approve`, `student.create`, `class.link_regenerate`. |

## 3. Edge cases (all live unless noted)

| Case | Result |
|---|---|
| Duplicate student (same name + phone) | 409 rejected |
| Duplicate roll number | 409 rejected |
| Invalid PK phone on student create (`12345`) | 400 rejected ("Parent phone is not a valid Pakistani mobile number") |
| Parent opt-out | No draft, no reminder; job counts it in `skipped_opt_out` |
| Missing parent phone | No draft; job counts it in `skipped_no_phone` |
| Sunday submission | Blocked — live service-level probe (public route has no date override; tested via real service + real DB): `409 No attendance on Sundays or holidays` for 2026-11-08 (Sunday) |
| Holiday submission | Blocked live — after unlock, submit on a holiday returns 409 and the error names the holiday rule (verified in E2E log) |
| Leave / late statuses | Live probe 2026-11-09: present 9, late 1, leave 1, absent 1 — recorded correctly; re-submit same day 409 |
| Leave application create | 201; `fromDate`/`toDate` stored as dates (see §5.2) |
| Partial fee payment (500/2000 → 1500/2000) | Status `partial` → `paid`; receipt number unchanged across the two payments |
| Overpayment | 400 rejected ("exceeds the remaining balance of 0 PKR") |
| Receipt-number uniqueness under rapid payments | 5 rapid pays (2 correctly rejected as already-paid); receipts `…-003`, `…-004`, `…-005` sequential; DB: 8 paid rows / **8 distinct receipt numbers**, zero collisions across students |
| Duplicate OCR confirm | 0 saved, 12 skipped |
| Expired / revoked / random teacher token | Revoked → 404; random 64-hex token → 404 |
| Cross-tenant access | Demo admin cannot see QA class 2-A; `GET` QA class as demo admin → 404 |
| Forged `school_id` in create-class body | 400 |
| Clerk role | Create-clerk 403; approve 403; **can** mark fee paid 201 (allowed by design) |
| No token / bad token | Both 401 |
| Device wrong key | 401 |

## 4. Security / privacy review

| Area | Finding |
|---|---|
| JWT | Access tokens required on all admin routes; no-token and bad-token both 401. Verified live. |
| Rate limiting | **Works.** 22 rapid failed logins: attempts 1–11 → 401, attempts 12–22 → **429** (tripped at 12 because earlier logins in the same 15-min window counted toward the 20/15-min budget). Note: this probe locked localhost logins for up to 15 min afterwards; the limiter is in-memory, so a server restart clears it. |
| Phone masking | Pending-approval response shows `+92 3XX XXXX333` only. A grep of the full pending-approval JSON found no 11-digit PK number. |
| Phones at rest | DB check: **0 rows** contain plaintext `0300`/`032` in `parentPhoneEnc`; 35 rows hold ciphertext. Encryption is AES-256-GCM, canonical `base64(iv‖tag‖ct)` layout. |
| Phone decryption round-trip | Device poll returned the decrypted number `+923002223333` for the approved message — the seeded/created phone decrypts correctly under the QA key. |
| Teacher-link tokens | 64-hex-char crypto-random token; only its SHA-256 hash is stored; expiry enforced; revoke → 404. |
| Audit log | Mutations audited: `attendance.submit`, `attendance.unlock`, `fee.pay`, `fee.structure.create`, `message.approve`, `student.create`, `class.link_regenerate`, `auth.signup`, `holiday.create/delete`, `leave.create`, `session.create`. Verified live via `GET /audit-logs`. |
| Device auth | School-scoped derived key `HMAC-SHA256(SMS_DEVICE_SECRET, "device:<schoolId>")`, sent via `X-Device-Key`. The `api_key` is shown once at registration and never returned again. |

## 5. Bugs found live and fixed (all re-verified green)

### 5.1 BUG #1 — `fee_records.status` GENERATED ALWAYS vs Prisma `@default` (critical, pre-existing in this pass)
`prisma/schema.prisma` declared `status @default("unpaid")` but Postgres defines it `GENERATED ALWAYS`; Prisma sent it on every INSERT, so seed and all fee-record creation failed. Fixed by declaring the field `@default(dbgenerated("(CASE WHEN...)"))` with a comment warning against `migrate diff` drift. (Found and fixed earlier in this QA pass; seed then produced 23 unpaid / 2 paid.)

### 5.2 BUG #2 — Prisma `@db.Date` rejects plain `YYYY-MM-DD` strings (CRITICAL)
`Invalid value for argument 'date': premature end of input. Expected ISO-8601 DateTime`. Live impact before the fix: `GET /t/:token` 500, attendance submit 500, dashboard 500, teacher-attendance mark 500, holiday create 500 — **the entire attendance flow was broken on a live DB**. Unit tests passed only because fakes don't validate. Fix: new `dateOnly()` helper in `src/lib/dates.ts` (`new Date(s + 'T00:00:00.000Z')`) and used at every `@db.Date` read/write: `lib/dates.ts` (holiday lookup), `modules/attendance/service.ts` (getClassDay, submit create, teacher-attendance find/create, list filter), `modules/admin/service.ts` (dashboard ×2, holiday create, session create, leave create), `modules/reports/service.ts` (range gte/lte). Fees module was already correct. Test fakes were also fixed to compare dates by value (see §6).

### 5.3 BUG #3 — Newly signed-up school has NO message templates; monthly fee job crashes (critical)
Signup created no template rows, so `monthly_fee_reminder` threw `No active fee_reminder template` and reminded nobody. Fix (two layers): (a) `jobs/common.ts loadTemplate` now falls back to the built-in `DEFAULT_TEMPLATES` when a school has no rows, so a job can never crash for a missing row; (b) `modules/auth/service.ts` signup now seeds all 6 default templates (absent / fee_reminder / teacher_reminder × en + ur). Regression test added: signup asserts 6 templates seeded.

### 5.4 BUG #4 — Android companion app could NEVER poll or report delivery (critical)
Device-key-only requests to `/sms/devices/:id/queue` and `/delivery` returned **401 "Missing or invalid Authorization header"** even with a valid device key. Root cause: `attendanceRouter` mounts a sub-router with `authed.use(authenticate, requireSchool)` — a router-level `use()` that runs for *every* request falling through that router, including paths owned by later-mounted routers. Fix: (a) `modules/attendance/routes.ts` — auth is now applied **per-route** on the 5 admin attendance routes instead of via `authed.use()`; (b) `src/app.ts` — the messaging router is mounted right after the attendance router, before `studentsRouter`/`adminRouter` (which also globally authenticate `/api/v1`). Verified live: device-key-only poll now returns the approved message; public `/t/:token` still works without auth; JWT routes still 401 without a token.

### 5.5 BUG #5 — `prisma db seed` silently did nothing (minor)
`package.json` had no `prisma.seed` config, so `prisma db seed` exited 0 with no output and an empty DB. Fixed by adding `"prisma": { "seed": "tsx prisma/seed.ts" }`; verified `prisma db seed` now seeds (idempotent).

## 6. Test-harness fixes (not app bugs)

- `src/modules/attendance/attendance.test.ts`: fake compared dates with `===`, which never matches a `Date` vs string (or two `Date` instances). Added a value-based `same()` comparator for `holiday.findFirst` / `attendanceDay.findFirst` — this is what made the double-submit and holiday unit tests meaningful again.
- `src/modules/auth/auth.test.ts`: fake DB gained `messageTemplate.createMany`; signup test now asserts the 6 seeded templates.
- `~/workspace/tmp/qa-e2e.sh` (harness, not the app): fixed psql column names to quoted camelCase (`"studentId"`, `"schoolId"`, `"dedupeKey"`), fetched the demo school id dynamically (the seed regenerates it), corrected expected statuses to 201 for resource creation (OCR upload, attendance submit, teacher-attendance mark), fixed pending-approval jq fields to camelCase (`studentName`, `dedupeKey`), changed unlock to `PATCH` (the route is PATCH, not POST — the earlier 404 was the harness's fault), fixed a jq `//` bug (`false // empty` yields empty, so the job-guard check could never pass), and added a check that the holiday rejection names the holiday rule.

## 7. Still failing / unverified

| Item | Severity | Note |
|---|---|---|
| Login does NOT require email verification | Low (product decision) | An unverified admin can use the platform fully. Flagged, not changed — needs Majid's call. |
| About Us section (photo + details) | Unverified | Frontend builds fine, but this QA pass did not live-check the rendered About Us section (separate Vite app; visual check not done here). |
| Real Android device + real SIM SMS send | Unverified | No physical device in this environment. Device API verified end-to-end via curl (register → poll → delivery → `sent` in log); actual on-phone SMS dispatch not tested. |
| Gateway SMS provider path | Unverified | No gateway credentials in QA; SIM path tested. |
| Sunday scheduled jobs (`pending_attendance`, `teacher_reminder` on a Sunday) | Unverified live | Sunday *submission* block is proven live at the service level; the Sunday job-skip branches were not run live. |
| Production secrets | Action needed | QA used throwaway secrets. `PHONE_ENC_KEY` must be backed up before any real deployment — seeded/created phones only decrypt under it. |

## 8. How to reproduce this pass

```bash
# DB + seed
sudo -u postgres psql -d postgres -c "DROP DATABASE IF EXISTS school_qa" -c "CREATE DATABASE school_qa OWNER qa"
cd backend && npx prisma migrate deploy && npx prisma db seed
# API (env from ~/workspace/tmp/qa.env)
node dist/server.js            # :4000
# Full live E2E (66 checks)
bash ~/workspace/tmp/qa-e2e.sh # log: ~/workspace/tmp/qa-e2e.log
# Static
npm run build && npx vitest run
cd src/modules/ocr/tests && npm run test && npm run test:e2e && npx tsx smoke.ts
cd ../../../../frontend && npm run build
```
Note: the server must be stopped before `DROP DATABASE` (it holds pooled connections). After the rate-limit probe, restart the server to clear the in-memory login lock.
