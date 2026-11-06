# INTEGRATION.md — Phase 3 (integration)

Merged the six Phase-2 modules into one working system. No module was
rewritten; only integration seams were fixed. Contracts (`contracts/`) were
not touched. The frontend was not touched (its build was only verified).

## 1. What was mounted (`src/app.ts`, `src/server.ts`)

All routers live under `/api/v1` per `contracts/API.md`. Mount order matters:
the attendance router stays FIRST because it owns the public `/t/:token`
link routes (no auth).

| Mount | Router | Auth |
|---|---|---|
| `/api/v1/auth` | `authRouter` | — (login/signup) |
| `/api/v1` | `attendanceRouter` | public `/t/:token` + authed sub-router |
| `/api/v1/classes` | `classesRouter` | `authenticate, requireSchool` |
| `/api/v1` | `studentsRouter`, `parentsRouter` | `authenticate, requireSchool` |
| `/api/v1/reports` | `reportsRouter` | `authenticate, requireSchool` |
| `/api/v1` | `adminRouter` | `authenticate, requireSchool` |
| `/api/v1` | `createOcrRouter(...)` | composed `authWithTenant` (see below) |
| `/api/v1` | `createMessagingRouter(...)` | composed `authWithTenant` + `requireAdmin` |
| `/api/v1/fees` | `feesRouter` | own `authenticate, requireSchool` |
| `/api/v1/jobs` | `jobsStatusRouter` | own `authenticate, requireSchool` + `requireAdminOrClerk` |

* `authWithTenant` (new, `src/app.ts`) composes `authenticate` +
  `requireSchool` into one handler. `authenticate` alone only sets
  `req.user`; the OCR and Messaging routers also need `req.schoolId`, and
  both take a single `auth`/`requireAuth` dependency, so the pair is
  composed once in `app.ts` instead of inside the modules.
* OCR wiring: `createOcrRouter({ db: prismaOcrDb(getDb()), auth: authWithTenant, uploadDir: <UPLOAD_DIR>/ocr })`.
  Messaging wiring: `createMessagingRouter({ store: createPrismaMessagingStore(getDb()), requireAuth: authWithTenant, requireAdmin })`.
* Jobs: `registerJobs(getDb())` in `src/server.ts` (4 cron ticks); `jobs.stop()`
  on shutdown. `node-cron@3.0.3` + `@types/node-cron@3.0.11` are saved in
  `backend/package.json` (the Fee agent had installed them `--no-save`).

## 2. The central defect: Prisma field naming (repo-wide)

The schema, the generated client and the seed use **camelCase** Prisma
fields (`schoolId`, `parentPhoneEnc`, `dedupeKey`, `rollNo`, `createdAt`).
The Backend modules used **snake_case** in Prisma queries and row reads
(`school_id`, `parent_phone_enc`, …) — every such query throws
"Unknown argument" at runtime. Fixed in 9 files (377 mechanical
replacements via a reviewed script, `~/workspace/tmp/rename_prisma.py`,
plus hand fixes — see §3):

* `src/lib/audit.ts`, `src/lib/dates.ts`
* `src/modules/{attendance,students,classes,admin,reports,auth}/service.ts`
* `src/modules/messaging/store.ts`

**What was deliberately NOT renamed** (API wire formats are snake_case by
contract and must stay that way):

* Input DTO interfaces + reads (`input.name_ur`, `patch.class_id`,
  `SubmitInput.records[].student_id`, zod schemas, query params).
* `toPublic*` / view / return object KEYS (`school_id: s.schoolId` —
  key stays, value fixed).
* JWT claims (`school_id` in `AccessPayload`, `req.user.school_id` in
  `middleware/tenant.ts`) and the `signAccessToken` payload key.
* Settings JSONB keys (`sms_provider`, `message_language`, …) and audit
  `details` JSON keys.
* The OCR module's internal `OcrDb` interface shapes (translated at the
  adapter boundary instead — see §5).
* CSV header strings, template variables (`{student_name}`), job result
  DTO keys.

**Latent bugs found and fixed while renaming:**

* `src/lib/tokens.ts` — `signAccessToken`/`signRefreshToken` read
  `user.school_id` off Prisma rows (camelCase `schoolId`), so the JWT
  `school_id` claim would have been `undefined` and **every authenticated
  request would 401**. Now reads `user.schoolId`; the claim name stays
  `school_id`.
* `src/modules/attendance/service.ts` — `editAttendance` did
  `const date = day.date as string`; `day.date` is a Prisma `@db.Date`
  (a `Date` object), so the dedupe `contains: ':${date}'` match never
  matched and `date.slice(0, 7)` would throw. Now formats to `YYYY-MM-DD`.
* Same file — `markTeacherAttendance` built its Prisma `data` object as a
  standalone literal with snake_case keys (`school_id`, `marked_by`).
  Fixed to camelCase.

## 3. Attendance → Messaging wiring (`submitAttendance`)

The inline draft-creation block in `submitAttendance` was replaced with
the canonical call (`messaging/MOUNT.md` §3):

```ts
const store = createPrismaMessagingStore(db);
const draftResult = await buildAbsentDrafts({ store }, {
  school: { id, name, timezone, smsProvider },
  classId, className, date,
  records: students.map(s => ({ studentId: s.id, status: statuses.get(s.id)! })),
  students: students.map(s => ({ id, name, classId, parentName, parentPhoneEnc, parentOptOut })),
  language: lang, // from school.settings.message_language
});
```

* `drafted = draftResult.created`; `students_without_valid_number` =
  skipped reasons `missing_phone` / `invalid_phone` / `opted_out`
  (same meaning as the old inline code, which also listed opted-out
  parents there). `already_queued` is not listed — the draft already
  exists and will go out after approval.
* The `absent_approval` notification is still created here (attendance
  owns it; `buildAbsentDrafts` does not create notifications).
* `editAttendance` keeps its own inline re-sync logic (it also **cancels**
  unapproved drafts for students who are no longer absent — a different
  flow `buildAbsentDrafts` does not do), with field names fixed only.

**Fee/scheduler hooks — deliberately NOT rewired.** The jobs
(`src/jobs/fee-reminders.ts`, `teacher-reminders.ts`,
`pending-attendance.ts`) already implement the reminder logic directly
and write `message_queue` rows themselves, complete and tested. Rewiring
them to `buildFeeReminderDrafts` / `buildTeacherReminderDraft` would be
churn on tested code. The integration point is the shared
`message_queue` table + dedupe keys, which the messaging
approval/device flow consumes. If a future change wants the builders,
the call shapes are in `messaging/MOUNT.md` §4.

## 4. Phone/crypto dedup — ONE implementation

Canonical: `src/lib/crypto.ts`, wire format `base64(iv||tag||ciphertext)`
(AES-256-GCM, key from `PHONE_ENC_KEY` via `src/config.ts`).

* `src/modules/ocr/crypto.ts` — was a **different** format
  (`base64(iv):base64(ct):base64(tag)`). Now re-exports lib/crypto's
  `encryptPhone`/`decryptPhone`. Seeded data only decrypts under the
  canonical format, so this was a real incompatibility, not just
  duplication.
* `src/modules/ocr/phone.ts` — re-exports `normalizePhone` as
  `normalizePkPhone`, `sha256Hex` as `hashPhone`, `maskPhone`.
  **Exception:** `normalizeName` stays local — the OCR parser strips
  punctuation (`"Fatima-Khan"` → `"fatimakhan"`, asserted in
  `tests/parser.test.ts`); lib's version only strips diacritics.
* `src/modules/messaging/phone.ts` — re-exports `normalizePhone` as
  `normalizePK`, `isValidPhone` as `isValidPK`, `maskPhone`, `sha256Hex`
  as `hashPhone`, `encryptPhone`, `decryptPhone`. Only `deriveDeviceKey`
  stays local (messaging-specific HMAC over `SMS_DEVICE_SECRET`).
  `getPhoneKey` is gone (nothing used it; the key now comes from config).
* Behaviour notes: lib's `normalizePhone` also accepts the `0092…`
  international prefix (the old OCR helper rejected it; no test asserted
  the rejection). lib's `maskPhone` returns `null` for nullish input
  (old messaging helper returned a placeholder string); the one call site
  (`messaging/service.ts` pending-approval list) keeps the same
  placeholder via `??`. The OCR `phone-crypto` test was rewritten for
  the canonical format (see §7).

## 5. OCR adapter rewrite (`src/modules/ocr/prisma-adapter.ts`)

The adapter used wrong model names (`prisma.classes/students/ocr_uploads/
audit_logs`) and snake_case fields — both would throw at runtime. Rewritten
to the real generated client (`prisma.class/student/ocrUpload/auditLog`,
camelCase fields) with boundary mapping: Prisma camelCase rows → the
`OcrDb` snake_case records on the way out, `OcrDb` snake_case inputs →
Prisma camelCase on the way in. The `OcrDb` interface, service and tests
are unchanged.

## 6. Other integration fixes

* `src/modules/ocr/routes.ts` — `AuthedRequest` redeclared `user` as
  `{id, role?}`, conflicting with the global `Express.Request.user:
  AccessPayload`. Removed the local declaration (inherits the global one)
  and switched `req.user?.id` → `req.user?.sub` (2 places).
* `src/middleware/errors.ts` — the Messaging module (and device auth)
  throw plain `Error`s carrying a `.code` (`NOT_FOUND`, `VALIDATION`,
  …), which fell through to 500. Added a branch mapping known codes:
  VALIDATION 400, UNAUTHORIZED 401, FORBIDDEN 403, NOT_FOUND 404,
  CONFLICT 409, RATE_LIMITED 429. `ApiError` and `P2002` handling
  unchanged.
* `src/modules/messaging/service.ts` — one type fix from the dedup:
  `maskPhone` now returns `string | null`; the pending-approval list
  keeps its `'+92 3XX XXXX???'` fallback via `??`.
* `src/modules/attendance/attendance.test.ts` — fake DB rows moved to
  camelCase (class/student/holiday/queue rows + assertions) so the fake
  matches the real client; the fake `messageQueue.create` now applies
  the DB defaults (`approvedBy: null`, `approvedAt: null`, …) so a
  freshly created draft reads exactly like a real Prisma row.
* `backend/tsconfig.json` — excluded `src/modules/ocr/tests`: that
  harness is ESM (`import.meta.url`, own NodeNext tsconfig + tsx runner)
  and cannot compile under the backend's `commonjs` tsconfig.
  (Rewriting the two `import.meta.url` uses to `__dirname` would break
  the ESM harness instead.)
* `src/modules/ocr/tests/tsconfig.json` — `rootDir` widened to `src/`
  and `src/types/express.d.ts` included, so the harness still
  type-checks after the dedup pulled `src/lib/crypto.ts` (+ config) and
  the global `Request.user` augmentation into its program.
* `backend/vitest.config.ts` (new) — excludes `src/modules/ocr/tests`
  from vitest: those tests use `node:test`, which vitest cannot collect
  ("No test suite found"). They run under their own tsx harness (§7).

## 7. Verification (all run 2026-11-06, this VM — no Postgres available)

| Check | Result |
|---|---|
| `npx tsc --noEmit` (backend) | **0 errors** (was 7: 5× OCR routes + 2× `import.meta`) |
| `npx tsc -p src/modules/ocr/tests/tsconfig.json --noEmit` | **0 errors** |
| `npm run build` (backend) | **ok** (`dist/` emitted) |
| `npx vitest run` | **8 files, 80 tests, all pass** (was 6 failing before the fake/rename fixes) |
| OCR tsx harness (`tsx --test parser phone-crypto service ocr-engine`) | **27 pass, 0 fail** |
| OCR e2e (`tsx --test e2e.test.ts`, real Tesseract eng+urd) | **1 pass** |
| OCR smoke (`tsx smoke.ts`, real HTTP + real Tesseract) | **PASS** (upload 12 rows → review → confirm 12 → duplicate guard → non-image 400) |
| Prisma arg validation, no DB (`~/workspace/tmp/prisma-arg-check.cjs`, dummy `DATABASE_URL`) | **52/52 query shapes accepted** by the real generated client (every where/data/orderBy/groupBy shape the services use; failures would be "Unknown argument") |
| Boot test (`node dist/server.js`, dummy DB) | listens; `/health` 200; `/classes`, `/jobs/status`, `/ocr-uploads/:id`, `POST /classes/:id/ocr-upload`, `/messages/pending-approval`, `/fees` all **401 without a token** (routers mounted + auth enforced); `/t/badtoken` reaches the handler (500 only because there is no DB to query) |
| `npm run build` (frontend) | **ok** (untouched) |
| `fee_records.status` writes repo-wide | **none** (grep-verified; the column is GENERATED, read-only) |

## 8. What remains for QA (Phase 4)

* **Live-DB checks** — everything above is client-side/static except the
  OCR smoke test. With a real Postgres: run the migrations, seed, sign
  up, create a class, submit attendance via a real token link, approve
  an absent draft in `/messages/pending-approval`, and confirm the
  device-poll flow end to end. The 52-shape arg check strongly suggests
  no "Unknown argument" surprises, but only a live run proves the flows.
* **Pre-existing quirk (not introduced here):** unknown `/api/v1/*`
  paths return **401, not 404**, because `adminRouter`/`studentsRouter`/
  etc. apply `authenticate` at router level and catch every `/api/v1/*`
  path before `notFoundHandler`. Decide in QA whether to keep that.
* **Env vars the server needs:** `DATABASE_URL`, `PHONE_ENC_KEY`
  (32-byte base64), `JWT_SECRET`, `JWT_REFRESH_SECRET`,
  `SMS_DEVICE_SECRET`, `UPLOAD_DIR`, `OCR_PROVIDER`/`OCR_LANGS`,
  `SMS_GATEWAY_*` (optional). Without `PHONE_ENC_KEY` the server boots
  with an ephemeral dev key (config warning) — encrypted numbers will
  not survive restarts.
* **Server setup:** `tesseract-ocr` + `tesseract-ocr-urd` must be
  installed (`tesseract --list-langs` must show `eng` and `urd`),
  otherwise OCR uploads return 503 `OCR_UNAVAILABLE` by design.
* **Frontend "About Us" section** (user order 2026-11-06 17:01 PKT —
  photo in a round circle, details below) is the Frontend agent's job;
  integration only confirmed the frontend build still passes.
* **Known limitation:** `buildAbsentDrafts` renders templates with
  `{student_name, class, date, school_name}` only. The old inline
  attendance code also passed `{month, amount}` — irrelevant for the
  absent template, but a custom absent template using `{month}` would
  now render literally. Flagged, not fixed: the builder owns template
  rendering by design.
