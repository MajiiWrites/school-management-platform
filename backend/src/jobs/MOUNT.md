# MOUNT.md — Jobs (integration notes for the Lead / Phase 3)

## 1. REQUIRED dependency (do this first)

`node-cron` is **not yet in `backend/package.json`** (it is the scheduler
the contracts specify, but nobody has added it). Run once:

```bash
npm install node-cron@3.0.3
npm install -D @types/node-cron@3.0.11
```

Until then the backend still compiles for other modules, but
`src/jobs/registry.ts` cannot be imported and the jobs cannot start.
(For verification only, the packages were installed with `--no-save` into
`node_modules`; that does not survive the next `npm install`.)

## 2. Start the jobs (server.ts)

```ts
import { getDb } from './lib/db';
import { registerJobs } from './jobs/registry';

const jobs = registerJobs(getDb());
// on shutdown: jobs.stop();
```

`registerJobs` starts four cron ticks (see jobs/README.md). It never
throws on a single school's failure — errors are recorded per school and
logged; the tick continues with the next school.

## 3. Mount the status endpoint (app.ts)

```ts
import { jobsStatusRouter } from './jobs/status-router';
app.use('/api/v1/jobs', jobsStatusRouter); // GET /jobs/status (admin, clerk)
```

Alternatively the Backend Agent can call `getJobsStatus(getDb())` from its
own endpoint — the data shape is identical.

## 4. Notes for the Messaging Agent

- **Sendable = `approved_at IS NOT NULL`.** Fee rows are pre-approved only
  when `settings.fee_auto_send` is true; otherwise they wait for admin
  approval. Teacher-reminder rows are always pre-approved.
- **Dedupe keys are the backstop.** Never send a row twice for the same
  `dedupe_key`; the UNIQUE constraint will reject the second insert, but
  the device poller must not re-send an already-`sent` row.
- **Staggering:** `scheduled_for` is already staggered 2s/message by the
  jobs; the poller still enforces its own 1 msg / 2 s per device.

## 5. Assumptions / deviations from the contracts (all deliberate)

- **Follow-up dedupe key** is `fee:{student}:{month}:followup`. The
  contract only defines `fee:{student}:{month}`; a second row for the same
  student/month would violate that key, so the follow-up needs its own
  suffix. Without it, follow-ups would be impossible.
- **"First school day" rule.** The contract says the monthly job runs on
  the 1st and skips Sundays/holidays. If the 1st is a non-school day the job
  runs on the 2nd/3rd instead (never later than the 3rd) — otherwise a
  Sunday 1st would silently skip a whole month of reminders.
- **Teacher-reminder window.** The cron polls every 5 min and fires inside
  a 5-minute window from `teacher_reminder_time` (an exact-minute match
  would be missed by polling).
- **Pending-check time** defaults to `16:00` local and is configurable via
  `settings.pending_check_time` (not in the contract's settings list, but
  `settings` is free-form JSONB).
- **`fee_require_approval`** defaults to `!fee_auto_send`; the two flags
  are kept in sync by `settingsOf()` in jobs/common.ts.
