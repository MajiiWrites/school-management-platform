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
- id UUID PK, attendance_day_id UUID FK attendance_days, student_id UUID FK students, status TEXT CHECK IN ('present','absent','late','leave'), marked_at TIMESTAMPTZ, updated_by TEXT
- Unique: (attendance_day_id, student_id). Index: (student_id, status).

### teacher_attendance
- id UUID PK, school_id UUID FK, class_id UUID FK classes, date DATE, status TEXT CHECK IN ('present','absent','leave'), marked_by UUID NULL, note TEXT NULL, created_at
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
