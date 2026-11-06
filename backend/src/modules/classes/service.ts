import { config } from '../../config';
import { ApiError } from '../../lib/errors';
import { normalizePhone, encryptPhone, decryptPhone, sha256Hex, maskPhone, randomToken, hashToken } from '../../lib/crypto';
import { writeAudit } from '../../lib/audit';
import { writeChangeLogs, softDeleteEntity } from '../hardening/helpers';
import type { Db } from '../../lib/db';

export interface ClassInput {
  name: string;
  section: string;
  teacher_name: string;
  teacher_phone?: string | null;
}

export function toPublicClass(c: any, studentCount?: number): Record<string, unknown> {
  return {
    id: c.id,
    school_id: c.schoolId,
    name: c.name,
    section: c.section,
    display_name: `${c.name}-${c.section}`,
    teacher_name: c.teacherName,
    teacher_phone_masked: c.teacherPhoneEnc ? maskPhone(decryptPhone(c.teacherPhoneEnc)) : null,
    attendance_link_active: Boolean(c.attendanceTokenHash) && !c.tokenRevoked,
    token_expires_at: c.tokenExpiresAt ?? null,
    student_count: studentCount ?? undefined,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
  };
}

async function assertUniqueName(db: Db, schoolId: string, name: string, section: string, excludeId?: string): Promise<void> {
  const existing = await db.class.findFirst({ where: { schoolId: schoolId, name, section, deletedAt: null } });
  if (existing && existing.id !== excludeId) {
    throw ApiError.conflict(`Class ${name}-${section} already exists`);
  }
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
  const created = await db.class.create({
    data: {
      schoolId: schoolId,
      name: input.name.trim(),
      section: input.section.trim(),
      teacherName: input.teacher_name.trim(),
      teacherPhoneEnc: phone.enc,
      teacherPhoneHash: phone.hash,
    },
  });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'class.create', entity: 'class', entityId: created.id, details: { name: created.name, section: created.section } });
  return created;
}

export async function listClasses(db: Db, schoolId: string): Promise<Record<string, unknown>[]> {
  const classes = await db.class.findMany({ where: { schoolId: schoolId, deletedAt: null }, orderBy: [{ name: 'asc' }, { section: 'asc' }] });
  const counts = await db.student.groupBy({ by: ['classId'], where: { schoolId: schoolId, deletedAt: null }, _count: { _all: true } });
  const countByClass = new Map<string, number>(counts.map((c: any) => [c.classId, c._count._all]));
  return classes.map((c: any) => toPublicClass(c, countByClass.get(c.id) ?? 0));
}

export async function getClass(db: Db, schoolId: string, id: string): Promise<any> {
  const c = await db.class.findFirst({ where: { id, schoolId: schoolId, deletedAt: null } });
  if (!c) throw ApiError.notFound('Class not found');
  const count = await db.student.count({ where: { classId: id, schoolId: schoolId, deletedAt: null } });
  return toPublicClass(c, count);
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
  const updated = await db.class.update({ where: { id }, data });
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
    data: { attendanceTokenHash: hashToken(token), tokenExpiresAt: expiresAt, tokenRevoked: false },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'class.link_regenerate', entity: 'class', entityId: id });
  return { link: `${config.frontendUrl}/t/${token}`, token, expires_at: expiresAt };
}

export async function revokeLink(db: Db, schoolId: string, id: string, actorId: string): Promise<void> {
  const existing = await db.class.findFirst({ where: { id, schoolId: schoolId, deletedAt: null } });
  if (!existing) throw ApiError.notFound('Class not found');
  await db.class.update({ where: { id }, data: { tokenRevoked: true } });
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
