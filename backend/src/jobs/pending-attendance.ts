// Daily pending-attendance check.
// Runs after school hours (school.settings.pending_check_time, default
// 16:00 school-local). For every class with NO attendance submission today
// it creates one notification (de-duplicated per school day). It never
// sends SMS itself — teacher reminders are a separate job (teacher-reminders.ts).
// Skips Sundays and holidays; teacher absence never creates messages.

import type { Db } from '../lib/db';
import { localParts } from './date-utils';
import { audit, notifyOnce, schoolDayInfo, settingsOf, type SchoolRow } from './common';

export interface PendingAttendanceResult {
  job: 'daily_pending_attendance';
  ran: boolean;
  reason?: string;
  school_id: string;
  local_date: string;
  pending_classes: Array<{ class_id: string; class_name: string }>;
  notifications_created: number;
}

/** Classes of a school with no attendance_day row for the given local date. */
export async function getPendingClasses(
  db: Db,
  schoolId: string,
  localDate: string,
): Promise<Array<{ id: string; name: string; section: string; teacherPhoneEnc: string | null }>> {
  const [classes, submitted]: [any[], any[]] = await Promise.all([
    db.class.findMany({ where: { schoolId }, orderBy: [{ name: 'asc' }, { section: 'asc' }] }),
    db.attendanceDay.findMany({
      where: { schoolId, date: new Date(`${localDate}T00:00:00Z`) },
      select: { classId: true },
    }),
  ]);
  const submittedIds = new Set(submitted.map((s) => s.classId));
  return classes.filter((c) => !submittedIds.has(c.id));
}

export async function runDailyPendingAttendance(
  db: Db,
  school: SchoolRow,
  now: Date = new Date(),
): Promise<PendingAttendanceResult> {
  const parts = localParts(now, school.timezone);
  const base = {
    job: 'daily_pending_attendance' as const,
    ran: false as boolean,
    school_id: school.id,
    local_date: parts.date,
    pending_classes: [] as Array<{ class_id: string; class_name: string }>,
    notifications_created: 0,
  };

  const dayInfo = await schoolDayInfo(db, school, now);
  if (!dayInfo.isSchoolDay) {
    return { ...base, reason: dayInfo.isSunday ? 'sunday' : `holiday:${dayInfo.holidayName ?? ''}` };
  }

  // Only at/after the configured check time (the cron polls every 30 min).
  const settings = settingsOf(school);
  const [hh, mm] = settings.pending_check_time.split(':').map(Number);
  if (parts.hour * 60 + parts.minute < hh * 60 + mm) {
    return { ...base, reason: 'too-early' };
  }

  const pending = await getPendingClasses(db, school.id, parts.date);
  let notificationsCreated = 0;
  for (const klass of pending) {
    const created = await notifyOnce(
      db,
      school,
      'pending_attendance',
      `Attendance pending: Class ${klass.name}-${klass.section}`,
      `Class ${klass.name}-${klass.section} has not submitted attendance for ${parts.date} yet.`,
      'class',
      klass.id,
      now,
    );
    if (created) notificationsCreated += 1;
  }

  await audit(db, school.id, 'job.daily_pending_attendance', 'attendance_day', {
    date: parts.date,
    pending_classes: pending.map((c) => c.id),
    notifications_created: notificationsCreated,
  });

  return {
    ...base,
    ran: true,
    pending_classes: pending.map((c) => ({ class_id: c.id, class_name: `${c.name}-${c.section}` })),
    notifications_created: notificationsCreated,
  };
}
