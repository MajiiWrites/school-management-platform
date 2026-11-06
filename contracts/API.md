# School Management Platform — API Spec (CONTRACT v1.0)

Base: `/api/v1`. Envelope: success `{ok:true, data:...}`; error `{ok:false, error:{code, message}}`. Auth: `Authorization: Bearer <access JWT>` (15 min) + refresh cookie/JWT (7 days). Roles enforced per endpoint (admin | clerk). All list endpoints: `?page&limit&search&sort` and return `{items, total, page, pages}`. All tenant-scoped endpoints require the middleware to resolve `school_id` from the JWT — never trust a `school_id` from the client body.

## Auth
- POST /auth/signup {school_name, email, password} → creates school + admin, sends verification email (dev: log token). 201.
- POST /auth/verify-email {token}
- POST /auth/login {email, password} → {access, refresh, user}
- POST /auth/refresh, POST /auth/logout, POST /auth/forgot-password {email}, POST /auth/reset-password {token, password}
- GET /auth/me

## Admin: users & settings
- POST /users/clerks {email, password} (admin) — create clerk login. GET /users (admin). DELETE /users/:id (admin).
- GET /settings, PATCH /settings (admin) — keys per SCHEMA.schools.settings.
- GET /dashboard — {classes_submitted, classes_pending, present, absent, teachers_present, teachers_absent, fee_collected_this_month, fee_pending_this_month, recent_notifications}

## Classes
- POST /classes {name, section, teacher_name, teacher_phone} (admin)
- GET /classes, GET /classes/:id, PATCH /classes/:id, DELETE /classes/:id (admin; delete blocked if students exist — return 409)
- POST /classes/:id/attendance-link/regenerate (admin) → {link} (full URL, token in path). POST /classes/:id/attendance-link/revoke (admin).

## Students + OCR
- POST /classes/:id/students {name, name_ur?, roll_no?, parent_name?, parent_phone?} (admin)
- GET /classes/:id/students?search=&status= — search by name/class/roll_no.
- PATCH /students/:id, DELETE /students/:id (admin)
- POST /classes/:id/students/import-csv — multipart CSV/Excel {name, roll_no, parent_name, parent_phone}; returns {imported, duplicates_flagged, invalid_rows}.
- POST /classes/:id/ocr-upload — multipart image → {upload_id, raw_text, rows:[{name, name_ur?, roll_no?, parent_phone?, confidence, duplicate?}]}. GET /ocr-uploads/:id (review data).
- POST /classes/:id/ocr-upload/:upload_id/confirm {rows:[...edited...]} → saves students (merge, no duplicates; returns {saved, skipped_duplicates}).

## Teacher attendance link (PUBLIC, token auth — no JWT)
- GET /t/:token — validates token (not revoked/expired) → {class, date, students:[{id, name, roll_no, status?}], already_submitted}
- POST /t/:token/submit {records:[{student_id, status}]} — statuses present/absent/late/leave; default present. One submission per class per day; 409 if already submitted (unless admin unlocked). On success: creates attendance_day + records, audit log, dashboard badge data, and (if any absent and not Sunday/holiday) creates a pending-approval notification + draft queue rows in status `queued` BUT held — see Messaging.
- Offline: page is a PWA-style cacheable page; if offline on submit, the browser stores the payload in localStorage and retries when online (frontend implements; backend accepts late same-day submissions).

## Teacher attendance (admin-marked)
- POST /teacher-attendance {class_id, date, status, note?} (admin). GET /teacher-attendance?date=&class_id=

## Reports
- GET /reports/attendance/daily?date=&class_id=, /weekly?week_start=, /monthly?month=YYYY-MM — per class + per student; `?format=pdf|xlsx` for export.
- GET /reports/fees/monthly?month= — {collected, pending, by_class}.

## Parents
- GET /parents?flag=missing|invalid|duplicate — students with phone issues. PATCH /students/:id/parent {parent_name, parent_phone, opt_out?}.

## Messaging (approval flow)
- GET /messages/pending-approval — draft groups per class/day: {class, date, absent_count, messages:[{student, parent_phone_masked, body}]}.
- POST /messages/approve {dedupe_keys:[...] | group_id} (admin) — approves + enqueues for sending (status queued, approved_by/at set). Body editable per message before approval: PATCH /messages/queue/:id {body}.
- GET /messages/log?status=&type=&date= — every send with status. POST /messages/queue/:id/retry (failed only).
- GET /messages/templates, PATCH /messages/templates/:id {body} (admin) — character counter is a frontend concern; Urdu/Unicode supported.
- GET /sms/status — {provider, sim_connected, last_seen_at, queued_count}. POST /sms/devices/register {device_id, name} (device auth: school-scoped API key). GET /sms/devices/:device_id/queue — device polls: returns next batch (max 10, rate limit: 1 msg / 2 s per device enforced server-side via scheduled_for staggering). POST /sms/devices/:device_id/delivery {queue_id, status, error?} — device reports result.

## Fees
- GET /fees?month=YYYY-MM&class_id=&status= — students with amount_due/paid/status.
- POST /fees/:student_id/pay {month, amount_paid, discount?, payment_method?, receipt?} (admin/clerk) → {receipt_no, receipt_url}. Partial payments allowed; status recomputed.
- GET /fees/receipts/:receipt_no — printable receipt (HTML → PDF).
- POST /fees/structures {class_id, monthly_amount, effective_from} (admin). GET /fees/structures.
- Fee reset: on month rollover the scheduler creates new fee_records (status unpaid) from fee_structures; paid records are NEVER re-created or re-reminded.

## Scheduler (server jobs; status endpoints only — jobs run via node-cron)
- GET /jobs/status — last runs: monthly_fee_reminder, daily_pending_attendance, teacher_reminders.
- Monthly 1st (school tz, skips Sundays/holidays): for each unpaid fee_record of the new month → queue fee_reminder (auto-send if settings.fee_auto_send, else await approval). Follow-up on settings.fee_followup_day if enabled.
- Daily (settings.teacher_reminder_time, school tz): classes with no submission → teacher_reminder queue rows (SIM) + notification. Never on Sundays/holidays.

## Academic sessions, holidays, promotion, leave, audit, notifications
- POST /sessions {name, start_date, end_date} + POST /sessions/:id/make-current (admin). GET /sessions.
- POST /promotions {session_id, mappings:[{student_id, to_class_id}]} (admin).
- GET /holidays, POST /holidays {date, name}, DELETE /holidays/:id (admin).
- POST /leaves {student_id, from_date, to_date, reason} + PATCH /leaves/:id {status} (admin).
- GET /audit-logs?entity=&action=, GET /notifications, POST /notifications/:id/read.

## Rules every agent must enforce
1. Messages go ONLY to parents of ABSENT students, ONLY after admin approval, NEVER twice for the same (student, day) — dedupe_key unique constraint is the backstop.
2. Teacher absence NEVER creates messages.
3. No attendance/messages on Sundays or holidays (scheduler + submit endpoint both check).
4. Never log or return full phone numbers; mask as +92 3XX XXXX123.
5. Every mutation writes an audit_logs row.

---

# v2 endpoints (CONTRACT v2.0 — 2026-11-06, endpoint list only, no implementation)

Base `/api/v1`, same envelope/auth/tenant rules as v1. Every mutation writes an
`audit_logs` row (v1 rule) AND a `change_logs` row per changed field (v2 §5).
List endpoints over students/classes/fee_records/exams/results/result_sheets
exclude soft-deleted rows (`deleted_at IS NULL`). Clerk writes that create or
delete data go through the approval queue (§Approvals) instead of applying
directly. Roles: admin | clerk | principal (principal = view-only; a 403 for
any mutating call).

## Roles & permissions
- GET /roles/permissions — the school's role_permissions matrix.
- PATCH /roles/permissions (admin) {role, resource, action, allowed} — customise one cell.
- GET /roles/me — the caller's effective permissions.

## Approvals
- GET /approvals?status=pending|approved|rejected — approval_requests list.
- POST /approvals {action_type, entity, entity_id?, payload} — clerk creates a request instead of applying.
- POST /approvals/:id/approve (admin) — applies the payload, marks approved.
- POST /approvals/:id/reject (admin) {reason?} — marks rejected.
- GET /approvals/:id — one request with its payload.

## Recycle bin & change history
- GET /recycle-bin?entity= — deleted_records list (30-day window).
- POST /recycle-bin/:id/restore — clears deleted_at on the row.
- DELETE /recycle-bin/:id (admin) — permanent delete (sets permanently_deleted_at).
- GET /change-logs?entity=&entity_id= — change_logs list (per-field old/new).

## Students (extended profile)
- POST /classes/:id/students — now accepts father_name, admission_no, date_of_birth, gender, address, admission_date, parent2_name, parent2_phone, parent2_opt_out.
- PATCH /students/:id — same extended fields; id_card_issued_at set via POST /students/:id/issue-id-card.
- GET /students/:id — full extended profile.
- DELETE /students/:id — soft delete (recycle bin, 30-day restore).
- GET /students?admission_no=&status= — search/filter incl. struck_off/graduated.

## Results, exams, grading, datesheets
- POST /exams {name, session_id?, start_date?, end_date?}, GET /exams, GET /exams/:id, PATCH /exams/:id, DELETE /exams/:id (soft delete).
- POST /exams/:id/datesheet {class_id, subject, date, start_time, end_time}, GET /exams/:id/datesheet?class_id=, PATCH /exams/datesheet/:id, DELETE /exams/datesheet/:id.
- GET /grading-scales?class_id=, POST /grading-scales {class_id?, min_marks, max_marks, grade, gpa_points, is_passing?}, PATCH /grading-scales/:id, DELETE /grading-scales/:id.
- POST /classes/:id/results/upload — multipart result-sheet image → {result_sheet_id, raw_text, rows:[{roll_no, student_name, father_name?, subject_marks, confidence}]} (same OCR review shape as v1 ocr-upload).
- GET /result-sheets/:id (review data), POST /result-sheets/:id/confirm {rows:[...edited...]} → saves results (links student_id where roll_no matches; returns {saved, linked, unlinked}).
- GET /results?exam_id=&class_id=&student_id= — results list.
- GET /results/:id, PATCH /results/:id (manual correction; writes change_logs), POST /results/:id/link {student_id} (link an unlinked row).
- GET /results/toppers?exam_id=&class_id= — position-ordered toppers.
- GET /students/:id/report-card?exam_id= — printable report card (HTML → PDF).
- POST /results/manual {exam_id, class_id, rows:[...]} — manual entry without a sheet.

## Timetable, staff, payroll
- GET /timetable?class_id=&day=, POST /timetable {class_id, teacher_id?, day_of_week, period_no, subject, start_time, end_time, room?}, PATCH /timetable/:id, DELETE /timetable/:id.
- GET /staff?role=, POST /staff {name, role, phone?, email?, joining_date?, subjects?, salary_monthly?}, GET /staff/:id, PATCH /staff/:id, DELETE /staff/:id.
- POST /staff/:id/assign {class_id, subject}, DELETE /staff/:id/assign/:assignment_id.
- GET /payroll?month=&staff_id=, POST /payroll {staff_id, month, base_salary, deductions?, payslip_no?} → {net_pay}, GET /payroll/:id/payslip — printable payslip (HTML → PDF).

## Fees (extensions)
- POST /fees/structures — now accepts admission_fee, sibling_discount_pct.
- POST /fees/:student_id/pay — now accepts arrears, scholarship_discount (folded into amount_due).
- GET /fees/vouchers?month=&status=, POST /fees/vouchers {fee_record_id, month, amount_due, due_date} → {voucher_no}, GET /fees/vouchers/:voucher_no — printable voucher (HTML → PDF).

## Expenses, announcements, events, certificates
- GET /expenses?month=&category=, POST /expenses {date, category, description?, amount}, PATCH /expenses/:id, DELETE /expenses/:id.
- GET /announcements?status=, POST /announcements {title, body, target_type, target_class_id?, sms_send?}, PATCH /announcements/:id, POST /announcements/:id/approve (admin) → queues SMS via message_queue if sms_send, POST /announcements/:id/send (approved only).
- GET /events?month=, POST /events {date, title, description?}, PATCH /events/:id, DELETE /events/:id.
- POST /students/:id/certificates {type} → {certificate_id, certificate_url}, GET /students/:id/certificates, GET /certificates/:id — printable certificate (HTML → PDF).

## Auth & security (2FA)
- POST /auth/2fa/setup (authed) → {otpauth_url, backup note: secret stored encrypted, never returned again}.
- POST /auth/2fa/verify {code} — enables totp.
- POST /auth/2fa/disable {code}.
- POST /auth/login — accepts optional {totp_code} when totp_enabled; login alerts sent when settings say so.
- GET /auth/sessions — active sessions (for the session-timeout phase); DELETE /auth/sessions/:id.

## Data ownership
- POST /account/delete-request {reason?} — creates account_deletion_requests row (status pending).
- GET /account/delete-requests (admin) — list; PATCH /account/delete-requests/:id {status} (admin).
- GET /data/export — full school data export (JSON/CSV; backup job writes a school_backups row).
- GET /backups — school_backups list.

## Custom Messages (Section 11)
- GET /messages/templates — all templates (incl. custom; nothing locked).
- POST /messages/templates {name, type, language, body} (admin) — create custom template (is_custom=true).
- PATCH /messages/templates/:id {name?, body?, type?, language?} (admin) — edit/rename any template.
- POST /messages/templates/:id/duplicate (admin) — copies a template (new name "Copy of …").
- DELETE /messages/templates/:id (admin) — delete any template (no locked rows).
- GET /messages/drafts?status=, POST /messages/drafts {recipient_type, target_class_id?, target_student_ids?, body, scheduled_for?} — create draft.
- GET /messages/drafts/:id — draft with rendered preview (variables resolved per first recipient).
- PATCH /messages/drafts/:id {body?, recipient_type?, target_class_id?, target_student_ids?, scheduled_for?}, DELETE /messages/drafts/:id (draft only), POST /messages/drafts/:id/cancel.
- POST /messages/drafts/:id/submit-for-approval — moves the draft into the existing approval flow; on approval the send builds message_queue rows (opted-out parents auto-excluded, skipped count returned). No second sending path.
- GET /messages/recipients?filter=absent|fee_unpaid&class_id=&date=&month= — recipient picker source (absent list, fee-unpaid list) over existing data.
- Variables rendered: {student_name} {father_name} {class} {section} {date} {amount} {month} {school_name} (see SCHEMA.md §11).

### Section 11 — implementation additions (2026-11-06, agent S11)
The contract list above names the endpoints; the implementation adds the
three calls the approval-before-send flow needs (no contract change beyond
this note), plus history filters:
- POST /messages/preview {body?, template_id?, recipient_type, target_class_id?, target_student_ids?, filter?, date?, month?} — live preview: rendered samples (first 3 recipients, exactly what each parent receives) + char count + SMS-part count (160 GSM / 70 Unicode per part) + recipient count + skipped/opted-out count. Read-only; queues nothing.
- POST /messages/drafts/:id/approve-send (admin) — direct admin approval: records an APPROVED approval_requests row, then sends now, or marks the draft 'scheduled' when scheduled_for is in the future (the scheduled-messages job picks it up when due). Returns {queued, skipped, skipped_opted_out} or {scheduled: true}.
- POST /messages/drafts/:id/reject (admin) {reason?} — cancels the draft and rejects any pending approval request for it.
- GET /messages/log — also accepts ?class_id= (in addition to status/type/date) and each item now carries student_name, parent_phone_masked and the latest message_deliveries row ({status, delivered_at, error}).
- GET /messages/pending-approval — now returns the contract shape {groups: [{group_id, class, class_id, date, absent_count, messages: [{id, student, parent_phone_masked, body, dedupe_key}]}]} (was raw camelCase rows).
- message_queue.type now also accepts 'result' | 'announcement' | 'custom' (migration 20261106232000_v2_queue_custom_type) so custom drafts send through the existing queue with type 'custom' and dedupe `custom:{draft_id}:{student_id}`.
- Scheduled job 'scheduled_messages' (every 5 min): sends due scheduled drafts that have an approved approval_requests row; unapproved scheduled drafts stay scheduled and never send. See backend/src/modules/messaging/CUSTOM-MESSAGES.md.

## 6C-1 additions (2026-11-06 — sessions / exams / timetable / staff / payroll)

Implemented in `backend/src/modules/{sessions,exams,timetable,staff}/`.
Clerk mutations on all of these return 202 (approval queue) unless noted;
admin applies directly. Principals are view-only (403 on mutations).
Full rules in `backend/src/modules/sessions/FEATURES-6C1.md`.

- Sessions: `GET /sessions?archived_only=&include_archived=`, `POST /sessions`,
  `GET /sessions/:id`, `PATCH /sessions/:id`, `DELETE /sessions/:id`
  (guarded hard delete — blocked while current / referenced by exams /
  promotions), `POST /sessions/:id/make-current`, `POST /sessions/:id/archive`,
  `POST /sessions/:id/unarchive`, `POST /sessions/:id/promote`
  `{from_class_id, to_class_id}` (whole class-section; reuses the hardened
  `promoteStudents` implementation), `GET /sessions/:id/promotions`.
  Archive flag lives in school settings JSONB `archived_session_ids`
  (academic_sessions has no is_archived column — see FEATURES-6C1.md);
  archived sessions are read-only (409 on make-current / update / promote /
  exam create) and their exams are excluded from the default exam list.
- Exams (definitions only; results belong to 6B): `GET /exams?session_id=&search=&include_archived=`,
  `POST /exams`, `GET /exams/:id`, `PATCH /exams/:id`, `DELETE /exams/:id`
  (soft delete → recycle bin), `GET /exams/:id/datesheet?class_id=`,
  `POST /exams/:id/datesheet`, `PATCH /exams/datesheet/:id`,
  `DELETE /exams/datesheet/:id`.
- Grading scales: `GET /grading-scales?class_id=` (class bands, then school
  defaults), `POST /grading-scales`, `PATCH /grading-scales/:id`,
  `DELETE /grading-scales/:id`, `POST /grading-scales/seed-defaults`
  (A+..F, passing 50), `GET /grading-scales/passing?class_id=` — passing
  marks are stored on the grading scale (lowest min_marks among is_passing
  bands; class override wins over the school default). No passing_marks
  column exists on exams/classes.
- Timetable: `GET /timetable?class_id=&teacher_id=&day=` (day 0–6),
  `GET /timetable/class/:class_id`, `GET /timetable/teacher/:staff_id`
  (both grouped by_day 0–6), `POST /timetable`, `PATCH /timetable/:id`,
  `DELETE /timetable/:id`. Conflicts (409): same class+day+period; same
  teacher+day+period or overlapping time; same class+day overlapping time.
- Staff & payroll: `GET /staff?role=&search=`, `POST /staff`,
  `GET /staff/:id`, `PATCH /staff/:id`, `DELETE /staff/:id` (blocked while
  on the timetable or with salary records), `GET /staff/:id/assignments`,
  `POST /staff/:id/assign`, `DELETE /staff/:id/assign/:assignment_id`,
  `GET /payroll?month=&staff_id=&paid=`, `POST /payroll`
  `{staff_id, month, base_salary?, deductions?, payslip_no?}` → net_pay
  = max(0, base − deductions), `GET /payroll/:id`, `PATCH /payroll/:id`
  `{base_salary?, deductions?, paid?}`, `DELETE /payroll/:id` (paid records
  cannot be deleted), `GET /payroll/:id/payslip` (printable HTML).

---

## 6B additions (2026-11-06 — students/classes/results)

Base `/api/v1`, same envelope/auth/tenant rules. Clerk mutations return
202 (approval queue); admin applies directly. Principal view-only.

### Students (extended profile)
- `GET /students?admission_no=&status=&search=&class_id=` — school-wide list (incl. `struck_off`/`graduated`).
- `POST /students/:id/move {class_id}` — move between sections/classes (same school; roll/name must be free in target; change-logged).
- `POST /classes/:id/students/import-preview` — multipart CSV/Excel; per-row `{row, status: ok|duplicate|invalid, reason}`; writes NOTHING. Confirm with `POST /classes/:id/students/import-csv` afterwards.
- `POST /classes/:id/students` / `PATCH /students/:id` — now accept the full extended profile (`father_name`, `admission_no` unique per school, `date_of_birth`, `gender`, `address`, `admission_date`, `parent2_name`, `parent2_phone`, `parent2_opt_out`, `parent_opt_out`, `status` incl. `struck_off`).
- `POST /students/:id/issue-id-card` — stamps `id_card_issued_at` (route in the 6C-2 certificates router).

### Results
- `POST /classes/:id/results/upload` (multipart `image` + `exam_name`) and `POST /results/upload` (multipart `image` + `class_id` + `exam_name`) → `{result_sheet_id, exam_id, raw_text, headings, rows, engine, warnings}`. Exam row created if needed.
- `GET /results/review/:sheetId` and `GET /result-sheets/:id` — review data with per-row `link_preview` (`{studentId, method: roll|name|null, mismatch}`).
- `POST /result-sheets/:id/confirm {rows}` → `{saved, linked, unlinked, skipped, flagged}`. Upserts by `(exam_id, class_id, roll_no)`; positions recomputed.
- `POST /results/manual {exam_id?/exam_name?, class_id, session_id?, rows}` — manual entry, no sheet.
- `GET /results?exam_id=&class_id=&student_id=&linked=&search=`, `GET /results/:id`, `PATCH /results/:id` (recomputes %/grade/positions), `POST /results/:id/link {student_id}` (explicit link, same class only, never creates a student), `DELETE /results/:id` (soft delete → recycle bin), `DELETE /result-sheets/:id` (soft delete).
- `GET /results/toppers?exam_id=&class_id=&limit=`, `GET /results/summary?exam_id=&class_id=` (pass/fail; default pass mark 33% unless grading scales set a band), `GET /results/report-card/:student_id/:exam_id` (HTML; `?format=pdf`), `GET /students/:id/report-card?exam_id=` (alias), `GET /results/export?format=xlsx|pdf&exam_id=&class_id=`.
- `POST /result-sheets/:id/publish` — marks sheet `published`, creates `message_drafts` (status `draft`) for linked students' parents; opted-out/missing numbers skipped with reasons. Drafts go through the existing approval flow before any send; no direct `message_queue` insert (queue rows are born approved — drafts are the pending-approval vehicle).
- Exams list/create/update/delete live in 6C-1 (`modules/exams/**`); the results flow only upserts exam rows internally when a sheet/manual entry names a new exam.

### Classes
- No new endpoints. Verified: no caps on classes/sections/students; sections are independent (own teacher + own attendance link per `(name, section)` row); teacher assign/change already on `POST /classes` / `PATCH /classes/:id` (no migration — fields already in the schema).

## 6C-2 endpoints (2026-11-06 — School Features part 2)

Base `/api/v1`, same envelope/auth/tenant rules as v1. Clerk writes go
through the approval queue (202) unless noted; every edit writes a
`change_logs` row; principal is view-only.

- Fees extensions: `POST /fees/structures` accepts `admission_fee`,
  `sibling_discount_pct` (already wired in 6A; 6C-2 folds them into
  `amount_due` at record creation — see FEATURES-6C2.md). `POST
  /fees/:student_id/pay` accepts `arrears`, `scholarship_discount`.
  `GET /fees` rows now include `record_id`, `arrears`,
  `scholarship_discount`, `breakdown` (prospective, when no record exists).
  Vouchers: `GET /fees/vouchers?month=&status=`, `POST /fees/vouchers
  {fee_record_id, month, due_date?}` → `{voucher_no}`,
  `POST /fees/vouchers/by-student {student_id, month, due_date?}`,
  `GET /fees/vouchers/:voucher_no` (HTML; `?format=pdf`).
- Expenses: `GET /expenses?month=&category=`, `POST /expenses {date,
  category, description?, amount, paid_by?}`, `PATCH /expenses/:id`,
  `DELETE /expenses/:id`, `GET /expenses/report/income-expense?month=`.
- Announcements (notice board only): `GET /announcements?status=`, `GET
  /announcements/:id`, `POST /announcements {title, body, target_type,
  target_class_id?, sms_send?}`, `PATCH /announcements/:id`, `DELETE
  /announcements/:id`, `POST /announcements/:id/approve` (admin; notice
  board only, no SMS). `POST /announcements/:id/send` (admin; approved +
  sms_send only — wired in Phase 8 QA to the Section 11 draft → approval →
  queue flow, queue type 'announcement'; see FEATURES-6C2.md §Announcement-SMS hook point).
- Events: `GET /events?month=`, `POST /events {date, title,
  description?}`, `PATCH /events/:id`, `DELETE /events/:id`, `GET
  /events/calendar?month=` (holidays + events merged).
- Certificates + ID cards: `POST /students/:id/certificates {type}` →
  `{certificate_id, certificate_no, certificate_url}`, `GET
  /students/:id/certificates`, `GET /certificates/:id` (HTML;
  `?format=pdf`), `POST /students/:id/issue-id-card`, `GET
  /students/:id/id-card` (printable HTML).
- Leave + late: `GET /leaves`, `POST /leaves`, `PATCH /leaves/:id
  {status: approved|rejected}` (existing; 6C-2 adds change history),
  `GET /leaves/late?date=&month=&class_id=`.
- Reports (all support `?format=pdf|xlsx|csv`): `GET
  /reports/fees/defaulters?month=&class_id=`, `GET
  /reports/results/summary?exam_id=&class_id=`, `GET
  /reports/classes/strength`, `GET /reports/messages/history?status=&type=&date=`,
  `GET /reports/income-expense?month=`.
- Settings: `GET /settings`, `PATCH /settings` — now also `school_name`,
  `timezone`, `school_address`, `school_phone`, `logo_url`, `language`
  (`en`|`ur`).
- Notification center: `GET /notifications/center` (read-only
  aggregation: pending approvals, failed messages, OCR needing review,
  fee dues).

---

# 6D additions (2026-11-06 — agent 6D; see backend/src/modules/security/SECURITY-6D.md)

## Rate limiting (verified, one gap fixed)
- General API: 300 req / 15 min / IP (`apiLimiter`, every `/api/*` route).
- Auth endpoints: 20 attempts / 15 min / IP (`authLimiter`): signup,
  verify-email, login, 2fa/login, forgot-password, reset-password — and
  `POST /auth/refresh` (6D: it was the only auth route without the limiter).
- Public teacher link: 120 req / 10 min / IP.
- Over the limit: `429 {ok:false, error:{code:'RATE_LIMITED', ...}}` +
  `RateLimit-*` draft-7 headers.

## Backup
- `POST /backups/run` (admin) — run this school's backup now; returns
  `{ran, school, file, sizeBytes, tables, exportedAt}`.
- Nightly job `school_backup` (02:00 UTC): per-school full export to
  `backend/backups/<slug>/<YYYY-MM-DD>.json` + a `school_backups` row.
  `GET /backups` (admin, 6A) lists the log. **Caveat:** local disk is
  ephemeral on the Render free tier — the durable copy is the admin's
  manual export (`POST /export/all`).
- Restore: `npx tsx src/jobs/restore-backup.ts <file> [--slug=<new-slug>] [--apply]`
  (dry-run default; restores as a NEW school, never overwrites the source;
  restored logins need “Forgot password” — passwords are scrubbed from exports).

## Session timeout
- Setting `session_timeout_minutes` (default 120, 15–1440) via
  `GET/PATCH /settings`.
- `POST /auth/refresh` is rejected with `401 {code:'SESSION_EXPIRED'}`
  when the refresh token is older than the setting (idle time is measured
  from the token's `iat`; the frontend only refreshes on real activity).
  Access tokens still live 15 min.
- Frontend: idle warning modal 2 min before expiry (“Stay signed in” /
  “Sign out now”); on expiry the login page explains the sign-out.
- `GET /auth/sessions` / `DELETE /auth/sessions/:id` are NOT built:
  with stateless JWTs there is no server-side session to list or revoke.
