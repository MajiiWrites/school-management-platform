// Exams, datesheets & grading scales (6C-1). Owns the exam DEFINITIONS
// only — the results module (6B) reads exams; nothing here touches results,
// result_sheets, or result rows.
//
// PASSING MARKS — storage decision (see FEATURES-6C1.md): there is no
// passing_marks column on exams or classes, so passing marks live on the
// grading scale: the passing threshold for a class is the lowest min_marks
// among that class's bands with is_passing = true (class-specific bands win
// over the school default, class_id NULL). getPassingMarks() is the single
// reader; the results module should call it rather than re-deriving it.
import { ApiError } from '../../lib/errors';
import { isValidDateString, dateOnly } from '../../lib/dates';
import { writeAudit } from '../../lib/audit';
import { writeChangeLogs, logCreate, logDelete, softDeleteEntity } from '../hardening/helpers';
import { paginatedResponse, parsePagination } from '../../lib/pagination';
import type { Db } from '../../lib/db';
import { getArchivedSessionIds } from '../sessions/service';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/* FINAL REBUILD (Module C): exam types — exactly these three. The free
 * exam name is untouched ("Monthly Test – March" stays that name); the
 * type is a separate field the admin picks. */
export const EXAM_TYPES = ['monthly', 'midterm', 'annual'] as const;
export type ExamType = (typeof EXAM_TYPES)[number];
export const EXAM_TYPE_LABELS: Record<ExamType, string> = {
  monthly: 'Monthly Test',
  midterm: 'Midterm',
  annual: 'Annual',
};

/** Validate an exam type; undefined defaults to 'monthly'. Anything else is a 400. */
export function validateExamType(value: unknown): ExamType {
  if (value === undefined || value === null) return 'monthly';
  if (typeof value === 'string' && (EXAM_TYPES as readonly string[]).includes(value)) {
    return value as ExamType;
  }
  throw ApiError.validation("type must be one of 'monthly', 'midterm', 'annual'");
}

function assertTimeRange(start: string, end: string, label = 'start_time'): void {
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) throw ApiError.validation(`${label} and end_time must be HH:MM (24h)`);
  if (start >= end) throw ApiError.validation('start_time must be before end_time');
}

function timesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function toPublicExam(e: any): Record<string, unknown> {
  return {
    id: e.id, school_id: e.schoolId, name: e.name, type: e.type ?? 'monthly', session_id: e.sessionId ?? null,
    start_date: e.startDate ? (e.startDate instanceof Date ? e.startDate.toISOString().slice(0, 10) : e.startDate) : null,
    end_date: e.endDate ? (e.endDate instanceof Date ? e.endDate.toISOString().slice(0, 10) : e.endDate) : null,
    created_at: e.createdAt,
  };
}

export function toPublicDatesheet(d: any): Record<string, unknown> {
  return {
    id: d.id, school_id: d.schoolId, exam_id: d.examId, class_id: d.classId, subject: d.subject,
    date: d.date instanceof Date ? d.date.toISOString().slice(0, 10) : d.date,
    start_time: d.startTime, end_time: d.endTime, created_at: d.createdAt,
  };
}

export function toPublicGradingScale(g: any): Record<string, unknown> {
  return {
    id: g.id, school_id: g.schoolId, class_id: g.classId ?? null,
    min_marks: g.minMarks, max_marks: g.maxMarks, grade: g.grade,
    gpa_points: g.gpaPoints, is_passing: g.isPassing, created_at: g.createdAt,
  };
}

async function getExamRow(db: Db, schoolId: string, id: string): Promise<any> {
  const e = await db.exam.findFirst({ where: { id, schoolId, deletedAt: null } });
  if (!e) throw ApiError.notFound('Exam not found');
  return e;
}

async function assertSessionUsable(db: Db, schoolId: string, sessionId: string | null | undefined): Promise<void> {
  if (!sessionId) return;
  const s = await db.academicSession.findFirst({ where: { id: sessionId, schoolId } });
  if (!s) throw ApiError.notFound('Session not found');
  if ((await getArchivedSessionIds(db, schoolId)).includes(sessionId)) {
    throw ApiError.conflict('This session is archived and read-only. Exams cannot be added to it.');
  }
}

// --- Exams -----------------------------------------------------------------
export async function listExams(
  db: Db, schoolId: string, query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  const where: Record<string, unknown> = { schoolId, deletedAt: null };
  if (query.session_id) where.sessionId = String(query.session_id);
  if (query.type) where.type = validateExamType(String(query.type));
  if (query.search) where.name = { contains: String(query.search), mode: 'insensitive' };
  let rows = await db.exam.findMany({ where, orderBy: [{ createdAt: 'desc' }] });
  // Archived sessions' exams are excluded from current lists (viewable by
  // explicit ?session_id= or ?include_archived=true).
  if (!query.session_id && query.include_archived !== 'true') {
    const archived = new Set(await getArchivedSessionIds(db, schoolId));
    rows = rows.filter((e: any) => !e.sessionId || !archived.has(e.sessionId));
  }
  const total = rows.length;
  return paginatedResponse(rows.slice(skip, skip + limit).map(toPublicExam), total, { page, limit, skip });
}

export async function createExam(
  db: Db, schoolId: string,
  input: { name: string; type?: string | null; session_id?: string | null; start_date?: string | null; end_date?: string | null },
  actorId: string,
): Promise<any> {
  const name = input.name?.trim();
  if (!name) throw ApiError.validation('name is required');
  const type = validateExamType(input.type ?? undefined);
  await assertSessionUsable(db, schoolId, input.session_id ?? null);
  if (input.start_date && !isValidDateString(input.start_date)) throw ApiError.validation('start_date must be YYYY-MM-DD');
  if (input.end_date && !isValidDateString(input.end_date)) throw ApiError.validation('end_date must be YYYY-MM-DD');
  if (input.start_date && input.end_date && input.start_date > input.end_date) throw ApiError.validation('start_date must be on or before end_date');
  const created = await db.exam.create({
    data: {
      schoolId, name, type, sessionId: input.session_id ?? null,
      startDate: input.start_date ? dateOnly(input.start_date) : null,
      endDate: input.end_date ? dateOnly(input.end_date) : null,
    },
  });
  await logCreate(db, {
    schoolId,
    actorId,
    entity: 'exam',
    entityId: created.id,
    after: { name: created.name, type: created.type, session_id: created.sessionId, start_date: created.startDate, end_date: created.endDate },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'exam.create', entity: 'exam', entityId: created.id, details: { name, type } });
  return toPublicExam(created);
}

export async function getExam(db: Db, schoolId: string, id: string): Promise<any> {
  return toPublicExam(await getExamRow(db, schoolId, id));
}

export async function updateExam(
  db: Db, schoolId: string, id: string,
  patch: { name?: string; type?: string | null; session_id?: string | null; start_date?: string | null; end_date?: string | null },
  actorId: string,
): Promise<any> {
  const e = await getExamRow(db, schoolId, id);
  if (e.sessionId && (await getArchivedSessionIds(db, schoolId)).includes(e.sessionId)) {
    throw ApiError.conflict('This exam belongs to an archived session and is read-only.');
  }
  await assertSessionUsable(db, schoolId, patch.session_id !== undefined ? patch.session_id : e.sessionId);
  const before = { name: e.name, type: e.type ?? 'monthly', session_id: e.sessionId, start_date: e.startDate, end_date: e.endDate };
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw ApiError.validation('name is required');
    data.name = name;
  }
  if (patch.type !== undefined) data.type = validateExamType(patch.type);
  if (patch.session_id !== undefined) data.sessionId = patch.session_id;
  if (patch.start_date !== undefined) {
    if (patch.start_date && !isValidDateString(patch.start_date)) throw ApiError.validation('start_date must be YYYY-MM-DD');
    data.startDate = patch.start_date ? dateOnly(patch.start_date) : null;
  }
  if (patch.end_date !== undefined) {
    if (patch.end_date && !isValidDateString(patch.end_date)) throw ApiError.validation('end_date must be YYYY-MM-DD');
    data.endDate = patch.end_date ? dateOnly(patch.end_date) : null;
  }
  const start = (data.startDate as Date | null | undefined) ?? e.startDate;
  const end = (data.endDate as Date | null | undefined) ?? e.endDate;
  if (start && end && start > end) throw ApiError.validation('start_date must be on or before end_date');
  if (Object.keys(data).length === 0) return toPublicExam(e);
  const updated = await db.exam.update({ where: { id }, data });
  await writeChangeLogs(db, { schoolId, actorId, entity: 'exam', entityId: id, before, after: { name: updated.name, type: updated.type ?? 'monthly', session_id: updated.sessionId, start_date: updated.startDate, end_date: updated.endDate } });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'exam.update', entity: 'exam', entityId: id, details: { name: updated.name, type: updated.type ?? 'monthly' } });
  return toPublicExam(updated);
}

export async function deleteExam(db: Db, schoolId: string, id: string, actorId: string): Promise<void> {
  await getExamRow(db, schoolId, id);
  await softDeleteEntity(db, { schoolId, entity: 'exam', entityId: id, deletedBy: actorId });
}

// --- Datesheets --------------------------------------------------------------
export async function listDatesheet(
  db: Db, schoolId: string, examId: string, query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  await getExamRow(db, schoolId, examId);
  const { page, limit, skip } = parsePagination(query);
  const where: Record<string, unknown> = { schoolId, examId };
  if (query.class_id) where.classId = String(query.class_id);
  const [rows, total] = await Promise.all([
    db.examDatesheet.findMany({ where, orderBy: [{ date: 'asc' }, { startTime: 'asc' }], skip, take: limit }),
    db.examDatesheet.count({ where }),
  ]);
  return paginatedResponse(rows.map(toPublicDatesheet), total, { page, limit, skip });
}

export async function createDatesheet(
  db: Db, schoolId: string, examId: string,
  input: { class_id: string; subject: string; date: string; start_time: string; end_time: string },
  actorId: string,
): Promise<any> {
  const exam = await getExamRow(db, schoolId, examId);
  if (exam.sessionId && (await getArchivedSessionIds(db, schoolId)).includes(exam.sessionId)) {
    throw ApiError.conflict('This exam belongs to an archived session and is read-only.');
  }
  const cls = await db.class.findFirst({ where: { id: input.class_id, schoolId, deletedAt: null } });
  if (!cls) throw ApiError.notFound('Class not found');
  const subject = input.subject?.trim();
  if (!subject) throw ApiError.validation('subject is required');
  if (!isValidDateString(input.date)) throw ApiError.validation('date must be YYYY-MM-DD');
  assertTimeRange(input.start_time, input.end_time);
  const dayRows = await db.examDatesheet.findMany({ where: { schoolId, classId: input.class_id, date: dateOnly(input.date) } });
  const sameExamSameSubject = dayRows.find((r: any) => r.examId === examId && r.subject.toLowerCase() === subject.toLowerCase());
  if (sameExamSameSubject) throw ApiError.conflict(`"${subject}" is already scheduled for this class on ${input.date} for this exam`);
  const clash = dayRows.find((r: any) => timesOverlap(input.start_time, input.end_time, r.startTime, r.endTime));
  if (clash) throw ApiError.conflict(`This paper overlaps "${clash.subject}" (${clash.startTime}–${clash.endTime}) for this class on ${input.date}`);
  const created = await db.examDatesheet.create({
    data: { schoolId, examId, classId: input.class_id, subject, date: dateOnly(input.date), startTime: input.start_time, endTime: input.end_time },
  });
  await logCreate(db, {
    schoolId,
    actorId,
    entity: 'exam_datesheet',
    entityId: created.id,
    after: { exam_id: examId, class_id: input.class_id, subject, date: input.date, start_time: input.start_time, end_time: input.end_time },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'exam_datesheet.create', entity: 'exam_datesheet', entityId: created.id, details: { exam_id: examId, class_id: input.class_id, subject, date: input.date } });
  return toPublicDatesheet(created);
}

export async function updateDatesheet(
  db: Db, schoolId: string, id: string,
  patch: { subject?: string; date?: string; start_time?: string; end_time?: string },
  actorId: string,
): Promise<any> {
  const row = await db.examDatesheet.findFirst({ where: { id, schoolId } });
  if (!row) throw ApiError.notFound('Datesheet entry not found');
  const exam = await getExamRow(db, schoolId, row.examId);
  if (exam.sessionId && (await getArchivedSessionIds(db, schoolId)).includes(exam.sessionId)) {
    throw ApiError.conflict('This exam belongs to an archived session and is read-only.');
  }
  const before = { subject: row.subject, date: row.date, start_time: row.startTime, end_time: row.endTime };
  const data: Record<string, unknown> = {};
  if (patch.subject !== undefined) {
    const subject = patch.subject.trim();
    if (!subject) throw ApiError.validation('subject is required');
    data.subject = subject;
  }
  if (patch.date !== undefined) {
    if (!isValidDateString(patch.date)) throw ApiError.validation('date must be YYYY-MM-DD');
    data.date = dateOnly(patch.date);
  }
  if (patch.start_time !== undefined) data.startTime = patch.start_time;
  if (patch.end_time !== undefined) data.endTime = patch.end_time;
  const start = (data.startTime as string | undefined) ?? row.startTime;
  const end = (data.endTime as string | undefined) ?? row.endTime;
  assertTimeRange(start, end);
  const date = (data.date as Date | undefined) ?? row.date;
  const subject = (data.subject as string | undefined) ?? row.subject;
  const dayRows = await db.examDatesheet.findMany({ where: { schoolId, classId: row.classId, date } });
  const dup = dayRows.find((r: any) => r.id !== id && r.examId === row.examId && r.subject.toLowerCase() === subject.toLowerCase());
  if (dup) throw ApiError.conflict(`"${subject}" is already scheduled for this class on that date for this exam`);
  const clash = dayRows.find((r: any) => r.id !== id && timesOverlap(start, end, r.startTime, r.endTime));
  if (clash) throw ApiError.conflict(`This paper overlaps "${clash.subject}" (${clash.startTime}–${clash.endTime}) for this class on that date`);
  if (Object.keys(data).length === 0) return toPublicDatesheet(row);
  const updated = await db.examDatesheet.update({ where: { id }, data });
  await writeChangeLogs(db, { schoolId, actorId, entity: 'exam_datesheet', entityId: id, before, after: { subject: updated.subject, date: updated.date, start_time: updated.startTime, end_time: updated.endTime } });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'exam_datesheet.update', entity: 'exam_datesheet', entityId: id, details: { subject: updated.subject } });
  return toPublicDatesheet(updated);
}

export async function deleteDatesheet(db: Db, schoolId: string, id: string, actorId: string): Promise<void> {
  const row = await db.examDatesheet.findFirst({ where: { id, schoolId } });
  if (!row) throw ApiError.notFound('Datesheet entry not found');
  const snapshot = JSON.parse(JSON.stringify(row, (_k, v) => (v instanceof Date ? v.toISOString() : v)));
  await db.examDatesheet.delete({ where: { id } });
  await (db as any).deletedRecord.create({
    data: { schoolId, entity: 'exam_datesheet', entityId: id, snapshot, deletedBy: actorId, deletedAt: new Date(), restoreBy: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  });
  await logDelete(db, {
    schoolId,
    actorId,
    entity: 'exam_datesheet',
    entityId: id,
    before: { exam_id: row.examId, class_id: row.classId, subject: row.subject, date: row.date, start_time: row.startTime, end_time: row.endTime },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'exam_datesheet.delete', entity: 'exam_datesheet', entityId: id, details: { subject: row.subject } });
}

// --- Grading scales ----------------------------------------------------------
export const DEFAULT_GRADING_BANDS: Array<{ min_marks: number; max_marks: number; grade: string; gpa_points: number; is_passing: boolean }> = [
  { min_marks: 90, max_marks: 100, grade: 'A+', gpa_points: 4.0, is_passing: true },
  { min_marks: 80, max_marks: 89, grade: 'A', gpa_points: 3.7, is_passing: true },
  { min_marks: 70, max_marks: 79, grade: 'B', gpa_points: 3.0, is_passing: true },
  { min_marks: 60, max_marks: 69, grade: 'C', gpa_points: 2.0, is_passing: true },
  { min_marks: 50, max_marks: 59, grade: 'D', gpa_points: 1.0, is_passing: true },
  { min_marks: 0, max_marks: 49, grade: 'F', gpa_points: 0, is_passing: false },
];

function assertBandRange(minMarks: number, maxMarks: number, gpaPoints: number): void {
  if (!Number.isInteger(minMarks) || minMarks < 0) throw ApiError.validation('min_marks must be an integer >= 0');
  if (!Number.isInteger(maxMarks) || maxMarks <= minMarks) throw ApiError.validation('max_marks must be an integer greater than min_marks');
  if (typeof gpaPoints !== 'number' || gpaPoints < 0) throw ApiError.validation('gpa_points must be a number >= 0');
}

async function assertNoOverlap(db: Db, schoolId: string, classId: string | null, minMarks: number, maxMarks: number, excludeId?: string): Promise<void> {
  const rows = await db.gradingScale.findMany({ where: { schoolId, classId } });
  const clash = rows.find((r: any) => r.id !== excludeId && minMarks <= r.maxMarks && maxMarks >= r.minMarks);
  if (clash) throw ApiError.conflict(`Grade band ${minMarks}–${maxMarks} overlaps the existing "${clash.grade}" band (${clash.minMarks}–${clash.maxMarks})`);
}

export async function listGradingScales(db: Db, schoolId: string, query: Record<string, any>): Promise<any[]> {
  const where: Record<string, unknown> = { schoolId };
  if (query.class_id) {
    // Applicable scales for a class: its own bands, then the school default
    // (class_id NULL) for anything not overridden.
    const own = await db.gradingScale.findMany({ where: { schoolId, classId: String(query.class_id) }, orderBy: [{ minMarks: 'desc' }] });
    const defaults = await db.gradingScale.findMany({ where: { schoolId, classId: null }, orderBy: [{ minMarks: 'desc' }] });
    return [...own, ...defaults].map(toPublicGradingScale);
  }
  const rows = await db.gradingScale.findMany({ where, orderBy: [{ classId: 'asc' }, { minMarks: 'desc' }] });
  return rows.map(toPublicGradingScale);
}

export async function createGradingScale(
  db: Db, schoolId: string,
  input: { class_id?: string | null; min_marks: number; max_marks: number; grade: string; gpa_points: number; is_passing?: boolean },
  actorId: string,
): Promise<any> {
  const classId = input.class_id ?? null;
  if (classId) {
    const cls = await db.class.findFirst({ where: { id: classId, schoolId, deletedAt: null } });
    if (!cls) throw ApiError.notFound('Class not found');
  }
  const grade = input.grade?.trim();
  if (!grade) throw ApiError.validation('grade is required');
  assertBandRange(input.min_marks, input.max_marks, input.gpa_points);
  await assertNoOverlap(db, schoolId, classId, input.min_marks, input.max_marks);
  const created = await db.gradingScale.create({
    data: { schoolId, classId, minMarks: input.min_marks, maxMarks: input.max_marks, grade, gpaPoints: input.gpa_points, isPassing: input.is_passing ?? true },
  });
  await logCreate(db, {
    schoolId,
    actorId,
    entity: 'grading_scale',
    entityId: created.id,
    after: { class_id: classId, min_marks: created.minMarks, max_marks: created.maxMarks, grade, gpa_points: created.gpaPoints, is_passing: created.isPassing },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'grading_scale.create', entity: 'grading_scale', entityId: created.id, details: { grade, class_id: classId } });
  return toPublicGradingScale(created);
}

export async function updateGradingScale(
  db: Db, schoolId: string, id: string,
  patch: { min_marks?: number; max_marks?: number; grade?: string; gpa_points?: number; is_passing?: boolean },
  actorId: string,
): Promise<any> {
  const row = await db.gradingScale.findFirst({ where: { id, schoolId } });
  if (!row) throw ApiError.notFound('Grading scale not found');
  const before = { min_marks: row.minMarks, max_marks: row.maxMarks, grade: row.grade, gpa_points: row.gpaPoints, is_passing: row.isPassing };
  const minMarks = patch.min_marks ?? row.minMarks;
  const maxMarks = patch.max_marks ?? row.maxMarks;
  const gpaPoints = patch.gpa_points ?? row.gpaPoints;
  assertBandRange(minMarks, maxMarks, gpaPoints);
  await assertNoOverlap(db, schoolId, row.classId ?? null, minMarks, maxMarks, id);
  const data: Record<string, unknown> = { minMarks, maxMarks, gpaPoints };
  if (patch.grade !== undefined) {
    const grade = patch.grade.trim();
    if (!grade) throw ApiError.validation('grade is required');
    data.grade = grade;
  }
  if (patch.is_passing !== undefined) data.isPassing = patch.is_passing;
  const updated = await db.gradingScale.update({ where: { id }, data });
  await writeChangeLogs(db, { schoolId, actorId, entity: 'grading_scale', entityId: id, before, after: { min_marks: updated.minMarks, max_marks: updated.maxMarks, grade: updated.grade, gpa_points: updated.gpaPoints, is_passing: updated.isPassing } });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'grading_scale.update', entity: 'grading_scale', entityId: id, details: { grade: updated.grade } });
  return toPublicGradingScale(updated);
}

export async function deleteGradingScale(db: Db, schoolId: string, id: string, actorId: string): Promise<void> {
  const row = await db.gradingScale.findFirst({ where: { id, schoolId } });
  if (!row) throw ApiError.notFound('Grading scale not found');
  await db.gradingScale.delete({ where: { id } });
  await logDelete(db, {
    schoolId,
    actorId,
    entity: 'grading_scale',
    entityId: id,
    before: { class_id: row.classId, min_marks: row.minMarks, max_marks: row.maxMarks, grade: row.grade },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'grading_scale.delete', entity: 'grading_scale', entityId: id, details: { grade: row.grade } });
}

export async function seedDefaultGradingScales(db: Db, schoolId: string, actorId: string): Promise<any[]> {
  const existing = await db.gradingScale.count({ where: { schoolId, classId: null } });
  if (existing > 0) throw ApiError.conflict('A school-default grading scale already exists');
  const created: any[] = [];
  for (const band of DEFAULT_GRADING_BANDS) {
    created.push(await db.gradingScale.create({
      data: { schoolId, classId: null, minMarks: band.min_marks, maxMarks: band.max_marks, grade: band.grade, gpaPoints: band.gpa_points, isPassing: band.is_passing },
    }));
  }
  for (const band of created) {
    await logCreate(db, {
      schoolId,
      actorId,
      entity: 'grading_scale',
      entityId: band.id,
      after: { class_id: null, min_marks: band.minMarks, max_marks: band.maxMarks, grade: band.grade, gpa_points: band.gpaPoints, is_passing: band.isPassing },
    });
  }
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'grading_scale.seed_defaults', entity: 'grading_scale', entityId: null, details: { bands: created.length } });
  return created.map(toPublicGradingScale);
}

/**
 * Passing marks for a class: the lowest min_marks among bands with
 * is_passing = true. Class-specific bands win; the school default
 * (class_id NULL) is the fallback. Returns null when no passing band exists.
 */
export async function getPassingMarks(
  db: Db, schoolId: string, classId?: string | null,
): Promise<{ passing_marks: number | null; grade: string | null; source: 'class' | 'school-default' | null }> {
  if (classId) {
    const cls = await db.class.findFirst({ where: { id: classId, schoolId, deletedAt: null } });
    if (!cls) throw ApiError.notFound('Class not found');
    const own = await db.gradingScale.findMany({ where: { schoolId, classId } });
    const passing = own.filter((r: any) => r.isPassing).sort((a: any, b: any) => a.minMarks - b.minMarks);
    if (passing.length > 0) return { passing_marks: passing[0].minMarks, grade: passing[0].grade, source: 'class' };
  }
  const defaults = await db.gradingScale.findMany({ where: { schoolId, classId: null } });
  const passing = defaults.filter((r: any) => r.isPassing).sort((a: any, b: any) => a.minMarks - b.minMarks);
  if (passing.length > 0) return { passing_marks: passing[0].minMarks, grade: passing[0].grade, source: 'school-default' };
  return { passing_marks: null, grade: null, source: null };
}
