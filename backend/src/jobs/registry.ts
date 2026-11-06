// Job registry — node-cron schedules, run tracking, and the status data
// provider for GET /jobs/status (wired by the Backend Agent, see MOUNT.md).
//
// Design notes:
// - Cron ticks run in UTC; every job converts to the SCHOOL's timezone
//   internally, so one deployment serves schools in different timezones.
// - Every job function is idempotent (dedupe keys, skipDuplicates,
//   per-day notification guards), so a tick that runs twice is harmless.
// - The registry additionally records per-school last runs in memory.
//   Last-run state resets on restart — if durable history is ever needed,
//   persist it (e.g. a job_runs table) instead of this map.
// - A per-job+school `running` guard prevents overlapping ticks.

import type { Db } from '../lib/db';
import * as cron from 'node-cron';
import { runFeeFollowup, runMonthlyFeeReminders } from './fee-reminders';
import { runDailyPendingAttendance } from './pending-attendance';
import { runTeacherReminders } from './teacher-reminders';
import type { SchoolRow, SchoolSettings } from './common';

export type JobName = 'monthly_fee_reminder' | 'fee_followup' | 'daily_pending_attendance' | 'teacher_reminders';

export interface JobDefinition {
  name: JobName;
  description: string;
  schedule: string; // cron expression (UTC tick; school-local logic inside)
}

export const JOB_DEFINITIONS: JobDefinition[] = [
  {
    name: 'monthly_fee_reminder',
    description:
      '1st school day of the month: roll over fee records, queue fee reminders for unpaid students (auto-send or approval per settings).',
    schedule: '*/30 * * * *',
  },
  {
    name: 'fee_followup',
    description:
      'On settings.fee_followup_day (or next school day within 3 days): remind parents whose fees are still unpaid.',
    schedule: '*/30 * * * *',
  },
  {
    name: 'daily_pending_attendance',
    description:
      'After school hours (settings.pending_check_time, default 16:00 local): notify admin about classes with no attendance submission today.',
    schedule: '*/30 * * * *',
  },
  {
    name: 'teacher_reminders',
    description:
      'At settings.teacher_reminder_time (default 15:00 local): queue a teacher-reminder SMS for each class that has not submitted attendance.',
    schedule: '*/5 * * * *',
  },
];

export interface JobRunRecord {
  lastRunAt: string | null;
  lastStatus: 'ok' | 'skipped' | 'error' | 'never';
  lastSummary: string;
  lastError: string | null;
  runs: number;
}

const runRecords = new Map<string, JobRunRecord>();
const running = new Set<string>();

function recordKey(job: JobName, schoolId: string): string {
  return `${job}:${schoolId}`;
}

function recordRun(job: JobName, schoolId: string, status: JobRunRecord['lastStatus'], summary: string, error: string | null): void {
  const key = recordKey(job, schoolId);
  const prev = runRecords.get(key);
  runRecords.set(key, {
    lastRunAt: new Date().toISOString(),
    lastStatus: status,
    lastSummary: summary,
    lastError: error,
    runs: (prev?.runs ?? 0) + 1,
  });
}

export function toSchoolRow(row: {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  settings: unknown;
}): SchoolRow {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone || 'Asia/Karachi',
    settings: (row.settings ?? {}) as SchoolSettings,
  };
}

export async function loadSchools(db: Db): Promise<SchoolRow[]> {
  const rows: any[] = await db.school.findMany({ orderBy: { createdAt: 'asc' } });
  return rows.map(toSchoolRow);
}

type JobFn = (db: Db, school: SchoolRow, now?: Date) => Promise<{ ran: boolean; reason?: string }>;
// Job functions return richer result objects; the registry only reads ran/reason.

const JOB_FNS: Record<JobName, JobFn> = {
  monthly_fee_reminder: runMonthlyFeeReminders,
  fee_followup: runFeeFollowup,
  daily_pending_attendance: runDailyPendingAttendance,
  teacher_reminders: runTeacherReminders,
};

/** Run one job once for one school (used by the cron ticks and run-manual.ts). */
export async function runJobForSchool(
  db: Db,
  job: JobName,
  school: SchoolRow,
  now: Date = new Date(),
): Promise<{ ran: boolean; reason?: string } & Record<string, unknown>> {
  const key = recordKey(job, school.id);
  if (running.has(key)) {
    return { ran: false, reason: 'already-running' };
  }
  running.add(key);
  try {
    const result = await JOB_FNS[job](db, school, now);
    const summary = result.ran
      ? `ran (${JSON.stringify(result).slice(0, 200)})`
      : `skipped: ${result.reason ?? 'n/a'}`;
    recordRun(job, school.id, result.ran ? 'ok' : 'skipped', summary, null);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordRun(job, school.id, 'error', '', message);
    throw err;
  } finally {
    running.delete(key);
  }
}

/** Run one job for every school (a cron tick). Errors in one school never block others. */
export async function runJobForAllSchools(db: Db, job: JobName, now: Date = new Date()): Promise<void> {
  const schools = await loadSchools(db);
  for (const school of schools) {
    try {
      await runJobForSchool(db, job, school, now);
    } catch (err) {
      // Logged in runRecords; do not let one school break the tick.
      console.error(`[jobs] ${job} failed for school ${school.slug}:`, err instanceof Error ? err.message : err);
    }
  }
}

export interface RegisteredJobs {
  stop: () => void;
}

/** Start all cron jobs. Call once from server.ts (see jobs/MOUNT.md). */
export function registerJobs(db: Db): RegisteredJobs {
  const tasks: cron.ScheduledTask[] = [];
  for (const def of JOB_DEFINITIONS) {
    const task = cron.schedule(
      def.schedule,
      () => {
        void runJobForAllSchools(db, def.name, new Date());
      },
      { timezone: 'UTC' },
    );
    tasks.push(task);
  }
  return {
    stop: () => {
      for (const t of tasks) t.stop();
    },
  };
}

/** Status snapshot for GET /jobs/status (Backend Agent mounts the endpoint). */
export function getJobsStatus(db: Db): Promise<{
  jobs: Array<{
    name: JobName;
    description: string;
    schedule: string;
    schools: Array<{ school_id: string; school_slug: string; last_run_at: string | null; last_status: JobRunRecord['lastStatus']; last_summary: string; last_error: string | null; runs: number }>;
  }>;
}> {
  return loadSchools(db).then((schools) => ({
    jobs: JOB_DEFINITIONS.map((def) => ({
      name: def.name,
      description: def.description,
      schedule: def.schedule,
      schools: schools.map((s) => {
        const rec = runRecords.get(recordKey(def.name, s.id));
        return {
          school_id: s.id,
          school_slug: s.slug,
          last_run_at: rec?.lastRunAt ?? null,
          last_status: rec?.lastStatus ?? 'never',
          last_summary: rec?.lastSummary ?? '',
          last_error: rec?.lastError ?? null,
          runs: rec?.runs ?? 0,
        };
      }),
    })),
  }));
}

/** Run a single job by name (used by run-manual.ts and tests). */
export async function runJobNow(
  db: Db,
  job: JobName,
  opts: { schoolId?: string; schoolSlug?: string; now?: Date },
): Promise<unknown> {
  const where = opts.schoolId
    ? { id: opts.schoolId }
    : opts.schoolSlug
      ? { slug: opts.schoolSlug }
      : null;
  if (!where) throw new Error('runJobNow requires schoolId or schoolSlug');
  const row: any = await db.school.findFirst({ where });
  if (!row) throw new Error('School not found');
  return runJobForSchool(db, job, toSchoolRow(row), opts.now ?? new Date());
}
