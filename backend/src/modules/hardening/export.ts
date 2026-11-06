/**
 * Data ownership — full export (6A).
 *
 * GET/POST /export/all (admin, password-confirmed) returns the school's full
 * data as JSON. This is the admin's OWN data, so phones are included FULLY
 * DECRYPTED (unlike list endpoints, which mask them). The export is logged
 * in audit_logs. No ZIP: JSON keeps the endpoint dependency-free; the
 * Phase 6D backup job writes school_backups rows separately.
 */
import { ApiError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { decryptPhone } from '../../lib/crypto';
import type { Db } from '../../lib/db';

function tryDecrypt(enc: string | null | undefined): string | null {
  if (!enc) return null;
  try {
    return decryptPhone(enc);
  } catch {
    return null;
  }
}

/** Tenant tables exported (delegate -> export key). All are school-scoped. */
const TABLES: Array<[keyof Db, string]> = [
  ['school', 'schools'],
  ['user', 'users'],
  ['class', 'classes'],
  ['student', 'students'],
  ['attendanceDay', 'attendance_days'],
  ['teacherAttendance', 'teacher_attendance'],
  ['feeStructure', 'fee_structures'],
  ['feeRecord', 'fee_records'],
  ['messageTemplate', 'message_templates'],
  ['messageQueue', 'message_queue'],
  ['smsDevice', 'sms_devices'],
  ['holiday', 'holidays'],
  ['academicSession', 'academic_sessions'],
  ['promotion', 'promotions'],
  ['leaveApplication', 'leave_applications'],
  ['ocrUpload', 'ocr_uploads'],
  ['auditLog', 'audit_logs'],
  ['notification', 'notifications'],
  ['rolePermission', 'role_permissions'],
  ['approvalRequest', 'approval_requests'],
  ['deletedRecord', 'deleted_records'],
  ['changeLog', 'change_logs'],
  ['exam', 'exams'],
  ['gradingScale', 'grading_scales'],
  ['resultSheet', 'result_sheets'],
  ['result', 'results'],
  ['timetableEntry', 'timetable_entries'],
  ['staff', 'staff'],
  ['staffClassAssignment', 'staff_class_assignments'],
  ['salaryRecord', 'salary_records'],
  ['expense', 'expenses'],
  ['announcement', 'announcements'],
  ['event', 'events'],
  ['certificate', 'certificates'],
  ['examDatesheet', 'exam_datesheets'],
  ['feeVoucher', 'fee_vouchers'],
  ['accountDeletionRequest', 'account_deletion_requests'],
  ['schoolBackup', 'school_backups'],
  ['messageDraft', 'message_drafts'],
];

/** Strip credential/token material that must never leave the server in an export. */
function scrubUser(u: any): Record<string, unknown> {
  const { passwordHash, verifyTokenHash, resetTokenHash, totpSecretEnc, ...rest } = u;
  return rest;
}

export async function exportSchoolData(db: Db, schoolId: string, actorId: string): Promise<Record<string, unknown>> {
  const tables: Record<string, unknown[]> = {};
  for (const [delegate, key] of TABLES) {
    // The schools table itself is keyed by id, not schoolId.
    const where = delegate === 'school' ? { id: schoolId } : { schoolId };
    const rows: any[] = await (db as any)[delegate].findMany({ where });
    tables[key] = rows;
  }

  // attendance_records + message_deliveries have no school_id; scope via parents.
  const dayIds = (tables.attendance_days as any[]).map((d) => d.id);
  tables.attendance_records = dayIds.length
    ? await db.attendanceRecord.findMany({ where: { attendanceDayId: { in: dayIds } } })
    : [];
  const queueIds = (tables.message_queue as any[]).map((q) => q.id);
  tables.message_deliveries = queueIds.length
    ? await db.messageDelivery.findMany({ where: { queueId: { in: queueIds } } })
    : [];

  // Full decrypted phones — this is the admin's own data.
  tables.students = (tables.students as any[]).map((s) => ({
    ...s,
    parent_phone: tryDecrypt(s.parentPhoneEnc),
    parent2_phone: tryDecrypt(s.parent2PhoneEnc),
  }));
  tables.classes = (tables.classes as any[]).map((c) => ({
    ...c,
    teacher_phone: tryDecrypt(c.teacherPhoneEnc),
  }));
  tables.staff = (tables.staff as any[]).map((s) => ({
    ...s,
    phone: tryDecrypt(s.phoneEnc),
  }));
  tables.users = (tables.users as any[]).map(scrubUser);

  await writeAudit(db, {
    schoolId,
    actorId,
    actorType: 'user',
    action: 'data.export',
    entity: 'school',
    entityId: schoolId,
    details: { tables: Object.keys(tables).length },
  });

  return {
    school_id: schoolId,
    exported_at: new Date().toISOString(),
    note: 'Full school data export. Phones are included decrypted — this is your own data; store the file securely.',
    tables,
  };
}

/** Verify an admin's password (used as confirmation for export + account deletion). */
export async function verifyAdminPassword(db: Db, adminId: string, password: string): Promise<void> {
  if (!password) throw ApiError.validation('password is required to confirm this action');
  const bcrypt = await import('bcrypt');
  const user = await db.user.findUnique({ where: { id: adminId } });
  if (!user) throw ApiError.unauthorized();
  const ok = await bcrypt.compare(password, (user as any).passwordHash);
  if (!ok) throw ApiError.unauthorized('Invalid password');
}
