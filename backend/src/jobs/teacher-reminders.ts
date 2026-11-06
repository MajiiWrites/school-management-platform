// Teacher reminders.
// At school.settings.teacher_reminder_time (default 15:00 school-local),
// for every class with no attendance submission today, queue ONE teacher
// reminder SMS via the admin's SIM (message_queue type 'teacher_reminder',
// dedupe `teacher:{class_id}:{date}`). These rows are auto-approved
// (approved_at set) — admin approval applies to parent messages, not to
// teacher reminders. Skips Sundays/holidays, classes already submitted,
// and classes whose teacher has no phone on file (a notification is created
// instead so the admin can fix the number). Teacher absence NEVER creates
// parent messages — this job only reminds teachers to submit.
// Rate limiting: scheduled_for is staggered 2s per message (see common.ts).

import type { Db } from '../lib/db';
import { localParts } from './date-utils';
import { audit, loadTemplate, notifyOnce, queueRowExistsToday, schoolDayInfo, settingsOf, staggeredTime, type SchoolRow } from './common';
import { renderTemplate } from './templates';
import { getPendingClasses } from './pending-attendance';

export interface TeacherReminderResult {
  job: 'teacher_reminders';
  ran: boolean;
  reason?: string;
  school_id: string;
  local_date: string;
  queued: number;
  skipped_no_phone: number;
  skipped_already_queued: number;
  missing_template_vars: string[];
}

function humanDate(localDate: string): string {
  const d = new Date(`${localDate}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export async function runTeacherReminders(
  db: Db,
  school: SchoolRow,
  now: Date = new Date(),
): Promise<TeacherReminderResult> {
  const parts = localParts(now, school.timezone);
  const base = {
    job: 'teacher_reminders' as const,
    ran: false as boolean,
    school_id: school.id,
    local_date: parts.date,
    queued: 0,
    skipped_no_phone: 0,
    skipped_already_queued: 0,
    missing_template_vars: [] as string[],
  };

  const dayInfo = await schoolDayInfo(db, school, now);
  if (!dayInfo.isSchoolDay) {
    return { ...base, reason: dayInfo.isSunday ? 'sunday' : `holiday:${dayInfo.holidayName ?? ''}` };
  }

  // Fire inside a 5-minute window starting at the configured time (the
  // cron polls every 5 minutes, so an exact-minute match would be missed).
  const settings = settingsOf(school);
  const [th, tm] = settings.teacher_reminder_time.split(':').map(Number);
  const targetMin = th * 60 + tm;
  const nowMin = parts.hour * 60 + parts.minute;
  if (nowMin < targetMin || nowMin >= targetMin + 5) {
    return { ...base, reason: 'outside-reminder-window' };
  }

  const pending = await getPendingClasses(db, school.id, parts.date);
  if (pending.length === 0) {
    return { ...base, ran: true };
  }

  const template = await loadTemplate(db, school.id, 'teacher_reminder', 'en');
  if (!template) {
    throw new Error(`No active teacher_reminder template for school ${school.slug}`);
  }

  const rows: Array<{
    schoolId: string;
    type: string;
    studentId: null;
    classId: string;
    parentPhoneEnc: string;
    body: string;
    status: string;
    dedupeKey: string;
    scheduledFor: Date;
    approvedAt: Date | null;
  }> = [];
  let skippedNoPhone = 0;
  let skippedAlreadyQueued = 0;
  const missingVars: string[] = [];

  for (const klass of pending) {
    const already = await queueRowExistsToday(
      db,
      school,
      'teacher_reminder',
      { classId: klass.id },
      now,
    );
    if (already) {
      skippedAlreadyQueued += 1;
      continue;
    }
    if (!klass.teacherPhoneEnc) {
      skippedNoPhone += 1;
      await notifyOnce(
        db,
        school,
        'teacher_phone_missing',
        `Teacher phone missing: Class ${klass.name}-${klass.section}`,
        `Add the teacher's phone number for Class ${klass.name}-${klass.section} to enable attendance reminders.`,
        'class',
        klass.id,
        now,
      );
      continue;
    }
    const rendered = renderTemplate(template.body, {
      class: `${klass.name}-${klass.section}`,
      date: humanDate(parts.date),
      school_name: school.name,
    });
    for (const v of rendered.missing) if (!missingVars.includes(v)) missingVars.push(v);
    rows.push({
      schoolId: school.id,
      type: 'teacher_reminder',
      studentId: null,
      classId: klass.id,
      parentPhoneEnc: klass.teacherPhoneEnc,
      body: rendered.body,
      status: 'queued',
      dedupeKey: `teacher:${klass.id}:${parts.date}`,
      scheduledFor: staggeredTime(now, rows.length),
      approvedAt: now, // teacher reminders are auto-approved by design
    });
  }

  let queued = 0;
  if (rows.length > 0) {
    const res = await db.messageQueue.createMany({ data: rows, skipDuplicates: true });
    queued = res.count;
  }

  await audit(db, school.id, 'job.teacher_reminders', 'message_queue', {
    date: parts.date,
    queued,
    skipped_no_phone: skippedNoPhone,
    skipped_already_queued: skippedAlreadyQueued,
  });

  return { ...base, ran: true, queued, skipped_no_phone: skippedNoPhone, skipped_already_queued: skippedAlreadyQueued, missing_template_vars: missingVars };
}
