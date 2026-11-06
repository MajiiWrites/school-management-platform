# Scheduler jobs — `backend/src/jobs/`

node-cron jobs for fee reminders, follow-ups, pending-attendance checks,
and teacher reminders. All jobs run in **school-local time** (each school's
`timezone`); cron ticks run in UTC and each job converts internally, so one
deployment serves schools in different timezones.

## Jobs

| Job | Schedule (tick) | What it does |
|---|---|---|
| `monthly_fee_reminder` | every 30 min | On the **first school day of the month** (the 1st, or the 2nd/3rd when the 1st is a Sunday/holiday): rolls the month over, then queues one `fee_reminder` per UNPAID record. |
| `fee_followup` | every 30 min | On `settings.fee_followup_day` (or the next school day within 3 days): queues a follow-up for students **still** unpaid. |
| `daily_pending_attendance` | every 30 min | At/after `settings.pending_check_time` (default `16:00` local): creates one notification per class with no attendance submission today. |
| `teacher_reminders` | every 5 min | Inside a 5-min window from `settings.teacher_reminder_time` (default `15:00` local): queues one `teacher_reminder` SMS per unsubmitted class whose teacher has a phone. |

## Rules every job enforces

- **Never on Sundays or holidays** (holidays table). The monthly job shifts
  to the first school day instead of skipping the whole month.
- **Paid students are NEVER reminded.** Only records with balance > 0
  (`amount_due - amount_paid - discount`) get a row. Partial-paid-in-full
  (balance 0) counts as paid. Left/graduated students, missing parent
  numbers, and opted-out parents are skipped (and counted).
- **Idempotent by design.** Queue rows use `dedupe_key` (UNIQUE):
  `fee:{student_id}:{month}`, follow-up `fee:{student_id}:{month}:followup`,
  `teacher:{class_id}:{date}`. Rollover uses `skipDuplicates`. Notifications
  are de-duplicated per school day. A job may run twice without
  double-sending; the registry additionally records per-school last runs.
- **Approval semantics.** Fee rows are pre-approved (`approved_at` set)
  only when `settings.fee_auto_send` is true; otherwise `approved_at` stays
  null and the row waits for admin approval (`POST /messages/approve`).
  Teacher reminders are auto-approved by design (admin approval applies to
  parent messages, not teacher reminders). **Messaging Agent note:** only
  rows with `approved_at != null` are sendable.
- **Rate limiting.** `scheduled_for` is staggered 2s per message so one SIM
  never bursts (the device poller also enforces 1 msg / 2 s).
- **Teacher absence never creates parent messages.** These jobs only remind
  teachers to submit; they never message parents about teachers.
- **Templates.** Bodies come from `message_templates` (`fee_reminder` /
  `teacher_reminder`, preferring `en`). Variables: `{student_name}`
  `{class}` `{month}` `{amount}` `{school_name}` for fees;
  `{class}` `{date}` `{school_name}` for teachers. `{amount}` is the
  **remaining balance** (integer PKR, no "Rs." prefix — put that in the
  template text if wanted). `{month}` is the `YYYY-MM` key; `{date}` is a
  human date like `6 Nov 2026`. Unknown variables are left in place and
  reported in the job result (`missing_template_vars`).
- **Audit + notifications.** Each run writes an `audit_logs` row and (when
  it creates rows) a notification.

## Settings keys used (schools.settings JSONB)

`teacher_reminder_time` ("HH:MM", default `15:00`), `pending_check_time`
("HH:MM", default `16:00`), `fee_auto_send` (bool, default false),
`fee_require_approval` (bool, default `!fee_auto_send`),
`fee_followup_day` (int day-of-month or null = disabled),
`sms_provider` ('sim' | 'gateway').

## Status endpoint

`getJobsStatus(db)` (registry.ts) returns last runs per job per school
(last run time, status ok/skipped/error, summary, error, run count).
`jobs/status-router.ts` exposes it as `GET /jobs/status` (mount it with the
fees module — see MOUNT.md). Last-run state is in-memory and resets on
restart; persist it (e.g. a `job_runs` table) if durable history is needed.

## Run a job manually

```bash
# Needs DATABASE_URL and the generated Prisma client.
npx tsx src/jobs/run-manual.ts monthly_fee_reminder --school=demo-public
npx tsx src/jobs/run-manual.ts teacher_reminders --school=demo-public --at=2026-11-06T10:00:00Z
```

`--at` fakes "now" (ISO) so a job can be tested for a specific school-local
date/time. Valid job names: `monthly_fee_reminder`, `fee_followup`,
`daily_pending_attendance`, `teacher_reminders`.

## How to test

```bash
npx vitest run src/jobs/__tests__/jobs.test.ts src/jobs/__tests__/demo-flow.test.ts
```

13 tests cover date/timezone math, first-school-day shifting, paid
exclusion, dedupe, follow-up windows, Sunday/holiday skips, and the
teacher/pending flows. The demo test scripts the whole November cycle
through the real service/job functions and prints a trace.
