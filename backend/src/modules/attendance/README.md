# Attendance module

Public tokenized teacher links + admin attendance management + teacher attendance.

## Endpoints

### Public (no JWT, rate-limited) — mounted at `/api/v1`

| Method | Path | Description |
|---|---|---|
| GET | /t/:token | Validates the link → `{class, date, non_school_day, already_submitted, students:[{id, name, roll_no, status?}]}`. 404 if the token is invalid, revoked or expired. |
| POST | /t/:token/submit | `{records:[{student_id, status}]}` — statuses `present/absent/late/leave`. Students missing from `records` default to `present`. 201 on success. |

### Admin (JWT + tenant) — mounted at `/api/v1`

| Method | Path | Role | Description |
|---|---|---|---|
| GET | /classes/:id/attendance?date= | admin/clerk | A class's submitted day + records for a date (null if none). |
| PATCH | /classes/:id/attendance/unlock | admin | Unlocks a submitted day so the teacher link can re-submit it (one-time). |
| PATCH | /attendance/:dayId | admin | Edit a submitted day's records. Re-syncs absent drafts (cancels unapproved drafts for students no longer absent, drafts new ones for newly absent). |
| POST | /teacher-attendance | admin | Mark a teacher `{class_id, date, status, note?}` (upsert per class/day). |
| GET | /teacher-attendance?date=&class_id= | admin/clerk | List teacher attendance. |

## Rules enforced (contracts/API.md)

1. **One submission per class per day** — a second submit returns 409 unless the admin unlocked the day (unlock is consumed by the re-submit).
2. **No attendance on Sundays or holidays** — submit returns 409 `No attendance on Sundays or holidays`; the same check runs in `GET /t/:token` (returns `non_school_day: true`).
3. **Messages only for absent students, only after approval** — on submit, draft `message_queue` rows are created (status `queued`, `approved_by` NULL = held) with `dedupe_key = absent:{student_id}:{date}`, plus a `notifications` row of type `absent_approval`. The Messaging Agent's approve endpoint releases them. Students with no valid parent number or `parent_opt_out` are skipped and listed in the response (`students_without_valid_number`) and in the notification body.
4. **Teacher absence NEVER creates messages** — teacher attendance is a separate table and no queue rows are created from it.
5. **Dedupe** — the unique `dedupe_key` constraint is the backstop against duplicate sends for the same (student, day); re-submits and edits check it before creating rows.
6. **Audit** — every submit / unlock / edit / teacher mark writes an `audit_logs` row (actor `teacher_link` for link submits).
7. **Template** — the absent message body is rendered from the school's active `absent` template (language from `school.settings.message_language`, default `en`), falling back to the contract default text.

## Offline

The teacher page is PWA-style (frontend): if offline on submit, the browser stores the payload in localStorage and retries when online. The backend accepts late same-day submissions (the day's `date` is always the school-local today).
