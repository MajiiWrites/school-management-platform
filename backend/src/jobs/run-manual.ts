// Manual job runner (ops / testing).
// Usage:
//   npx tsx src/jobs/run-manual.ts <job-name> --school=<slug|id> [--at=2026-11-01T08:00:00Z]
// Job names: monthly_fee_reminder | fee_followup | daily_pending_attendance | teacher_reminders | school_backup
// Requires DATABASE_URL and the generated Prisma client. The --at flag fakes
// "now" so a job can be tested for a specific school-local date/time.

import { getDb } from '../lib/db';
import { JOB_DEFINITIONS, runJobNow, type JobName } from './registry';

function parseArgs(argv: string[]): { job: JobName; school: string; at?: Date } {
  const job = argv[2] as JobName;
  if (!JOB_DEFINITIONS.some((d) => d.name === job)) {
    throw new Error(`Unknown job "${job}". Valid: ${JOB_DEFINITIONS.map((d) => d.name).join(', ')}`);
  }
  let school = '';
  let at: Date | undefined;
  for (const arg of argv.slice(3)) {
    if (arg.startsWith('--school=')) school = arg.slice('--school='.length);
    else if (arg.startsWith('--at=')) at = new Date(arg.slice('--at='.length));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!school) throw new Error('Missing --school=<slug|id>');
  if (at && Number.isNaN(at.getTime())) throw new Error('Invalid --at date (use ISO format)');
  return { job, school, at };
}

async function main(): Promise<void> {
  const { job, school, at } = parseArgs(process.argv);
  const prisma = getDb();
  try {
    const result = await runJobNow(prisma, job, {
      schoolSlug: school,
      schoolId: undefined,
      now: at,
    }).catch(async (err) => {
      // If slug lookup failed, try id lookup.
      if (String(err?.message ?? '').includes('School not found')) {
        return runJobNow(prisma, job, { schoolId: school, now: at });
      }
      throw err;
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
