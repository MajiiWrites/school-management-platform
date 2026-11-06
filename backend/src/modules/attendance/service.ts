import { ApiError } from '../../lib/errors';
import { isNonSchoolDay, todayInTz, isValidDateString, dateOnly } from '../../lib/dates';
import { writeAudit } from '../../lib/audit';
import { resolveLinkToken } from '../classes/service';
import { buildAbsentDrafts } from '../messaging/service';
import { createPrismaMessagingStore } from '../messaging/store';
import type { Db } from '../../lib/db';

export type AttendanceStatus = 'present' | 'absent' | 'late' | 'leave';
export const ATTENDANCE_STATUSES: AttendanceStatus[] = ['present', 'absent', 'late', 'leave'];

const DEFAULT_ABSENT_TEMPLATE_EN =
  'Dear Parent, your child {student_name} (Class {class}) was marked ABSENT from school today ({date}). Please contact the school if needed. – {school_name}';
const DEFAULT_ABSENT_TEMPLATE_UR =
  'محترم والدین، آپ کے بچے {student_name} (کلاس {class}) آج ({date}) اسکول سے غیر حاضر تھے۔ ضرورت ہو تو اسکول سے رابطہ کریں۔ – {school_name}';

export function renderTemplate(body: string, vars: Record<string, string>): string {
  let out = body;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(value);
  }
  return out;
}

async function getSchool(db: Db, schoolId: string): Promise<any> {
  const school = await db.school.findUnique({ where: { id: schoolId } });
  if (!school) throw ApiError.notFound('School not found');
  return school;
}

// ISOLATION FIX: the old lookup was by (classId, date) alone. Every caller
// now passes the school that owns the class, so a day row can never be
// resolved across schools even if ids were ever confused upstream.
async function getClassDay(db: Db, classId: string, date: string, schoolId?: string): Promise<any | null> {
  const where: Record<string, unknown> = { classId: classId, date: dateOnly(date) };
  if (schoolId) where.schoolId = schoolId;
  return db.attendanceDay.findFirst({ where });
}

/** Public link page data: class, today's date, students, submission state. */
export async function getLinkPage(db: Db, token: string, expectedSchoolId?: string): Promise<Record<string, unknown>> {
  const cls = await resolveLinkToken(db, token, expectedSchoolId);
  if (!cls) throw ApiError.notFound('This attendance link is invalid, revoked or expired');
  const school = await getSchool(db, cls.schoolId);
  const date = todayInTz(school.timezone);
  const nonSchoolDay = await isNonSchoolDay(db, cls.schoolId, date);
  const students = await db.student.findMany({
    where: { classId: cls.id, status: 'active' },
    orderBy: [{ rollNo: 'asc' }, { name: 'asc' }],
  });
  const day = await getClassDay(db, cls.id, date, cls.schoolId);
  let submitted: Record<string, string> = {};
  if (day) {
    const records = await db.attendanceRecord.findMany({ where: { attendanceDayId: day.id } });
    submitted = Object.fromEntries(records.map((r: any) => [r.studentId, r.status]));
  }
  return {
    class: { id: cls.id, display_name: `${cls.name}-${cls.section}`, teacher_name: cls.teacherName },
    date,
    non_school_day: nonSchoolDay,
    already_submitted: Boolean(day),
    students: students.map((s: any) => ({
      id: s.id,
      name: s.name,
      roll_no: s.rollNo ?? null,
      status: submitted[s.id] ?? null,
    })),
  };
}

export interface SubmitInput {
  token: string;
  records: Array<{ student_id: string; status: AttendanceStatus }>;
  /** Test/QA only — forces the submission date. Routes never set this. */
  dateOverride?: string;
  /** Optional school context: when set, a token from another school is rejected (404). */
  expectedSchoolId?: string;
}

export interface SubmitResult {
  day_id: string;
  date: string;
  class_id: string;
  present: number;
  absent: number;
  late: number;
  leave: number;
  absent_students: Array<{ id: string; name: string }>;
  messages_drafted: number;
  students_without_valid_number: Array<{ id: string; name: string }>;
}

/**
 * Submit attendance for a class/day via the public teacher link.
 * Rules enforced (contracts/API.md):
 * - token must be valid / not revoked / not expired
 * - no attendance on Sundays or holidays (409)
 * - one submission per class per day; 409 unless the admin unlocked it
 * - students missing from `records` default to present
 * - absent students generate held draft queue rows (status queued, approved_by
 *   null — the Messaging Agent's approve flow releases them) + a notification
 * - dedupe_key `absent:{student_id}:{date}` prevents duplicate sends
 * - teacher absence NEVER creates messages (this flow is student-only)
 */
export async function submitAttendance(db: Db, input: SubmitInput): Promise<SubmitResult> {
  const cls = await resolveLinkToken(db, input.token, input.expectedSchoolId);
  if (!cls) throw ApiError.notFound('This attendance link is invalid, revoked or expired');
  const school = await getSchool(db, cls.schoolId);
  const date = input.dateOverride ?? todayInTz(school.timezone);

  if (await isNonSchoolDay(db, cls.schoolId, date)) {
    throw ApiError.conflict('No attendance on Sundays or holidays');
  }

  const students = await db.student.findMany({
    where: { classId: cls.id, status: 'active' },
    orderBy: [{ rollNo: 'asc' }, { name: 'asc' }],
  });
  const byId = new Map<string, any>(students.map((s: any) => [s.id, s]));
  const statuses = new Map<string, AttendanceStatus>();
  for (const r of input.records) {
    if (!byId.has(r.student_id)) throw ApiError.validation(`Student ${r.student_id} does not belong to this class`);
    if (!ATTENDANCE_STATUSES.includes(r.status)) throw ApiError.validation(`Invalid status: ${r.status}`);
    statuses.set(r.student_id, r.status);
  }
  for (const s of students) {
    if (!statuses.has(s.id)) statuses.set(s.id, 'present');
  }

  const existing = await getClassDay(db, cls.id, date, cls.schoolId);
  if (existing && !existing.unlocked) {
    throw ApiError.conflict('Attendance for this class has already been submitted today');
  }

  const counts = { present: 0, absent: 0, late: 0, leave: 0 };
  for (const st of statuses.values()) counts[st] += 1;
  const absentStudents = students.filter((s: any) => statuses.get(s.id) === 'absent');

  const result = await db.$transaction(async (tx) => {
    let day: any;
    if (existing) {
      await tx.attendanceRecord.deleteMany({ where: { attendanceDayId: existing.id } });
      day = await tx.attendanceDay.update({
        where: { id: existing.id },
        data: { submittedBy: 'teacher_link', submittedAt: new Date(), unlocked: false, unlockedBy: null },
      });
    } else {
      day = await tx.attendanceDay.create({
        data: { schoolId: cls.schoolId, classId: cls.id, date: dateOnly(date), submittedBy: 'teacher_link', submittedAt: new Date(), unlocked: false },
      });
    }
    await tx.attendanceRecord.createMany({
      data: students.map((s: any) => ({
        attendanceDayId: day.id,
        studentId: s.id,
        status: statuses.get(s.id)!,
        markedAt: new Date(),
        updatedBy: 'teacher_link',
      })),
    });
    return day;
  });

  await writeAudit(db, {
    schoolId: cls.schoolId,
    actorType: 'teacher_link',
    action: 'attendance.submit',
    entity: 'attendance_day',
    entityId: result.id,
    details: { class_id: cls.id, date, ...counts },
  });

  // Draft absent messages (held for admin approval) + notification.
  // INTEGRATION (Phase 3): the canonical draft builder is the Messaging
  // service's buildAbsentDrafts (messaging/MOUNT.md §3) — it owns template
  // resolution, phone decrypt/validation and the dedupe guard, so this flow
  // no longer duplicates that logic inline. The notification stays here: it
  // is attendance-owned (absent_approval) and buildAbsentDrafts does not
  // create it. editAttendance keeps its own inline re-sync (it also cancels
  // drafts for students who are no longer absent — a different flow).
  let drafted = 0;
  const withoutNumber: Array<{ id: string; name: string }> = [];
  if (absentStudents.length > 0) {
    const lang = (school.settings as Record<string, any>)?.message_language === 'ur' ? 'ur' : 'en';
    const displayName = `${cls.name}-${cls.section}`;
    const store = createPrismaMessagingStore(db);
    const draftResult = await buildAbsentDrafts(
      { store },
      {
        school: {
          id: school.id,
          name: school.name,
          timezone: school.timezone,
          smsProvider: (school.settings as Record<string, any>)?.sms_provider === 'gateway' ? 'gateway' : 'sim',
        },
        classId: cls.id,
        className: displayName,
        date,
        records: students.map((s: any) => ({ studentId: s.id, status: statuses.get(s.id)! })),
        students: students.map((s: any) => ({
          id: s.id,
          name: s.name,
          classId: cls.id,
          parentName: s.parentName ?? null,
          parentPhoneEnc: s.parentPhoneEnc ?? null,
          parentOptOut: s.parentOptOut ?? false,
          // Section 11: full 8-variable render context for absent templates.
          fatherName: s.fatherName ?? null,
          section: cls.section ?? null,
        })),
        language: lang,
      },
    );
    drafted = draftResult.created;
    // Same "no valid number" meaning as the old inline code: a missing or
    // undecryptable number, or a parent who opted out — no message can go
    // out for the child either way. (`already_queued` is not listed: the
    // draft already exists and will go out after approval.)
    withoutNumber.push(
      ...draftResult.skipped
        .filter((sk) => sk.reason === 'missing_phone' || sk.reason === 'invalid_phone' || sk.reason === 'opted_out')
        .map((sk) => ({ id: sk.studentId, name: sk.studentName })),
    );
    await db.notification.create({
      data: {
        schoolId: cls.schoolId,
        type: 'absent_approval',
        title: `Absent today: ${absentStudents.length} in Class ${displayName}`,
        body: `${absentStudents.length} student(s) were marked absent in Class ${displayName} on ${date}. ${drafted} message(s) are ready for your approval.${withoutNumber.length > 0 ? ` ${withoutNumber.length} absent student(s) have no valid parent number: ${withoutNumber.map((s) => s.name).join(', ')}.` : ''}`,
        relatedType: 'attendance_day',
        relatedId: result.id,
      },
    });
  }

  return {
    day_id: result.id,
    date,
    class_id: cls.id,
    ...counts,
    absent_students: absentStudents.map((s: any) => ({ id: s.id, name: s.name })),
    messages_drafted: drafted,
    students_without_valid_number: withoutNumber,
  };
}

/** Admin: unlock a submitted day so the teacher link can re-submit it. */
export async function unlockAttendance(db: Db, schoolId: string, classId: string, date: string, adminId: string): Promise<any> {
  if (!isValidDateString(date)) throw ApiError.validation('Date must be YYYY-MM-DD');
  const cls = await db.class.findFirst({ where: { id: classId, schoolId: schoolId } });
  if (!cls) throw ApiError.notFound('Class not found');
  const day = await getClassDay(db, classId, date, schoolId);
  if (!day) throw ApiError.notFound('No attendance submission exists for this class and date');
  const updated = await db.attendanceDay.update({ where: { id: day.id }, data: { unlocked: true, unlockedBy: adminId } });
  await writeAudit(db, { schoolId, actorId: adminId, actorType: 'user', action: 'attendance.unlock', entity: 'attendance_day', entityId: day.id, details: { class_id: classId, date } });
  return updated;
}

/** Admin: edit a submitted day's records (replaces them; re-syncs absent drafts). */
export async function editAttendance(
  db: Db,
  schoolId: string,
  dayId: string,
  records: Array<{ student_id: string; status: AttendanceStatus }>,
  adminId: string,
): Promise<SubmitResult> {
  const day = await db.attendanceDay.findFirst({ where: { id: dayId, schoolId: schoolId } });
  if (!day) throw ApiError.notFound('Attendance day not found');
  const school = await getSchool(db, schoolId);
  const cls = await db.class.findFirst({ where: { id: day.classId, schoolId: schoolId } });
  if (!cls) throw ApiError.notFound('Class not found');

  const students = await db.student.findMany({ where: { classId: day.classId, status: 'active' } });
  const byId = new Map<string, any>(students.map((s: any) => [s.id, s]));
  const statuses = new Map<string, AttendanceStatus>();
  for (const r of records) {
    if (!byId.has(r.student_id)) throw ApiError.validation(`Student ${r.student_id} does not belong to this class`);
    if (!ATTENDANCE_STATUSES.includes(r.status)) throw ApiError.validation(`Invalid status: ${r.status}`);
    statuses.set(r.student_id, r.status);
  }
  const prevRecords = await db.attendanceRecord.findMany({ where: { attendanceDayId: day.id } });
  const prevByStudent = new Map<string, string>(prevRecords.map((r: any) => [r.studentId, r.status]));
  for (const s of students) {
    if (!statuses.has(s.id)) {
      statuses.set(s.id, (prevByStudent.get(s.id) as AttendanceStatus) ?? 'present');
    }
  }

  const counts = { present: 0, absent: 0, late: 0, leave: 0 };
  for (const st of statuses.values()) counts[st] += 1;

  await db.$transaction(async (tx) => {
    await tx.attendanceRecord.deleteMany({ where: { attendanceDayId: day.id } });
    await tx.attendanceRecord.createMany({
      data: students.map((s: any) => ({
        attendanceDayId: day.id,
        studentId: s.id,
        status: statuses.get(s.id)!,
        markedAt: new Date(),
        updatedBy: 'admin',
      })),
    });
  });

  // Re-sync absent drafts: cancel unapproved drafts for students no longer
  // absent; create drafts for newly absent students (dedupe-guarded).
  // day.date is a Prisma @db.Date (a Date object at runtime, not a string):
  // format it to YYYY-MM-DD so the dedupe `contains` match and the
  // `absent:<id>:<date>` keys line up with submitAttendance.
  const date = (day.date instanceof Date ? day.date : new Date(day.date)).toISOString().slice(0, 10);
  const nowAbsent = new Set(students.filter((s: any) => statuses.get(s.id) === 'absent').map((s: any) => s.id));
  const drafts = await db.messageQueue.findMany({ where: { schoolId: schoolId, type: 'absent', classId: day.classId, dedupeKey: { contains: `:${date}` } } });
  for (const d of drafts) {
    if (d.approvedBy) continue; // already approved — never touch a live send
    if (d.studentId && !nowAbsent.has(d.studentId) && d.status === 'queued') {
      await db.messageQueue.update({ where: { id: d.id }, data: { status: 'cancelled' } });
    }
  }
  let drafted = 0;
  const withoutNumber: Array<{ id: string; name: string }> = [];
  const displayName = `${cls.name}-${cls.section}`;
  const lang = (school.settings as Record<string, any>)?.message_language === 'ur' ? 'ur' : 'en';
  const template = await db.messageTemplate.findFirst({ where: { schoolId: schoolId, type: 'absent', language: lang, isActive: true } });
  const bodyTemplate = template?.body ?? (lang === 'ur' ? DEFAULT_ABSENT_TEMPLATE_UR : DEFAULT_ABSENT_TEMPLATE_EN);
  for (const s of students) {
    if (!nowAbsent.has(s.id)) continue;
    if (!s.parentPhoneEnc || s.parentOptOut) {
      withoutNumber.push({ id: s.id, name: s.name });
      continue;
    }
    const dedupeKey = `absent:${s.id}:${date}`;
    const already = await db.messageQueue.findFirst({ where: { schoolId: schoolId, dedupeKey: dedupeKey } });
    if (already) continue;
    await db.messageQueue.create({
      data: {
        schoolId: schoolId,
        type: 'absent',
        studentId: s.id,
        classId: day.classId,
        parentPhoneEnc: s.parentPhoneEnc,
        body: renderTemplate(bodyTemplate, { student_name: s.name, class: displayName, date, month: date.slice(0, 7), amount: '', school_name: school.name }),
        status: 'queued',
        attempts: 0,
        dedupeKey: dedupeKey,
        scheduledFor: new Date(),
        approvedBy: null,
        approvedAt: null,
      },
    });
    drafted += 1;
  }

  await writeAudit(db, { schoolId, actorId: adminId, actorType: 'user', action: 'attendance.edit', entity: 'attendance_day', entityId: day.id, details: { class_id: day.classId, date, ...counts } });
  return {
    day_id: day.id,
    date,
    class_id: day.classId,
    ...counts,
    absent_students: students.filter((s: any) => nowAbsent.has(s.id)).map((s: any) => ({ id: s.id, name: s.name })),
    messages_drafted: drafted,
    students_without_valid_number: withoutNumber,
  };
}

/** Admin: get a class's attendance day + records for a date. */
export async function getClassAttendance(db: Db, schoolId: string, classId: string, date: string): Promise<Record<string, unknown> | null> {
  if (!isValidDateString(date)) throw ApiError.validation('Date must be YYYY-MM-DD');
  const cls = await db.class.findFirst({ where: { id: classId, schoolId: schoolId } });
  if (!cls) throw ApiError.notFound('Class not found');
  const day = await getClassDay(db, classId, date, schoolId);
  if (!day) return null;
  const records = await db.attendanceRecord.findMany({ where: { attendanceDayId: day.id } });
  const students = await db.student.findMany({ where: { classId: classId } });
  const byId = new Map<string, any>(students.map((s: any) => [s.id, s]));
  return {
    day: { id: day.id, date: day.date, submitted_by: day.submittedBy, submitted_at: day.submittedAt, unlocked: day.unlocked },
    records: records.map((r: any) => ({
      student_id: r.studentId,
      name: byId.get(r.studentId)?.name ?? 'Unknown',
      roll_no: byId.get(r.studentId)?.rollNo ?? null,
      status: r.status,
    })),
  };
}

// ---------------------------------------------------------------------------
// Teacher attendance (admin-marked; absence NEVER triggers messages)
// ---------------------------------------------------------------------------

export async function markTeacherAttendance(
  db: Db,
  schoolId: string,
  input: { class_id: string; date: string; status: 'present' | 'absent' | 'leave'; note?: string | null },
  adminId: string,
): Promise<any> {
  if (!isValidDateString(input.date)) throw ApiError.validation('Date must be YYYY-MM-DD');
  const cls = await db.class.findFirst({ where: { id: input.class_id, schoolId: schoolId } });
  if (!cls) throw ApiError.notFound('Class not found');
  if (await isNonSchoolDay(db, schoolId, input.date)) {
    throw ApiError.conflict('No attendance on Sundays or holidays');
  }
  const existing = await db.teacherAttendance.findFirst({ where: { classId: input.class_id, date: dateOnly(input.date) } });
  const data = { schoolId: schoolId, classId: input.class_id, date: dateOnly(input.date), status: input.status, markedBy: adminId, note: input.note ?? null };
  const saved = existing
    ? await db.teacherAttendance.update({ where: { id: existing.id }, data })
    : await db.teacherAttendance.create({ data });
  await writeAudit(db, { schoolId, actorId: adminId, actorType: 'user', action: 'teacher_attendance.mark', entity: 'teacher_attendance', entityId: saved.id, details: { class_id: input.class_id, date: input.date, status: input.status } });
  return saved;
}

export async function listTeacherAttendance(db: Db, schoolId: string, query: Record<string, any>): Promise<any[]> {
  const where: Record<string, unknown> = { schoolId: schoolId };
  if (query.date) {
    if (!isValidDateString(String(query.date))) throw ApiError.validation('Date must be YYYY-MM-DD');
    where.date = dateOnly(String(query.date));
  }
  if (query.class_id) where.classId = String(query.class_id);
  const rows = await db.teacherAttendance.findMany({ where, orderBy: [{ date: 'desc' }] });
  const classes = await db.class.findMany({ where: { schoolId: schoolId } });
  const byId = new Map<string, any>(classes.map((c: any) => [c.id, c]));
  return rows.map((r: any) => ({
    id: r.id,
    class_id: r.classId,
    class_display_name: byId.get(r.classId) ? `${byId.get(r.classId).name}-${byId.get(r.classId).section}` : null,
    teacher_name: byId.get(r.classId)?.teacherName ?? null,
    date: r.date,
    status: r.status,
    note: r.note ?? null,
  }));
}
