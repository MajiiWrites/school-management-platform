// Monthly fee reminders (1st of month) + follow-up reminders.
//
// Flow (per school, school-local time):
//   1. Runs on the FIRST SCHOOL DAY of the month (the 1st, or the 2nd/3rd
//      when the 1st is a Sunday/holiday — a fee reminder must never be
//      skipped for a whole month because the 1st was a holiday).
//   2. Rolls the month over first (creates fee_records from fee_structures;
//      already-paid records are never re-created — rollover is idempotent).
//   3. For every UNPAID record (balance > 0) of the new month, creates one
//      message_queue row (dedupe `fee:{student_id}:{month}`).
//      NEVER reminds: paid students, partial-paid-in-full students
//      (balance 0), left/graduated students, students with no/invalid
//      parent number, opted-out parents.
//   4. Approval: if settings.fee_auto_send is true the row is pre-approved
//      (approved_at set — the Messaging Agent treats approved_at != null as
//      sendable); otherwise approved_at stays null and the row waits for the
//      admin in the approval screen (POST /messages/approve).
//   5. Follow-up: if settings.fee_followup_day is set, the same flow runs
//      again on that day (or the next school day within 3 days) for students
//      STILL unpaid, with dedupe `fee:{student_id}:{month}:followup`.
//      The follow-up is a separate row so the 1st-of-month dedupe key is
//      never violated.
//
// All sends go through message_queue only — this job never sends SMS itself.

import type { Db } from '../lib/db';
import { rolloverMonth } from '../modules/fees/service';
import { localParts, monthStartDate } from './date-utils';
import { audit, loadTemplate, notifyOnce, queueRowExistsToday, schoolDayInfo, settingsOf, staggeredTime, type SchoolRow } from './common';
import { renderTemplate } from './templates';

export interface FeeReminderResult {
  job: 'monthly_fee_reminder' | 'fee_followup';
  ran: boolean;
  reason?: string;
  school_id: string;
  month: string;
  local_date: string;
  created: number;
  skipped_paid: number;
  skipped_no_phone: number;
  skipped_opt_out: number;
  skipped_inactive: number;
  duplicates: number;
  missing_template_vars: string[];
}

async function buildReminderRows(
  db: Db,
  school: SchoolRow,
  month: string,
  now: Date,
  dedupeSuffix: string,
): Promise<{
  rows: Array<{
    schoolId: string;
    type: string;
    studentId: string;
    classId: string;
    parentPhoneEnc: string;
    body: string;
    status: string;
    dedupeKey: string;
    scheduledFor: Date;
    approvedAt: Date | null;
  }>;
  counts: Pick<FeeReminderResult, 'skipped_paid' | 'skipped_no_phone' | 'skipped_opt_out' | 'skipped_inactive'>;
  missingVars: string[];
}> {
  const settings = settingsOf(school);
  const template = await loadTemplate(db, school.id, 'fee_reminder', 'en');
  if (!template) {
    throw new Error(`No active fee_reminder template for school ${school.slug}`);
  }

  const [classes, students, records]: [any[], any[], any[]] = await Promise.all([
    db.class.findMany({ where: { schoolId: school.id } }),
    db.student.findMany({ where: { schoolId: school.id } }),
    db.feeRecord.findMany({ where: { schoolId: school.id, month } }),
  ]);
  const classById = new Map(classes.map((c) => [c.id, c]));
  const studentById = new Map(students.map((s) => [s.id, s]));

  const rows: Array<{
    schoolId: string;
    type: string;
    studentId: string;
    classId: string;
    parentPhoneEnc: string;
    body: string;
    status: string;
    dedupeKey: string;
    scheduledFor: Date;
    approvedAt: Date | null;
  }> = [];
  const counts = { skipped_paid: 0, skipped_no_phone: 0, skipped_opt_out: 0, skipped_inactive: 0 };
  const missingVars: string[] = [];

  for (const rec of records) {
    const student = studentById.get(rec.studentId);
    if (!student) continue;
    const balance = rec.amountDue - rec.amountPaid - rec.discount;
    if (balance <= 0) {
      // Paid (or partial-paid-in-full): NEVER reminded.
      counts.skipped_paid += 1;
      continue;
    }
    if (student.status !== 'active') {
      counts.skipped_inactive += 1;
      continue;
    }
    if (student.parentOptOut) {
      counts.skipped_opt_out += 1;
      continue;
    }
    if (!student.parentPhoneEnc) {
      counts.skipped_no_phone += 1;
      continue;
    }
    const klass = classById.get(student.classId);
    const rendered = renderTemplate(template.body, {
      student_name: student.name,
      class: klass ? `${klass.name}-${klass.section}` : '',
      month,
      amount: balance,
      school_name: school.name,
    });
    for (const v of rendered.missing) if (!missingVars.includes(v)) missingVars.push(v);
    rows.push({
      schoolId: school.id,
      type: 'fee_reminder',
      studentId: student.id,
      classId: student.classId,
      parentPhoneEnc: student.parentPhoneEnc,
      body: rendered.body,
      status: 'queued',
      dedupeKey: `fee:${student.id}:${month}${dedupeSuffix}`,
      scheduledFor: staggeredTime(now, rows.length),
      approvedAt: settings.fee_auto_send ? now : null,
    });
  }
  return { rows, counts, missingVars };
}

export async function runMonthlyFeeReminders(
  db: Db,
  school: SchoolRow,
  now: Date = new Date(),
): Promise<FeeReminderResult> {
  const parts = localParts(now, school.timezone);
  const month = parts.monthKey;
  const base: Omit<FeeReminderResult, 'created' | 'skipped_paid' | 'skipped_no_phone' | 'skipped_opt_out' | 'skipped_inactive' | 'duplicates' | 'missing_template_vars'> = {
    job: 'monthly_fee_reminder',
    ran: false,
    school_id: school.id,
    month,
    local_date: parts.date,
  };

  // Only the first school day of the month (1st, or 2nd/3rd if the 1st was
  // a Sunday/holiday). Outside that window the job is a no-op.
  if (parts.day > 3) return { ...base, reason: 'not-first-days-of-month', created: 0, skipped_paid: 0, skipped_no_phone: 0, skipped_opt_out: 0, skipped_inactive: 0, duplicates: 0, missing_template_vars: [] };
  const dayInfo = await schoolDayInfo(db, school, now);
  if (!dayInfo.isSchoolDay) {
    return { ...base, reason: dayInfo.isSunday ? 'sunday' : `holiday:${dayInfo.holidayName ?? ''}`, created: 0, skipped_paid: 0, skipped_no_phone: 0, skipped_opt_out: 0, skipped_inactive: 0, duplicates: 0, missing_template_vars: [] };
  }

  // Already ran this month? (queue rows of this type created since month start)
  const monthStart = new Date(`${monthStartDate(month)}T00:00:00Z`);
  const already: any[] = await db.messageQueue.findMany({
    where: { schoolId: school.id, type: 'fee_reminder', createdAt: { gte: monthStart } },
    select: { id: true },
  });
  if (already.length > 0) {
    return { ...base, reason: 'already-ran-this-month', created: 0, skipped_paid: 0, skipped_no_phone: 0, skipped_opt_out: 0, skipped_inactive: 0, duplicates: 0, missing_template_vars: [] };
  }

  // 1) Rollover first — creates this month's fee_records (idempotent).
  await rolloverMonth(db, school.id, month);

  // 2) Build + insert reminder rows (skipDuplicates = dedupe backstop).
  const { rows, counts, missingVars } = await buildReminderRows(db, school, month, now, '');
  let created = 0;
  let duplicates = 0;
  if (rows.length > 0) {
    const res = await db.messageQueue.createMany({ data: rows, skipDuplicates: true });
    created = res.count;
    duplicates = rows.length - created;
  }

  await audit(db, school.id, 'job.monthly_fee_reminder', 'message_queue', {
    month,
    created,
    duplicates,
    ...counts,
  });
  if (created > 0) {
    await notifyOnce(
      db,
      school,
      'fee_reminder',
      `Fee reminders queued for ${month}`,
      `${created} parent(s) will be reminded about unpaid ${month} fees.`,
      null,
      null,
      now,
    );
  }

  return { ...base, ran: true, created, duplicates, missing_template_vars: missingVars, ...counts };
}

export async function runFeeFollowup(
  db: Db,
  school: SchoolRow,
  now: Date = new Date(),
): Promise<FeeReminderResult> {
  const settings = settingsOf(school);
  const parts = localParts(now, school.timezone);
  const month = parts.monthKey;
  const base: Omit<FeeReminderResult, 'created' | 'skipped_paid' | 'skipped_no_phone' | 'skipped_opt_out' | 'skipped_inactive' | 'duplicates' | 'missing_template_vars'> = {
    job: 'fee_followup',
    ran: false,
    school_id: school.id,
    month,
    local_date: parts.date,
  };
  const zero = { created: 0, skipped_paid: 0, skipped_no_phone: 0, skipped_opt_out: 0, skipped_inactive: 0, duplicates: 0, missing_template_vars: [] as string[] };

  const followupDay = settings.fee_followup_day;
  if (!followupDay) return { ...base, reason: 'followup-disabled', ...zero };
  // Window: follow-up day, or the next school day within 3 days after it.
  if (parts.day < followupDay || parts.day > followupDay + 3) {
    return { ...base, reason: 'outside-followup-window', ...zero };
  }
  const dayInfo = await schoolDayInfo(db, school, now);
  if (!dayInfo.isSchoolDay) {
    return { ...base, reason: dayInfo.isSunday ? 'sunday' : `holiday:${dayInfo.holidayName ?? ''}`, ...zero };
  }
  // Already sent a follow-up this month?
  const already: any = await db.messageQueue.findFirst({
    where: { schoolId: school.id, type: 'fee_reminder', dedupeKey: { contains: `:${month}:followup` } },
  });
  if (already) return { ...base, reason: 'already-ran-this-month', ...zero };

  // Only students STILL unpaid right now.
  const { rows, counts, missingVars } = await buildReminderRows(db, school, month, now, ':followup');
  let created = 0;
  let duplicates = 0;
  if (rows.length > 0) {
    const res = await db.messageQueue.createMany({ data: rows, skipDuplicates: true });
    created = res.count;
    duplicates = rows.length - created;
  }

  await audit(db, school.id, 'job.fee_followup', 'message_queue', { month, created, duplicates, ...counts });
  if (created > 0) {
    await notifyOnce(
      db,
      school,
      'fee_reminder',
      `Fee follow-up reminders queued for ${month}`,
      `${created} parent(s) with fees still unpaid were reminded again.`,
      null,
      null,
      now,
    );
  }
  return { ...base, ran: true, created, duplicates, missing_template_vars: missingVars, ...counts };
}
