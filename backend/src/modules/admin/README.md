# Admin module

Dashboard, settings, clerk management, holidays, academic sessions, promotions, leaves, audit logs and notifications.

## Endpoints (mounted at `/api/v1`, all JWT + tenant-scoped)

| Method | Path | Role | Description |
|---|---|---|---|
| GET | /dashboard | admin/clerk | `{date, non_school_day, classes_total, classes_submitted, classes_pending, present, absent, teachers_present, teachers_absent, fee_collected_this_month, fee_pending_this_month, recent_notifications}`. On Sundays/holidays `classes_pending` is 0 and `non_school_day` is true. |
| GET | /settings | admin/clerk | Settings with defaults applied. |
| PATCH | /settings | admin | Whitelisted keys only: `teacher_reminder_time` (HH:MM), `fee_auto_send`, `fee_require_approval`, `fee_followup_day` (1–28 or null), `sms_provider` (sim/gateway), `teacher_attendance_mode` (admin/link), `message_language` (en/ur). |
| POST | /users/clerks | admin | Create a clerk login `{email, password}`. |
| GET | /users | admin | List users (no password hashes). |
| DELETE | /users/:id | admin | Cannot delete yourself or the last admin. |
| GET | /holidays | admin/clerk | List holidays (date order). |
| POST | /holidays | admin | `{date, name}` — 409 if the date is already a holiday. |
| DELETE | /holidays/:id | admin | |
| GET | /sessions | admin/clerk | Academic sessions. |
| POST | /sessions | admin | `{name, start_date, end_date}`. |
| POST | /sessions/:id/make-current | admin | Exactly one current session per school. |
| POST | /promotions | admin | `{session_id, mappings:[{student_id, to_class_id}]}` — moves students and writes `promotions` rows (transactional). |
| GET | /leaves | admin/clerk | Leave applications (`?student_id=&status=`). |
| POST | /leaves | admin | `{student_id, from_date, to_date, reason}`. |
| PATCH | /leaves/:id | admin | `{status: approved\|rejected}`. |
| GET | /audit-logs?entity=&action= | admin | Paginated, newest first. |
| GET | /notifications?unread_only= | admin/clerk | Unread first, newest first. |
| POST | /notifications/:id/read | admin/clerk | Mark one notification read. |

## Notes

- Clerk limits (contracts/SCHEMA.md): clerks cannot manage users, change settings, regenerate teacher links, or approve messages. Those endpoints are `requireAdmin`; clerks can view the dashboard, students, fees (Fee Agent), reports and logs.
- Dashboard "today" is always computed in the school's timezone (`todayInTz`).
- Every mutation writes an `audit_logs` row.
