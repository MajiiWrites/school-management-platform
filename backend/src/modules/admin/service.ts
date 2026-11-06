import bcrypt from 'bcrypt';
import { config } from '../../config';
import { ApiError } from '../../lib/errors';
import { todayInTz, currentMonthInTz, isValidDateString, isNonSchoolDay, dateOnly, monthRange } from '../../lib/dates';
import { writeAudit } from '../../lib/audit';
import { writeChangeLogs } from '../hardening/helpers';
import { paginatedResponse, parsePagination } from '../../lib/pagination';
import type { Db } from '../../lib/db';

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export async function getDashboard(db: Db, schoolId: string): Promise<Record<string, unknown>> {
  const school = await db.school.findUnique({ where: { id: schoolId } });
  if (!school) throw ApiError.notFound('School not found');
  const tz = school.timezone;
  const today = todayInTz(tz);
  const month = currentMonthInTz(tz);
  const nonSchoolDay = await isNonSchoolDay(db, schoolId, today);

  const classes = await db.class.findMany({ where: { schoolId: schoolId, deletedAt: null } });
  const days = nonSchoolDay ? [] : await db.attendanceDay.findMany({ where: { schoolId: schoolId, date: dateOnly(today) } });
  const submittedIds = new Set(days.map((d: any) => d.classId));
  let present = 0;
  let absent = 0;
  if (days.length > 0) {
    const records = await db.attendanceRecord.findMany({ where: { attendanceDayId: { in: days.map((d: any) => d.id) } } });
    for (const r of records) {
      if (r.status === 'present') present += 1;
      if (r.status === 'absent') absent += 1;
    }
  }
  const teacherRows = nonSchoolDay ? [] : await db.teacherAttendance.findMany({ where: { schoolId: schoolId, date: dateOnly(today) } });
  const teachersPresent = teacherRows.filter((r: any) => r.status === 'present').length;
  const teachersAbsent = teacherRows.filter((r: any) => r.status === 'absent').length;

  const feeRecords = await db.feeRecord.findMany({ where: { schoolId: schoolId, month, deletedAt: null } });
  let feeCollected = 0;
  let feePending = 0;
  for (const r of feeRecords) {
    feeCollected += r.amountPaid ?? 0;
    feePending += Math.max(0, (r.amountDue ?? 0) - (r.discount ?? 0) - (r.amountPaid ?? 0));
  }
  const notifications = await db.notification.findMany({
    where: { schoolId: schoolId },
    orderBy: [{ isRead: 'asc' }, { createdAt: 'desc' }],
    take: 10,
  });
  return {
    date: today,
    non_school_day: nonSchoolDay,
    classes_total: classes.length,
    classes_submitted: days.length,
    classes_pending: nonSchoolDay ? 0 : classes.length - submittedIds.size,
    present,
    absent,
    teachers_present: teachersPresent,
    teachers_absent: teachersAbsent,
    fee_collected_this_month: feeCollected,
    fee_pending_this_month: feePending,
    // Phase 9 fix: serialize to the snake_case contract (see
    // toNotificationView) — the raw row's `isRead` never matched the
    // frontend's `is_read`, so every notification showed as unread.
    recent_notifications: (notifications as any[]).map(toNotificationView),
  };
}

/** Snake_case notification view (the contract the frontend uses) — see
 * listNotifications for why the raw Prisma row cannot be returned. */
export function toNotificationView(n: any): Record<string, unknown> {
  return {
    id: n.id,
    school_id: n.schoolId ?? null,
    type: n.type,
    title: n.title,
    body: n.body,
    related_type: n.relatedType ?? null,
    related_id: n.relatedId ?? null,
    is_read: n.isRead === true,
    created_at: n.createdAt ? new Date(n.createdAt).toISOString() : new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const SETTING_KEYS = [
  'teacher_reminder_time',
  'fee_auto_send',
  'fee_require_approval',
  'fee_followup_day',
  'sms_provider',
  'teacher_attendance_mode',
  'message_language',
  // 6C-2: school identity + display language. `school_name` and `timezone`
  // live on the schools ROW (columns), the rest in settings JSONB.
  // `language` is the UI language (en/ur); `message_language` (v1) stays
  // the SMS template language — the two are independent.
  'school_name',
  'timezone',
  'school_address',
  'school_phone',
  'logo_url',
  'language',
  // 6D: idle/session timeout in minutes (default 120, min 15, max 1440).
  'session_timeout_minutes',
] as const;

export function validateSettings(patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) {
      throw ApiError.validation(`Unknown setting: ${key}`);
    }
    switch (key) {
      case 'teacher_reminder_time':
        if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) throw ApiError.validation('teacher_reminder_time must be HH:MM');
        out[key] = value;
        break;
      case 'fee_auto_send':
      case 'fee_require_approval':
        if (typeof value !== 'boolean') throw ApiError.validation(`${key} must be a boolean`);
        out[key] = value;
        break;
      case 'fee_followup_day':
        if (value !== null && (typeof value !== 'number' || value < 1 || value > 28)) {
          throw ApiError.validation('fee_followup_day must be null or an integer 1–28');
        }
        out[key] = value;
        break;
      case 'sms_provider':
        if (value !== 'sim' && value !== 'gateway') throw ApiError.validation("sms_provider must be 'sim' or 'gateway'");
        out[key] = value;
        break;
      case 'teacher_attendance_mode':
        if (value !== 'admin' && value !== 'link') throw ApiError.validation("teacher_attendance_mode must be 'admin' or 'link'");
        out[key] = value;
        break;
      case 'message_language':
        if (value !== 'en' && value !== 'ur') throw ApiError.validation("message_language must be 'en' or 'ur'");
        out[key] = value;
        break;
      // 6C-2 keys.
      case 'school_name':
        if (typeof value !== 'string' || value.trim().length < 2 || value.trim().length > 200) {
          throw ApiError.validation('school_name must be 2–200 chars');
        }
        out[key] = value.trim();
        break;
      case 'timezone':
        if (typeof value !== 'string' || !/^[A-Za-z_]+\/[A-Za-z_+-]+$/.test(value) && value !== 'UTC') {
          throw ApiError.validation('timezone must be an IANA name (e.g. Asia/Karachi) or UTC');
        }
        try {
          Intl.DateTimeFormat('en-CA', { timeZone: value });
        } catch {
          throw ApiError.validation('timezone is not a known IANA timezone');
        }
        out[key] = value;
        break;
      case 'school_address':
        if (typeof value !== 'string' || value.trim().length > 500) throw ApiError.validation('school_address must be a string (max 500 chars)');
        out[key] = value.trim();
        break;
      case 'school_phone':
        if (typeof value !== 'string' || value.trim().length > 30) throw ApiError.validation('school_phone must be a string (max 30 chars)');
        out[key] = value.trim();
        break;
      case 'logo_url': {
        // Either an https URL or a data:image/* URL (uploaded logo, see the
        // frontend Settings page — FileReader → data URL, capped at ~500 KB).
        if (typeof value !== 'string' || value.length > 700_000) throw ApiError.validation('logo_url is too large (max ~500 KB image)');
        if (value !== '' && !value.startsWith('data:image/') && !value.startsWith('https://')) {
          throw ApiError.validation('logo_url must be an https URL or a data:image/* URL');
        }
        out[key] = value;
        break;
      }
      case 'language':
        if (value !== 'en' && value !== 'ur') throw ApiError.validation("language must be 'en' or 'ur'");
        out[key] = value;
        break;
      case 'session_timeout_minutes':
        // 6D: min 15 (an access token already lives 15 min — shorter would
        // log out active users), max 1440 (24 h).
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 15 || value > 1440) {
          throw ApiError.validation('session_timeout_minutes must be an integer between 15 and 1440');
        }
        out[key] = value;
        break;
    }
  }
  return out;
}

export async function getSettings(db: Db, schoolId: string): Promise<Record<string, unknown>> {
  const school = await db.school.findUnique({ where: { id: schoolId } });
  if (!school) throw ApiError.notFound('School not found');
  const settings = (school.settings as Record<string, unknown>) ?? {};
  return {
    teacher_reminder_time: '08:00',
    fee_auto_send: false,
    fee_require_approval: true,
    fee_followup_day: null,
    sms_provider: 'sim',
    teacher_attendance_mode: 'admin',
    message_language: 'en',
    session_timeout_minutes: 120, // 6D: idle timeout, minutes
    // 6C-2: school identity — name/timezone from the school row, the rest
    // from settings JSONB (defaults below when unset).
    school_name: school.name,
    timezone: school.timezone ?? 'Asia/Karachi',
    school_address: '',
    school_phone: '',
    logo_url: '',
    language: 'en',
    ...settings,
  };
}

export async function updateSettings(db: Db, schoolId: string, patch: Record<string, unknown>, adminId: string): Promise<Record<string, unknown>> {
  const valid = validateSettings(patch);
  const school = await db.school.findUnique({ where: { id: schoolId } });
  if (!school) throw ApiError.notFound('School not found');
  const before = (school.settings as Record<string, unknown>) ?? {};
  // 6C-2: school_name / timezone live on the schools ROW, not in settings
  // JSONB — split them out so the JSON never shadows the row (getSettings
  // reads name/timezone from the row first).
  const { school_name, timezone, ...jsonPatch } = valid as Record<string, unknown>;
  const merged = { ...before, ...jsonPatch };
  const rowData: Record<string, unknown> = { settings: merged };
  if (school_name !== undefined) rowData.name = school_name;
  if (timezone !== undefined) rowData.timezone = timezone;
  await db.school.update({ where: { id: schoolId }, data: rowData });
  // 6A change history: one row per changed setting key (row-backed keys
  // compare against the row's old value).
  const beforeAll: Record<string, unknown> = Object.fromEntries(
    Object.keys(valid).map((k) => [
      k,
      k === 'school_name' ? school.name : k === 'timezone' ? school.timezone : before[k] ?? null,
    ]),
  );
  await writeChangeLogs(db, {
    schoolId,
    actorId: adminId,
    entity: 'school_settings',
    entityId: schoolId,
    before: beforeAll,
    after: Object.fromEntries(Object.keys(valid).map((k) => [k, valid[k]])),
  });
  await writeAudit(db, { schoolId, actorId: adminId, actorType: 'user', action: 'settings.update', entity: 'school', entityId: schoolId, details: valid });
  return getSettings(db, schoolId);
}

// ---------------------------------------------------------------------------
// Users / clerks
// ---------------------------------------------------------------------------

export async function createClerk(db: Db, schoolId: string, input: { email: string; password: string }, adminId: string): Promise<any> {
  const email = input.email.trim().toLowerCase();
  const existing = await db.user.findFirst({ where: { email } });
  if (existing) throw ApiError.conflict('An account with this email already exists');
  const passwordHash = await bcrypt.hash(input.password, config.bcryptRounds);
  const clerk = await db.user.create({
    data: { schoolId: schoolId, email, passwordHash: passwordHash, role: 'clerk', emailVerified: true },
  });
  await writeAudit(db, { schoolId, actorId: adminId, actorType: 'user', action: 'user.clerk_create', entity: 'user', entityId: clerk.id, details: { email } });
  return { id: clerk.id, email: clerk.email, role: clerk.role, school_id: clerk.schoolId, email_verified: clerk.emailVerified };
}

export async function listUsers(db: Db, schoolId: string): Promise<any[]> {
  const users = await db.user.findMany({ where: { schoolId: schoolId }, orderBy: [{ createdAt: 'asc' }] });
  return users.map((u: any) => ({ id: u.id, email: u.email, role: u.role, email_verified: u.emailVerified, last_login_at: u.lastLoginAt, created_at: u.createdAt }));
}

export async function deleteUser(db: Db, schoolId: string, id: string, adminId: string): Promise<void> {
  if (id === adminId) throw ApiError.validation('You cannot delete your own account');
  const target = await db.user.findFirst({ where: { id, schoolId: schoolId } });
  if (!target) throw ApiError.notFound('User not found');
  if (target.role === 'admin') {
    const admins = await db.user.count({ where: { schoolId: schoolId, role: 'admin' } });
    if (admins <= 1) throw ApiError.conflict('Cannot delete the last admin of the school');
  }
  await db.user.delete({ where: { id } });
  await writeAudit(db, { schoolId, actorId: adminId, actorType: 'user', action: 'user.delete', entity: 'user', entityId: id, details: { email: target.email, role: target.role } });
}

// ---------------------------------------------------------------------------
// Holidays
// ---------------------------------------------------------------------------

export async function listHolidays(db: Db, schoolId: string): Promise<any[]> {
  return db.holiday.findMany({ where: { schoolId: schoolId }, orderBy: [{ date: 'asc' }] });
}

export async function createHoliday(db: Db, schoolId: string, input: { date: string; name: string }, adminId: string): Promise<any> {
  if (!isValidDateString(input.date)) throw ApiError.validation('Date must be YYYY-MM-DD');
  const existing = await db.holiday.findFirst({ where: { schoolId: schoolId, date: dateOnly(input.date) } });
  if (existing) throw ApiError.conflict('This date is already a holiday');
  const created = await db.holiday.create({ data: { schoolId: schoolId, date: dateOnly(input.date), name: input.name.trim() } });
  await writeAudit(db, { schoolId, actorId: adminId, actorType: 'user', action: 'holiday.create', entity: 'holiday', entityId: created.id, details: { date: input.date, name: input.name } });
  return created;
}

export async function deleteHoliday(db: Db, schoolId: string, id: string, adminId: string): Promise<void> {
  const existing = await db.holiday.findFirst({ where: { id, schoolId: schoolId } });
  if (!existing) throw ApiError.notFound('Holiday not found');
  await db.holiday.delete({ where: { id } });
  await writeAudit(db, { schoolId, actorId: adminId, actorType: 'user', action: 'holiday.delete', entity: 'holiday', entityId: id, details: { date: existing.date } });
}

// ---------------------------------------------------------------------------
// Academic sessions
// ---------------------------------------------------------------------------

export async function listSessions(db: Db, schoolId: string): Promise<any[]> {
  return db.academicSession.findMany({ where: { schoolId: schoolId }, orderBy: [{ startDate: 'desc' }] });
}

export async function createSession(db: Db, schoolId: string, input: { name: string; start_date: string; end_date: string }, adminId: string): Promise<any> {
  if (!isValidDateString(input.start_date) || !isValidDateString(input.end_date)) throw ApiError.validation('Dates must be YYYY-MM-DD');
  if (input.start_date >= input.end_date) throw ApiError.validation('start_date must be before end_date');
  const created = await db.academicSession.create({ data: { schoolId: schoolId, name: input.name.trim(), startDate: dateOnly(input.start_date), endDate: dateOnly(input.end_date), isCurrent: false } });
  await writeAudit(db, { schoolId, actorId: adminId, actorType: 'user', action: 'session.create', entity: 'academic_session', entityId: created.id, details: { name: input.name } });
  return created;
}

export async function makeSessionCurrent(db: Db, schoolId: string, id: string, adminId: string): Promise<any> {
  const session = await db.academicSession.findFirst({ where: { id, schoolId: schoolId } });
  if (!session) throw ApiError.notFound('Session not found');
  await db.$transaction(async (tx) => {
    await tx.academicSession.updateMany({ where: { schoolId: schoolId, isCurrent: true }, data: { isCurrent: false } });
    await tx.academicSession.update({ where: { id }, data: { isCurrent: true } });
  });
  await writeAudit(db, { schoolId, actorId: adminId, actorType: 'user', action: 'session.make_current', entity: 'academic_session', entityId: id });
  return { ...session, is_current: true };
}

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------

export async function promoteStudents(
  db: Db,
  schoolId: string,
  input: { session_id: string; mappings: Array<{ student_id: string; to_class_id: string }> },
  adminId: string,
): Promise<{ promoted: number }> {
  const session = await db.academicSession.findFirst({ where: { id: input.session_id, schoolId: schoolId } });
  if (!session) throw ApiError.notFound('Session not found');
  if (!Array.isArray(input.mappings) || input.mappings.length === 0) throw ApiError.validation('mappings must be a non-empty array');
  for (const m of input.mappings) {
    const student = await db.student.findFirst({ where: { id: m.student_id, schoolId: schoolId } });
    if (!student) throw ApiError.validation(`Student not found: ${m.student_id}`);
    const toClass = await db.class.findFirst({ where: { id: m.to_class_id, schoolId: schoolId } });
    if (!toClass) throw ApiError.validation(`Class not found: ${m.to_class_id}`);
  }
  await db.$transaction(async (tx) => {
    for (const m of input.mappings) {
      // ISOLATION FIX: the old re-read inside the transaction was by id
      // alone. Re-prove school ownership here (defence in depth: the
      // pre-validation above already checked, the tx must not trust it).
      const student = await tx.student.findFirst({ where: { id: m.student_id, schoolId: schoolId } });
      if (!student) throw ApiError.validation(`Student not found: ${m.student_id}`);
      const toClass = await tx.class.findFirst({ where: { id: m.to_class_id, schoolId: schoolId } });
      if (!toClass) throw ApiError.validation(`Class not found: ${m.to_class_id}`);
      await tx.promotion.create({
        data: { schoolId: schoolId, studentId: m.student_id, fromClassId: (student as any).classId, toClassId: m.to_class_id, sessionId: input.session_id, promotedAt: new Date(), promotedBy: adminId },
      });
      await tx.student.update({ where: { id: m.student_id }, data: { classId: m.to_class_id } });
    }
  });
  await writeAudit(db, { schoolId, actorId: adminId, actorType: 'user', action: 'promotion.run', entity: 'academic_session', entityId: input.session_id, details: { promoted: input.mappings.length } });
  return { promoted: input.mappings.length };
}

// ---------------------------------------------------------------------------
// Leave applications
// ---------------------------------------------------------------------------

export async function createLeave(db: Db, schoolId: string, input: { student_id: string; from_date: string; to_date: string; reason: string }, adminId: string): Promise<any> {
  if (!isValidDateString(input.from_date) || !isValidDateString(input.to_date)) throw ApiError.validation('Dates must be YYYY-MM-DD');
  if (input.from_date > input.to_date) throw ApiError.validation('from_date must be on or before to_date');
  const student = await db.student.findFirst({ where: { id: input.student_id, schoolId: schoolId } });
  if (!student) throw ApiError.notFound('Student not found');
  const created = await db.leaveApplication.create({
    data: { schoolId: schoolId, studentId: input.student_id, fromDate: dateOnly(input.from_date), toDate: dateOnly(input.to_date), reason: input.reason.trim(), status: 'pending' },
  });
  await writeAudit(db, { schoolId, actorId: adminId, actorType: 'user', action: 'leave.create', entity: 'leave_application', entityId: created.id, details: { student_id: input.student_id } });
  return toLeaveView(created, student.name);
}

/** Snake_case leave view (the contract the frontend uses). The raw Prisma
 * row is camelCase — returning it made the Leaves page crash on
 * `from_date.slice(...)` (Phase 9 fix). */
export function toLeaveView(r: any, studentName: string | null): Record<string, unknown> {
  return {
    id: r.id,
    student_id: r.studentId,
    student_name: studentName,
    from_date: new Date(r.fromDate).toISOString().slice(0, 10),
    to_date: new Date(r.toDate).toISOString().slice(0, 10),
    reason: r.reason,
    status: r.status,
    created_at: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
  };
}

export async function listLeaves(db: Db, schoolId: string, query: Record<string, any>): Promise<any[]> {
  const where: Record<string, unknown> = { schoolId: schoolId };
  if (query.student_id) where.studentId = String(query.student_id);
  if (query.status) where.status = String(query.status);
  const rows = await db.leaveApplication.findMany({ where, orderBy: [{ createdAt: 'desc' }] });
  const students: any[] = rows.length
    ? await db.student.findMany({ where: { schoolId: schoolId, id: { in: [...new Set(rows.map((r: any) => r.studentId))] } } })
    : [];
  const nameById = new Map(students.map((s: any) => [s.id, s.name as string]));
  return rows.map((r: any) => toLeaveView(r, nameById.get(r.studentId) ?? null));
}

export async function decideLeave(db: Db, schoolId: string, id: string, status: 'approved' | 'rejected', adminId: string): Promise<any> {
  const leave = await db.leaveApplication.findFirst({ where: { id, schoolId: schoolId } });
  if (!leave) throw ApiError.notFound('Leave application not found');
  // Snapshot before-values BEFORE the update: some DB layers mutate the
  // fetched row in place, which would erase the old values (6A lesson).
  const beforeStatus = leave.status;
  const beforeDecidedBy = leave.decidedBy ?? null;
  const updated = await db.leaveApplication.update({ where: { id }, data: { status, decidedBy: adminId } });
  // 6C-2: every edit writes change_logs (one row per changed field).
  await writeChangeLogs(db, {
    schoolId,
    actorId: adminId,
    entity: 'leave_application',
    entityId: id,
    before: { status: beforeStatus, decided_by: beforeDecidedBy },
    after: { status, decided_by: adminId },
  });
  await writeAudit(db, { schoolId, actorId: adminId, actorType: 'user', action: 'leave.decide', entity: 'leave_application', entityId: id, details: { status } });
  return updated;
}

// ---------------------------------------------------------------------------
// Late arrivals (6C-2) — see FEATURES-6C2.md "Late-tracking decision".
// There is NO late-arrival table/column in the v2 schema, and
// LeaveApplication has no `type` column, so late arrivals are NOT stored
// as leave rows. Late IS a first-class attendance status
// (attendance_records.status = 'late', v1): a late arrival is recorded at
// attendance-submit time and read back here. No migration was needed.
// ---------------------------------------------------------------------------

export async function listLateArrivals(
  db: Db,
  schoolId: string,
  query: Record<string, any>,
): Promise<Array<{ date: string; student_id: string; student_name: string; roll_no: number | null; class_id: string; class_name: string }>> {
  // Default (no date/month given): today in the SCHOOL timezone.
  let start: string;
  let end: string;
  if (query.date) {
    if (!isValidDateString(String(query.date))) throw ApiError.validation('date must be YYYY-MM-DD');
    start = String(query.date);
    end = String(query.date);
  } else if (query.month) {
    if (!/^\d{4}-\d{2}$/.test(String(query.month))) throw ApiError.validation('month must be YYYY-MM');
    ({ start, end } = monthRange(String(query.month)));
  } else {
    const schoolRow: any = await db.school.findUnique({ where: { id: schoolId } }).catch(() => null);
    const today = todayInTz((schoolRow?.timezone as string | undefined) ?? 'Asia/Karachi');
    start = today;
    end = today;
  }
  const dayWhere: Record<string, unknown> = { schoolId: schoolId, date: { gte: dateOnly(start), lte: dateOnly(end) } };
  if (query.class_id) dayWhere.classId = String(query.class_id);
  const days = await db.attendanceDay.findMany({ where: dayWhere, orderBy: [{ date: 'asc' }] });
  if (days.length === 0) return [];
  const dayIds = days.map((d: any) => d.id);
  const dayById = new Map<string, any>(days.map((d: any) => [d.id, d] as [string, any]));
  const records = await db.attendanceRecord.findMany({ where: { attendanceDayId: { in: dayIds }, status: 'late' } });
  if (records.length === 0) return [];
  const studentIds = [...new Set(records.map((r: any) => r.studentId))];
  const students = await db.student.findMany({ where: { schoolId: schoolId, id: { in: studentIds } } });
  const studentById = new Map<string, any>(students.map((s: any) => [s.id, s] as [string, any]));
  const classes = await db.class.findMany({ where: { schoolId: schoolId } });
  const classById = new Map<string, any>(classes.map((c: any) => [c.id, c] as [string, any]));
  return records
    .map((r: any) => {
      const day = dayById.get(r.attendanceDayId);
      const s = studentById.get(r.studentId);
      if (!day || !s) return null;
      const c = classById.get(s.classId);
      return {
        date: new Date(day.date).toISOString().slice(0, 10),
        student_id: s.id,
        student_name: s.name,
        roll_no: s.rollNo ?? null,
        class_id: s.classId,
        class_name: c ? `${c.name}-${c.section}` : s.classId,
      };
    })
    .filter((x: any): x is NonNullable<typeof x> => x !== null)
    .sort((a: any, b: any) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Audit logs & notifications
// ---------------------------------------------------------------------------

export async function listAuditLogs(db: Db, schoolId: string, query: Record<string, any>): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  const where: Record<string, unknown> = { schoolId: schoolId };
  if (query.entity) where.entity = String(query.entity);
  if (query.action) where.action = String(query.action);
  const [items, total] = await Promise.all([
    db.auditLog.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip, take: limit }),
    db.auditLog.count({ where }),
  ]);
  return paginatedResponse(items, total, { page, limit, skip });
}

export async function listNotifications(db: Db, schoolId: string, query: Record<string, any>): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  const where: Record<string, unknown> = { schoolId: schoolId };
  if (query.unread_only === 'true') where.isRead = false;
  const [items, total] = await Promise.all([
    db.notification.findMany({ where, orderBy: [{ isRead: 'asc' }, { createdAt: 'desc' }], skip, take: limit }),
    db.notification.count({ where }),
  ]);
  // Phase 9 fix: the raw Prisma row is camelCase (isRead/createdAt) but the
  // frontend NotificationItem reads snake_case (is_read/created_at) — so
  // `!n.is_read` was true for EVERY row and the header badge stayed stuck
  // at its count even after marking items read. Serialize to the contract.
  const views = (items as any[]).map(toNotificationView);
  return paginatedResponse(views, total, { page, limit, skip });
}

export async function markNotificationRead(db: Db, schoolId: string, id: string): Promise<any> {
  const n = await db.notification.findFirst({ where: { id, schoolId: schoolId } });
  if (!n) throw ApiError.notFound('Notification not found');
  const updated: any = await db.notification.update({ where: { id }, data: { isRead: true } });
  return toNotificationView(updated);
}
