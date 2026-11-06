# v2 Schema Notes — School Management Platform

Date: 2026-11-06. Author: agent 6A-1 (Schema & Contracts).
Source of truth: `contracts/SCHEMA.md` ("v2 additions", §§1–11) and
`contracts/API.md` ("v2 endpoints"). This file is the implementation map:
what was added, which migration carries it, and what each later phase needs.

## Migrations

| Migration | Contents |
|---|---|
| `backend/prisma/migrations/20261106120000_init/migration.sql` | v1 — UNTOUCHED, never edit. |
| `backend/prisma/migrations/20261106230000_v2_schema/migration.sql` | All v2 tables/columns except Custom Messages: 20 new tables, extended student profile, roles/permissions + default seed, approval queue, recycle bin + soft-delete columns, change history, results module, timetable/staff/payroll, expenses/announcements/events/certificates, exam datesheets, fee extensions + vouchers, account deletion requests, school backups, 2FA columns. Hand-added: CHECK constraints (incl. extended `users.role` and `students.status`) + per-school permission seed for pre-existing schools. |
| `backend/prisma/migrations/20261106231000_v2_messages/migration.sql` | Section 11 (Custom Messages): `message_templates.name` + `is_custom`, type CHECK extended to 6 types, new `message_drafts` table, name backfill for v1-seeded templates. Hand-added: CHECKs + backfill UPDATE. |

### ⚠️ `fee_records.status` drift — read before regenerating any migration
`fee_records.status` is a GENERATED ALWAYS column (v1, QA §5.1). The Prisma
schema declares it `@default(dbgenerated(...))` so Prisma omits it from
writes. Every `prisma migrate diff` re-emits this as
`ALTER COLUMN "status" SET NOT NULL / SET DEFAULT (CASE...)` — applying that
would silently convert the generated column into a plain column with a
default. It was stripped from BOTH v2 migrations by hand (the first
`migrate deploy` of `v2_messages` failed on exactly this before the strip).
**Rule: after any future `migrate diff`, grep the output for `fee_records`
and delete any `ALTER COLUMN "status"` lines before applying.** The checked-in
migration SQL is authoritative, not the diff.

### How the migrations were produced
`prisma migrate dev` is interactive and cannot run in this environment, so
both v2 migrations were generated with
`prisma migrate diff --from-migrations ... --to-schema-datamodel ... --script`
against a shadow DB, hand-edited (CHECKs + seed + drift strip), then applied
with `prisma migrate deploy`. That is the supported non-interactive path;
the SQL is identical in shape to what `migrate dev` would emit.

## Table list (21 new tables)

| Table | Purpose | Key constraints |
|---|---|---|
| `role_permissions` | Per-school customizable permissions | UNIQUE (school_id, role, resource, action); role/action CHECKs |
| `approval_requests` | Clerk/sub-account adds/deletes wait here | action_type/status CHECKs; payload JSONB |
| `deleted_records` | Recycle bin snapshots | restoreBy = deletedAt + 30d; index (restoreBy) for purge job |
| `change_logs` | Per-field old/new history | index (school_id, entity, entityId, changedAt) |
| `exams` | Midterm/Final/Monthly Test | session_id NULLABLE; soft-delete |
| `grading_scales` | Grade/GPA bands, per class or all | CHECK max > min ≥ 0; overlap validated in app |
| `result_sheets` | OCR result-sheet uploads (mirrors v1 ocr_uploads) | status processing/review/saved/published |
| `results` | One row per student per exam/class | UNIQUE (exam_id, class_id, roll_no); student_id NULL until linked |
| `timetable_entries` | Class timetable | UNIQUE (school_id, class_id, day_of_week, period_no); day 0–6 |
| `staff` | Teachers + non-teaching staff | role teacher/staff; phone enc/hash pattern |
| `staff_class_assignments` | Who teaches what where | UNIQUE (staff_id, class_id, subject) |
| `salary_records` | Monthly payroll | UNIQUE (staff_id, month YYYY-MM) |
| `expenses` | School expenses | index (school_id, date), (school_id, category) |
| `announcements` | Notices, optional SMS | target all/class; status draft/approved/sent |
| `events` | School calendar events | index (school_id, date) |
| `certificates` | Leaving/character/bonafide | type CHECK; issued_at/issued_by |
| `exam_datesheets` | Per-exam per-class paper schedule | UNIQUE (exam_id, class_id, subject, date) |
| `fee_vouchers` | Printable fee vouchers | UNIQUE (school_id, voucher_no) |
| `account_deletion_requests` | Data-deletion requests | status pending/approved/completed/rejected |
| `school_backups` | Per-school backup log | file_ref + size_bytes |
| `message_drafts` | Custom-message drafts (§11) | recipient_type/status CHECKs; target_student_ids JSONB |

## Columns added to v1 tables

| Table | Added columns |
|---|---|
| `users` | `totp_secret_enc` (NULL), `totp_enabled` (false), `login_alerts` (true), `last_login_ip` (NULL). Role CHECK → admin/clerk/principal. |
| `students` | `father_name`, `admission_no` (UNIQUE per school), `date_of_birth`, `gender`, `address`, `admission_date`, `parent2_name`, `parent2_phone_enc`, `parent2_phone_hash`, `parent2_opt_out` (false), `deleted_at`, `id_card_issued_at`. Status CHECK → + `struck_off`. |
| `classes` | `deleted_at`. |
| `fee_structures` | `admission_fee` (0), `sibling_discount_pct` (0, CHECK 0–100). |
| `fee_records` | `arrears` (0), `scholarship_discount` (0), `deleted_at`. `status` GENERATED — never write. |
| `message_templates` | `name` (NULL, backfilled by migration), `is_custom` (false). Type CHECK → + `result`, `announcement`, `custom`. |

## Design decisions (made here so later phases don't rework them)

1. **Additive only.** No v1 column was renamed, retyped, or dropped. All new
   columns are nullable or defaulted, so the v1 seed and all v1 code keep
   working unchanged.
2. **CHECKs in migration SQL only.** Prisma 6.19.3 has no `@@check`; the
   schema carries no CHECK. If a phase regenerates migrations, the hand-added
   CHECK blocks (end of each v2 migration file) must be re-applied.
3. **Soft delete = `deleted_at` + `deleted_records` snapshot.** Six tables
   carry `deleted_at` (students, classes, fee_records, exams, results,
   result_sheets). Every list query over them must add `deleted_at IS NULL`.
   The purge job (later phase) uses `deleted_records.restoreBy`.
4. **Approval queue stores the proposal, not a half-applied row.**
   `approval_requests.payload` is the full proposed change; nothing is
   written to the target table until an admin approves. Clerk "add" is a
   request, never a row.
5. **`change_logs` ≠ `audit_logs`.** Audit = one row per action (v1, stays).
   Change history = one row per changed field with old/new values.
6. **`results.roll_no` is NOT NULL, `student_id` is NULL until linked.**
   The unique key (exam_id, class_id, roll_no) is therefore enforceable;
   unlinked OCR rows are matched to students by roll_no at confirm/link time.
7. **`exams.session_id` and `result_sheets.session_id` are NULLABLE.**
   Monthly Tests often sit outside a session; forcing a session would invent
   data. `grading_scales.class_id` NULL = applies to all classes (overlap
   validated in the app layer — NULL defeats a DB unique constraint).
8. **Times are TEXT "HH:MM".** `timetable_entries` and `exam_datesheets`
   store start/end time as 24h "HH:MM" strings (same as
   `schools.settings.teacher_reminder_time`), not `TIME` columns — simpler
   for the frontend and for the scheduler; the phase owning each table
   validates the format.
9. **Money is integer PKR everywhere** (`admission_fee`, `arrears`,
   `scholarship_discount`, `salary_records`, `expenses`, `fee_vouchers`).
   `fee_records.status` is GENERATED from `amount_paid + discount` vs
   `amount_due` ONLY — `arrears`/`scholarship_discount` do NOT feed it; the
   Fees phase must fold them into `amount_due` at record creation.
10. **Announcements target model.** `target_type` ('all' | 'class') +
    `target_class_id` NULL (= all classes). SMS for announcements reuses the
    v1 `message_queue` + approval flow; there is no second sending path.
11. **Custom Messages (§11) renderer extension.** The v1 message builder
    only rendered `{student_name}`, `{class}`, `{date}`, `{school_name}`.
    The Messages phase MUST extend the renderer to all eight variables:
    `{student_name}` `{father_name}` `{class}` `{section}` `{date}`
    `{amount}` `{month}` `{school_name}`. `{class}` = class name, `{section}`
    = section. Unknown variables render literally, never crash a send.
    "Variables used" is derived at render time by scanning `body` — no
    column on `message_drafts`. Drafts NEVER send directly: submit for
    approval → approval → `message_queue` rows, with opted-out parents
    auto-excluded and a skipped count returned.
12. **Templates are per-school copies, nothing locked.** `is_custom`
    distinguishes seeded defaults (false) from admin-created ones (true),
    but the flag grants no protection — any template may be edited, renamed,
    duplicated, or deleted by that school's admin.
13. **Permissions seed lives in TWO places deliberately.** The v2_schema
    migration seeds defaults for schools that already exist at deploy time;
    `prisma/seed.ts` seeds them for the demo school on a fresh DB (the school
    does not exist yet when the migration runs). Both use the same matrix
    (admin 84 rows, clerk 9, principal 12); keep them in sync if the matrix
    changes. `ON CONFLICT DO NOTHING` / upsert makes both idempotent.
14. **2FA secret encryption.** `users.totp_secret_enc` uses the same
    AES-256-GCM pattern as phone encryption (base64(iv||tag||ct), key from
    `PHONE_ENC_KEY` via `src/lib/crypto.ts`); never store or return it in
    plaintext. TOTP verification itself is a later (6D) phase.
15. **Teacher is link-only, no login.** `staff.role = 'teacher'` does NOT
    create a `users` row. The timetable's `teacher_id` points at `staff`.

## What each phase needs from this schema

- **6A (core: roles/approvals/recycle bin/change history):**
  `role_permissions`, `approval_requests`, `deleted_records`, `change_logs`,
  `users.role` (+principal), soft-delete columns. Enforce permissions in
  middleware from `role_permissions`; clerk mutations must create
  `approval_requests` rows; every edit writes `change_logs`.
- **6B (students/results):** extended `students` columns (+ `admission_no`
  unique, `struck_off`), `exams`, `exam_datesheets`, `grading_scales`,
  `result_sheets`, `results` (+ link-by-roll_no flow, toppers = ORDER BY
  `position`/percentage).
- **6C (features):** `timetable_entries`, `staff` + `staff_class_assignments`,
  `salary_records`, `expenses`, `announcements`, `events`, `certificates`,
  `fee_structures`/`fee_records` extensions, `fee_vouchers`,
  `message_templates` extensions + `message_drafts` (renderer extension per
  decision 11; recipient quick filters are queries over existing
  attendance/fee data; preview + char/SMS-part counter are frontend).
- **6D (roles/security):** `role_permissions` matrix UI, `users` 2FA columns,
  `account_deletion_requests`, `school_backups`, session-timeout (no new
  table — uses existing JWT/refresh mechanics).
- **7 (live deploy):** run `prisma migrate deploy` (v1 → v2_schema →
  v2_messages, in order). No seed on live (SEED_ON_BOOT off, demo removed);
  the v2_schema migration seeds permissions for the live school(s)
  automatically. Back up before deploying (free Postgres expires 2026-12-06).
- **8 (QA):** re-run the CHECK probes below on the live DB after deploy
  (read-only probes where possible); verify `fee_records.status` is still
  GENERATED; verify no v1 behaviour regressed (vitest + seed still green).

## Verification (this pass, scratch DB `v2dev`, local Postgres 16 — live DB untouched)

- `npx prisma validate` — valid.
- `npx prisma migrate deploy` — 3 migrations applied (init, v2_schema,
  v2_messages); `migrate status` — up to date. (One failed deploy attempt:
  `migrate diff` re-emitted the `fee_records.status` drift; stripped, marked
  rolled back, re-deployed clean — see drift note above.)
- `npx prisma generate` + `npx prisma db seed` — seed complete and
  idempotent (25 students, 23 unpaid / 2 paid fee records, 105 role-permission
  rows: admin 84, clerk 9, principal 12; re-run produced the same counts).
- CHECK probes (rolled-back transactions, DB left clean): `principal` role,
  `struck_off` status, `result` template type, `selected_students` /
  `single_parent` drafts all INSERT OK; `superadmin` role, `bogus` template
  type, `everyone` recipient type, `flying` draft status all rejected by the
  correct CHECK constraint.
- `fee_records.status` confirmed still `is_generated = ALWAYS` after both
  migrations.
- `npx tsc --noEmit` (backend) — 0 errors.
- `npx vitest run` (backend) — 9 files, 125 tests, all pass. (v1 had 8 files /
  80 tests; parallel agents added an isolation/cross-tenant suite during this
  pass. One transient failure was observed mid-run in that suite — a tsc error
  in `cross-tenant.test.ts:615` while another agent was editing the file — and
  both `tsc` and the full suite passed clean on immediate re-run; it was not
  caused by the schema change.)

## Files changed

- `backend/prisma/schema.prisma` — v2 models + columns (formatted with
  `prisma format`).
- `backend/prisma/migrations/20261106230000_v2_schema/migration.sql` — new.
- `backend/prisma/migrations/20261106231000_v2_messages/migration.sql` — new.
- `backend/prisma/seed.ts` — role-permission seed (105 rows) + template names.
- `contracts/SCHEMA.md` — "v2 additions" (§§1–11).
- `contracts/API.md` — "v2 endpoints" (list only).
- `backend/prisma/V2-SCHEMA-NOTES.md` — this file.
- Nothing else: no services, routes, or frontend touched; live DB and Render
  deploy untouched.
