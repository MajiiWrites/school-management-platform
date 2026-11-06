# Tenant Isolation Audit — School Management Platform v2

Date: 2026-11-06 · Auditor: agent 6A-2 · Scope: every Prisma query in
`backend/src` (all `findFirst` / `findUnique` / `findMany` / `create` /
`update` / `delete` / `upsert` / `groupBy` / `aggregate` / `$queryRaw` —
214 grep hits, zero `$queryRaw` / `$executeRaw` in the codebase) plus every
route handler. Rule: `school_id` comes ONLY from the JWT
(`req.schoolId` / `req.user.school_id`, set by `authenticate` +
`requireSchool`); a client-supplied `school_id` in body/query is rejected
with 400 by `middleware/tenant.ts`. Phone crypto unchanged
(AES-256-GCM, base64 `iv||tag||ct`). API envelope / wire formats unchanged.

## Verdict

**No live cross-tenant data leak was found in the already-guarded paths**
(most services already checked ownership explicitly), but **7 real gaps**
were found and fixed — 2 HIGH (cross-tenant disclosure / device hijack),
5 MEDIUM/LOW (unscoped store/adapter methods that relied on a single
caller-side check). All fixes are covered by regression tests below.

## Gaps found and fixed

| # | Severity | Gap (before) | Fix (after) | File:line |
|---|----------|--------------|-------------|-----------|
| G1 | HIGH | `GET /jobs/status` returned **every school's** job history (ids, slugs, last-run state) to any authenticated user — `getJobsStatus()` listed all schools and the route ignored `req.schoolId`. | `getJobsStatus(db, schoolId?)` filters to the requesting school; the route now passes `schoolIdOf(req)`. Server-side callers (no user context) may still omit it. | `src/jobs/registry.ts:185,194`, `src/jobs/status-router.ts:26` |
| G2 | HIGH | `smsDevice.upsert` by globally-unique `device_id`: school B registering school A's `device_id` **silently reassigned the device to B** (A cut off from its own SIM queue). | `upsertDevice` first reads the row; if it exists under another school it throws `CONFLICT` (`device_id is already registered to another school`). Same-school re-register still works. | `src/modules/messaging/store.ts:433` |
| G3 | MEDIUM | `MessagingStore.getStudentsByIds(ids)` looked students up by id **with no school filter** — any caller passing foreign ids got foreign names. | Signature is now `getStudentsByIds(ids, schoolId)`; Prisma query is `where: { schoolId, id: { in: ids } }`. Route + fake stores updated. | `src/modules/messaging/store.ts:229`, `src/modules/messaging/routes.ts:132` |
| G4 | MEDIUM | `findQueueByDedupeKey` / `getQueueById` / `getTemplateById` / `updateTemplate` / `updateQueue` in the Prisma messaging store were **unscoped by id**; only some callers checked ownership afterwards. | Each takes an optional `schoolId`: lookups return `null` on mismatch, updates throw `NOT_FOUND` on mismatch. All service callers (`buildAbsentDrafts`, `buildFeeReminderDrafts`, `buildTeacherReminderDraft`, `approveMessages`, `editQueueBody`, `retryFailed`, `getDeviceQueue`, `reportDelivery`) and the template route now pass the JWT school. | `src/modules/messaging/store.ts:277,284,299,374,380`, `src/modules/messaging/service.ts:188,268,327,487,502,531,543,563,572,622,647,653` |
| G5 | MEDIUM | `OcrDb.updateUpload(uploadId, …)` updated **by id alone** — any holder of another school's upload id could overwrite its status / `raw_text`. (`getUpload` was already scoped; the write was not.) | Signature is now `updateUpload(schoolId, uploadId, …)`; the adapter verifies ownership with a scoped read first and throws 404 otherwise. Service call sites (3) + both `ocr/tests` fakes updated. | `src/modules/ocr/prisma-adapter.ts:95`, `src/modules/ocr/service.ts:35,98,110,216` |
| G6 | LOW | `attendance.getClassDay()` looked up days by `(classId, date)` with no school; `editAttendance`'s dedupe re-check used unscoped `findUnique({ dedupeKey })`. | `getClassDay(db, classId, date, schoolId?)` scopes by school at all 4 call sites; dedupe re-check is now `findFirst({ schoolId, dedupeKey })`. | `src/modules/attendance/service.ts:34,51,130,249,329,367` |
| G7 | LOW | Promotion transaction re-read the student (and never re-checked the class) by id alone inside `$transaction`. | Tx re-reads are now `findFirst({ id, schoolId })` for both student and target class, throwing if either is foreign. | `src/modules/admin/service.ts:251` |

## Hardening (defence in depth, behaviour-preserving)

- Teacher link: `resolveLinkToken(db, token, expectedSchoolId?)`
  (`src/modules/classes/service.ts:137,142`) — the public `/t/:token` flow
  is still bearer-token by hash alone (no JWT exists there, by design), but
  any caller WITH a school context can now pass it and a foreign token
  resolves to `null` (404). `getLinkPage` / `submitAttendance` accept the
  same optional context (`src/modules/attendance/service.ts:41,77,106`).
- Reports fee-monthly student join is now
  `where: { schoolId, id: { in: studentIds } }`
  (`src/modules/reports/service.ts:140`).
- Fees: receipt path re-checks `student.schoolId` and scopes the class
  re-reads (`src/modules/fees/service.ts` — `getReceiptByNo`,
  `updateFeeStructure`, `payFee`).
- Students: duplicate-name and roll-number checks now include `schoolId`
  (`src/modules/students/service.ts` — `findDuplicate`, `assertRollUnique`,
  import roll check); class student counts in `classes/service.ts`
  (`getClass`, `deleteClass`) are now `where: { classId, schoolId }`.

## Per-resource audit table

| Resource / endpoint | Scoping check | Test | Result |
|---|---|---|---|
| Tenant middleware (`requireSchool`) | Rejects `school_id` in body/query (400); sets `req.schoolId` from JWT only | forged `school_id` body + query; forged id in create-class body ignored | PASS |
| Classes `POST/GET/PATCH/DELETE /classes`, link regenerate/revoke | All `findFirst({id, schoolId})`; create writes JWT school only; uniqueness is per-school | B read/update/delete/re-link A class → 404; same `5-A` exists in both schools | PASS |
| Students `POST/GET/PATCH/DELETE /classes/:id/students`, `/students/:id` | Class asserted in-school first; all reads `findFirst({id, schoolId})`; `class_id` moves re-validated | B read/update/delete A student → 404; B create in A class → 404; B cannot move own student into A class | PASS |
| Student search + Parents `GET /parents` | Lists are `where: {schoolId, classId}` (+ search `OR` inside that scope) | B searching `Ahmed Raza` / `Sara Ahmed` → 0 results; B parents list has no A student | PASS |
| Fees structures / list / pay / receipts | `createFeeStructure` checks class school; update/delete check structure school; `payFee` checks student school; receipt `findFirst({schoolId, receiptNo})` | B pay A student → 404; B fetch A receipt → 404; B structure ops on A class → 404; B list/report exclude A's PKR 2500 | PASS |
| Dashboard `GET /dashboard` | Every aggregate `where: {schoolId}` | B dashboard: `classes_total`=2, present/absent/fee-collected count B only | PASS |
| Reports attendance daily/weekly/monthly, fees monthly | `loadRange` ANDs `schoolId` with any `class_id`; fee-monthly join scoped (hardened) | B reports with A `class_id` → empty; B fee report `collected`=0 | PASS |
| Attendance admin (get/unlock/edit, teacher-attendance) | Class/day lookups scoped; `getClassDay` hardened (G6) | B get/unlock/edit A day → 404; B mark teacher attendance for A class → 404; B list filtered by A class → [] | PASS |
| Public teacher link `GET/POST /t/:token` | Token = hash-only bearer credential (by design); students validated against the token's class; optional school-context check added | B + A token + B context → 404; token alone still works (public flow); smuggled foreign student id → VALIDATION (400) | PASS |
| Messaging approval (`/messages/approve`, queue edit/retry) | Approve selects only from `listPendingApproval(schoolId)`; edit/retry/report check `row.schoolId` + scoped store (G4) | B approving A dedupe key / group → 0 approved; B edit/retry/report-delivery on A row → 404 | PASS |
| Messaging templates | List scoped; get/update scoped at route + store (G4) | B template lookup/update of A template → null / 404; B list = own 6 only | PASS |
| Messaging devices (`/sms/devices/*`) | Device key = `HMAC(secret, device:<schoolId>)`; poll/delivery check `device.schoolId`; hijack blocked (G2) | B polling with A `device_id` → 404; B registering A `device_id` → 409; B device receives only B rows | PASS |
| Messaging store lookups | Scoped (G3, G4) | Prisma-adapter tests: student/dedupe/queue/template lookups return null for B; updates throw 404 | PASS |
| OCR uploads (`/ocr-uploads/:id`, confirm) | `getUpload` scoped; `updateUpload` scoped (G5) | B review/confirm A upload → 404; adapter update cross-school → 404; A upload untouched | PASS |
| Admin users / settings / holidays / sessions / promotions / leaves / audit / notifications | All `findFirst({id, schoolId})` (or scoped lists); promotion tx hardened (G7); clerk email is globally unique by design (conflict, not leak) | B delete A user/holiday → 404; B settings change touches B only; B promote A student → VALIDATION; B leave ops → 404; B logs/notifications contain no A rows | PASS |
| Jobs `GET /jobs/status` | Scoped to requesting school (G1) | `getJobsStatus(db, B)` returns only B; unscoped server-side call still returns all | PASS |
| Scheduler jobs (fee/teacher/pending) | Registry loops schools and passes one `SchoolRow` per run; every job query is `where: {schoolId: school.id}` | Code audit (per-school `schoolDayInfo`, `loadTemplate`, `notifyOnce`, `queueRowExistsToday` all scoped); no cross-school query found | PASS (audit) |
| Auth signup / verify / login / refresh / reset | Email is globally unique (CITEXT); refresh re-checks `user.schoolId === payload.school_id`; verify/reset tokens are random bearer hashes (by design, not tenant ids) | Signup seeds exactly 6 templates per school, each `schoolId`-owned, no shared rows (2-signup test) | PASS |
| Shared/global data paths | Grep: no `findMany({})` / unscoped list / "most common" / cross-school search / shared template pool anywhere in `src` | Signup seeds per-school copies (6 each); `loadTemplate` falls back to built-in *constant* defaults only, never another school's row | PASS |

## Notes / accepted-by-design (not gaps)

- **Email addresses are globally unique** (`users.email` CITEXT UNIQUE):
  `createClerk` / `signup` return 409 when the email exists in another
  school. That reveals only *existence* of an email, the same as login —
  it cannot create or take over the other school's account.
- **Verify / reset / attendance-link tokens are bearer credentials**
  (random 256-bit hashes). They are not tenant ids and are intentionally
  looked up globally; possession of the token *is* the authorization.
- **Device API key is school-scoped, not per-device**
  (`HMAC(SMS_DEVICE_SECRET, "device:<schoolId>")`, per API.md). Any device
  of a school shares the school key; a leaked key affects that school only.
- `attendanceRecord` has no `schoolId` column (reached via its day, which
  is scoped); `deleteStudent`'s history counts use the already-scoped
  student id. Both are safe by construction, noted for completeness.

## Verification

- `npx tsc --noEmit` in `backend/`: **0 errors**.
- `npx vitest run` in `backend/`: **9 files, 125 tests, all passing**
  (baseline 80 + **45 new** cross-tenant tests in
  `src/modules/isolation/__tests__/cross-tenant.test.ts`).
- `npx tsx --test` OCR harness (`src/modules/ocr/tests/service.test.ts`):
  **4/4 passing** (vitest excludes this harness by design).
- **Live-DB probe** `bash src/modules/isolation/live-cross-tenant.sh`:
  **28/28 probes PASS** against real Postgres 16 (cluster `16 main`) on a
  scratch DB `school_isolation_probe` with two seeded schools, real service
  functions and real Prisma adapters. Scratch DB + probe role dropped
  afterwards (verified: no `school_isolation_probe` DB / `isolation_probe`
  role remains). The live Render DB was never touched (script refuses any
  non-local `DATABASE_URL`).
- Live-probe notes: `live-seed.ts` / `live-probe.ts` sit next to the test
  file under `src/modules/isolation/`; the shell script is the entry point.
  One probe-script bug was found and fixed during the run (a non-UUID actor
  id passed to `payFee` tripped Prisma's UUID validation — the app code was
  correct; the probe now uses the seeded admin UUID).
