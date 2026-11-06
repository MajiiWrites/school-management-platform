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
