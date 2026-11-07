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
import crypto from 'node:crypto';
import { ApiError } from '../../lib/errors';
import { isValidDateString, dateOnly } from '../../lib/dates';
import { writeAudit } from '../../lib/audit';
import { writeChangeLogs, logCreate, logDelete } from '../hardening/helpers';
import { paginatedResponse, parsePagination } from '../../lib/pagination';
import type { Db } from '../../lib/db';

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

// ===========================================================================
// Promotion rebuild (Module D, 2026-11-07) — root-cause fix.
//
// DEFECTS FOUND IN THE OLD FLOW (reproduced on scratch before this fix —
// see PROMOTION-REBUILD.md; repro suite promotion-repro.test.ts, 6/6
// reproducing, since removed in favour of promotion.test.ts):
//   D1. Left / struck-off / graduated students COULD be promoted: the old
//       admin.promoteStudents loaded a student by id with no status or
//       deletedAt check, so an explicit mapping moved a 'left' student.
//       (The whole-class path filtered status='active', so the hole was
//       only reachable via /admin/promotions — i.e. exactly the path a
//       bulk/selected-student promotion uses.)
//   D2. Roll numbers were copied unchanged into the target class. The
//       target often already holds that roll number, so on real Postgres
//       the UNIQUE (class_id, roll_no) index throws P2002 and the whole
//       transaction fails with a 500; where the index was not enforced
//       the target silently ended up with two students on one roll.
//   D3. No batch / status / outcome on the promotion row: the same
//       student could be promoted twice in one session (two live rows,
//       inflated counts, the second move overwriting the first with no
//       record of which decision was current), and there was no way to
//       undo or edit a promotion at all.
//   D4. Highest class had no graduate/hold path: nothing stopped a
//       10th grader being promoted "to" 9th (or any arbitrary class),
//       and no 'graduated' outcome existed.
//   D5. History was mixed by the in-place classId mutation: promotion
//       rewrote student.classId, so old-session rosters (attendance
//       days, fee lists, result sheets keyed by class) lost the student
//       the moment they moved, while the bare promotion row recorded
//       neither the old roll number nor which decision moved them.
//   D6. The audit trail was written AFTER the transaction (change logs
//       + audit outside $transaction, validation reads outside it too),
//       so a promotion could land with no log, and a student could move
//       between the pre-check and the write (TOCTOU).
//
// FIX (this file is now the single canonical promotion engine;
// admin.promoteStudents is a thin delegate to applyPromotion):
//   * One admin decision = one batch (batchId, crypto.randomUUID()).
//     Every row in the batch is applied, undone, or audited as a unit.
//   * Preview first: previewPromotion computes every row (target roll,
//     outcome, skip reason) WITHOUT mutating anything; the admin confirms
//     exactly that preview.
//   * applyPromotion runs entirely inside ONE $transaction — validation
//     re-reads, student moves, promotion rows, change logs and audit all
//     commit or roll back together.
//   * Only status='active' AND deletedAt IS NULL students move; left /
//     struck_off / graduated / deleted students are SKIPPED with a reason
//     (never silently moved, never silently dropped — the preview lists
//     them). A student with a live ('applied') promotion in this session
//     is skipped the same way; the partial unique index in migration
//     20261107151000 enforces it in the DB as well.
//   * Roll-number rule (deterministic, collision-free): within each
//     target class, ready students are ordered by old roll (nulls last)
//     then name, and receive max(existing rolls in target) + 1, + 2, …
//     Rolls are never reused from gaps and never copied across. The old
//     and new rolls are snapshotted on the promotion row (rollNoFrom/To)
//     so undo restores them exactly.
//   * Highest class is explicit: outcome 'graduated' (status ->
//     'graduated', class unchanged) or 'held' (stays in class, row
//     recorded). A 'promoted' mapping always needs a real target class.
//   * History is preserved, never rewritten: promotion touches ONLY the
//     student row (classId/rollNo/status) and promotion rows. Attendance
//     days/records, fee records and results keep their own keys
//     (AttendanceDay.classId + date, FeeRecord.month, ResultSheet
//     .sessionId/.classId) and are never created, moved or deleted by a
//     promotion — the new session therefore starts clean (zero new
//     attendance/fee/result rows), and the class a student belonged to in
//     an old session is recoverable from the promotion row
//     (getStudentClassInSession) instead of today's student.classId.
//   * Undo reverses a whole batch atomically (restores class + roll +
//     status; blocked with a 409 naming the student if they have since
//     moved again — edit instead). Edit supersedes one applied row and
//     writes a new applied row in the same batch, so history stays
//     complete. Every step writes change_logs + audit_logs.
// ===========================================================================

export type PromotionOutcome = 'promoted' | 'graduated' | 'held';
export type PromotionStatus = 'applied' | 'reversed' | 'superseded';

export interface PromotionMappingInput {
  student_id: string;
  /** Null/absent + outcome 'graduated' = graduate. Required for 'promoted'. */
  to_class_id?: string | null;
  outcome?: PromotionOutcome;
}

export interface PromotionPreviewRow {
  student_id: string;
  student_name: string | null;
  roll_no_from: number | null;
  from_class_id: string;
  to_class_id: string | null;
  outcome: PromotionOutcome;
  roll_no_to: number | null;
  status: 'ready' | 'skipped';
  skip_reason: string | null;
}

export interface PromotionPreview {
  session_id: string;
  rows: PromotionPreviewRow[];
  ready: number;
  skipped: number;
}

export interface PromotionApplyResult {
  batch_id: string;
  session_id: string;
  promoted: number;
  graduated: number;
  held: number;
  skipped: Array<{ student_id: string; reason: string }>;
}

const NON_ACTIVE_SKIP = (status: string): string =>
  `Student status is '${status}' — only active students are promoted. Left, struck-off and graduated students are never promoted.`;

function classLabel(c: any): string {
  return c ? `${c.name}-${c.section}` : '';
}

/** Next free roll in a class: max(existing rolls) + 1, or 1 when empty. */
function nextRollNo(studentsInClass: Array<{ rollNo?: number | null }>, alreadyAssigned: number[]): number {
  const taken = [
    ...studentsInClass.map((s) => s.rollNo).filter((r): r is number => typeof r === 'number'),
    ...alreadyAssigned,
  ];
  return taken.length ? Math.max(...taken) + 1 : 1;
}

/**
 * Build the preview for a set of mappings against `db` (the live db or a
 * transaction client). Pure read — mutates nothing. Throws ApiError on hard
 * input errors (unknown session/student, duplicate student in the request,
 * contradictory outcome/target); per-student eligibility problems become
 * 'skipped' rows so one bad student never blocks or silently voids the rest.
 */
async function buildPreview(
  db: Db,
  schoolId: string,
  sessionId: string,
  mappings: PromotionMappingInput[],
): Promise<PromotionPreview> {
  const session = await db.academicSession.findFirst({ where: { id: sessionId, schoolId } });
  if (!session) throw ApiError.notFound('Session not found');
  if ((await getArchivedSessionIds(db, schoolId)).includes(sessionId)) {
    throw ApiError.conflict('This session is archived and read-only. Promotions are not allowed.');
  }
  if (!Array.isArray(mappings) || mappings.length === 0) {
    throw ApiError.validation('mappings must be a non-empty array');
  }
  const seen = new Set<string>();
  for (const m of mappings) {
    if (seen.has(m.student_id)) throw ApiError.validation(`Duplicate student in mappings: ${m.student_id}`);
    seen.add(m.student_id);
  }
  const studentIds = mappings.map((m) => m.student_id);
  const students = await db.student.findMany({ where: { schoolId, id: { in: studentIds } } });
  const studentById = new Map(students.map((s: any) => [s.id as string, s]));
  for (const m of mappings) {
    if (!studentById.has(m.student_id)) throw ApiError.validation(`Student not found: ${m.student_id}`);
  }
  const live = await db.promotion.findMany({ where: { schoolId, sessionId, studentId: { in: studentIds }, status: 'applied' } });
  const liveByStudent = new Map(live.map((r: any) => [r.studentId as string, r]));

  // Resolve + validate target classes once.
  const targetIds = [...new Set(mappings.map((m) => m.to_class_id).filter((x): x is string => typeof x === 'string' && x.length > 0))];
  const targetClasses = targetIds.length
    ? await db.class.findMany({ where: { schoolId, id: { in: targetIds }, deletedAt: null } })
    : [];
  const targetById = new Map(targetClasses.map((c: any) => [c.id as string, c]));
  for (const id of targetIds) {
    if (!targetById.has(id)) throw ApiError.notFound(`To class not found: ${id}`);
  }

  const rows: PromotionPreviewRow[] = [];
  for (const m of mappings) {
    const st: any = studentById.get(m.student_id);
    const outcome: PromotionOutcome = m.outcome ?? (m.to_class_id ? 'promoted' : 'graduated');
    const base: PromotionPreviewRow = {
      student_id: m.student_id,
      student_name: st.name ?? null,
      roll_no_from: st.rollNo ?? null,
      from_class_id: st.classId,
      to_class_id: outcome === 'promoted' ? (m.to_class_id as string) : st.classId,
      outcome,
      roll_no_to: null,
      status: 'ready',
      skip_reason: null,
    };
    const skip = (reason: string): void => {
      rows.push({ ...base, status: 'skipped', skip_reason: reason, roll_no_to: base.roll_no_from });
    };
    if (st.deletedAt) { skip('Student is deleted.'); continue; }
    if (st.status !== 'active') { skip(NON_ACTIVE_SKIP(String(st.status))); continue; }
    if (liveByStudent.has(m.student_id)) { skip('Student already has an applied promotion in this session — undo or edit that promotion instead.'); continue; }
    if (outcome === 'promoted') {
      if (!m.to_class_id) { skip('No target class given for promotion.'); continue; }
      if (m.to_class_id === st.classId) { skip('Student is already in the target class.'); continue; }
    } else if (outcome === 'graduated') {
      if (m.to_class_id) throw ApiError.validation('Graduation takes no target class — pass outcome "graduated" with no to_class_id.');
    } else if (outcome === 'held') {
      if (m.to_class_id) throw ApiError.validation('Holding a student takes no target class — pass outcome "held" with no to_class_id.');
    }
    rows.push(base);
  }

  // Roll-number assignment (D2 fix): per target class, order ready promoted
  // rows by old roll (nulls last) then name; assign max(existing)+1, +2, …
  const readyPromoted = rows.filter((r) => r.status === 'ready' && r.outcome === 'promoted');
  const byTarget = new Map<string, PromotionPreviewRow[]>();
  for (const r of readyPromoted) {
    const list = byTarget.get(r.to_class_id as string) ?? [];
    list.push(r);
    byTarget.set(r.to_class_id as string, list);
  }
  for (const [targetId, list] of byTarget) {
    const inTarget = await db.student.findMany({ where: { schoolId, classId: targetId, deletedAt: null } });
    const ordered = [...list].sort((a, b) => {
      if (a.roll_no_from === null && b.roll_no_from !== null) return 1;
      if (a.roll_no_from !== null && b.roll_no_from === null) return -1;
      if (a.roll_no_from !== null && b.roll_no_from !== null && a.roll_no_from !== b.roll_no_from) return a.roll_no_from - b.roll_no_from;
      return String(a.student_name ?? '').localeCompare(String(b.student_name ?? ''));
    });
    const assigned: number[] = [];
    for (const r of ordered) {
      r.roll_no_to = nextRollNo(inTarget, assigned);
      assigned.push(r.roll_no_to);
    }
  }
  for (const r of rows) {
    if (r.status === 'ready' && r.outcome !== 'promoted') r.roll_no_to = r.roll_no_from;
  }
  return {
    session_id: sessionId,
    rows,
    ready: rows.filter((r) => r.status === 'ready').length,
    skipped: rows.filter((r) => r.status === 'skipped').length,
  };
}

/** Public preview: what applyPromotion would do, without changing anything. */
export async function previewPromotion(
  db: Db,
  schoolId: string,
  sessionId: string,
  input: { mappings: PromotionMappingInput[] },
): Promise<PromotionPreview> {
  return buildPreview(db, schoolId, sessionId, input.mappings);
}

export function toPublicPromotion(r: any, studentName?: string | null, fromLabel?: string | null, toLabel?: string | null): Record<string, unknown> {
  return {
    id: r.id,
    school_id: r.schoolId,
    student_id: r.studentId,
    student_name: studentName ?? null,
    from_class_id: r.fromClassId,
    from_class: fromLabel ?? null,
    to_class_id: r.toClassId,
    to_class: toLabel ?? null,
    session_id: r.sessionId,
    batch_id: r.batchId ?? null,
    status: r.status ?? 'applied',
    outcome: r.outcome ?? 'promoted',
    roll_no_from: r.rollNoFrom ?? null,
    roll_no_to: r.rollNoTo ?? null,
    promoted_at: r.promotedAt,
    promoted_by: r.promotedBy ?? null,
  };
}

/**
 * Apply a previewed promotion. Everything — re-validation, student moves,
 * promotion rows, change logs, audit — runs inside ONE $transaction, so a
 * promotion can never land without its log (D6 fix).
 */
export async function applyPromotion(
  db: Db,
  schoolId: string,
  sessionId: string,
  input: { mappings: PromotionMappingInput[] },
  actorId: string,
): Promise<PromotionApplyResult> {
  const batchId = crypto.randomUUID();
  const result = await db.$transaction(async (tx) => {
    const preview = await buildPreview(tx, schoolId, sessionId, input.mappings);
    const ready = preview.rows.filter((r) => r.status === 'ready');
    if (ready.length === 0) {
      const reasons = preview.rows.map((r) => `${r.student_name ?? r.student_id}: ${r.skip_reason ?? 'skipped'}`).join('; ');
      throw ApiError.validation(`Nothing to promote. ${reasons}`);
    }
    const now = new Date();
    let promoted = 0;
    let graduated = 0;
    let held = 0;
    for (const row of ready) {
      const toClassId = row.to_class_id as string;
      await tx.promotion.create({
        data: {
          schoolId,
          studentId: row.student_id,
          fromClassId: row.from_class_id,
          toClassId,
          sessionId,
          promotedAt: now,
          promotedBy: actorId,
          batchId,
          status: 'applied',
          outcome: row.outcome,
          rollNoFrom: row.roll_no_from,
          rollNoTo: row.roll_no_to,
        },
      });
      if (row.outcome === 'promoted') {
        const before = { class_id: row.from_class_id, roll_no: row.roll_no_from };
        await tx.student.update({ where: { id: row.student_id }, data: { classId: toClassId, rollNo: row.roll_no_to } });
        await writeChangeLogs(tx, {
          schoolId, actorId, entity: 'student', entityId: row.student_id,
          before, after: { class_id: toClassId, roll_no: row.roll_no_to },
        });
        promoted += 1;
      } else if (row.outcome === 'graduated') {
        await tx.student.update({ where: { id: row.student_id }, data: { status: 'graduated' } });
        await writeChangeLogs(tx, {
          schoolId, actorId, entity: 'student', entityId: row.student_id,
          before: { status: 'active', class_id: row.from_class_id, roll_no: row.roll_no_from },
          after: { status: 'graduated', class_id: row.from_class_id, roll_no: row.roll_no_from },
        });
        graduated += 1;
      } else {
        held += 1;
      }
      await writeChangeLogs(tx, {
        schoolId, actorId, entity: 'promotion', entityId: row.student_id,
        before: {},
        after: { batch_id: batchId, session_id: sessionId, from_class_id: row.from_class_id, to_class_id: toClassId, outcome: row.outcome, roll_no_from: row.roll_no_from, roll_no_to: row.roll_no_to, status: 'applied' },
      });
    }
    await writeAudit(tx, {
      schoolId, actorId, actorType: 'user', action: 'promotion.apply', entity: 'academic_session', entityId: sessionId,
      details: { batch_id: batchId, promoted, graduated, held, skipped: preview.skipped },
    });
    return {
      batch_id: batchId,
      session_id: sessionId,
      promoted,
      graduated,
      held,
      skipped: preview.rows.filter((r) => r.status === 'skipped').map((r) => ({ student_id: r.student_id, reason: r.skip_reason ?? 'skipped' })),
    };
  });
  return result;
}

/**
 * Undo a whole promotion batch atomically. Restores each student to the
 * state BEFORE the batch — not merely the inverse of their latest row:
 * if a student was edited after the batch (5-A → 6-A, then edited to 7-A),
 * the batch's earliest row (5-A) is the pre-batch state, so undo takes
 * them back to 5-A, never to the intermediate 6-A. All rows of the batch
 * (applied AND superseded-by-edit) are marked 'reversed'. Blocked (409,
 * nothing applied) when a student has moved on since by any other means —
 * that student needs an edit, not a blind undo.
 */
export async function undoPromotion(
  db: Db,
  schoolId: string,
  batchId: string,
  actorId: string,
): Promise<{ batch_id: string; reversed: number; roll_no_reassigned: Array<{ student_id: string; roll_no: number }> }> {
  return db.$transaction(async (tx) => {
    const rows = await tx.promotion.findMany({ where: { schoolId, batchId, status: { in: ['applied', 'superseded'] } }, orderBy: [{ promotedAt: 'asc' }] });
    if (rows.length === 0) throw ApiError.notFound('Promotion batch not found or already reversed');
    // Per student: earliest row = pre-batch state; latest APPLIED row =
    // where the student should be now (edits supersede, never delete).
    const byStudent = new Map<string, any[]>();
    for (const row of rows as any[]) {
      const list = byStudent.get(row.studentId) ?? [];
      list.push(row);
      byStudent.set(row.studentId, list);
    }
    const reassigned: Array<{ student_id: string; roll_no: number }> = [];
    for (const [studentId, list] of byStudent) {
      const earliest = list[0];
      const latestApplied = [...list].reverse().find((r) => r.status === 'applied');
      if (!latestApplied) throw ApiError.conflict('Promotion batch is in an inconsistent state — no applied row to undo.');
      const st: any = await tx.student.findFirst({ where: { id: studentId, schoolId } });
      if (!st || st.deletedAt) throw ApiError.conflict(`Cannot undo: student ${studentId} no longer exists.`);
      // Verify the student is still where the batch last put them.
      if (latestApplied.outcome === 'promoted' && st.classId !== latestApplied.toClassId) {
        throw ApiError.conflict(
          `Cannot undo: ${st.name ?? studentId} has moved to a different class since this promotion — edit the promotion instead.`,
        );
      }
      if (latestApplied.outcome === 'graduated' && st.status !== 'graduated') {
        throw ApiError.conflict(`Cannot undo: ${st.name ?? studentId} is no longer graduated — edit the promotion instead.`);
      }
      const before = { class_id: st.classId, roll_no: st.rollNo, status: st.status };
      let restoreRoll: number | null = earliest.rollNoFrom ?? null;
      if (latestApplied.outcome === 'promoted' || st.classId !== earliest.fromClassId) {
        if (restoreRoll !== null) {
          const inFrom = await tx.student.findMany({ where: { schoolId, classId: earliest.fromClassId, deletedAt: null } });
          const occupied = inFrom.some((s: any) => s.id !== st.id && s.rollNo === restoreRoll);
          if (occupied) {
            restoreRoll = nextRollNo(inFrom.filter((s: any) => s.id !== st.id), []);
            reassigned.push({ student_id: st.id, roll_no: restoreRoll });
          }
        }
        await tx.student.update({ where: { id: st.id }, data: { classId: earliest.fromClassId, rollNo: restoreRoll, status: 'active' } });
      } else if (latestApplied.outcome === 'graduated') {
        await tx.student.update({ where: { id: st.id }, data: { status: 'active' } });
      }
      // 'held' latest rows need no student change — the row itself is the record.
      await writeChangeLogs(tx, {
        schoolId, actorId, entity: 'student', entityId: st.id,
        before, after: { class_id: earliest.fromClassId, roll_no: restoreRoll, status: 'active' },
      });
      for (const row of list) {
        await tx.promotion.update({ where: { id: row.id }, data: { status: 'reversed' } });
      }
      await writeChangeLogs(tx, {
        schoolId, actorId, entity: 'promotion', entityId: st.id,
        before: { batch_id: batchId, status: 'applied' }, after: { batch_id: batchId, status: 'reversed' },
      });
    }
    await writeAudit(tx, {
      schoolId, actorId, actorType: 'user', action: 'promotion.undo', entity: 'academic_session',
      entityId: (rows[0] as any).sessionId, details: { batch_id: batchId, reversed: byStudent.size },
    });
    // `reversed` counts STUDENTS restored, not rows: an edited student has
    // two rows in the batch but is one student moved back.
    return { batch_id: batchId, reversed: byStudent.size, roll_no_reassigned: reassigned };
  });
}

/**
 * Edit ONE applied promotion: move that single student to a different class
 * (or graduate them). The old row is superseded (kept for history) and a
 * new applied row is written in the SAME batch, so the batch still tells
 * the whole story. Other students in the batch are untouched.
 */
export async function editPromotion(
  db: Db,
  schoolId: string,
  promotionId: string,
  patch: { to_class_id?: string | null; outcome?: PromotionOutcome },
  actorId: string,
): Promise<Record<string, unknown>> {
  return db.$transaction(async (tx) => {
    const row: any = await tx.promotion.findFirst({ where: { id: promotionId, schoolId } });
    if (!row) throw ApiError.notFound('Promotion not found');
    if (row.status !== 'applied') throw ApiError.conflict('Only an applied promotion can be edited — this one was already reversed or superseded.');
    const st: any = await tx.student.findFirst({ where: { id: row.studentId, schoolId } });
    if (!st || st.deletedAt) throw ApiError.conflict('Cannot edit: the student no longer exists.');
    if (st.status !== 'active' && row.outcome !== 'graduated') {
      throw ApiError.conflict(`Cannot edit: student status is '${st.status}' — left, struck-off and graduated students are never moved by promotion.`);
    }
    const newOutcome: PromotionOutcome = patch.outcome ?? (patch.to_class_id ? 'promoted' : row.outcome);
    let newToClassId: string = st.classId as string;
    let newRoll: number | null = st.rollNo ?? null;
    const beforeStudent = { class_id: st.classId, roll_no: st.rollNo, status: st.status };
    if (newOutcome === 'promoted') {
      if (!patch.to_class_id) throw ApiError.validation('Editing to a promotion needs a to_class_id.');
      const target: any = await tx.class.findFirst({ where: { id: patch.to_class_id, schoolId, deletedAt: null } });
      if (!target) throw ApiError.notFound('To class not found');
      if (target.id === st.classId) throw ApiError.validation('Student is already in that class.');
      const inTarget = await tx.student.findMany({ where: { schoolId, classId: target.id, deletedAt: null } });
      newToClassId = target.id;
      newRoll = nextRollNo(inTarget, []);
      await tx.student.update({ where: { id: st.id }, data: { classId: target.id, rollNo: newRoll, status: 'active' } });
    } else if (newOutcome === 'graduated') {
      if (patch.to_class_id) throw ApiError.validation('Graduation takes no target class.');
      await tx.student.update({ where: { id: st.id }, data: { status: 'graduated' } });
    } else {
      // 'held': student stays where they are.
      if (patch.to_class_id) throw ApiError.validation('Holding a student takes no target class.');
    }
    await tx.promotion.update({ where: { id: row.id }, data: { status: 'superseded' } });
    const created: any = await tx.promotion.create({
      data: {
        schoolId,
        studentId: st.id,
        fromClassId: st.classId,
        toClassId: newToClassId,
        sessionId: row.sessionId,
        promotedAt: new Date(),
        promotedBy: actorId,
        batchId: row.batchId,
        status: 'applied',
        outcome: newOutcome,
        rollNoFrom: st.rollNo ?? null,
        rollNoTo: newRoll,
      },
    });
    const afterStudent = { class_id: newToClassId, roll_no: newRoll, status: newOutcome === 'graduated' ? 'graduated' : 'active' };
    await writeChangeLogs(tx, {
      schoolId, actorId, entity: 'student', entityId: st.id, before: beforeStudent, after: afterStudent,
    });
    await writeChangeLogs(tx, {
      schoolId, actorId, entity: 'promotion', entityId: st.id,
      before: { promotion_id: row.id, status: 'applied', to_class_id: row.toClassId },
      after: { promotion_id: created.id, status: 'applied', to_class_id: newToClassId, outcome: newOutcome, supersedes: row.id },
    });
    await writeAudit(tx, {
      schoolId, actorId, actorType: 'user', action: 'promotion.edit', entity: 'academic_session', entityId: row.sessionId,
      details: { batch_id: row.batchId, promotion_id: row.id, new_promotion_id: created.id, to_class_id: newToClassId, outcome: newOutcome },
    });
    return toPublicPromotion(created, st.name);
  });
}

/** Batch summaries for one session, newest first (for the history + undo UI). */
export async function listPromotionBatches(db: Db, schoolId: string, sessionId: string): Promise<Array<Record<string, unknown>>> {
  await getSessionRow(db, schoolId, sessionId);
  const rows: any[] = await db.promotion.findMany({ where: { schoolId, sessionId }, orderBy: [{ promotedAt: 'desc' }] });
  const byBatch = new Map<string, any[]>();
  for (const r of rows) {
    const list = byBatch.get(r.batchId ?? r.id) ?? [];
    list.push(r);
    byBatch.set(r.batchId ?? r.id, list);
  }
  return [...byBatch.values()].map((list) => {
    const applied = list.filter((r) => r.status === 'applied').length;
    const reversed = list.filter((r) => r.status === 'reversed').length;
    return {
      batch_id: list[0].batchId ?? list[0].id,
      session_id: sessionId,
      promoted_at: list[0].promotedAt,
      promoted_by: list[0].promotedBy ?? null,
      students: list.length,
      applied,
      reversed,
      superseded: list.filter((r) => r.status === 'superseded').length,
      status: applied === 0 ? 'reversed' : reversed > 0 ? 'partially_reversed' : 'applied',
      outcomes: {
        promoted: list.filter((r) => r.outcome === 'promoted').length,
        graduated: list.filter((r) => r.outcome === 'graduated').length,
        held: list.filter((r) => r.outcome === 'held').length,
      },
    };
  });
}

/**
 * Which class did a student belong to in a given session? The promotion row
 * is the authoritative record (D5 fix): if the student has an applied (or
 * superseded) promotion in that session, their class THEN was fromClassId;
 * otherwise their class is their current class. Attendance/fee/result
 * reports for an old session must resolve the class this way — never from
 * today's student.classId, which the promotion has since rewritten.
 * History rows themselves (attendance days by class+date, fee records by
 * student+month, result sheets by session+class) are never touched by a
 * promotion, so the old session's records stay exactly where they were.
 */
export async function getStudentClassInSession(
  db: Db,
  schoolId: string,
  studentId: string,
  sessionId: string,
): Promise<{ class_id: string | null; source: 'promotion' | 'current' }> {
  const row: any = await db.promotion.findFirst({
    where: { schoolId, studentId, sessionId, status: { in: ['applied', 'superseded'] } },
    orderBy: [{ promotedAt: 'desc' }],
  });
  if (row) return { class_id: row.fromClassId, source: 'promotion' };
  const st: any = await db.student.findFirst({ where: { id: studentId, schoolId } });
  return { class_id: st?.classId ?? null, source: 'current' };
}

/**
 * Promote a whole class-section (or a selected subset of it) within a
 * session. Backwards-compatible with the old call shape
 * ({from_class_id, to_class_id} → every active student moves), plus:
 * student_ids (promote only these), outcome 'graduated' | 'held' with
 * to_class_id omitted (highest class: graduate or hold the whole class).
 * Selection, eligibility and roll numbers all go through the same
 * preview/apply engine — there is no second promotion implementation.
 */
export async function promoteClassSection(
  db: Db,
  schoolId: string,
  sessionId: string,
  input: { from_class_id: string; to_class_id?: string | null; student_ids?: string[]; outcome?: PromotionOutcome },
  actorId: string,
): Promise<{ promoted: number; graduated: number; held: number; skipped: Array<{ student_id: string; reason: string }>; batch_id: string; session_id: string; from_class_id: string; to_class_id: string | null }> {
  const session = await getSessionRow(db, schoolId, sessionId);
  if ((await getArchivedSessionIds(db, schoolId)).includes(sessionId)) {
    throw ApiError.conflict('This session is archived and read-only. Promotions are not allowed.');
  }
  const outcome: PromotionOutcome = input.outcome ?? (input.to_class_id ? 'promoted' : 'graduated');
  if (outcome === 'promoted' && !input.to_class_id) throw ApiError.validation('to_class_id is required to promote a class');
  if (outcome !== 'promoted' && input.to_class_id) throw ApiError.validation('Graduating or holding a class takes no target class.');
  if (input.to_class_id && input.from_class_id === input.to_class_id) throw ApiError.validation('from_class_id and to_class_id must be different classes');
  const fromClass = await db.class.findFirst({ where: { id: input.from_class_id, schoolId, deletedAt: null } });
  if (!fromClass) throw ApiError.notFound('From class not found');
  if (input.to_class_id) {
    const toClass = await db.class.findFirst({ where: { id: input.to_class_id, schoolId, deletedAt: null } });
    if (!toClass) throw ApiError.notFound('To class not found');
  }
  let students: any[];
  if (input.student_ids && input.student_ids.length > 0) {
    // Explicit selection: load as requested (any status) so the engine can
    // skip ineligible students WITH a reason instead of dropping them silently.
    students = await db.student.findMany({
      where: { schoolId, classId: input.from_class_id, id: { in: input.student_ids }, deletedAt: null },
      orderBy: [{ rollNo: 'asc' }, { name: 'asc' }],
    });
  } else {
    students = await db.student.findMany({
      where: { schoolId, classId: input.from_class_id, status: 'active', deletedAt: null },
      orderBy: [{ rollNo: 'asc' }, { name: 'asc' }],
    });
  }
  if (students.length === 0) throw ApiError.validation('No active students in the from class to promote');
  const result = await applyPromotion(
    db, schoolId, sessionId,
    { mappings: students.map((st: any) => ({ student_id: st.id, to_class_id: input.to_class_id ?? null, outcome })) },
    actorId,
  );
  return { ...result, from_class_id: input.from_class_id, to_class_id: input.to_class_id ?? null };
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
  if (query.status) where.status = String(query.status);
  if (query.batch_id) where.batchId = String(query.batch_id);
  if (query.outcome) where.outcome = String(query.outcome);
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
  const studentById = new Map<string, any>(students.map((s: any) => [s.id as string, s]));
  const classById = new Map<string, string>(classes.map((c: any) => [c.id as string, `${c.name}-${c.section}`]));
  const items = rows.map((r: any) => toPublicPromotion(
    r,
    (studentById.get(r.studentId) as any)?.name ?? null,
    classById.get(r.fromClassId) ?? null,
    classById.get(r.toClassId) ?? null,
  ));
  return paginatedResponse(items, total, { page, limit, skip });
}
