# Features 6C-1 — Sessions, Exams, Timetable, Staff & Payroll

Date: 2026-11-06. Agent: 6C-1. Schema/migrations untouched — every table
already existed (v2 schema). No live DB touched (fake-DB vitest only; see
§Verification).

## Endpoints (base `/api/v1`, envelope `{ok, data}`, school from JWT only)

### Sessions (`backend/src/modules/sessions/`)
| Endpoint | Role | Notes |
|---|---|---|
| `GET /sessions` | any authed | Paginated; `?archived_only=true` / `?include_archived=false` |
| `POST /sessions` | admin | `{name, start_date, end_date}`; duplicate name per school → 409 |
| `GET /sessions/:id` | any authed | Includes `is_archived` |
| `PATCH /sessions/:id` | admin; clerk → queue | `{name?, start_date?, end_date?}`; 409 when archived |
| `DELETE /sessions/:id` | admin; clerk → queue | Guarded hard delete (see below) |
| `POST /sessions/:id/make-current` | admin | Exactly one current session (tx) |
| `POST /sessions/:id/archive` | admin; clerk → queue | Read-only afterwards; clears current |
| `POST /sessions/:id/unarchive` | admin | |
| `POST /sessions/:id/promote` | admin | `{from_class_id, to_class_id}` — whole class-section |
| `GET /sessions/:id/promotions` | any authed | Promotion history for the session |

The sessions router is mounted **before** adminRouter in `app.ts` and
supersedes the v1 admin session routes (same paths, snake_case public views
+ `is_archived` + PATCH/DELETE/archive/promote). `GET /sessions` and
`POST /sessions/:id/make-current` keep the v1 contract the Settings page
relies on.

### Exams (`backend/src/modules/exams/`)
| Endpoint | Role | Notes |
|---|---|---|
| `GET /exams?session_id=&search=&include_archived=` | any authed | Archived-session exams excluded by default |
| `POST /exams` | admin; clerk → queue | `{name, session_id?, start_date?, end_date?}` |
| `GET /exams/:id`, `PATCH /exams/:id` | any / admin; clerk → queue | |
| `DELETE /exams/:id` | admin; clerk → queue | Soft delete → recycle bin |
| `GET /exams/:id/datesheet?class_id=` | any authed | |
| `POST /exams/:id/datesheet` | admin; clerk → queue | `{class_id, subject, date, start_time, end_time}` |
| `PATCH /exams/datesheet/:id`, `DELETE /exams/datesheet/:id` | admin; clerk → queue | |
| `GET /grading-scales?class_id=` | any authed | Class bands first, then school defaults |
| `POST /grading-scales` | admin; clerk → queue | `{class_id?, min_marks, max_marks, grade, gpa_points, is_passing?}` |
| `POST /grading-scales/seed-defaults` | admin | A+..F bands (see below); 409 if defaults exist |
| `PATCH /grading-scales/:id`, `DELETE /grading-scales/:id` | admin; clerk → queue | |
| `GET /grading-scales/passing?class_id=` | any authed | `{passing_marks, grade, source}` |

This module owns exam **definitions** only. Results (sheets, marks,
toppers, report cards) belong to 6B and read exams via these endpoints.

### Timetable (`backend/src/modules/timetable/`)
| Endpoint | Role | Notes |
|---|---|---|
| `GET /timetable?class_id=&teacher_id=&day=` | any authed | `day` 0–6 (0 = Sunday) |
| `GET /timetable/class/:class_id` | any authed | Grouped `by_day` (0–6) |
| `GET /timetable/teacher/:staff_id` | any authed | Grouped `by_day` (0–6) |
| `POST /timetable` | admin; clerk → queue | See conflict rules |
| `PATCH /timetable/:id`, `DELETE /timetable/:id` | admin; clerk → queue | |

### Staff & payroll (`backend/src/modules/staff/`)
| Endpoint | Role | Notes |
|---|---|---|
| `GET /staff?role=&search=` | any authed | Phone returned masked only |
| `POST /staff` | admin; clerk → queue | `{name, role, phone?, email?, joining_date?, subjects?, salary_monthly?}` |
| `GET /staff/:id`, `PATCH /staff/:id`, `DELETE /staff/:id` | any / admin; clerk → queue | Delete blocked (see below) |
| `GET /staff/:id/assignments` | any authed | |
| `POST /staff/:id/assign` | admin; clerk → queue | `{class_id, subject}` |
| `DELETE /staff/:id/assign/:assignment_id` | admin; clerk → queue | |
| `GET /payroll?month=&staff_id=&paid=` | any authed | `month` YYYY-MM |
| `POST /payroll` | admin; clerk → queue | `{staff_id, month, base_salary?, deductions?, payslip_no?}` → `{net_pay}` |
| `GET /payroll/:id`, `PATCH /payroll/:id`, `DELETE /payroll/:id` | any / admin; clerk → queue | PATCH `{base_salary?, deductions?, paid?}` |
| `GET /payroll/:id/payslip` | any authed | Printable HTML payslip (Print / Save as PDF) |

## Promotion & archive rules

- **Promotion** reuses `admin.promoteStudents` (the 6A-2-hardened,
  tx-scoped implementation) — `sessions/service.ts:promoteClassSection`
  only resolves "every active student in the from class" into mappings
  and delegates. No promotion logic is duplicated. A promotion moves
  students to the target class and writes one `promotions` row per student
  (session, from/to class, promoted_by/at). Archived sessions refuse
  promotion (409); same-class promotion and empty from-classes are 400s.
- **Archive** — see the schema constraint below. Archiving clears
  `is_current`, flags the session, and makes it read-only: make-current,
  update, promote, and exam/datesheet creation on it all 409. Archived
  sessions' exams are excluded from the default `GET /exams` list but are
  viewable with an explicit `?session_id=` (or `?include_archived=true`).
  Students/fees/attendance carry no session column, so for them the rule
  is enforced at the session boundary (no new promotions/exams in an
  archived session); reports can still query the session explicitly.
- **Session delete** is a guarded hard delete: blocked while current,
  while exams reference it, or while promotions reference it.

## Grading / passing-marks storage decision

There is **no `passing_marks` column** on `exams` or `classes`, so passing
marks live on the **grading scale**: the passing threshold for a class is
the lowest `min_marks` among that class's bands with `is_passing = true`.
Class-specific bands win; the school default (`class_id` NULL) is the
fallback. `GET /grading-scales/passing?class_id=` is the single reader
(`exams/service.ts:getPassingMarks`); the results module should call it
rather than re-deriving the threshold. Seeded defaults (A+ 90–100/4.0,
A 80–89/3.7, B 70–79/3.0, C 60–69/2.0, D 50–59/1.0, F 0–49/0.0
not-passing) make the passing mark **50**. Grade-band ranges may not
overlap within one scope (same `class_id`, NULL included); overlap is a
409. Bands in different scopes may share ranges.

## Timetable conflict rules

1. Same class-section + day + period cannot double-book — app-layer 409
   (friendly message naming the existing lesson) backed by the DB unique
   `(school_id, class_id, day_of_week, period_no)`.
2. Same teacher cannot be in two places at once — same teacher + day +
   `period_no` (any class) is a 409, and so is any overlapping time
   interval for that teacher on that day (catches different period
   numbers with overlapping times).
3. Same class-section + day with overlapping times is a 409 even for
   different period numbers.
Only staff with `role = 'teacher'` can be put on the timetable.

## Staff / payroll rules

- Phones use the unchanged AES-256-GCM + SHA-256 pattern; responses carry
  `phone_masked` only (`+92 3XX XXXX123`); change logs store the masked
  number, never ciphertext.
- `net_pay = max(0, base_salary − deductions)`; one salary record per
  `(staff, month)` (409 on duplicate); `base_salary` defaults to the
  staff profile's `salary_monthly`. Payslip numbers auto-generate as
  `PS-YYYYMM-NNN` per month. `paid` toggles `paid_at`; paid records cannot
  be deleted (unmark first).
- Staff delete is blocked while timetable entries exist or salary records
  exist (payroll history must not vanish silently); assignments are
  removed with the staff row. Changing a teacher's role to `staff` is
  blocked while they are on the timetable.

## Soft delete / recycle bin — where it applies

Only `exams` among these modules has a `deleted_at` column, so only exam
delete is a true soft delete (`softDeleteEntity`, restorable from the
recycle bin within 30 days). `academic_sessions`, `staff`,
`timetable_entries`, `exam_datesheets` have **no** `deleted_at` column
(schema forbids adding one in this task), so their deletes are hard
deletes that still write a `deleted_records` snapshot row for the audit
trail — but the generic recycle-bin restore helper cannot restore them
(they are not in `ENTITY_DELEGATES`). Grading scales and salary records
are hard-deleted with an audit log only. Every edit writes `change_logs`
(per-field old/new, phones masked) and an `audit_logs` row.

## Archive storage — the schema gap (read this before "fixing" it)

`academic_sessions` has no `is_archived` / `deleted_at` column and the
task forbids schema/migration changes. The archived flag therefore lives
in the school's `settings` JSONB under `archived_session_ids` (an array of
session ids; `sessions/service.ts:getArchivedSessionIds`). `getSettings()`
merges unknown keys through unchanged, so the Settings page is unaffected.
**A future migration should add a real `is_archived BOOLEAN` column and
move this list there** (and add `deleted_at` to sessions/staff/timetable
if true soft delete is wanted for them).

## Approval queue

Clerk mutations on every mutating endpoint above return **202**
`{approval_request_id, status: "pending"}` and apply nothing; an admin
approves in `/approvals` and the payload is applied via the appliers in
`modules/hardening/approvals.ts` (6C-1 block: `academic_session`,
`exam`, `exam_datesheet`, `grading_scale`, `timetable_entry`, `staff`,
`staff_assignment`, `salary_record`). Principals get 403 on all mutations
(`requireQueueable` / `requireAdmin`). Queueable pairs added in
`middleware/permissions.ts` (6C-1 block).

## Frontend

- `frontend/src/pages/Sessions.tsx` — sessions CRUD, archive/unarchive,
  make-current, whole-class promotion + promotion history.
- `frontend/src/pages/Exams.tsx` — exams CRUD, datesheet per exam,
  grading-scale manager + seed defaults, passing-marks display.
- `frontend/src/pages/Timetable.tsx` — class-wise / teacher-wise views,
  add/edit entry, conflict errors shown inline.
- `frontend/src/pages/Staff.tsx` — staff CRUD + assignments, payroll tab
  (create, mark paid/unpaid, printable payslip modal).
- Nav entries (Sessions, Exams, Timetable, Staff) in `Layout.tsx`;
  routes in `App.tsx`; types in `lib/types.ts` (6C-1 blocks).
- All forms `autoComplete="off"`; every add/delete/bulk action goes
  through the shared `ConfirmDialog`; empty states on every list.

## Verification (final run 2026-11-06 ~18:54 PKT)

- `npx tsc --noEmit` (backend): **0 errors in any 6C-1 file** and 0 in the
  shared files this task edited (`app.ts`, `middleware/permissions.ts`,
  `modules/hardening/approvals.ts`). The full-repo run still shows 10
  errors, all in two parallel agents' in-flight test files
  (`modules/expenses/__tests__/features-6c2.test.ts` ×6,
  `modules/messaging/__tests__/custom-messages.test.ts` ×4) — not 6C-1
  code, and the count was falling as those agents worked (45 → 12 → 10
  during this task).
- `npx vitest run` (6C-1 files): **4 files, 41 tests, all pass**
  (`sessions.test.ts` 10, `exams.test.ts` 10, `timetable.test.ts` 11,
  `staff.test.ts` 10) — fake in-memory DB, no live DB.
- `npx vitest run` (full backend): **16/17 files pass, 244/248 tests
  pass**. The 4 failures are all in 6C-2's `features-6c2.test.ts`
  (certificates/expenses/leave — that agent's in-flight work, failing on
  its own fake DB / admin-service changes), not 6C-1.
- Frontend: `npm run build` (tsc -b + vite) — **clean, 48 modules,
  built in 1.35s**.
- Live-DB smoke: **not run** — no local Postgres binaries were present in
  this environment (`pg_ctlcluster` / `psql` / `docker` all absent), so
  the task's "start local Postgres" step could not be executed and the
  live DB was never touched. The services use only standard Prisma calls
  already proven by the v1/v2 live probes, and the fake-DB suite covers
  the new logic. A live smoke (migrate deploy on a scratch DB + HTTP
  walk of the new endpoints) is still worth doing in Phase 8 QA.
