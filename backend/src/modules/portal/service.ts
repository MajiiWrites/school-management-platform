// Parent portal (Gap #1, 2026-11-20) — tokenized read-only link /p/:token.
// One token shows exactly ONE student: attendance, results, fees,
// timetable, announcements and homework. No login, no edits, no other
// student's data. Tokens reuse the Class attendance-link storage pattern:
// raw token AES-256-GCM-encrypted (so the admin UI can show the existing
// link after a reload) + SHA-256 hash lookup, revocable, 1-year expiry.
import { config } from '../../config';
import { ApiError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { logCreate } from '../hardening/helpers';
import { randomToken, hashToken, encryptToken, decryptToken, decryptPhone, maskPhone } from '../../lib/crypto';
import { todayInTz } from '../../lib/dates';
import { waLink } from '../messaging/whatsapp';
import type { Db } from '../../lib/db';

const TOKEN_TTL_DAYS = 365;

function portalUrl(token: string): string {
  return `${config.frontendUrl}/p/${token}`;
}

function isoDate(d: Date | string): string {
  return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);
}

async function getStudentInSchool(db: Db, schoolId: string, studentId: string): Promise<any> {
  const student = await db.student.findFirst({ where: { id: studentId, schoolId, deletedAt: null } });
  if (!student) throw ApiError.notFound('Student not found');
  return student;
}

/** Resolve a raw parent token to its row + student + school. Null = invalid / revoked / expired. */
export async function resolveParentToken(db: Db, token: string): Promise<{ row: any; student: any; school: any } | null> {
  const row = await db.parentToken.findFirst({ where: { tokenHash: hashToken(token) } });
  if (!row || row.revoked) return null;
  if (row.expiresAt && new Date(row.expiresAt) < new Date()) return null;
  const student = await db.student.findFirst({ where: { id: row.studentId, schoolId: row.schoolId, deletedAt: null } });
  if (!student) return null;
  const school = await db.school.findUnique({ where: { id: row.schoolId } });
  if (!school) return null;
  return { row, student, school };
}

/** Public portal data for one token — read-only, exactly one student. */
export async function getParentPortal(db: Db, token: string): Promise<Record<string, unknown>> {
  const resolved = await resolveParentToken(db, token);
  if (!resolved) throw ApiError.notFound('This parent link is invalid, revoked or expired');
  const { student, school } = resolved;

  const cls = await db.class.findFirst({ where: { id: student.classId, schoolId: school.id } });
  const classLabel = cls ? `${cls.name}-${cls.section}` : '—';

  // Attendance: the student's own records for the class's recent days.
  const days: any[] = await db.attendanceDay.findMany({
    where: { schoolId: school.id, classId: student.classId },
    orderBy: [{ date: 'desc' }],
    take: 30,
  });
  const dayIds = days.map((d: any) => d.id);
  const records: any[] = dayIds.length
    ? await db.attendanceRecord.findMany({ where: { attendanceDayId: { in: dayIds }, studentId: student.id } })
    : [];
  const statusByDay = new Map<string, string>(records.map((r: any) => [r.attendanceDayId, r.status]));
  const attendance = days.map((d: any) => ({
    date: isoDate(d.date),
    status: statusByDay.get(d.id) ?? null,
  }));

  // Results: latest 20, with exam names resolved in one query.
  const results: any[] = await db.result.findMany({
    where: { schoolId: school.id, studentId: student.id, deletedAt: null },
    orderBy: [{ createdAt: 'desc' }],
    take: 20,
  });
  const examIds = [...new Set(results.map((r: any) => r.examId))];
  const exams: any[] = examIds.length ? await db.exam.findMany({ where: { id: { in: examIds } } }) : [];
  const examName = new Map<string, string>(exams.map((e: any) => [e.id, e.name]));

  // Fees: latest 12 records (status is GENERATED in the DB — read-only here).
  const fees: any[] = await db.feeRecord.findMany({
    where: { schoolId: school.id, studentId: student.id, deletedAt: null },
    orderBy: [{ month: 'desc' }],
    take: 12,
  });

  // Timetable: class entries grouped by day of week, with teacher names.
  const entries: any[] = await db.timetableEntry.findMany({
    where: { schoolId: school.id, classId: student.classId },
    orderBy: [{ dayOfWeek: 'asc' }, { periodNo: 'asc' }],
  });
  const teacherIds = [...new Set(entries.map((e: any) => e.teacherId).filter(Boolean))];
  const teachers: any[] = teacherIds.length ? await db.staff.findMany({ where: { id: { in: teacherIds } } }) : [];
  const teacherName = new Map<string, string>(teachers.map((t: any) => [t.id, t.name]));
  const byDay = new Map<number, any[]>();
  for (const e of entries) {
    const list = byDay.get(e.dayOfWeek) ?? [];
    list.push({
      period_no: e.periodNo,
      subject: e.subject,
      start_time: e.startTime,
      end_time: e.endTime,
      room: e.room ?? null,
      teacher_name: e.teacherId ? (teacherName.get(e.teacherId) ?? null) : null,
    });
    byDay.set(e.dayOfWeek, list);
  }
  const timetable = [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, periods]) => ({ day_of_week: day, periods }));

  // Announcements: approved/sent ones for everyone or this class.
  const announcements: any[] = await db.announcement.findMany({
    where: { schoolId: school.id, status: { in: ['approved', 'sent'] } },
    orderBy: [{ createdAt: 'desc' }],
    take: 10,
  });

  // Homework: this class's diary, soonest due first.
  const homework: any[] = await db.homework.findMany({
    where: { schoolId: school.id, classId: student.classId, deletedAt: null },
    orderBy: [{ dueDate: 'asc' }],
  });

  return {
    school: { name: school.name },
    student: {
      id: student.id,
      name: student.name,
      name_ur: student.nameUr ?? null,
      class_name: classLabel,
      roll_no: student.rollNo ?? null,
      admission_no: student.admissionNo ?? null,
    },
    attendance,
    results: results.map((r: any) => ({
      id: r.id,
      exam_name: examName.get(r.examId) ?? 'Exam',
      obtained_marks: r.obtainedMarks ?? null,
      total_marks: r.totalMarks ?? null,
      percentage: r.percentage ?? null,
      grade: r.grade ?? null,
      position: r.position ?? null,
      created_at: r.createdAt,
    })),
    fees: fees.map((f: any) => ({
      month: f.month,
      amount_due: f.amountDue,
      amount_paid: f.amountPaid,
      discount: f.discount,
      status: f.status,
      paid_at: f.paidAt ?? null,
      receipt_no: f.receiptNo ?? null,
    })),
    timetable,
    announcements: announcements
      .filter((a: any) => a.targetType === 'all' || !a.targetClassId || a.targetClassId === student.classId)
      .map((a: any) => ({ id: a.id, title: a.title, body: a.body, created_at: a.createdAt })),
    homework: homework.map((h: any) => ({
      id: h.id,
      subject: h.subject,
      title: h.title,
      description: h.description ?? null,
      due_date: isoDate(h.dueDate),
      teacher: h.teacher,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Admin: token management                                             */
/* ------------------------------------------------------------------ */

export async function getParentTokenInfo(db: Db, schoolId: string, studentId: string): Promise<Record<string, unknown>> {
  await getStudentInSchool(db, schoolId, studentId);
  const row = await db.parentToken.findFirst({
    where: { schoolId, studentId, revoked: false },
    orderBy: [{ createdAt: 'desc' }],
  });
  if (!row || (row.expiresAt && new Date(row.expiresAt) < new Date())) {
    return { exists: false, url: null, expires_at: null };
  }
  return { exists: true, url: portalUrl(decryptToken(row.tokenEnc)), expires_at: row.expiresAt };
}

/** Create (or rotate) a student's parent link. Old active tokens are revoked. */
export async function createParentToken(db: Db, schoolId: string, studentId: string, actorId?: string): Promise<Record<string, unknown>> {
  const student = await getStudentInSchool(db, schoolId, studentId);
  await db.parentToken.updateMany({ where: { schoolId, studentId, revoked: false }, data: { revoked: true } });
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  const created = await db.parentToken.create({
    data: { schoolId, studentId, tokenHash: hashToken(token), tokenEnc: encryptToken(token), expiresAt, revoked: false },
  });
  await logCreate(db, {
    schoolId,
    actorId: actorId ?? null,
    entity: 'parent_token',
    entityId: created.id,
    after: { student_id: studentId, expires_at: expiresAt.toISOString() },
  });
  await writeAudit(db, {
    schoolId,
    actorId: actorId ?? null,
    actorType: 'user',
    action: 'parent_token.create',
    entity: 'parent_token',
    entityId: created.id,
    details: { student_id: studentId, student_name: student.name, expires_at: expiresAt.toISOString() },
  });
  return { url: portalUrl(token), expires_at: expiresAt, token_id: created.id };
}

/** Revoke all active tokens for a student. */
export async function revokeParentToken(db: Db, schoolId: string, studentId: string, actorId?: string): Promise<Record<string, unknown>> {
  await getStudentInSchool(db, schoolId, studentId);
  const res = await db.parentToken.updateMany({ where: { schoolId, studentId, revoked: false }, data: { revoked: true } });
  await writeAudit(db, {
    schoolId,
    actorId: actorId ?? null,
    actorType: 'user',
    action: 'parent_token.revoke',
    entity: 'parent_token',
    entityId: null,
    details: { student_id: studentId, revoked_count: res.count ?? 0 },
  });
  return { revoked: res.count ?? 0 };
}

/**
 * Queue the parent-link SMS as a held draft (type 'custom') — it is NEVER
 * sent directly; the admin approves it in Messages like every other SMS,
 * and the Android companion app delivers it from the school's own SIM.
 * Idempotent per student per day (dedupe key), so re-clicking cannot spam.
 */
export async function sendParentLinkSms(db: Db, schoolId: string, studentId: string, actorId?: string): Promise<Record<string, unknown>> {
  const student = await getStudentInSchool(db, schoolId, studentId);
  if (!student.parentPhoneEnc || student.parentOptOut) {
    throw ApiError.validation('This student has no valid parent number on file (or the parent opted out of SMS)');
  }
  const school = await db.school.findUnique({ where: { id: schoolId } });
  if (!school) throw ApiError.notFound('School not found');
  const info = await getParentTokenInfo(db, schoolId, studentId);
  const url = info.exists ? (info.url as string) : (await createParentToken(db, schoolId, studentId, actorId)).url as string;
  const today = todayInTz(school.timezone ?? 'Asia/Karachi');
  const dedupeKey = `parent-link:${studentId}:${today}`;
  const existing = await db.messageQueue.findFirst({ where: { schoolId, dedupeKey } });
  if (existing) return { queued: true, already_queued: true, queue_id: existing.id };
  const body = `Dear Parent, view ${student.name}'s attendance, results, fees and homework here: ${url} – ${school.name}`;
  const created = await db.messageQueue.create({
    data: {
      schoolId,
      type: 'custom',
      studentId,
      classId: student.classId,
      parentPhoneEnc: student.parentPhoneEnc,
      body,
      status: 'queued',
      attempts: 0,
      dedupeKey,
      scheduledFor: new Date(),
      approvedBy: null,
      approvedAt: null,
    },
  });
  await writeAudit(db, {
    schoolId,
    actorId: actorId ?? null,
    actorType: 'user',
    action: 'parent_token.sms_link',
    entity: 'message_queue',
    entityId: created.id,
    details: { student_id: studentId, dedupe_key: dedupeKey },
  });
  return { queued: true, already_queued: false, queue_id: created.id };
}

/**
 * Build the parent-link WhatsApp click-to-send link (Messaging Center
 * wiring, 2026-11-20). Unlike the SMS path this queues NOTHING — the
 * admin opens the wa.me link themselves and taps send in WhatsApp, so
 * there is no held draft and no approval step. The link is built
 * server-side because the frontend only ever sees the MASKED parent
 * phone. Same number rules as SMS (valid number, not opted out). The
 * outcome is NOT recorded as sent anywhere — opening the link is the
 * admin's own WhatsApp send, and the audit log is the only trace.
 */
export async function getParentLinkWhatsApp(
  db: Db,
  schoolId: string,
  studentId: string,
  actorId?: string,
): Promise<Record<string, unknown>> {
  const student = await getStudentInSchool(db, schoolId, studentId);
  if (!student.parentPhoneEnc || student.parentOptOut) {
    throw ApiError.validation('This student has no valid parent number on file (or the parent opted out of messages)');
  }
  const school = await db.school.findUnique({ where: { id: schoolId } });
  if (!school) throw ApiError.notFound('School not found');
  const info = await getParentTokenInfo(db, schoolId, studentId);
  const url = info.exists ? (info.url as string) : (await createParentToken(db, schoolId, studentId, actorId)).url as string;
  const phone = decryptPhone(student.parentPhoneEnc);
  const body = `Dear Parent, view ${student.name}'s attendance, results, fees and homework here: ${url} – ${school.name}`;
  const link = waLink(phone, body);
  if (!link) {
    throw ApiError.validation('This student has no valid parent number on file');
  }
  await writeAudit(db, {
    schoolId,
    actorId: actorId ?? null,
    actorType: 'user',
    action: 'parent_token.whatsapp_link',
    entity: 'parent_token',
    entityId: null,
    details: { student_id: studentId },
  });
  return { wa_url: link, phone_masked: maskPhone(phone) };
}
