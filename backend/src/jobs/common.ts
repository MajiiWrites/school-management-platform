// Shared helpers for scheduler jobs.
// Jobs are idempotent by design: every queue row has a dedupe_key with a
// UNIQUE constraint, rollover uses skipDuplicates, and notifications are
// de-duplicated per school day. A job may therefore run repeatedly without
// double-sending; the registry additionally guards to once per school-day.

import type { Db } from '../lib/db';
import { localDateString, localParts } from './date-utils';
import { DEFAULT_TEMPLATES, type TemplateLanguage } from '../modules/messaging/templates';

export interface SchoolSettings {
  teacher_reminder_time?: string; // "HH:MM", default 15:00
  fee_auto_send?: boolean; // default false (approval required)
  fee_require_approval?: boolean; // default true when fee_auto_send is false
  fee_followup_day?: number | null; // day-of-month, e.g. 10; null = disabled
  sms_provider?: 'sim' | 'gateway';
  teacher_attendance_mode?: 'admin' | 'link';
  pending_check_time?: string; // "HH:MM", default 16:00
  session_timeout_minutes?: number; // 6D: idle timeout, default 120, min 15, max 1440
}

export interface SchoolRow {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  settings: SchoolSettings | null;
}

export function settingsOf(school: SchoolRow): Required<Pick<SchoolSettings, 'teacher_reminder_time' | 'pending_check_time'>> &
  SchoolSettings {
  const s = school.settings ?? {};
  return {
    teacher_reminder_time: s.teacher_reminder_time ?? '15:00',
    pending_check_time: s.pending_check_time ?? '16:00',
    fee_auto_send: s.fee_auto_send ?? false,
    fee_require_approval: s.fee_require_approval ?? !s.fee_auto_send,
    fee_followup_day: s.fee_followup_day ?? null,
    sms_provider: s.sms_provider ?? 'sim',
    teacher_attendance_mode: s.teacher_attendance_mode ?? 'admin',
    session_timeout_minutes: s.session_timeout_minutes ?? 120,
  };
}

export interface SchoolDayInfo {
  localDate: string; // YYYY-MM-DD
  monthKey: string; // YYYY-MM
  isSunday: boolean;
  holidayName: string | null;
  isSchoolDay: boolean;
}

/** School-day status for an instant (Sundays + holidays table are off). */
export async function schoolDayInfo(
  db: Db,
  school: SchoolRow,
  now: Date,
): Promise<SchoolDayInfo> {
  const parts = localParts(now, school.timezone);
  const holiday: any = await db.holiday.findFirst({
    where: { schoolId: school.id, date: new Date(`${parts.date}T00:00:00Z`) },
  });
  const isSunday = parts.weekday === 'Sunday';
  return {
    localDate: parts.date,
    monthKey: parts.monthKey,
    isSunday,
    holidayName: holiday?.name ?? null,
    isSchoolDay: !isSunday && !holiday,
  };
}

/** Latest active template of a type, preferring the given language. */
export async function loadTemplate(
  db: Db,
  schoolId: string,
  type: 'absent' | 'fee_reminder' | 'teacher_reminder',
  language: TemplateLanguage = 'en',
): Promise<{ id: string; body: string; language: string } | null> {
  const templates: any[] = await db.messageTemplate.findMany({
    where: { schoolId, type, isActive: true },
  });
  if (templates.length === 0) {
    // No template rows for this school (e.g. signed up before templates were
    // seeded): fall back to the built-in defaults instead of returning null,
    // so scheduled jobs NEVER crash the whole school's reminders for a
    // missing row (QA 2026-11-06: monthly_fee_reminder threw here and
    // reminded nobody). Callers treat id '' as "built-in default".
    return { id: '', body: DEFAULT_TEMPLATES[type][language] ?? DEFAULT_TEMPLATES[type].en, language };
  }
  return (
    templates.find((t) => t.language === language) ??
    templates.find((t) => t.language === 'en') ??
    templates[0]
  );
}

/** True when a queue row of the given type was already created today (school-local). */
export async function queueRowExistsToday(
  db: Db,
  school: SchoolRow,
  type: string,
  whereExtra: Record<string, unknown>,
  now: Date,
): Promise<boolean> {
  const latest: any = await db.messageQueue.findFirst({
    where: { schoolId: school.id, type, ...whereExtra },
    orderBy: { createdAt: 'desc' },
  });
  if (!latest) return false;
  return localDateString(latest.createdAt, school.timezone) === localDateString(now, school.timezone);
}

/** Create a notification unless one of the same type/related entity already exists today. */
export async function notifyOnce(
  db: Db,
  school: SchoolRow,
  type: string,
  title: string,
  body: string,
  relatedType: string | null,
  relatedId: string | null,
  now: Date,
): Promise<boolean> {
  const latest: any = await db.notification.findFirst({
    where: { schoolId: school.id, type, relatedType: relatedType ?? undefined, relatedId: relatedId ?? undefined },
    orderBy: { createdAt: 'desc' },
  });
  if (latest && localDateString(latest.createdAt, school.timezone) === localDateString(now, school.timezone)) {
    return false;
  }
  await db.notification.create({
    data: { schoolId: school.id, type, title, body, relatedType, relatedId },
  });
  return true;
}

export async function audit(
  db: Db,
  schoolId: string,
  action: string,
  entity: string,
  details: Record<string, unknown>,
): Promise<void> {
  await db.auditLog.create({
    data: { schoolId, actorType: 'system', action, entity, entityId: null, details },
  });
}

/** Stagger scheduled_for by 2s per message so one SIM never bursts (1 msg / 2 s). */
export function staggeredTime(base: Date, index: number, secondsPerMessage = 2): Date {
  return new Date(base.getTime() + index * secondsPerMessage * 1000);
}
