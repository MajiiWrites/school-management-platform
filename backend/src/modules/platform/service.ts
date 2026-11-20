/**
 * Platform Admin Panel service (2026-11-20).
 *
 * Cross-school administration for the platform owner (role
 * 'platform_admin'). Every mutating action writes a platform_audit_logs
 * row; school-scoped actions ALSO write a school AuditLog row for the
 * target school (writeAudit) so the school's own history shows it.
 * Audit writes never break the business operation.
 *
 * Phones are MASKED in list/detail views exactly like the existing school
 * list endpoints (decrypt + maskPhone, null on failure) — never
 * full-decrypted in a list view. CSV exports strip encrypted/hash/secret
 * fields entirely. The full JSON export reuses exportSchoolData (which
 * decrypts phones — it is the school's own data, same as POST /export/all).
 *
 * Revocation note: there is NO server-side session store (stateless
 * JWTs). "Revoke all sessions" bumps users.token_version; refresh tokens
 * carrying an older version are rejected at the next refresh, and access
 * tokens expire within 15 minutes.
 */
import { ApiError } from '../../lib/errors';
import { decryptPhone, maskPhone } from '../../lib/crypto';
import { paginatedResponse, parsePagination } from '../../lib/pagination';
import { readPlatformSettings, type PlatformNotice, type PlatformSettings } from '../../lib/platformSettings';
import { writeAudit } from '../../lib/audit';
import { exportSchoolData } from '../hardening/export';
import { restoreDeletedRecord, permanentDeleteRecord, toPublicDeletedRecord } from '../hardening/recycleBin';
import { resendVerification, forgotPassword } from '../auth/service';
import type { Db } from '../../lib/db';

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export async function writePlatformAudit(
  db: Db,
  entry: {
    actorId?: string | null;
    action: string;
    entity: string;
    entityId?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    const delegate = (db as any)?.platformAuditLog;
    if (!delegate || typeof delegate.create !== 'function') return;
    await delegate.create({
      data: {
        actorId: entry.actorId ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        details: entry.details ?? {},
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[platform-audit] failed to write platform audit log:', (err as Error).message);
  }
}

async function auditBoth(
  db: Db,
  actorId: string,
  action: string,
  entity: string,
  entityId: string | null,
  details: Record<string, unknown>,
  schoolId?: string | null,
): Promise<void> {
  await writePlatformAudit(db, { actorId, action, entity, entityId, details });
  if (schoolId) {
    await writeAudit(db, { schoolId, actorId, actorType: 'user', action, entity, entityId, details });
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getPlatformSettings(db: Db): Promise<PlatformSettings> {
  return readPlatformSettings(db);
}

export async function updatePlatformSettings(
  db: Db,
  actorId: string,
  patch: { registration_open?: boolean; maintenance_mode?: boolean; notice?: { text: string } | null },
): Promise<PlatformSettings> {
  const before = await readPlatformSettings(db);
  const delegate = (db as any)?.platformSetting;
  const set = async (key: string, value: unknown): Promise<void> => {
    if (!delegate || typeof delegate.upsert !== 'function') return;
    await delegate.upsert({ where: { key }, update: { value }, create: { key, value } });
  };
  if (typeof patch.registration_open === 'boolean') await set('registration_open', patch.registration_open);
  if (typeof patch.maintenance_mode === 'boolean') await set('maintenance_mode', patch.maintenance_mode);
  if (patch.notice !== undefined) {
    await set(
      'platform_notice',
      patch.notice === null
        ? null
        : { text: patch.notice.text.trim(), created_at: new Date().toISOString(), created_by: actorId },
    );
  }
  const after = await readPlatformSettings(db);
  await writePlatformAudit(db, {
    actorId,
    action: 'platform.settings_update',
    entity: 'platform_settings',
    entityId: null,
    details: { before, after },
  });
  return after;
}

export async function getPublicStatus(db: Db): Promise<{
  registration_open: boolean;
  maintenance_mode: boolean;
  notice: PlatformNotice | null;
}> {
  const s = await readPlatformSettings(db);
  return { registration_open: s.registration_open, maintenance_mode: s.maintenance_mode, notice: s.notice };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export async function getOverview(db: Db): Promise<Record<string, unknown>> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [schools, students, users, verified, unverified, signupsWeek, signupsMonth] = await Promise.all([
    db.school.count(),
    db.student.count(),
    db.user.count(),
    db.user.count({ where: { emailVerified: true } }),
    db.user.count({ where: { emailVerified: false } }),
    db.user.count({ where: { createdAt: { gte: weekAgo } } }),
    db.user.count({ where: { createdAt: { gte: monthAgo } } }),
  ]);
  // Mail health: aggregates of the recorded verification-mail outcome —
  // honest counts from the data, not a probe (Gmail SMTP is known to time
  // out from Render; see /platform/mail-health).
  const [mailSent, mailFailed, mailPending] = await Promise.all([
    db.user.count({ where: { verifyEmailStatus: 'sent' } }),
    db.user.count({ where: { verifyEmailStatus: 'failed' } }),
    db.user.count({ where: { verifyEmailStatus: 'pending' } }),
  ]);
  const [queueHeld, queueApproved, queueQueued, queueFailed] = await Promise.all([
    db.messageQueue.count({ where: { status: 'held' } }),
    db.messageQueue.count({ where: { status: 'approved' } }),
    db.messageQueue.count({ where: { status: 'queued' } }),
    db.messageQueue.count({ where: { status: 'failed' } }),
  ]);
  const latestBackup: any = await (db as any).schoolBackup.findFirst({ orderBy: [{ createdAt: 'desc' }] });
  return {
    totals: { schools, students, users, verified_users: verified, unverified_users: unverified },
    signups: { this_week: signupsWeek, this_month: signupsMonth },
    health: {
      api: 'up',
      mail: { sent: mailSent, failed: mailFailed, pending: mailPending },
      queue: { held: queueHeld, approved: queueApproved, queued: queueQueued, failed: queueFailed },
      last_backup_at: latestBackup?.createdAt ? new Date(latestBackup.createdAt).toISOString() : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Schools
// ---------------------------------------------------------------------------

function maskEncrypted(enc: string | null | undefined): string | null {
  if (!enc) return null;
  try {
    return maskPhone(decryptPhone(enc));
  } catch {
    return null;
  }
}

function schoolSuspended(s: any): boolean {
  return !!s.suspendedAt;
}

export async function listSchools(
  db: Db,
  query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  const where: Record<string, unknown> = {};
  if (query.org_type) where.orgType = String(query.org_type);
  if (query.province) where.province = String(query.province);
  if (query.category) where.category = String(query.category);
  if (query.suspended === 'true') where.suspendedAt = { not: null };
  if (query.suspended === 'false') where.suspendedAt = null;
  // School lists are small (tens of schools); exact filters run in the DB,
  // the free-text search + admin/verification filters run in memory so the
  // same code works for every caller. Counts come from groupBy-free counts.
  const [schools, admins, studentCounts, userCounts] = await Promise.all([
    db.school.findMany({ where, orderBy: [{ createdAt: 'desc' }] }),
    db.user.findMany({ where: { role: 'admin' } }),
    (db as any).student.groupBy ? (db as any).student.groupBy({ by: ['schoolId'], _count: { _all: true } }) : [],
    (db as any).user.groupBy ? (db as any).user.groupBy({ by: ['schoolId'], _count: { _all: true } }) : [],
  ]);
  const adminBySchool = new Map<string, any>();
  for (const a of admins as any[]) if (!adminBySchool.has(a.schoolId)) adminBySchool.set(a.schoolId, a);
  const studentsBySchool = new Map<string, number>(
    (studentCounts as any[]).map((g: any) => [g.schoolId, g._count?._all ?? 0] as [string, number]),
  );
  const usersBySchool = new Map<string, number>(
    (userCounts as any[]).map((g: any) => [g.schoolId, g._count?._all ?? 0] as [string, number]),
  );
  const search = typeof query.search === 'string' ? query.search.trim().toLowerCase() : '';
  let rows = (schools as any[]).map((s: any) => {
    const admin = adminBySchool.get(s.id);
    return {
      id: s.id,
      name: s.name,
      slug: s.slug,
      org_type: s.orgType ?? null,
      province: s.province ?? null,
      category: s.category ?? null,
      created_at: s.createdAt,
      admin_email: admin?.email ?? null,
      admin_name: admin?.name ?? null,
      email_verified: admin ? admin.emailVerified === true : false,
      students_count: studentsBySchool.get(s.id) ?? 0,
      users_count: usersBySchool.get(s.id) ?? 0,
      suspended: schoolSuspended(s),
      _admin: admin,
    };
  });
  if (search) {
    rows = rows.filter(
      (r: any) =>
        r.name.toLowerCase().includes(search) ||
        r.slug.toLowerCase().includes(search) ||
        (r.admin_email ?? '').toLowerCase().includes(search) ||
        (r.admin_name ?? '').toLowerCase().includes(search),
    );
  }
  if (query.verified === 'true') rows = rows.filter((r: any) => r.email_verified === true);
  if (query.verified === 'false') rows = rows.filter((r: any) => r.email_verified === false);
  const total = rows.length;
  const items = rows.slice(skip, skip + limit).map(({ _admin, ...rest }: any) => rest);
  return paginatedResponse(items, total, { page, limit, skip });
}

export async function getSchoolDetail(db: Db, id: string): Promise<Record<string, unknown>> {
  const school: any = await db.school.findUnique({ where: { id } });
  if (!school) throw ApiError.notFound('School not found');
  const [admin, students, users, classes] = await Promise.all([
    db.user.findFirst({ where: { schoolId: id, role: 'admin' }, orderBy: [{ createdAt: 'asc' }] }),
    db.student.count({ where: { schoolId: id } }),
    db.user.count({ where: { schoolId: id } }),
    db.class.count({ where: { schoolId: id } }),
  ]);
  return {
    id: school.id,
    name: school.name,
    slug: school.slug,
    org_type: school.orgType ?? null,
    province: school.province ?? null,
    category: school.category ?? null,
    address: school.address ?? null,
    tehsil: school.tehsil ?? null,
    district: school.district ?? null,
    timezone: school.timezone ?? null,
    created_at: school.createdAt,
    suspended: schoolSuspended(school),
    suspended_at: school.suspendedAt ?? null,
    suspended_reason: school.suspendedReason ?? null,
    admin_email: (admin as any)?.email ?? null,
    admin_name: (admin as any)?.name ?? null,
    admin_phone_masked: maskEncrypted((admin as any)?.phoneEnc),
    email_verified: (admin as any) ? (admin as any).emailVerified === true : false,
    verify_email_status: (admin as any)?.verifyEmailStatus ?? null,
    verify_email_error: (admin as any)?.verifyEmailError ?? null,
    students_count: students,
    users_count: users,
    classes_count: classes,
  };
}

export async function suspendSchool(
  db: Db,
  id: string,
  actorId: string,
  reason?: string,
): Promise<Record<string, unknown>> {
  const school: any = await db.school.findUnique({ where: { id } });
  if (!school) throw ApiError.notFound('School not found');
  const updated: any = await db.school.update({
    where: { id },
    data: { suspendedAt: new Date(), suspendedReason: reason?.trim() ? reason.trim() : null },
  });
  await auditBoth(db, actorId, 'platform.school_suspend', 'school', id, { reason: reason ?? null }, id);
  return { id: updated.id, suspended: true, suspended_at: updated.suspendedAt, suspended_reason: updated.suspendedReason ?? null };
}

export async function activateSchool(db: Db, id: string, actorId: string): Promise<Record<string, unknown>> {
  const school: any = await db.school.findUnique({ where: { id } });
  if (!school) throw ApiError.notFound('School not found');
  const updated: any = await db.school.update({ where: { id }, data: { suspendedAt: null, suspendedReason: null } });
  await auditBoth(db, actorId, 'platform.school_activate', 'school', id, {}, id);
  return { id: updated.id, suspended: false, suspended_at: null, suspended_reason: null };
}

// Tenant tables deleted explicitly, in dependency order, before the school
// row itself. FK audit (schema.prisma): every school-scoped FK is ON
// DELETE CASCADE — the only Restrict FKs are Student->Class and
// Promotion->Class, both inside the school — so this order also respects
// them (students/promotions go before classes). message_deliveries and
// attendance_records have no school_id; they are removed via their parents
// first. platform_audit_logs has no school FK and survives (the deletion
// itself must stay auditable).
const SCHOOL_DELETE_ORDER: Array<keyof Db> = [
  'feeVoucher',
  'courseMark',
  'result',
  'certificate',
  'parentMessageRead',
  'parentToken',
  'studentEnrollment',
  'admissionInquiry',
  'homework',
  'messageDraft',
  'messageQueue',
  'timetableEntry',
  'staffClassAssignment',
  'salaryRecord',
  'examDatesheet',
  'resultSheet',
  'gradingScale',
  'exam',
  'promotion',
  'feeRecord',
  'feeStructure',
  'teacherAttendance',
  'attendanceDay',
  'ocrUpload',
  'messageTemplate',
  'academicSession',
  'expense',
  'announcement',
  'event',
  'staff',
  'course',
  'semester',
  'program',
  'class',
  'student',
  'user',
  'rolePermission',
  'approvalRequest',
  'deletedRecord',
  'changeLog',
  'auditLog',
  'notification',
  'accountDeletionRequest',
  'schoolBackup',
  'smsDevice',
  'holiday',
];

export async function deleteSchool(
  db: Db,
  id: string,
  actorId: string,
  confirm: unknown,
): Promise<{ deleted: boolean; school_id: string; school_name: string }> {
  const school: any = await db.school.findUnique({ where: { id } });
  if (!school) throw ApiError.notFound('School not found');
  // Second confirmation: the body must carry the school's EXACT name.
  if (typeof confirm !== 'string' || confirm !== school.name) {
    throw ApiError.validation('Delete requires confirmation with the exact school name');
  }
  // NOTE: there is no pre-existing account-deletion execution to reuse —
  // POST /account/delete-request only RECORDS a request. This is the real
  // delete: one transaction removing the school's rows, then the school.
  await db.$transaction(async (tx) => {
    const queues: any[] = await tx.messageQueue.findMany({ where: { schoolId: id } });
    const days: any[] = await tx.attendanceDay.findMany({ where: { schoolId: id } });
    if (queues.length > 0) {
      await tx.messageDelivery.deleteMany({ where: { queueId: { in: queues.map((q: any) => q.id) } } });
    }
    if (days.length > 0) {
      await tx.attendanceRecord.deleteMany({ where: { attendanceDayId: { in: days.map((d: any) => d.id) } } });
    }
    for (const key of SCHOOL_DELETE_ORDER) {
      const delegate = (tx as any)[key];
      if (delegate && typeof delegate.deleteMany === 'function') {
        await delegate.deleteMany({ where: { schoolId: id } });
      }
    }
    await tx.school.delete({ where: { id } });
  });
  await writePlatformAudit(db, {
    actorId,
    action: 'platform.school_delete',
    entity: 'school',
    entityId: id,
    details: { school_name: school.name, slug: school.slug },
  });
  return { deleted: true, school_id: id, school_name: school.name };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function toPlatformUserView(u: any, schoolName: string | null): Record<string, unknown> {
  return {
    id: u.id,
    email: u.email,
    name: u.name ?? null,
    role: u.role,
    school_id: u.schoolId,
    school_name: schoolName,
    email_verified: u.emailVerified === true,
    totp_enabled: u.totpEnabled === true,
    disabled: !!u.disabledAt,
    last_login_at: u.lastLoginAt ?? null,
    last_login_ip: u.lastLoginIp ?? null,
    created_at: u.createdAt,
  };
}

export async function listPlatformUsers(
  db: Db,
  query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  const where: Record<string, unknown> = {};
  if (query.role) where.role = String(query.role);
  if (query.verified === 'true') where.emailVerified = true;
  if (query.verified === 'false') where.emailVerified = false;
  if (query.disabled === 'true') where.disabledAt = { not: null };
  if (query.disabled === 'false') where.disabledAt = null;
  const [users, schools] = await Promise.all([
    db.user.findMany({ where, orderBy: [{ createdAt: 'desc' }] }),
    db.school.findMany({}),
  ]);
  const nameBySchool = new Map<string, string>((schools as any[]).map((s: any) => [s.id, s.name] as [string, string]));
  const search = typeof query.search === 'string' ? query.search.trim().toLowerCase() : '';
  let rows = (users as any[]).map((u: any) => toPlatformUserView(u, nameBySchool.get(u.schoolId) ?? null));
  if (search) {
    rows = rows.filter(
      (r: any) =>
        r.email.toLowerCase().includes(search) ||
        (r.name ?? '').toLowerCase().includes(search) ||
        (r.school_name ?? '').toLowerCase().includes(search),
    );
  }
  const total = rows.length;
  return paginatedResponse(rows.slice(skip, skip + limit), total, { page, limit, skip });
}

export async function getPlatformUser(db: Db, id: string): Promise<Record<string, unknown>> {
  const user: any = await db.user.findUnique({ where: { id } });
  if (!user) throw ApiError.notFound('User not found');
  const school: any = await db.school.findUnique({ where: { id: user.schoolId } });
  return {
    ...toPlatformUserView(user, school?.name ?? null),
    verify_email_status: user.verifyEmailStatus ?? null,
    verify_email_error: user.verifyEmailError ?? null,
    token_version: user.tokenVersion ?? 0,
  };
}

/** The last ENABLED platform admin cannot be disabled or demoted — that
 * would lock the platform out of its own panel with no way back. */
async function assertNotLastPlatformAdmin(db: Db, target: any): Promise<void> {
  if (target.role !== 'platform_admin') return;
  const enabled = await db.user.count({ where: { role: 'platform_admin', disabledAt: null } });
  if (enabled <= 1) {
    throw ApiError.validation('Cannot disable or demote the last platform administrator');
  }
}

export async function disableUser(db: Db, id: string, actorId: string): Promise<Record<string, unknown>> {
  const user: any = await db.user.findUnique({ where: { id } });
  if (!user) throw ApiError.notFound('User not found');
  await assertNotLastPlatformAdmin(db, user);
  const updated: any = await db.user.update({ where: { id }, data: { disabledAt: new Date() } });
  await auditBoth(db, actorId, 'platform.user_disable', 'user', id, { email: user.email }, user.schoolId);
  return { id: updated.id, disabled: true };
}

export async function enableUser(db: Db, id: string, actorId: string): Promise<Record<string, unknown>> {
  const user: any = await db.user.findUnique({ where: { id } });
  if (!user) throw ApiError.notFound('User not found');
  const updated: any = await db.user.update({ where: { id }, data: { disabledAt: null } });
  await auditBoth(db, actorId, 'platform.user_enable', 'user', id, { email: user.email }, user.schoolId);
  return { id: updated.id, disabled: false };
}

export async function reverifyUser(
  db: Db,
  id: string,
  actorId: string,
): Promise<{ sent: boolean; message: string }> {
  const user: any = await db.user.findUnique({ where: { id } });
  if (!user) throw ApiError.notFound('User not found');
  await db.user.update({
    where: { id },
    data: { emailVerified: false, verifyEmailStatus: 'pending', verifyEmailError: null },
  });
  // Reuse the existing resend flow (fresh token + send); do not duplicate
  // mail code. Login blocks until the user verifies again.
  const result = await resendVerification(db, user.email);
  await auditBoth(db, actorId, 'platform.user_reverify', 'user', id, { email: user.email, sent: result.sent }, user.schoolId);
  return result;
}

export async function resetUserPassword(db: Db, id: string, actorId: string): Promise<{ dev_token?: string }> {
  const user: any = await db.user.findUnique({ where: { id } });
  if (!user) throw ApiError.notFound('User not found');
  // Reuse the existing forgot-password flow (sends the reset email).
  // NEVER set a password directly from the panel.
  const result = await forgotPassword(db, user.email);
  await auditBoth(db, actorId, 'platform.user_reset_password', 'user', id, { email: user.email }, user.schoolId);
  return result;
}

export async function promoteUser(
  db: Db,
  id: string,
  actorId: string,
  role: string,
): Promise<Record<string, unknown>> {
  if (role !== 'platform_admin') throw ApiError.validation("role must be 'platform_admin'");
  const user: any = await db.user.findUnique({ where: { id } });
  if (!user) throw ApiError.notFound('User not found');
  if (!user.totpEnabled) {
    throw ApiError.validation('Enable two-factor authentication first');
  }
  const updated: any = await db.user.update({ where: { id }, data: { role: 'platform_admin' } });
  await auditBoth(
    db,
    actorId,
    'platform.user_promote',
    'user',
    id,
    { email: user.email, from_role: user.role, to_role: 'platform_admin' },
    user.schoolId,
  );
  return { id: updated.id, role: updated.role };
}

export async function demoteUser(
  db: Db,
  id: string,
  actorId: string,
  role: string,
): Promise<Record<string, unknown>> {
  if (role !== 'admin') throw ApiError.validation("role must be 'admin'");
  const user: any = await db.user.findUnique({ where: { id } });
  if (!user) throw ApiError.notFound('User not found');
  if (user.role !== 'platform_admin') throw ApiError.validation('Only a platform admin can be demoted');
  await assertNotLastPlatformAdmin(db, user);
  const updated: any = await db.user.update({ where: { id }, data: { role: 'admin' } });
  await auditBoth(
    db,
    actorId,
    'platform.user_demote',
    'user',
    id,
    { email: user.email, from_role: 'platform_admin', to_role: 'admin' },
    user.schoolId,
  );
  return { id: updated.id, role: updated.role };
}

// ---------------------------------------------------------------------------
// School data browser (read-only) + CSV export
// ---------------------------------------------------------------------------

type EntityDef = {
  delegate: keyof Db;
  searchFields: string[];
  view: (row: any, ctx: { studentsById: Map<string, any> }) => Record<string, unknown>;
};

const SECRET_KEY = /(enc|hash|passwordhash|verifytokenhash|resettokenhash|totpsecretenc|tokenenc)$/i;

function stripSecrets(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (SECRET_KEY.test(k)) continue;
    out[k] = v;
  }
  return out;
}

const ENTITY_DEFS: Record<string, EntityDef> = {
  students: {
    delegate: 'student',
    searchFields: ['name', 'nameUr', 'parentName'],
    view: (r: any) => ({
      id: r.id,
      name: r.name,
      name_ur: r.nameUr ?? null,
      class_id: r.classId,
      roll_no: r.rollNo ?? null,
      status: r.status,
      parent_name: r.parentName ?? null,
      parent_phone_masked: maskEncrypted(r.parentPhoneEnc),
      parent2_phone_masked: maskEncrypted(r.parent2PhoneEnc),
      parent_email: r.parentEmail ?? null,
      admission_no: r.admissionNo ?? null,
      created_at: r.createdAt,
    }),
  },
  classes: {
    delegate: 'class',
    searchFields: ['name', 'section', 'teacherName'],
    view: (r: any) => ({
      id: r.id,
      name: r.name,
      section: r.section,
      teacher_name: r.teacherName,
      teacher_phone_masked: maskEncrypted(r.teacherPhoneEnc),
      created_at: r.createdAt,
    }),
  },
  fees: {
    delegate: 'feeRecord',
    searchFields: ['month'],
    view: (r: any, ctx: { studentsById: Map<string, any> }) => ({
      id: r.id,
      student_id: r.studentId,
      student_name: ctx.studentsById.get(r.studentId)?.name ?? null,
      month: r.month,
      amount_due: r.amountDue,
      amount_paid: r.amountPaid,
      discount: r.discount,
      status: r.status,
      paid_at: r.paidAt ?? null,
      created_at: r.createdAt,
    }),
  },
  messages: {
    delegate: 'messageQueue',
    searchFields: ['body', 'type'],
    view: (r: any) => ({
      id: r.id,
      type: r.type,
      student_id: r.studentId ?? null,
      class_id: r.classId ?? null,
      parent_phone_masked: maskEncrypted(r.parentPhoneEnc),
      body: r.body,
      status: r.status,
      attempts: r.attempts,
      scheduled_for: r.scheduledFor,
      sent_at: r.sentAt ?? null,
      error: r.error ?? null,
      created_at: r.createdAt,
    }),
  },
  admissions: {
    delegate: 'admissionInquiry',
    searchFields: ['studentName', 'parentName', 'className'],
    view: (r: any) => ({
      id: r.id,
      student_name: r.studentName,
      class_name: r.className,
      parent_name: r.parentName,
      parent_phone_masked: maskEncrypted(r.parentPhoneEnc),
      parent_email: r.parentEmail ?? null,
      status: r.status,
      created_at: r.createdAt,
    }),
  },
  homework: {
    delegate: 'homework',
    searchFields: ['subject', 'title', 'teacher'],
    view: (r: any) => ({
      id: r.id,
      class_id: r.classId,
      subject: r.subject,
      title: r.title,
      due_date: r.dueDate,
      teacher: r.teacher,
      created_at: r.createdAt,
    }),
  },
  programs: {
    delegate: 'program',
    searchFields: ['name', 'code', 'department'],
    view: (r: any) => ({
      id: r.id,
      name: r.name,
      code: r.code,
      department: r.department,
      duration_years: r.durationYears,
      created_at: r.createdAt,
    }),
  },
};

export const SCHOOL_DATA_ENTITIES = Object.keys(ENTITY_DEFS);

async function fetchSchoolEntityRows(
  db: Db,
  schoolId: string,
  entity: string,
  query: Record<string, any>,
): Promise<any[]> {
  const def = ENTITY_DEFS[entity];
  if (!def) throw ApiError.validation(`Unknown entity: ${entity}`);
  const school: any = await db.school.findUnique({ where: { id: schoolId } });
  if (!school) throw ApiError.notFound('School not found');
  const delegate = (db as any)[def.delegate];
  const rows: any[] = await delegate.findMany({ where: { schoolId }, orderBy: [{ createdAt: 'desc' }] });
  const search = typeof query.search === 'string' ? query.search.trim().toLowerCase() : '';
  if (!search) return rows;
  return rows.filter((r: any) =>
    def.searchFields.some((f) => typeof r[f] === 'string' && r[f].toLowerCase().includes(search)),
  );
}

export async function listSchoolEntityData(
  db: Db,
  schoolId: string,
  entity: string,
  query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  const def = ENTITY_DEFS[entity];
  if (!def) throw ApiError.validation(`Unknown entity: ${entity}`);
  const rows = await fetchSchoolEntityRows(db, schoolId, entity, query);
  const studentsById = new Map<string, any>();
  if (entity === 'fees') {
    const students: any[] = await db.student.findMany({ where: { schoolId } });
    for (const s of students) studentsById.set(s.id, s);
  }
  const views = rows.map((r: any) => def.view(r, { studentsById }));
  return paginatedResponse(views.slice(skip, skip + limit), views.length, { page, limit, skip });
}

function toCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportSchoolEntityCsv(
  db: Db,
  schoolId: string,
  entity: string,
  query: Record<string, any>,
  actorId: string,
): Promise<{ filename: string; csv: string }> {
  const def = ENTITY_DEFS[entity];
  if (!def) throw ApiError.validation(`Unknown entity: ${entity}`);
  const rows = await fetchSchoolEntityRows(db, schoolId, entity, query);
  const studentsById = new Map<string, any>();
  if (entity === 'fees') {
    const students: any[] = await db.student.findMany({ where: { schoolId } });
    for (const s of students) studentsById.set(s.id, s);
  }
  // Views already mask phones and drop encrypted/hash/secret fields; the
  // extra stripSecrets pass is defense in depth (a view must never leak a
  // passwordHash, token hash or TOTP secret into a download).
  const views = rows.slice(0, 5000).map((r: any) => stripSecrets(def.view(r, { studentsById })));
  const columns = views.length > 0 ? Object.keys(views[0]) : [];
  const lines = [columns.join(',')];
  for (const v of views) lines.push(columns.map((c) => toCsvCell(v[c])).join(','));
  const school: any = await db.school.findUnique({ where: { id: schoolId } });
  await writePlatformAudit(db, {
    actorId,
    action: 'platform.school_data_export_csv',
    entity: 'school',
    entityId: schoolId,
    details: { data_entity: entity, rows: views.length },
  });
  return { filename: `${school?.slug ?? schoolId}-${entity}.csv`, csv: lines.join('\n') };
}

export async function exportSchoolFull(db: Db, schoolId: string, actorId: string): Promise<Record<string, unknown>> {
  const school: any = await db.school.findUnique({ where: { id: schoolId } });
  if (!school) throw ApiError.notFound('School not found');
  const data = await exportSchoolData(db, schoolId, actorId);
  await writePlatformAudit(db, {
    actorId,
    action: 'platform.school_export',
    entity: 'school',
    entityId: schoolId,
    details: { school_name: school.name },
  });
  return data;
}

// ---------------------------------------------------------------------------
// Recycle bin (cross-school)
// ---------------------------------------------------------------------------

export async function listPlatformRecycleBin(
  db: Db,
  query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  const where: Record<string, unknown> = { permanentlyDeletedAt: null };
  if (query.school_id) where.schoolId = String(query.school_id);
  if (query.entity) where.entity = String(query.entity);
  const [items, total] = await Promise.all([
    (db as any).deletedRecord.findMany({ where, orderBy: [{ deletedAt: 'desc' }], skip, take: limit }),
    (db as any).deletedRecord.count({ where }),
  ]);
  return paginatedResponse((items as any[]).map(toPublicDeletedRecord), total, { page, limit, skip });
}

export async function restorePlatformRecycleBinRecord(
  db: Db,
  id: string,
  actorId: string,
): Promise<Record<string, unknown>> {
  const record: any = await (db as any).deletedRecord.findFirst({ where: { id } });
  if (!record) throw ApiError.notFound('Recycle bin record not found');
  const result = await restoreDeletedRecord(db, record.schoolId, id, actorId);
  await writePlatformAudit(db, {
    actorId,
    action: 'platform.recycle_bin_restore',
    entity: record.entity,
    entityId: record.entityId,
    details: { deleted_record_id: id, school_id: record.schoolId },
  });
  return result as Record<string, unknown>;
}

export async function permanentDeletePlatformRecycleBinRecord(
  db: Db,
  id: string,
  actorId: string,
  confirm: unknown,
): Promise<Record<string, unknown>> {
  const record: any = await (db as any).deletedRecord.findFirst({ where: { id } });
  if (!record) throw ApiError.notFound('Recycle bin record not found');
  // Platform confirm is the string "<entity>:<entityId>"; the underlying
  // helper takes the boolean second confirmation, so validate the string
  // here and pass true through.
  const expected = `${record.entity}:${record.entityId}`;
  if (typeof confirm !== 'string' || confirm !== expected) {
    throw ApiError.validation(`Permanent delete requires confirmation "${expected}"`);
  }
  const result = await permanentDeleteRecord(db, record.schoolId, id, true, actorId);
  await writePlatformAudit(db, {
    actorId,
    action: 'platform.recycle_bin_permanent_delete',
    entity: record.entity,
    entityId: record.entityId,
    details: { deleted_record_id: id, school_id: record.schoolId },
  });
  return result as unknown as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Merged audit logs
// ---------------------------------------------------------------------------

export async function listMergedAuditLogs(
  db: Db,
  query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  const from = query.from ? new Date(String(query.from)) : null;
  const to = query.to ? new Date(String(query.to)) : null;
  const fromOk = from && !Number.isNaN(from.getTime()) ? from : null;
  const toOk = to && !Number.isNaN(to.getTime()) ? to : null;
  const schoolWhere: Record<string, unknown> = {};
  if (query.school_id) schoolWhere.schoolId = String(query.school_id);
  if (query.action) schoolWhere.action = String(query.action);
  if (query.user_id) schoolWhere.actorId = String(query.user_id);
  if (fromOk || toOk) {
    schoolWhere.createdAt = {
      ...(fromOk ? { gte: fromOk } : {}),
      ...(toOk ? { lte: toOk } : {}),
    };
  }
  const platformWhere: Record<string, unknown> = {};
  if (query.action) platformWhere.action = String(query.action);
  if (query.user_id) platformWhere.actorId = String(query.user_id);
  if (fromOk || toOk) {
    platformWhere.createdAt = {
      ...(fromOk ? { gte: fromOk } : {}),
      ...(toOk ? { lte: toOk } : {}),
    };
  }
  // Platform rows carry no school_id: when a school filter is set, only
  // platform rows about that school (entity 'school', entity_id = the
  // school) belong in the merged view.
  const [schoolRows, platformRows] = await Promise.all([
    db.auditLog.findMany({ where: schoolWhere, orderBy: [{ createdAt: 'desc' }], take: 500 }),
    (db as any).platformAuditLog.findMany({ where: platformWhere, orderBy: [{ createdAt: 'desc' }], take: 500 }),
  ]);
  const items: any[] = [];
  for (const l of schoolRows as any[]) {
    items.push({
      id: l.id,
      source: 'school',
      school_id: l.schoolId ?? null,
      actor_id: l.actorId ?? null,
      actor_type: l.actorType,
      action: l.action,
      entity: l.entity,
      entity_id: l.entityId ?? null,
      details: l.details ?? {},
      created_at: l.createdAt ? new Date(l.createdAt).toISOString() : new Date().toISOString(),
    });
  }
  for (const l of platformRows as any[]) {
    if (query.school_id && !(l.entity === 'school' && l.entityId === String(query.school_id))) continue;
    items.push({
      id: l.id,
      source: 'platform',
      school_id: l.entity === 'school' ? (l.entityId ?? null) : null,
      actor_id: l.actorId ?? null,
      actor_type: 'platform_admin',
      action: l.action,
      entity: l.entity,
      entity_id: l.entityId ?? null,
      details: l.details ?? {},
      created_at: l.createdAt ? new Date(l.createdAt).toISOString() : new Date().toISOString(),
    });
  }
  items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const total = items.length;
  return paginatedResponse(items.slice(skip, skip + limit), total, { page, limit, skip });
}

// ---------------------------------------------------------------------------
// Messaging queue (cross-school)
// ---------------------------------------------------------------------------

export async function listMessagingQueue(
  db: Db,
  query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  const where: Record<string, unknown> = {};
  if (query.status) where.status = String(query.status);
  if (query.school_id) where.schoolId = String(query.school_id);
  const [rows, total, schools] = await Promise.all([
    db.messageQueue.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip, take: limit }),
    db.messageQueue.count({ where }),
    db.school.findMany({}),
  ]);
  const nameBySchool = new Map<string, string>((schools as any[]).map((s: any) => [s.id, s.name] as [string, string]));
  const items = (rows as any[]).map((r: any) => ({
    id: r.id,
    school_id: r.schoolId,
    school_name: nameBySchool.get(r.schoolId) ?? null,
    type: r.type,
    student_id: r.studentId ?? null,
    class_id: r.classId ?? null,
    parent_phone_masked: maskEncrypted(r.parentPhoneEnc),
    body: r.body,
    status: r.status,
    attempts: r.attempts,
    scheduled_for: r.scheduledFor,
    sent_at: r.sentAt ?? null,
    error: r.error ?? null,
    created_at: r.createdAt,
  }));
  return paginatedResponse(items, total, { page, limit, skip });
}

export async function listFailedMessages(
  db: Db,
  query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  return listMessagingQueue(db, { ...query, status: 'failed' });
}

export async function retryQueueMessage(
  db: Db,
  id: string,
  actorId: string,
): Promise<Record<string, unknown>> {
  const row: any = await db.messageQueue.findFirst({ where: { id } });
  if (!row) throw ApiError.notFound('Message not found');
  if (row.status !== 'failed') throw ApiError.validation('Only failed messages can be retried');
  // NOTE: the school-side retryFailed() helper (messaging/service.ts)
  // preserves `attempts` and needs a store-based ServiceDeps; the panel
  // contract requires attempts reset to 0, so the panel resets it directly
  // here and writes both audit rows (school + platform).
  const updated: any = await db.messageQueue.update({
    where: { id },
    data: { status: 'queued', attempts: 0, error: null, scheduledFor: new Date() },
  });
  await auditBoth(db, actorId, 'message.retry', 'message_queue', id, { dedupeKey: row.dedupeKey }, row.schoolId);
  return {
    id: updated.id,
    school_id: updated.schoolId,
    status: updated.status,
    attempts: updated.attempts,
    scheduled_for: updated.scheduledFor,
  };
}

// ---------------------------------------------------------------------------
// Mail health
// ---------------------------------------------------------------------------

export const MAIL_HEALTH_NOTE =
  'Gmail SMTP is currently timing out from Render on both ports — verification mail cannot leave the server until a transactional-mail provider is wired in.';

export async function getMailHealth(db: Db): Promise<Record<string, unknown>> {
  const [sent, failed, pending] = await Promise.all([
    db.user.count({ where: { verifyEmailStatus: 'sent' } }),
    db.user.count({ where: { verifyEmailStatus: 'failed' } }),
    db.user.count({ where: { verifyEmailStatus: 'pending' } }),
  ]);
  const failures: any[] = await db.user.findMany({
    where: { verifyEmailStatus: 'failed' },
    orderBy: [{ updatedAt: 'desc' }],
    take: 10,
  });
  return {
    transport: 'smtp',
    recent_verification_mail: { sent, failed, pending },
    recent_failures: failures.map((u: any) => ({
      email: u.email,
      error: u.verifyEmailError ?? null,
      at: u.updatedAt ? new Date(u.updatedAt).toISOString() : null,
    })),
    note: MAIL_HEALTH_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Security: logins / platform admins / sessions
// ---------------------------------------------------------------------------

export async function listRecentLogins(db: Db, days: number): Promise<Record<string, unknown>> {
  const since = new Date(Date.now() - Math.max(1, days) * 24 * 60 * 60 * 1000);
  const users: any[] = await db.user.findMany({ where: { lastLoginAt: { gte: since } }, orderBy: [{ lastLoginAt: 'desc' }] });
  const schools: any[] = await db.school.findMany({});
  const nameBySchool = new Map<string, string>(schools.map((s: any) => [s.id, s.name] as [string, string]));
  return {
    // Honest note: this is last-login info, NOT a live session list —
    // auth is stateless JWTs, so there is no live session to list.
    note: 'Last-login information only — not a live session list (stateless JWTs).',
    items: users.map((u: any) => ({
      user_id: u.id,
      email: u.email,
      school_name: nameBySchool.get(u.schoolId) ?? null,
      last_login_at: u.lastLoginAt,
      last_login_ip: u.lastLoginIp ?? null,
    })),
  };
}

export async function listPlatformAdmins(db: Db): Promise<Record<string, unknown>> {
  const users: any[] = await db.user.findMany({ where: { role: 'platform_admin' }, orderBy: [{ createdAt: 'asc' }] });
  return {
    items: users.map((u: any) => ({
      id: u.id,
      email: u.email,
      totp_enabled: u.totpEnabled === true,
      disabled: !!u.disabledAt,
      last_login_at: u.lastLoginAt ?? null,
    })),
  };
}

export async function listSessions(db: Db): Promise<Record<string, unknown>> {
  const users: any[] = await db.user.findMany({ orderBy: [{ lastLoginAt: 'desc' }], take: 50 });
  return {
    // Revocation takes effect at the next refresh; access tokens expire
    // within 15 minutes. There is no server-side session store.
    note: 'Revocation takes effect at next refresh; access tokens expire within 15 minutes.',
    items: users.map((u: any) => ({
      id: u.id,
      email: u.email,
      role: u.role,
      last_login_at: u.lastLoginAt ?? null,
      last_login_ip: u.lastLoginIp ?? null,
      token_version: u.tokenVersion ?? 0,
    })),
  };
}

export async function revokeUserSessions(db: Db, id: string, actorId: string): Promise<Record<string, unknown>> {
  const user: any = await db.user.findUnique({ where: { id } });
  if (!user) throw ApiError.notFound('User not found');
  const updated: any = await db.user.update({
    where: { id },
    data: { tokenVersion: (user.tokenVersion ?? 0) + 1 },
  });
  await auditBoth(db, actorId, 'platform.user_revoke_sessions', 'user', id, { email: user.email }, user.schoolId);
  return { id: updated.id, token_version: updated.tokenVersion };
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export async function getBackups(db: Db): Promise<Record<string, unknown>> {
  const rows: any[] = await (db as any).schoolBackup.findMany({ orderBy: [{ createdAt: 'desc' }] });
  const schools: any[] = await db.school.findMany({});
  const nameBySchool = new Map<string, string>(schools.map((s: any) => [s.id, s.name] as [string, string]));
  const perSchool = new Map<string, { school_id: string; school_name: string | null; latest_at: string; total: number }>();
  for (const r of rows) {
    const entry = perSchool.get(r.schoolId);
    const at = r.createdAt ? new Date(r.createdAt).toISOString() : '';
    if (!entry) {
      perSchool.set(r.schoolId, { school_id: r.schoolId, school_name: nameBySchool.get(r.schoolId) ?? null, latest_at: at, total: 1 });
    } else {
      entry.total += 1;
      if (at > entry.latest_at) entry.latest_at = at;
    }
  }
  const latest = rows[0] ?? null;
  return {
    // If no rows exist, latest is null and the UI must say so honestly —
    // no backup has ever run. This endpoint does NOT build a backup system.
    latest: latest
      ? {
          file_ref: latest.fileRef,
          size_bytes: latest.sizeBytes ?? null,
          created_at: latest.createdAt ? new Date(latest.createdAt).toISOString() : null,
          school_name: nameBySchool.get(latest.schoolId) ?? null,
        }
      : null,
    per_school: [...perSchool.values()].sort((a, b) => b.latest_at.localeCompare(a.latest_at)),
    total: rows.length,
  };
}
