// Sessions (6C-1) — academic-year CRUD, set-current, class-section
// promotion (reuses admin.promoteStudents — never duplicated), archive.
//
// ARCHIVE DESIGN (schema constraint): academic_sessions has NO is_archived
// / deleted_at column and the task forbids schema/migration changes, so the
// archived flag lives in the school's settings JSONB under
// `archived_session_ids` (an array of session ids). getSettings() merges
// unknown keys through unchanged, so the Settings page is unaffected.
// A future migration should add a real `is_archived` column and move this
// list there — see FEATURES-6C1.md. Archived sessions are read-only:
// make-current / update / promote / exam-create on them all 409.
// Exams linked to an archived session are excluded from the default exam
// list (see exams/service.ts); students/fees/attendance carry no session
// column, so for them "excluded from current lists" means: promotion and
// new exam creation refuse the archived session, while reports can still
// query it explicitly by session_id.
import { ApiError } from '../../lib/errors';
import { isValidDateString, dateOnly } from '../../lib/dates';
import { writeAudit } from '../../lib/audit';
import { writeChangeLogs, logCreate, logDelete } from '../hardening/helpers';
import { paginatedResponse, parsePagination } from '../../lib/pagination';
import type { Db } from '../../lib/db';
import { promoteStudents } from '../admin/service';

export const ARCHIVED_SESSION_IDS_KEY = 'archived_session_ids';

export async function getArchivedSessionIds(db: Db, schoolId: string): Promise<string[]> {
  const school = await db.school.findUnique({ where: { id: schoolId } });
  if (!school) return [];
  const ids = (school.settings as Record<string, unknown> | null)?.[ARCHIVED_SESSION_IDS_KEY];
  return Array.isArray(ids) ? (ids.filter((x) => typeof x === 'string') as string[]) : [];
}

async function setArchivedSessionIds(db: Db, schoolId: string, ids: string[]): Promise<void> {
  const school = await db.school.findUnique({ where: { id: schoolId } });
  if (!school) throw ApiError.notFound('School not found');
  const settings = { ...((school.settings as Record<string, unknown>) ?? {}), [ARCHIVED_SESSION_IDS_KEY]: ids };
  await db.school.update({ where: { id: schoolId }, data: { settings } });
}

export function toPublicSession(s: any, archived = false): Record<string, unknown> {
  return {
    id: s.id,
    school_id: s.schoolId,
    name: s.name,
    start_date: s.startDate instanceof Date ? s.startDate.toISOString().slice(0, 10) : s.startDate,
    end_date: s.endDate instanceof Date ? s.endDate.toISOString().slice(0, 10) : s.endDate,
    is_current: s.isCurrent,
    is_archived: archived,
    created_at: s.createdAt,
  };
}

async function getSessionRow(db: Db, schoolId: string, id: string): Promise<any> {
  const s = await db.academicSession.findFirst({ where: { id, schoolId } });
  if (!s) throw ApiError.notFound('Session not found');
  return s;
}

export async function listSessions(
  db: Db,
  schoolId: string,
  query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  const archivedIds = new Set(await getArchivedSessionIds(db, schoolId));
  const all = await db.academicSession.findMany({ where: { schoolId }, orderBy: [{ startDate: 'desc' }] });
  let rows = all;
  if (query.archived_only === 'true') rows = all.filter((s: any) => archivedIds.has(s.id));
  else if (query.include_archived === 'false') rows = all.filter((s: any) => !archivedIds.has(s.id));
  const total = rows.length;
  const pageRows = rows.slice(skip, skip + limit);
  return paginatedResponse(pageRows.map((s: any) => toPublicSession(s, archivedIds.has(s.id))), total, { page, limit, skip });
}

export async function createSession(
  db: Db,
  schoolId: string,
  input: { name: string; start_date: string; end_date: string },
  actorId: string,
): Promise<any> {
  if (!isValidDateString(input.start_date) || !isValidDateString(input.end_date)) {
    throw ApiError.validation('Dates must be YYYY-MM-DD');
  }
  if (input.start_date >= input.end_date) throw ApiError.validation('start_date must be before end_date');
  const name = input.name.trim();
  const dup = await db.academicSession.findFirst({ where: { schoolId, name } });
  if (dup) throw ApiError.conflict(`A session named "${name}" already exists`);
  const created = await db.academicSession.create({
    data: { schoolId, name, startDate: dateOnly(input.start_date), endDate: dateOnly(input.end_date), isCurrent: false },
  });
  await logCreate(db, {
    schoolId,
    actorId,
    entity: 'academic_session',
    entityId: created.id,
    after: { name: created.name, start_date: created.startDate, end_date: created.endDate },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'session.create', entity: 'academic_session', entityId: created.id, details: { name } });
  return toPublicSession(created, false);
}

export async function getSession(db: Db, schoolId: string, id: string): Promise<any> {
  const s = await getSessionRow(db, schoolId, id);
  const archived = (await getArchivedSessionIds(db, schoolId)).includes(id);
  return toPublicSession(s, archived);
}

export async function updateSession(
  db: Db,
  schoolId: string,
  id: string,
  patch: { name?: string; start_date?: string; end_date?: string },
  actorId: string,
): Promise<any> {
  const s = await getSessionRow(db, schoolId, id);
  if ((await getArchivedSessionIds(db, schoolId)).includes(id)) {
    throw ApiError.conflict('This session is archived and read-only. Unarchive it first to edit.');
  }
  const before = { name: s.name, start_date: s.startDate, end_date: s.endDate };
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw ApiError.validation('name is required');
    const dup = await db.academicSession.findFirst({ where: { schoolId, name } });
    if (dup && dup.id !== id) throw ApiError.conflict(`A session named "${name}" already exists`);
    data.name = name;
  }
  if (patch.start_date !== undefined) {
    if (!isValidDateString(patch.start_date)) throw ApiError.validation('start_date must be YYYY-MM-DD');
    data.startDate = dateOnly(patch.start_date);
  }
  if (patch.end_date !== undefined) {
    if (!isValidDateString(patch.end_date)) throw ApiError.validation('end_date must be YYYY-MM-DD');
    data.endDate = dateOnly(patch.end_date);
  }
  const start = (data.startDate as Date | undefined) ?? s.startDate;
  const end = (data.endDate as Date | undefined) ?? s.endDate;
  if (start >= end) throw ApiError.validation('start_date must be before end_date');
  if (Object.keys(data).length === 0) return toPublicSession(s, false);
  const updated = await db.academicSession.update({ where: { id }, data });
  await writeChangeLogs(db, {
    schoolId, actorId, entity: 'academic_session', entityId: id,
    before, after: { name: updated.name, start_date: updated.startDate, end_date: updated.endDate },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'session.update', entity: 'academic_session', entityId: id, details: { name: updated.name } });
  return toPublicSession(updated, false);
}

export async function makeSessionCurrent(db: Db, schoolId: string, id: string, actorId: string): Promise<any> {
  const session = await getSessionRow(db, schoolId, id);
  if ((await getArchivedSessionIds(db, schoolId)).includes(id)) {
    throw ApiError.conflict('An archived session cannot be made current. Unarchive it first.');
  }
  await db.$transaction(async (tx) => {
    await tx.academicSession.updateMany({ where: { schoolId, isCurrent: true }, data: { isCurrent: false } });
    await tx.academicSession.update({ where: { id }, data: { isCurrent: true } });
  });
  await writeChangeLogs(db, { schoolId, actorId, entity: 'academic_session', entityId: id, before: { is_current: false }, after: { is_current: true } });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'session.make_current', entity: 'academic_session', entityId: id });
  return toPublicSession({ ...session, isCurrent: true }, false);
}

export async function archiveSession(db: Db, schoolId: string, id: string, actorId: string): Promise<any> {
  const s = await getSessionRow(db, schoolId, id);
  const archived = await getArchivedSessionIds(db, schoolId);
  if (archived.includes(id)) throw ApiError.conflict('This session is already archived');
  if (s.isCurrent) {
    await db.academicSession.update({ where: { id }, data: { isCurrent: false } });
  }
  await setArchivedSessionIds(db, schoolId, [...archived, id]);
  await writeChangeLogs(db, { schoolId, actorId, entity: 'academic_session', entityId: id, before: { is_archived: false, is_current: Boolean(s.isCurrent) }, after: { is_archived: true, is_current: false } });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'session.archive', entity: 'academic_session', entityId: id, details: { name: s.name } });
  return toPublicSession({ ...s, isCurrent: false }, true);
}

export async function unarchiveSession(db: Db, schoolId: string, id: string, actorId: string): Promise<any> {
  const s = await getSessionRow(db, schoolId, id);
  const archived = await getArchivedSessionIds(db, schoolId);
  if (!archived.includes(id)) throw ApiError.conflict('This session is not archived');
  await setArchivedSessionIds(db, schoolId, archived.filter((x) => x !== id));
  await writeChangeLogs(db, { schoolId, actorId, entity: 'academic_session', entityId: id, before: { is_archived: true }, after: { is_archived: false } });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'session.unarchive', entity: 'academic_session', entityId: id, details: { name: s.name } });
  return toPublicSession(s, false);
}

/**
 * Delete a session. academic_sessions has NO deleted_at column, so there is
 * no soft delete / recycle-bin restore for sessions: deletion is a guarded
 * hard delete (blocked while current, referenced by exams, or referenced by
 * promotions) and a deleted_records snapshot row is still written for the
 * audit trail. See FEATURES-6C1.md.
 */
export async function deleteSession(db: Db, schoolId: string, id: string, actorId: string): Promise<void> {
  const s = await getSessionRow(db, schoolId, id);
  if (s.isCurrent) throw ApiError.conflict('The current session cannot be deleted. Make another session current first.');
  const exams = await db.exam.count({ where: { schoolId, sessionId: id, deletedAt: null } });
  if (exams > 0) throw ApiError.conflict('This session has exams. Delete or move the exams first.');
  const promotions = await db.promotion.count({ where: { schoolId, sessionId: id } });
  if (promotions > 0) throw ApiError.conflict('This session has promotion records and cannot be deleted.');
  const archived = await getArchivedSessionIds(db, schoolId);
  if (archived.includes(id)) await setArchivedSessionIds(db, schoolId, archived.filter((x) => x !== id));
  const snapshot = JSON.parse(JSON.stringify(s, (_k, v) => (v instanceof Date ? v.toISOString() : v)));
  await db.academicSession.delete({ where: { id } });
  await (db as any).deletedRecord.create({
    data: { schoolId, entity: 'academic_session', entityId: id, snapshot, deletedBy: actorId, deletedAt: new Date(), restoreBy: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  });
  await logDelete(db, {
    schoolId,
    actorId,
    entity: 'academic_session',
    entityId: id,
    before: { name: s.name, start_date: s.startDate, end_date: s.endDate },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'session.delete', entity: 'academic_session', entityId: id, details: { name: s.name } });
}

/**
 * Promote a whole class-section to the next class-section within a session.
 * Reuses admin.promoteStudents (the hardened tx-scoped implementation) —
 * this function only resolves "every active student in from_class" into
 * mappings and delegates. Archived sessions refuse promotion (409).
 */
export async function promoteClassSection(
  db: Db,
  schoolId: string,
  sessionId: string,
  input: { from_class_id: string; to_class_id: string },
  actorId: string,
): Promise<{ promoted: number; session_id: string; from_class_id: string; to_class_id: string }> {
  const session = await getSessionRow(db, schoolId, sessionId);
  if ((await getArchivedSessionIds(db, schoolId)).includes(sessionId)) {
    throw ApiError.conflict('This session is archived and read-only. Promotions are not allowed.');
  }
  if (input.from_class_id === input.to_class_id) throw ApiError.validation('from_class_id and to_class_id must be different classes');
  const fromClass = await db.class.findFirst({ where: { id: input.from_class_id, schoolId, deletedAt: null } });
  if (!fromClass) throw ApiError.notFound('From class not found');
  const toClass = await db.class.findFirst({ where: { id: input.to_class_id, schoolId, deletedAt: null } });
  if (!toClass) throw ApiError.notFound('To class not found');
  const students = await db.student.findMany({
    where: { schoolId, classId: input.from_class_id, status: 'active', deletedAt: null },
    orderBy: [{ rollNo: 'asc' }],
  });
  if (students.length === 0) throw ApiError.validation('No active students in the from class to promote');
  const result = await promoteStudents(
    db, schoolId,
    { session_id: sessionId, mappings: students.map((st: any) => ({ student_id: st.id, to_class_id: input.to_class_id })) },
    actorId,
  );
  return { promoted: result.promoted, session_id: sessionId, from_class_id: input.from_class_id, to_class_id: input.to_class_id };
}

export async function listSessionPromotions(
  db: Db,
  schoolId: string,
  sessionId: string,
  query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  await getSessionRow(db, schoolId, sessionId);
  const { page, limit, skip } = parsePagination(query);
  const where: Record<string, unknown> = { schoolId, sessionId };
  const [rows, total] = await Promise.all([
    db.promotion.findMany({ where, orderBy: [{ promotedAt: 'desc' }], skip, take: limit }),
    db.promotion.count({ where }),
  ]);
  const studentIds = [...new Set(rows.map((r: any) => r.studentId))];
  const classIds = [...new Set([...rows.map((r: any) => r.fromClassId), ...rows.map((r: any) => r.toClassId)])];
  const [students, classes] = await Promise.all([
    studentIds.length ? db.student.findMany({ where: { schoolId, id: { in: studentIds } } }) : Promise.resolve([]),
    classIds.length ? db.class.findMany({ where: { schoolId, id: { in: classIds } } }) : Promise.resolve([]),
  ]);
  const studentById = new Map(students.map((s: any) => [s.id, s]));
  const classById = new Map(classes.map((c: any) => [c.id, `${c.name}-${c.section}`]));
  const items = rows.map((r: any) => ({
    id: r.id, school_id: r.schoolId, student_id: r.studentId,
    student_name: (studentById.get(r.studentId) as any)?.name ?? null,
    from_class_id: r.fromClassId, from_class: classById.get(r.fromClassId) ?? null,
    to_class_id: r.toClassId, to_class: classById.get(r.toClassId) ?? null,
    session_id: r.sessionId, promoted_at: r.promotedAt, promoted_by: r.promotedBy ?? null,
  }));
  return paginatedResponse(items, total, { page, limit, skip });
}
