# School Management Platform — Database Schema (CONTRACT v1.0)

All tables live in PostgreSQL. Every tenant-scoped table has `school_id` (UUID, FK schools, ON DELETE CASCADE) and an index on it. Multi-tenancy is enforced in the app layer (tenant middleware) AND by always scoping queries to `school_id`. All timestamps are `timestamptz` (UTC); all dates are school-local `date`. Money is integer PKR (rupees, never floats). Phone numbers are stored encrypted (see below); `parent_phone_hash` = SHA-256 of the E.164-normalized number, used ONLY for duplicate detection.

## Tables

### schools
- id UUID PK, name TEXT, slug TEXT UNIQUE, timezone TEXT DEFAULT 'Asia/Karachi', country TEXT DEFAULT 'PK', settings JSONB DEFAULT '{}' (keys: `teacher_reminder_time` "HH:MM", `fee_auto_send` BOOL, `fee_require_approval` BOOL, `fee_followup_day` INT NULL, `sms_provider` 'sim'|'gateway', `teacher_attendance_mode` 'admin'|'link'), created_at, updated_at

### users (admin + clerk logins)
- id UUID PK, school_id UUID FK, email CITEXT UNIQUE, password_hash TEXT, role TEXT CHECK IN ('admin','clerk'), email_verified BOOL DEFAULT false, verify_token_hash TEXT NULL, verify_expires_at TIMESTAMPTZ NULL, reset_token_hash TEXT NULL, reset_expires_at TIMESTAMPTZ NULL, last_login_at TIMESTAMPTZ NULL, created_at, updated_at
- Index: (school_id, email). Clerk CANNOT: manage users, change settings, regenerate teacher links, approve messages (admin only approves; clerk can view logs).

### classes
- id UUID PK, school_id UUID FK, name TEXT (e.g. '5'), section TEXT (e.g. 'A'), teacher_name TEXT, teacher_phone_enc TEXT NULL, teacher_phone_hash TEXT NULL, attendance_token_hash TEXT NULL, token_expires_at TIMESTAMPTZ NULL, token_revoked BOOL DEFAULT false, created_at, updated_at
- Unique: (school_id, name, section). Display name = name || '-' || section.

### students
- id UUID PK, school_id UUID FK, class_id UUID FK classes, roll_no INT NULL, name TEXT, name_ur TEXT NULL, parent_name TEXT NULL, parent_phone_enc TEXT NULL, parent_phone_hash TEXT NULL, parent_opt_out BOOL DEFAULT false, status TEXT DEFAULT 'active' CHECK IN ('active','left','graduated'), created_at, updated_at
- Unique: (class_id, roll_no) WHERE roll_no IS NOT NULL. Index: (school_id, class_id), (school_id, parent_phone_hash). Duplicate rule: same (class_id, name-normalized) OR same (school_id, parent_phone_hash + name-normalized) is flagged on import/review, never silently merged.

### attendance_days (one row per class per day)
- id UUID PK, school_id UUID FK, class_id UUID FK, date DATE, submitted_by TEXT CHECK IN ('teacher_link','admin'), submitted_at TIMESTAMPTZ, unlocked BOOL DEFAULT false, unlocked_by UUID NULL, created_at
- Unique: (class_id, date).

### attendance_records
- id UUID PK, attendance_day_id UUID FK attendance_days, student_id UUID FK students, status TEXT CHECK IN ('present','absent'), marked_at TIMESTAMPTZ, updated_by TEXT
- Unique: (attendance_day_id, student_id). Index: (student_id, status).

### teacher_attendance
- id UUID PK, school_id UUID FK, class_id UUID FK classes, date DATE, status TEXT CHECK IN ('present','absent'), marked_by UUID NULL, note TEXT NULL, created_at
- Unique: (class_id, date). Teacher absence NEVER triggers messages (enforced in messaging service: only student absences generate queue rows).

### fee_structures
- id UUID PK, school_id UUID FK, class_id UUID FK classes, monthly_amount INT (PKR), effective_from DATE, created_at
- One active row per class (latest effective_from wins).

### fee_records
- id UUID PK, school_id UUID FK, student_id UUID FK students, month TEXT (YYYY-MM), amount_due INT, amount_paid INT DEFAULT 0, discount INT DEFAULT 0, status TEXT CHECK IN ('unpaid','partial','paid') GENERATED from amounts, paid_at TIMESTAMPTZ NULL, receipt_no TEXT NULL, payment_method TEXT NULL, marked_by UUID NULL, created_at, updated_at
- Unique: (student_id, month). Receipt numbers: `{school_slug}-{YYYYMM}-{seq}` per school, sequential.

### message_templates
- id UUID PK, school_id UUID FK, type TEXT CHECK IN ('absent','fee_reminder','teacher_reminder'), language TEXT CHECK IN ('en','ur'), body TEXT (variables: {student_name} {class} {date} {month} {amount} {school_name}), is_active BOOL DEFAULT true, created_at, updated_at
- Unique: (school_id, type, language). Seed: EN + UR defaults for all three types.

### message_queue (outbox; the ONLY source of sends)
- id UUID PK, school_id UUID FK, type TEXT CHECK IN ('absent','fee_reminder','teacher_reminder'), student_id UUID NULL (teacher reminders use class_id), class_id UUID NULL, parent_phone_enc TEXT, body TEXT, status TEXT DEFAULT 'queued' CHECK IN ('queued','sent','failed','cancelled'), attempts INT DEFAULT 0, dedupe_key TEXT UNIQUE (absent: `absent:{student_id}:{date}`; fee: `fee:{student_id}:{month}`; teacher: `teacher:{class_id}:{date}`), scheduled_for TIMESTAMPTZ, sent_at TIMESTAMPTZ NULL, error TEXT NULL, approved_by UUID NULL, approved_at TIMESTAMPTZ NULL, created_at
- Index: (school_id, status, scheduled_for).

### message_deliveries
- id UUID PK, queue_id UUID FK message_queue, provider TEXT CHECK IN ('sim','gateway'), device_id UUID NULL, status TEXT, delivered_at TIMESTAMPTZ NULL, error TEXT NULL, created_at

### sms_devices (Android companion phones)
- id UUID PK, school_id UUID FK, device_id TEXT UNIQUE (app-generated), name TEXT, last_seen_at TIMESTAMPTZ NULL, status TEXT DEFAULT 'offline' CHECK IN ('online','offline'), push_token TEXT NULL, created_at
- Online = last_seen_at within 90 seconds.

### holidays
- id UUID PK, school_id UUID FK, date DATE, name TEXT, created_at. Unique: (school_id, date). Sundays are always non-school days (no attendance/messages), no row needed.

### academic_sessions
- id UUID PK, school_id UUID FK, name TEXT (e.g. '2026-27'), start_date DATE, end_date DATE, is_current BOOL DEFAULT false, created_at

### promotions
- id UUID PK, school_id UUID FK, student_id UUID FK, from_class_id UUID, to_class_id UUID, session_id UUID FK academic_sessions, promoted_at TIMESTAMPTZ, promoted_by UUID

### leave_applications
- id UUID PK, school_id UUID FK, student_id UUID FK, from_date DATE, to_date DATE, reason TEXT, status TEXT DEFAULT 'pending' CHECK IN ('pending','approved','rejected'), decided_by UUID NULL, created_at

### ocr_uploads
- id UUID PK, school_id UUID FK, class_id UUID FK, file_path TEXT, status TEXT CHECK IN ('processing','review','saved','failed'), raw_text TEXT NULL, created_at

### audit_logs
- id UUID PK, school_id UUID FK, actor_id UUID NULL, actor_type TEXT ('user'|'teacher_link'|'system'|'device'), action TEXT, entity TEXT, entity_id UUID NULL, details JSONB DEFAULT '{}', created_at. Index: (school_id, created_at).

### notifications
- id UUID PK, school_id UUID FK, type TEXT, title TEXT, body TEXT, related_type TEXT NULL, related_id UUID NULL, is_read BOOL DEFAULT false, created_at. Index: (school_id, is_read, created_at).

## Encryption & phone rules
- Normalize PK numbers to E.164: `+92` + 10 digits (strip leading 0, accept 03XX, +92, 92). Reject anything else (flag invalid, never send).
- Encrypt `*_phone_enc` with AES-256-GCM, key from `PHONE_ENC_KEY` (32 bytes, base64). Decrypt only at send time or when an authorized admin views the number.
- `parent_opt_out = true` means NEVER message that number (all flows check it).

---

# v2 additions (CONTRACT v2.0 — 2026-11-06)

Additive only. All v1 tables/columns stay untouched; new columns are nullable or
have defaults. New tables: 21 (`role_permissions`, `approval_requests`,
`deleted_records`, `change_logs`, `exams`, `grading_scales`, `result_sheets`,
`results`, `timetable_entries`, `staff`, `staff_class_assignments`,
`salary_records`, `expenses`, `announcements`, `events`, `certificates`,
`exam_datesheets`, `fee_vouchers`, `account_deletion_requests`,
`school_backups`, `message_drafts`). Migrations:
`20261106230000_v2_schema`, `20261106231000_v2_messages` (never edit the v1
migration). CHECK constraints live in the v2 migration SQL (Prisma 6.x has no
`@@check`) — same pattern as v1. `fee_records.status` stays a GENERATED ALWAYS
column; `prisma migrate diff` re-emits it as a plain DEFAULT every time — that
drift must ALWAYS be stripped from generated migrations (see
`backend/prisma/V2-SCHEMA-NOTES.md`).

## 1. Extended student profile (students +=)
- `father_name TEXT NULL`, `admission_no TEXT NULL` UNIQUE per school
  (`(school_id, admission_no)`; NULLs never collide), `date_of_birth DATE NULL`,
  `gender TEXT NULL` CHECK IN ('male','female','other'), `address TEXT NULL`,
  `admission_date DATE NULL`, `id_card_issued_at TIMESTAMPTZ NULL` (flag: set
  when the ID card is issued — no separate table).
- `status` CHECK extended to ('active','left','struck_off','graduated').
- Second parent: `parent2_name`, `parent2_phone_enc`, `parent2_phone_hash`,
  `parent2_opt_out BOOL DEFAULT false` — same AES-256-GCM enc + SHA-256 hash
  pattern as parent 1; `parent2_opt_out = true` means NEVER message it.

## 2. Roles & permissions
- `users.role` CHECK extended to ('admin','clerk','principal'). Teacher is
  link-only, no login.
- `role_permissions`: id UUID PK, school_id UUID FK, role TEXT CHECK IN
  ('admin','clerk','principal'), resource TEXT, action TEXT CHECK IN
  ('view','create','update','delete','approve','export'), allowed BOOL DEFAULT
  true, created_at, updated_at. Unique: (school_id, role, resource, action).
  Defaults (seeded per school, in the v2 migration for existing schools and in
  `prisma/seed.ts` for fresh DBs): admin = every resource × every action;
  clerk = view students/fees/results/attendance/reports + create
  students/fees/results (approval-gated) + update fees (v1: clerk may mark fee
  paid); principal = view-only (students, fees, results, attendance, classes,
  messages, reports, staff, timetable, exams, announcements, expenses — no
  settings/users). Resources: students, fees, results, attendance, classes,
  messages, reports, settings, users, staff, timetable, exams, announcements,
  expenses.

## 3. Approval queue (approval_requests)
- id UUID PK, school_id UUID FK, requested_by UUID FK users, action_type TEXT
  CHECK IN ('create','update','delete','bulk'), entity TEXT, entity_id UUID
  NULL, payload JSONB (the full proposed row/change), status TEXT DEFAULT
  'pending' CHECK IN ('pending','approved','rejected'), decided_by UUID NULL FK
  users, decided_at TIMESTAMPTZ NULL, created_at. Index: (school_id, status,
  created_at). Rule: clerk/sub-account adds/deletes create a row here INSTEAD
  of applying directly; an admin approves/rejects, and only an approved row is
  applied (by the applying phase, from `payload`).

## 4. Recycle bin (deleted_records) + soft delete
- `deleted_records`: id UUID PK, school_id UUID FK, entity TEXT, entity_id UUID,
  snapshot JSONB (full row as deleted), deleted_by UUID NULL FK users,
  deleted_at TIMESTAMPTZ DEFAULT now, restore_by TIMESTAMPTZ NULL (restore
  deadline = deleted_at + 30 days), permanently_deleted_at TIMESTAMPTZ NULL.
  Index: (school_id, entity, deleted_at), (restore_by).
- Soft delete: `deleted_at TIMESTAMPTZ NULL` added to students, classes,
  fee_records, exams, results, result_sheets. ALL list queries must exclude
  rows where `deleted_at IS NOT NULL`. Delete flow: set `deleted_at` + write a
  `deleted_records` row with the snapshot; restore (within 30 days) clears
  `deleted_at`; a purge job permanently deletes rows past `restoreBy` and sets
  `permanently_deleted_at`.

## 5. Change history (change_logs)
- id UUID PK, school_id UUID FK, actor_id UUID NULL FK users, actor_type TEXT
  CHECK IN ('user','teacher_link','system','device'), entity TEXT, entity_id
  UUID NULL, field TEXT, old_value TEXT NULL, new_value TEXT NULL,
  changed_at TIMESTAMPTZ DEFAULT now. Index: (school_id, entity, entity_id,
  changed_at). This is per-field old/new history; `audit_logs` (v1) stays the
  per-action log. Every edit writes one row per changed field.

## 6. Results module
- `exams`: id UUID PK, school_id UUID FK, name TEXT (e.g. Midterm / Final /
  Monthly Test), session_id UUID NULL FK academic_sessions (NULL allowed: a
  Monthly Test may sit outside a session), start_date DATE NULL, end_date DATE
  NULL, deleted_at TIMESTAMPTZ NULL, created_at.
- `grading_scales`: id UUID PK, school_id UUID FK, class_id UUID NULL FK
  classes (NULL = applies to all classes), min_marks INT, max_marks INT,
  grade TEXT, gpa_points FLOAT, is_passing BOOL DEFAULT true, created_at.
  CHECK: min_marks >= 0 AND max_marks > min_marks AND gpa_points >= 0.
  Overlap between scales of one class is validated in the app layer (NULL
  class_id defeats a DB unique constraint).
- `result_sheets`: id UUID PK, school_id UUID FK, exam_id UUID FK exams,
  class_id UUID FK classes, session_id UUID NULL FK academic_sessions,
  file_path TEXT, status TEXT DEFAULT 'processing' CHECK IN
  ('processing','review','saved','published'), raw_text TEXT NULL,
  deleted_at TIMESTAMPTZ NULL, created_at. (Same OCR pipeline shape as v1
  `ocr_uploads`.)
- `results`: id UUID PK, school_id UUID FK, result_sheet_id UUID NULL FK
  result_sheets (NULL = manual entry, no sheet), exam_id UUID FK exams,
  class_id UUID FK classes, student_id UUID NULL FK students (NULL until
  linked), roll_no INT NOT NULL, student_name TEXT, father_name TEXT NULL,
  subject_marks JSONB DEFAULT '{}' (`{subject: marks}`), obtained_marks INT
  NULL, total_marks INT NULL, percentage FLOAT NULL, grade TEXT NULL,
  position INT NULL, remarks TEXT NULL, confidence JSONB NULL (per-field OCR
  confidence), linked_at TIMESTAMPTZ NULL, deleted_at TIMESTAMPTZ NULL,
  created_at. Unique: (exam_id, class_id, roll_no).

## 7. Timetable, staff, payroll, expenses, announcements, events, certificates
- `timetable_entries`: id UUID PK, school_id UUID FK, class_id UUID FK classes,
  teacher_id UUID NULL FK staff, day_of_week INT CHECK 0–6 (0 = Sunday),
  period_no INT CHECK >= 1, subject TEXT, start_time TEXT ("HH:MM" 24h),
  end_time TEXT ("HH:MM" 24h), room TEXT NULL, created_at. Unique:
  (school_id, class_id, day_of_week, period_no).
- `staff`: id UUID PK, school_id UUID FK, name TEXT, role TEXT CHECK IN
  ('teacher','staff'), phone_enc TEXT NULL, phone_hash TEXT NULL (same enc/hash
  pattern), email TEXT NULL, joining_date DATE NULL, subjects JSONB DEFAULT
  '[]', salary_monthly INT NULL (PKR), created_at, updated_at.
- `staff_class_assignments`: id UUID PK, school_id UUID FK, staff_id UUID FK
  staff, class_id UUID FK classes, subject TEXT, created_at. Unique:
  (staff_id, class_id, subject).
- `salary_records`: id UUID PK, school_id UUID FK, staff_id UUID FK staff,
  month TEXT (YYYY-MM), amount INT (one payment row; several per staff+month
  allowed and summed), paid_at TIMESTAMPTZ NULL, created_at. Index:
  (school_id, staff_id, month). CHECK: amount >= 0. Status (Paid / Partially
  Paid / Unpaid) and remaining are derived from Staff.salary_monthly minus
  the month's payments — never stored.
- `expenses`: id UUID PK, school_id UUID FK, date DATE, category TEXT,
  description TEXT NULL, amount INT (PKR), created_by UUID NULL FK users,
  created_at.
- `announcements`: id UUID PK, school_id UUID FK, title TEXT, body TEXT,
  target_type TEXT DEFAULT 'all' CHECK IN ('all','class'),
  target_class_id UUID NULL FK classes (NULL = all classes),
  sms_send BOOL DEFAULT false, status TEXT DEFAULT 'draft' CHECK IN
  ('draft','approved','sent'), created_by UUID NULL FK users, created_at,
  updated_at. SMS sending (if approved) goes through the v1 message_queue +
  approval flow — no second sending path.
- `events`: id UUID PK, school_id UUID FK, date DATE, title TEXT,
  description TEXT NULL, created_at.
- `certificates`: id UUID PK, school_id UUID FK, student_id UUID FK students,
  type TEXT CHECK IN ('leaving','character','bonafide'), issued_at TIMESTAMPTZ
  DEFAULT now, issued_by UUID NULL FK users.

## 8. Exam schedule, fee extensions, data ownership
- `exam_datesheets`: id UUID PK, school_id UUID FK, exam_id UUID FK exams,
  class_id UUID FK classes, subject TEXT, date DATE, start_time TEXT ("HH:MM"),
  end_time TEXT ("HH:MM"), created_at. Unique: (exam_id, class_id, subject, date).
- `fee_structures` += `admission_fee INT DEFAULT 0` (one-time, PKR),
  `sibling_discount_pct INT DEFAULT 0` CHECK 0–100.
- `fee_records` += `arrears INT DEFAULT 0` (carried from prior months, PKR),
  `scholarship_discount INT DEFAULT 0` (PKR). NOTE: `fee_records.status` is
  GENERATED from `amount_paid + discount` vs `amount_due` ONLY — arrears and
  scholarship_discount do NOT feed the generated status; the Fees phase must
  fold them into `amount_due` when creating the record (or into the payable
  total shown to the user).
- `fee_vouchers`: id UUID PK, school_id UUID FK, fee_record_id UUID FK
  fee_records, voucher_no TEXT, month TEXT (YYYY-MM), amount_due INT,
  due_date DATE, status TEXT DEFAULT 'unpaid' CHECK IN
  ('unpaid','partial','paid'), created_at. Unique: (school_id, voucher_no).
- `account_deletion_requests`: id UUID PK, school_id UUID FK, requested_by UUID
  FK users, status TEXT DEFAULT 'pending' CHECK IN
  ('pending','approved','completed','rejected'), requested_at TIMESTAMPTZ
  DEFAULT now, completed_at TIMESTAMPTZ NULL.
- `school_backups`: id UUID PK, school_id UUID FK, file_ref TEXT (storage
  reference to the backup file), created_at, size_bytes INT NULL.

## 9. 2FA & login security (users +=)
- `totp_secret_enc TEXT NULL` (TOTP secret, same AES-256-GCM enc pattern as
  phones — never store or return plaintext), `totp_enabled BOOL DEFAULT
  false`, `login_alerts BOOL DEFAULT true` (notify the user on login),
  `last_login_ip TEXT NULL`.

## 10. Soft-delete rule (applies to §4)
Every list endpoint over students, classes, fee_records, exams, results,
result_sheets must add `deleted_at IS NULL`. No other table is soft-deleted;
deletes elsewhere are hard deletes (still recorded in `deleted_records` when
the Recycle Bin flow applies, per the phase implementing it).

## 11. Custom Messages (Section 11 — 2026-11-06)
- `message_templates` extended: `name TEXT NULL` (admin-editable label),
  `is_custom BOOL DEFAULT false`. `type` CHECK extended to ('absent',
  'fee_reminder', 'teacher_reminder', 'result', 'announcement', 'custom').
  NOTHING is locked: any template (seeded default or custom) can be edited,
  renamed, duplicated, or deleted by the school's own admin. Templates are
  per-school copies only — never shared across schools. Seeded defaults are
  `is_custom = false` with names backfilled by the v2_messages migration
  ('Absent Alert (EN)', 'Fee Reminder (EN)', …); the seed sets names directly.
- `message_drafts`: id UUID PK, school_id UUID FK, created_by UUID NULL FK
  users, recipient_type TEXT CHECK IN ('all_parents','class',
  'selected_students','single_parent'), target_class_id UUID NULL FK classes,
  target_student_ids JSONB DEFAULT '[]' (array of student UUIDs — used when
  recipient_type is 'selected_students' or 'single_parent'),
  body TEXT, status TEXT DEFAULT 'draft' CHECK IN
  ('draft','scheduled','sent','cancelled'), scheduled_for TIMESTAMPTZ NULL,
  created_at, updated_at. Index: (school_id, status, created_at).
  "Variables used" is DERIVED at render time (scan `body` for `{...}`) — no
  column. Sending a draft goes through the EXISTING approval flow and the
  EXISTING `message_queue` (approval first, then queue rows) — there is NO
  second sending path.
- Variable set (renderer MUST support all of these; the v1 builder only
  rendered student_name/class/date/school_name — the Messages phase extends
  it): `{student_name}` `{father_name}` `{class}` `{section}` `{date}`
  `{amount}` `{month}` `{school_name}`. `{class}` = class name (e.g. '5'),
  `{section}` = section (e.g. 'A'); `{date}` = school-local date; `{amount}`
  = PKR amount where applicable (fee/result contexts); `{month}` = YYYY-MM.
  Unknown variables render literally (never crash the send).
- Contract notes (query-side / frontend concerns, no new tables): the
  recipient picker + quick filters (absent list, fee-unpaid list) are
  query-side over existing endpoints; live preview + char/SMS-part counter
  and Urdu/English Unicode support are frontend concerns; opted-out parents
  (`parent_opt_out` / `parent2_opt_out`) are auto-excluded at queue-build
  time and the build returns a skipped count.

## Final rebuild (2026-11-07)
- `exams.type` ExamType enum (`monthly` | `midterm` | `annual`, default `monthly`); `schools.smsSenderNumber` TEXT NULL.
- `promotions`: `batchId`, `status` (`applied`/`reversed`/`superseded`), `outcome` (`promoted`/`graduated`/`held`), `rollNoFrom`, `rollNoTo`; partial unique index: one live promotion per student per session.
- `certificates`: `leavingReason`, `leavingReasonOption`, `studentSnapshot` JSONB.
- `leave_applications` table dropped. `attendance_records` / `teacher_attendance` status CHECKs tightened to (`present`, `absent`); `students` status CHECK now (`active`, `left`, `struck_off`, `graduated`).
