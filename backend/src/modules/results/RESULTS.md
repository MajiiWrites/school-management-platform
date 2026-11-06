# Results Module — 6B (2026-11-06)

Students / classes / results for the School Management Platform v2.
Code: `backend/src/modules/results/` (service + routes), OCR table parser
`backend/src/modules/ocr/resultSheets.ts`, frontend `frontend/src/pages/Results.tsx`
(+ extended student form / move / import preview in `StudentsPanel.tsx`).

## 1. Classes / sections (no migration was needed)

- **No caps exist** anywhere on classes, sections, or students (verified by
  grep: only pagination `limit`s). Nothing was removed because nothing
  capped them.
- **Sections are independent**: each `(name, section)` row is its own class
  with its own `teacher_name` / `teacher_phone_enc` / `attendance_token_hash`.
  `regenerateLink` / `revokeLink` are per class id, so 5-A and 5-B have
  different links and revoking one leaves the other working (tested).
- **Class teacher fields already existed** in `schema.prisma`
  (`teacherName`, `teacherPhoneEnc`, `teacherPhoneHash`, AES-256-GCM +
  SHA-256 hash, same as parent phones). The task's conditional migration
  was therefore NOT created — no migration files were touched at all.
  Assign/change teacher via `POST /classes` / `PATCH /classes/:id`
  (already wired, change-logged).

## 2. Students — extended profile

- Fields already in the schema/service: `father_name`, `admission_no`
  (unique per school — app-level 409 check added in `createStudent` /
  `updateStudent`, DB unique `(schoolId, admissionNo)` is the backstop),
  `date_of_birth`, `gender`, `address`, `admission_date`, `parent2_*`,
  `status` incl. `struck_off`.
- New in 6B:
  - `POST /students/:id/move` — move between sections/classes (same
    school only; roll + name must be free in the target class; writes
    `change_logs` + audit `student.move`). UI: "Move" button per row +
    ConfirmDialog.
  - `GET /students?admission_no=&status=&search=&class_id=` — school-wide
    search (soft-deleted excluded).
  - `POST /students/:id/issue-id-card` — route lives in the 6C-2
    certificates router (same path); `students/service.issueIdCard`
    stamps `id_card_issued_at`.
  - Frontend `StudentForm` now has all extended fields + status select
    (edit mode, ConfirmDialog on save). Masked phone numbers
    (`+92 3XX XXXX123`) are shown but never sent back as edits.
- Import: `POST /classes/:id/students/import-preview` (new) validates a
  CSV/Excel file and returns per-row `{row, status: ok|duplicate|invalid,
  reason}` WITHOUT writing anything; the UI shows the preview table and
  only then runs `POST .../import-csv`. `previewImport` and `importStudents`
  share one validation path (duplicate name/roll in class, duplicate
  admission_no in school, invalid phone/gender/date; siblings sharing a
  parent number are NOT duplicates — only same phone + same name is).
  Import files now accept the extended columns (`father_name`,
  `admission_no`, `date_of_birth`, `gender`, `address`, `admission_date`,
  `parent2_name`, `parent2_phone`). OCR upload (`/classes/:id/ocr-upload`)
  is unchanged (v1 module reused).

## 3. Endpoints (base `/api/v1`, envelope `{ok, data}`)

| Endpoint | Notes |
|---|---|
| `POST /classes/:id/results/upload` | multipart `image` + `exam_name` (+optional `session_id`) → `{result_sheet_id, exam_id, raw_text, headings, rows, engine, warnings}`. Creates the exam row if needed. Missing Tesseract → 503 `OCR_UNAVAILABLE` with setup instructions (same as v1 OCR). |
| `POST /results/upload` | Same, with `class_id` in the multipart body. |
| `GET /results/review/:sheetId` | Review data: parsed rows + per-row `link_preview`. |
| `GET /result-sheets/:id` | Contract alias of the above. |
| `POST /result-sheets/:id/confirm` | `{rows:[...edited...]}` → `{saved, linked, unlinked, skipped, flagged}`. |
| `POST /results/:sheetId/save` | Task-name alias of the confirm route. |
| `POST /results/manual` | `{exam_id? / exam_name?, class_id, session_id?, rows}` — no sheet. |
| `GET /results?exam_id=&class_id=&student_id=&linked=&search=` | Paginated list. |
| `GET /results/:id` | One result. |
| `PATCH /results/:id` | Manual correction; recomputes %/grade/positions; change-logged. |
| `POST /results/:id/link` | `{student_id}` — explicit, admin-confirmed link to an existing student in the SAME class. Never creates a student. |
| `DELETE /results/:id` | Soft delete → recycle bin (30-day restore). |
| `DELETE /result-sheets/:id` | Soft delete → recycle bin. |
| `GET /results/toppers?exam_id=&class_id=&limit=` | Position-ordered. |
| `GET /results/summary?exam_id=&class_id=` | `{total, passed, failed, not_graded, pass_rate, average_percentage, passing_threshold_percent, topper}`. |
| `GET /results/report-card/:student_id/:exam_id` | Printable HTML; `?format=pdf` → PDF (school name + student + subjects + totals). |
| `GET /students/:id/report-card?exam_id=` | Contract alias of the above. |
| `GET /results/export?format=xlsx\|pdf&exam_id=&class_id=` | File download. |
| `POST /result-sheets/:id/publish` | Marks sheet `published` + creates SMS drafts (see §6). |
| `GET /exams`, `POST /exams`, `PATCH /exams/:id`, `DELETE /exams/:id` | Owned by 6C-1 (`modules/exams/**`) — NOT duplicated here. |

Clerk calls to the mutating routes return **202** (approval queue) via
`requireQueueable('results', …)` + `queueIfClerk`; the appliers live in
`modules/hardening/approvals.ts` (6B block: `result` create/update/delete,
`result_sheet` create/delete). A clerk upload queues with the uploaded
file's path in the payload, so OCR runs at approve time.

## 4. OCR heading logic (`modules/ocr/resultSheets.ts`)

- The sheet's OWN heading line is detected (first line with ≥ 2 heading
  hints) and each column is mapped from its heading, English AND Urdu:
  roll (`Roll No`, `رول نمبر`), name (`Student Name`, `نام`), father
  (`Father Name`, `والد کا نام`), obtained (`Obtained`, `حاصل کردہ`),
  total (`Total`, `کل`), percentage (`%`, `فیصد`), grade (`Grade`, `گریڈ`),
  position (`Position`, `پوزیشن`), remarks (`Remarks`, `ریمارکس`).
- **Any other heading is a subject** — its marks go into
  `subject_marks` (`{English: 85, Math: 90, …}`), so new subjects need no
  code change. Unrecognised extra columns are kept in `extra`.
- No heading line → free-form fallback (leading roll, name, trailing
  numbers as obtained/total/percentage) with a warning.
- Per-cell confidence: clean numbers/names ≈ 0.95; digits salvaged from
  OCR garbage (e.g. `8S` → 8) = 0.5; unreadable = 0.3. Rows below 0.7 are
  highlighted red in the review table.
- Flags: `obtained_gt_total`, `duplicate_roll`, `missing_roll`,
  `missing_name`, `link_mismatch` (set at save time, see §5).
- Percentage is always re-derived from obtained/total when both exist
  (a stale/mis-read OCR % never survives a marks change); obtained is
  derived from the subject-marks sum when no obtained column exists.
- OCR runs through the v1 engine (`modules/ocr/ocr-engine.ts` — Tesseract
  `eng+urd`); `uploadResultSheet` accepts an injected `runOcr` for tests.

## 5. Review flow + linking

1. Upload → sheet status `review`, parsed rows shown editable.
2. Review table: edit any cell, add/remove rows, low-confidence cells
   highlighted, mismatch flags shown, per-row link preview
   (`links via roll|name` / `unlinked` / `roll/name mismatch`).
3. Confirm (ConfirmDialog, names the low-confidence + flagged counts) →
   `POST .../confirm`. Save upserts by the unique `(exam, class, roll_no)`
   key (re-save updates, never duplicates), recomputes positions, marks
   the sheet `saved`.
4. Linking: roll match wins; exact normalized-name match is the fallback.
   **Roll/name mismatch (roll → student A, name → student B) stays
   unlinked with `link_mismatch`** — resolve it explicitly via
   `POST /results/:id/link` (ConfirmDialog in the UI). Students are never
   auto-created or overwritten.
5. Positions: dense rank by percentage desc within (exam, class); ties
   share a position. Recomputed on every save/update.

## 6. Publish / SMS flow

`POST /result-sheets/:id/publish` (sheet must be `saved`) sets the sheet
`published` and creates one `message_drafts` row per LINKED result whose
parent has a usable number (parent 1 first, else parent 2; opted-out or
missing numbers are skipped with a reason). Drafts are status `draft` —
they go through the SAME approval flow as custom messages (SCHEMA.md
§11): admin submits for approval → approval builds `message_queue` rows
(opted-out auto-excluded, skipped count returned). **No direct
`message_queue` insert is done here, deliberately:** queue rows are born
approved (approved_by/at set at creation), so writing one would send
without approval; drafts are the pending-approval vehicle (the
draft-send path types approved drafts as `custom` by default; the
announcement hook (Phase 8) passes `queueType: 'announcement'` so
announcement SMS is typed `announcement`). Migration
`20261106232000_v2_queue_custom_type` did extend the queue type CHECK to
include `result`, but that does not change the approval-first flow.
Variables rendered in the body:
`{student_name} {father_name} {class} {section} {date} {school_name}`
plus result context `{exam_name} {percentage} {grade} {position}`.
Returns `{published, drafts_created, skipped:[{student_name, reason}]}`.

## 7. Defaults

- **Passing marks: 33%** (`DEFAULT_PASS_PERCENTAGE`) unless grading scales
  exist — then the lowest `is_passing` band's `min_marks` for the class
  (class-specific scales first, then school-wide `class_id = NULL`).
- **Grade with no grading scale:** A ≥ 80, B ≥ 70, C ≥ 60, D ≥ 50, E ≥ 40,
  F below (`DEFAULT_GRADE_BANDS`). With scales, bands are percentage
  bands (`min_marks`–`max_marks` as 0–100).
- **Soft delete:** results, result_sheets (and exams, via 6C-1) use the
  6A recycle-bin helpers (`softDeleteEntity` → `deleted_at` +
  `deleted_records` snapshot, 30-day restore via `POST /recycle-bin/:id/restore`).
  All list queries exclude `deleted_at IS NOT NULL`.
- **Change history:** every result/student/class edit writes
  `change_logs` per changed field (phones masked); every mutation writes
  an `audit_logs` row. Clerk mutations are queue-gated (see §3).

## 8. Verification (2026-11-06, final)

- `npx tsc --noEmit` (backend): **0 errors** (whole backend, 19:24 PKT).
- `npx vitest run src/modules/results/__tests__/results-6b.test.ts`:
  **25/25 pass** (fake in-memory DB; no live DB). Full backend suite:
  289 passed / 5 failed (294 total) — the 5 failures are all in other
  agents' files (`jobs.test.ts` ×2, `cross-tenant.test.ts` ×3), not 6B.
- Frontend `npm run build`: clean (19:24 PKT).
- **Live-DB smoke: DONE 2026-11-06 ~19:22 PKT — 48/48 checks pass**
  on a scratch DB (`school_6b_smoke`, dropped afterwards; live DB never
  touched). PostgreSQL 16 was installed in this VM for the smoke and is
  now running locally. Script: `backend/smoke-6b.py` (real HTTP against
  the server on :4126). Coverage: signup/login, per-section teachers +
  links, extended student profile, admission_no 409, move, status
  struck_off, school-wide search, CSV preview/import, manual results,
  toppers/summary (33% default), PATCH recompute, report card, xlsx
  export, OCR upload with real Tesseract (eng+urd) → review → confirm →
  publish (SMS drafts visible), soft-delete → recycle bin → restore,
  clerk 202 queue → admin approve, cross-tenant 404s/empty lists.
- Parser fix found by the smoke (2026-11-06 19:2x PKT): the free-form
  fallback required `1.` after the roll number and assigned the last
  three numbers as obtained/total/%. It now accepts a bare leading roll
  (`1 Ahmed Raza …`) and takes the LAST TWO numbers as obtained/total
  (percentage is derived). Covered by a new unit test (25th test).
- Known limitation: Tesseract's `urd` dual-pass can hallucinate Urdu
  text over a purely Latin header line (observed on the smoke image),
  so the header is lost and the sheet falls back to free-form parsing
  with a warning. The review table is the safety net (admin checks
  every row before saving); fixing the OCR merge heuristic belongs to
  the v1 OCR module, not results.
