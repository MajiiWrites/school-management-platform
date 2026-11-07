import { config } from '../../config';
import { ApiError } from '../../lib/errors';
import { normalizePhone, encryptPhone, decryptPhone, encryptToken, decryptToken, sha256Hex, maskPhone, randomToken, hashToken } from '../../lib/crypto';
import { todayInTz, dateOnly } from '../../lib/dates';
import { writeAudit } from '../../lib/audit';
import { writeChangeLogs, logCreate, softDeleteEntity, isUniqueViolation } from '../hardening/helpers';
import type { Db } from '../../lib/db';

export interface ClassInput {
  name: string;
  section: string;
  teacher_name: string;
  teacher_phone?: string | null;
}

/** Today's attendance state for one class (school-local date). */
export interface TodayStatus {
  date: string;
  submitted: boolean;
  absent: number;
  present: number;
  unlocked: boolean;
}

export function toPublicClass(c: any, studentCount?: number, today?: TodayStatus | null): Record<string, unknown> {
  // Fix C (Phase 9): reconstruct the existing link from the encrypted token
  // so the Classes page still shows it after a reload. Rows whose link was
  // created before the attendance_token_enc column existed have no stored
  // token — the link is null while attendance_link_active stays true, and
  // the UI shows the legacy-active state (Regenerate to get a copyable link).
  let attendanceLink: string | null = null;
  if (c.attendanceTokenEnc) {
    try {
      attendanceLink = `${config.frontendUrl}/t/${decryptToken(c.attendanceTokenEnc)}`;
    } catch {
      attendanceLink = null; // corrupt ciphertext must never break the list
    }
  }
  return {
    id: c.id,
    school_id: c.schoolId,
    name: c.name,
    section: c.section,
    display_name: `${c.name}-${c.section}`,
    teacher_name: c.teacherName,
    teacher_phone_masked: c.teacherPhoneEnc ? maskPhone(decryptPhone(c.teacherPhoneEnc)) : null,
    attendance_link: attendanceLink,
    attendance_link_active: Boolean(c.attendanceTokenHash) && !c.tokenRevoked,
    token_expires_at: c.tokenExpiresAt ?? null,
    student_count: studentCount ?? undefined,
    // Fix C (Phase 9): today's submission state used to be absent from this
    // payload entirely, so the card always showed "Pending today" on reload.
    submitted_today: today?.submitted ?? false,
    absent_today: today?.absent ?? 0,
    present_today: today?.present ?? 0,
    attendance_date: today?.date ?? null,
    attendance_unlocked: today?.unlocked ?? false,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

/** Today's attendance-day state per class, keyed by class id. */
async function getTodayStatuses(db: Db, schoolId: string): Promise<{ date: string; byClass: Map<string, TodayStatus> }> {
  const school = await db.school.findUnique({ where: { id: schoolId } });
  const date = todayInTz(school?.timezone ?? 'Asia/Karachi');
  const days = await db.attendanceDay.findMany({ where: { schoolId: schoolId, date: dateOnly(date) } });
  const byClass = new Map<string, TodayStatus>();
  const dayIds: string[] = days.map((d: any) => d.id);
  const countsByDay = new Map<string, { absent: number; present: number }>();
  if (dayIds.length > 0) {
    const grouped = await db.attendanceRecord.groupBy({
      by: ['attendanceDayId', 'status'],
      where: { attendanceDayId: { in: dayIds } },
      _count: { _all: true },
    });
    for (const g of grouped as any[]) {
      const entry = countsByDay.get(g.attendanceDayId) ?? { absent: 0, present: 0 };
      if (g.status === 'absent') entry.absent = g._count._all;
      if (g.status === 'present') entry.present = g._count._all;
      countsByDay.set(g.attendanceDayId, entry);
    }
  }
  for (const d of days as any[]) {
    const counts = countsByDay.get(d.id) ?? { absent: 0, present: 0 };
    byClass.set(d.classId, { date, submitted: true, absent: counts.absent, present: counts.present, unlocked: Boolean(d.unlocked) });
  }
  return { date, byClass };
}

async function assertUniqueName(db: Db, schoolId: string, name: string, section: string, excludeId?: string): Promise<void> {
  const existing = await db.class.findFirst({ where: { schoolId: schoolId, name, section, deletedAt: null } });
  if (existing && existing.id !== excludeId) {
    throw ApiError.conflict(`Class ${name}-${section} already exists`);
  }
}

/**
 * D1: the DB unique index (schoolId, name, section) does NOT exclude
 * soft-deleted rows, while assertUniqueName does — so re-creating a class
 * with the same name as a deleted one reached the DB and surfaced as a
 * bare P2002 ("A record with these values already exists"). The app-layer
 * check passes, the DB refuses. Point the admin at the Recycle Bin
 * instead: the deleted class can be restored, or permanently deleted
 * there first, and then the name is free again.
 */
async function throwClassUniqueConflict(db: Db, schoolId: string, name: string, section: string): Promise<never> {
  const deleted = await db.class.findFirst({ where: { schoolId: schoolId, name, section, deletedAt: { not: null } } });
  if (deleted) {
    throw ApiError.conflict(
      `Class ${name}-${section} was deleted. Restore it from the Recycle Bin, or permanently delete it there first, then create it again.`,
    );
  }
  throw ApiError.conflict(`Class ${name}-${section} already exists`);
}

/** Display-safe view of a class row for change_logs (teacher phone masked). */
function changeView(c: any): Record<string, unknown> {
  return {
    name: c.name,
    section: c.section,
    teacher_name: c.teacherName,
    teacher_phone: c.teacherPhoneEnc ? maskPhone(decryptPhone(c.teacherPhoneEnc)) : null,
  };
}

function teacherPhoneFields(phone: string | null | undefined): { enc: string | null; hash: string | null } {
  if (!phone) return { enc: null, hash: null };
  const normalized = normalizePhone(phone);
  if (!normalized) throw ApiError.validation('Teacher phone is not a valid Pakistani mobile number');
  return { enc: encryptPhone(normalized), hash: sha256Hex(normalized) };
}

export async function createClass(db: Db, schoolId: string, input: ClassInput, actorId?: string): Promise<any> {
  await assertUniqueName(db, schoolId, input.name.trim(), input.section.trim());
  const phone = teacherPhoneFields(input.teacher_phone);
  let created: any;
  try {
    created = await db.class.create({
      data: {
        schoolId: schoolId,
        name: input.name.trim(),
        section: input.section.trim(),
        teacherName: input.teacher_name.trim(),
        teacherPhoneEnc: phone.enc,
        teacherPhoneHash: phone.hash,
      },
    });
  } catch (err) {
    if (isUniqueViolation(err)) await throwClassUniqueConflict(db, schoolId, input.name.trim(), input.section.trim());
    throw err;
  }
  await logCreate(db, {
    schoolId,
    actorId: actorId ?? null,
    entity: 'class',
    entityId: created.id,
    after: { name: created.name, section: created.section, teacher_name: created.teacherName },
  });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'class.create', entity: 'class', entityId: created.id, details: { name: created.name, section: created.section } });
  return created;
}

export async function listClasses(db: Db, schoolId: string): Promise<Record<string, unknown>[]> {
  const classes = await db.class.findMany({ where: { schoolId: schoolId, deletedAt: null }, orderBy: [{ name: 'asc' }, { section: 'asc' }] });
  const counts = await db.student.groupBy({ by: ['classId'], where: { schoolId: schoolId, deletedAt: null }, _count: { _all: true } });
  const countByClass = new Map<string, number>(counts.map((c: any) => [c.classId, c._count._all]));
  const today = await getTodayStatuses(db, schoolId);
  const fallback = (id: string): TodayStatus => today.byClass.get(id) ?? { date: today.date, submitted: false, absent: 0, present: 0, unlocked: false };
  return classes.map((c: any) => toPublicClass(c, countByClass.get(c.id) ?? 0, fallback(c.id)));
}

export async function getClass(db: Db, schoolId: string, id: string): Promise<any> {
  const c = await db.class.findFirst({ where: { id, schoolId: schoolId, deletedAt: null } });
  if (!c) throw ApiError.notFound('Class not found');
  const count = await db.student.count({ where: { classId: id, schoolId: schoolId, deletedAt: null } });
  const today = await getTodayStatuses(db, schoolId);
  return toPublicClass(c, count, today.byClass.get(id) ?? { date: today.date, submitted: false, absent: 0, present: 0, unlocked: false });
}

export async function updateClass(db: Db, schoolId: string, id: string, patch: Partial<ClassInput>, actorId?: string): Promise<any> {
  const existing = await db.class.findFirst({ where: { id, schoolId: schoolId, deletedAt: null } });
  if (!existing) throw ApiError.notFound('Class not found');
  const name = patch.name !== undefined ? patch.name.trim() : existing.name;
  const section = patch.section !== undefined ? patch.section.trim() : existing.section;
  await assertUniqueName(db, schoolId, name, section, id);
  const data: Record<string, unknown> = { name, section };
  if (patch.teacher_name !== undefined) data.teacherName = patch.teacher_name.trim();
  if (patch.teacher_phone !== undefined) {
    const phone = teacherPhoneFields(patch.teacher_phone);
    data.teacherPhoneEnc = phone.enc;
    data.teacherPhoneHash = phone.hash;
  }
  // Snapshot the before-view BEFORE the update (see students/service.ts).
  const beforeView = changeView(existing);
  let updated: any;
  try {
    updated = await db.class.update({ where: { id }, data });
  } catch (err) {
    if (isUniqueViolation(err)) await throwClassUniqueConflict(db, schoolId, name, section);
    throw err;
  }
  await writeChangeLogs(db, {
    schoolId,
    actorId: actorId ?? null,
    entity: 'class',
    entityId: id,
    before: beforeView,
    after: changeView(updated),
  });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'class.update', entity: 'class', entityId: id, details: { name, section } });
  return updated;
}

/** Soft delete (6A): sets deleted_at + recycle-bin snapshot. Blocked while students exist. */
export async function deleteClass(db: Db, schoolId: string, id: string, actorId?: string): Promise<void> {
  const existing = await db.class.findFirst({ where: { id, schoolId: schoolId, deletedAt: null } });
  if (!existing) throw ApiError.notFound('Class not found');
  const students = await db.student.count({ where: { classId: id, schoolId: schoolId, deletedAt: null } });
  if (students > 0) throw ApiError.conflict('Cannot delete a class that has students. Move or remove the students first.');
  await softDeleteEntity(db, { schoolId, entity: 'class', entityId: id, deletedBy: actorId ?? null });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'class.delete', entity: 'class', entityId: id, details: { name: existing.name, section: existing.section, soft_deleted: true } });
}

/** Generate a fresh tokenized attendance link. Only the hash is stored; the raw token is returned once. */
export async function regenerateLink(
  db: Db,
  schoolId: string,
  id: string,
  actorId: string,
): Promise<{ link: string; token: string; expires_at: Date }> {
  const existing = await db.class.findFirst({ where: { id, schoolId: schoolId, deletedAt: null } });
  if (!existing) throw ApiError.notFound('Class not found');
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + config.attendanceLinkTtlDays * 24 * 60 * 60 * 1000);
  await db.class.update({
    where: { id },
    data: { attendanceTokenHash: hashToken(token), attendanceTokenEnc: encryptToken(token), tokenExpiresAt: expiresAt, tokenRevoked: false },
  });
  await writeChangeLogs(db, {
    schoolId,
    actorId,
    entity: 'class',
    entityId: id,
    before: {},
    after: { attendance_link: 'regenerated' },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'class.link_regenerate', entity: 'class', entityId: id });
  return { link: `${config.frontendUrl}/t/${token}`, token, expires_at: expiresAt };
}

export async function revokeLink(db: Db, schoolId: string, id: string, actorId: string): Promise<void> {
  const existing = await db.class.findFirst({ where: { id, schoolId: schoolId, deletedAt: null } });
  if (!existing) throw ApiError.notFound('Class not found');
  await db.class.update({ where: { id }, data: { tokenRevoked: true, attendanceTokenEnc: null } });
  await writeChangeLogs(db, {
    schoolId,
    actorId,
    entity: 'class',
    entityId: id,
    before: {},
    after: { token_revoked: true },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'class.link_revoke', entity: 'class', entityId: id });
}

/**
 * Resolve a raw attendance token to its class (public link flow). Returns null when invalid/revoked/expired.
 * The token hash is the bearer credential for the PUBLIC /t/:token flow
 * (no JWT exists there), so the lookup is by hash alone by design.
 * `expectedSchoolId` is an optional defence: when a caller DOES have a
 * school context (e.g. a staff JWT), a token belonging to another school
 * resolves to null instead of leaking that school's class/students.
 */
export async function resolveLinkToken(db: Db, token: string, expectedSchoolId?: string): Promise<any | null> {
  const hash = hashToken(token);
  const c = await db.class.findFirst({ where: { attendanceTokenHash: hash, deletedAt: null } });
  if (!c || c.tokenRevoked) return null;
  if (c.tokenExpiresAt && new Date(c.tokenExpiresAt) < new Date()) return null;
  if (expectedSchoolId && c.schoolId !== expectedSchoolId) return null;
  return c;
}
