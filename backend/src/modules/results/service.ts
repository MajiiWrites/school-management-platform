// Results module (6B) — result sheets (OCR), review/save, manual entry,
// toppers, summaries, report cards, export, and admin-approved SMS on
// publish. Every query is scoped by the JWT school_id; clerk mutations
// go through the approval queue at the route layer (requireQueueable);
// every edit writes change_logs via writeChangeLogs.
//
// Linking rule (SCHEMA.md §6 + task): results link to existing students
// by roll_no (first) or normalized name (second). A roll/name MISMATCH
// (roll points at student A, name at student B) is NEVER auto-resolved —
// the row stays unlinked with flag `link_mismatch` for an explicit
// POST /results/:id/link. Students are NEVER auto-created or overwritten.
//
// Defaults (documented, see RESULTS.md):
//   - Passing marks: the lowest passing band of the class/school grading
//     scale when scales exist, else 33%.
//   - Grade when no grading scale exists: A>=80, B>=70, C>=60, D>=50,
//     E>=40, F below.
//   - Positions: dense rank by percentage desc within (exam, class);
//     equal percentages share a position. Recomputed on every save/update.
import PDFDocument from 'pdfkit';
import { ApiError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { writeChangeLogs, softDeleteEntity } from '../hardening/helpers';
import { paginatedResponse, parsePagination } from '../../lib/pagination';
import { normalizeName } from '../../lib/crypto';
import { runOcr } from '../ocr/ocr-engine';
import { parseResultSheet, type ParsedResultRow } from '../ocr/resultSheets';
import { exportPdf, exportXlsx } from '../reports/service';
import type { Db } from '../../lib/db';

export const DEFAULT_PASS_PERCENTAGE = 33;

export const DEFAULT_GRADE_BANDS: Array<{ min: number; grade: string }> = [
  { min: 80, grade: 'A' },
  { min: 70, grade: 'B' },
  { min: 60, grade: 'C' },
  { min: 50, grade: 'D' },
  { min: 40, grade: 'E' },
  { min: 0, grade: 'F' },
];

export interface ResultRowInput {
  roll_no: number;
  student_name: string;
  father_name?: string | null;
  subject_marks?: Record<string, number>;
  obtained_marks?: number | null;
  total_marks?: number | null;
  percentage?: number | null;
  grade?: string | null;
  position?: number | null;
  remarks?: string | null;
  confidence?: Record<string, number> | null;
  /** Explicit student link chosen by the admin in the review table. */
  student_id?: string | null;
}

export interface SaveResult {
  saved: number;
  linked: number;
  unlinked: number;
  /** Exam the rows were saved under — the frontend uses this to refresh
   * the exam filter and select the (possibly just auto-created) exam. */
  exam_id: string;
  exam_name: string;
  skipped: Array<{ row: number; reason: string }>;
  /** Rows that saved with review flags (e.g. obtained_gt_total). */
  flagged: Array<{ roll_no: number; flags: string[] }>;
}

export interface UploadResult {
  result_sheet_id: string;
  exam_id: string;
  raw_text: string;
  headings: string[];
  rows: ParsedResultRow[];
  engine: string;
  warnings: string[];
}

function toISODate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return new Date(d).toISOString().slice(0, 10);
}

export function toPublicResult(r: any): Record<string, unknown> {
  return {
    id: r.id,
    school_id: r.schoolId,
    result_sheet_id: r.resultSheetId ?? null,
    exam_id: r.examId,
    class_id: r.classId,
    student_id: r.studentId ?? null,
    roll_no: r.rollNo,
    student_name: r.studentName,
    father_name: r.fatherName ?? null,
    subject_marks: r.subjectMarks ?? {},
    obtained_marks: r.obtainedMarks ?? null,
    total_marks: r.totalMarks ?? null,
    percentage: r.percentage ?? null,
    grade: r.grade ?? null,
    position: r.position ?? null,
    remarks: r.remarks ?? null,
    linked: Boolean(r.studentId),
    linked_at: r.linkedAt ?? null,
    created_at: r.createdAt,
  };
}

export function toPublicSheet(s: any): Record<string, unknown> {
  return {
    id: s.id,
    school_id: s.schoolId,
    exam_id: s.examId,
    class_id: s.classId,
    session_id: s.sessionId ?? null,
    file_path: s.filePath,
    status: s.status,
    created_at: s.createdAt,
  };
}

export function toPublicExam(e: any): Record<string, unknown> {
  return {
    id: e.id,
    school_id: e.schoolId,
    name: e.name,
    session_id: e.sessionId ?? null,
    start_date: toISODate(e.startDate),
    end_date: toISODate(e.endDate),
    created_at: e.createdAt,
  };
}

function resultChangeView(r: any): Record<string, unknown> {
  return {
    roll_no: r.rollNo,
    student_name: r.studentName,
    father_name: r.fatherName ?? null,
    subject_marks: r.subjectMarks ?? {},
    obtained_marks: r.obtainedMarks ?? null,
    total_marks: r.totalMarks ?? null,
    percentage: r.percentage ?? null,
    grade: r.grade ?? null,
    position: r.position ?? null,
    remarks: r.remarks ?? null,
    student_id: r.studentId ?? null,
  };
}

async function assertClassInSchool(db: Db, schoolId: string, classId: string): Promise<any> {
  const c = await db.class.findFirst({ where: { id: classId, schoolId, deletedAt: null } });
  if (!c) throw ApiError.notFound('Class not found');
  return c;
}

async function assertExamInSchool(db: Db, schoolId: string, examId: string): Promise<any> {
  const e = await db.exam.findFirst({ where: { id: examId, schoolId, deletedAt: null } });
  if (!e) throw ApiError.notFound('Exam not found');
  return e;
}

/**
 * Exam upsert (6B): the results flow creates the exam row when the named
 * exam does not exist yet for this school/session. There is deliberately
 * NO backend/src/modules/exams/** — the full exams/datesheet module
 * belongs to 6C-1; this is only the minimal upsert the results save path
 * needs (Prisma directly, per task).
 */
export async function upsertExam(
  db: Db,
  schoolId: string,
  input: { name: string; session_id?: string | null; start_date?: string | null; end_date?: string | null },
): Promise<any> {
  const name = input.name.trim();
  if (!name) throw ApiError.validation('Exam name is required');
  const existing = await db.exam.findFirst({
    where: { schoolId, name, sessionId: input.session_id ?? null, deletedAt: null },
  });
  if (existing) return existing;
  if (input.session_id) {
    const session = await db.academicSession.findFirst({ where: { id: input.session_id, schoolId } });
    if (!session) throw ApiError.notFound('Academic session not found');
  }
  return db.exam.create({
    data: {
      schoolId,
      name,
      sessionId: input.session_id ?? null,
      startDate: input.start_date ? new Date(input.start_date) : null,
      endDate: input.end_date ? new Date(input.end_date) : null,
    },
  });
}

/** Grading scales for a class: class-specific rows first, then school-wide (class_id NULL). */
async function loadScales(db: Db, schoolId: string, classId: string): Promise<any[]> {
  const [specific, global] = await Promise.all([
    db.gradingScale.findMany({ where: { schoolId, classId } }),
    db.gradingScale.findMany({ where: { schoolId, classId: null } }),
  ]);
  return [...specific, ...global];
}

/** Grade + pass/fail for a percentage. Scale bands are percentage bands (min/max 0–100). */
export async function gradeForPercentage(
  db: Db,
  schoolId: string,
  classId: string,
  percentage: number | null,
): Promise<{ grade: string | null; isPassing: boolean }> {
  if (percentage === null || percentage === undefined) return { grade: null, isPassing: false };
  const scales = await loadScales(db, schoolId, classId);
  if (scales.length > 0) {
    const band = scales.find((s: any) => percentage >= s.minMarks && percentage <= s.maxMarks);
    if (band) return { grade: band.grade, isPassing: Boolean(band.isPassing) };
  }
  const band = DEFAULT_GRADE_BANDS.find((b) => percentage >= b.min);
  return { grade: band ? band.grade : 'F', isPassing: percentage >= DEFAULT_PASS_PERCENTAGE };
}

/** Passing threshold for a class: lowest passing scale band, else 33%. */
export async function passingThreshold(db: Db, schoolId: string, classId: string): Promise<number> {
  const scales = await loadScales(db, schoolId, classId);
  const passing = scales.filter((s: any) => s.isPassing);
  if (passing.length === 0) return DEFAULT_PASS_PERCENTAGE;
  return Math.min(...passing.map((s: any) => s.minMarks));
}

function computeDerived(row: ResultRowInput): { obtained: number | null; total: number | null; percentage: number | null } {
  const subjects = row.subject_marks ?? {};
  const subjectSum = Object.values(subjects).reduce((a, b) => a + (Number(b) || 0), 0);
  const obtained = row.obtained_marks ?? (Object.keys(subjects).length > 0 ? subjectSum : null);
  const total = row.total_marks ?? null;
  // Percentage is DERIVED from obtained/total whenever both are present —
  // a stale or mis-read OCR percentage must never survive a marks change.
  // The sheet's own percentage is used only when marks are missing.
  let percentage: number | null = null;
  if (obtained !== null && total !== null && total > 0) {
    percentage = Math.round((obtained / total) * 10000) / 100;
  } else {
    percentage = row.percentage ?? null;
  }
  return { obtained, total, percentage };
}

/**
 * Link a parsed row to an existing student in the same class.
 * Roll match wins; exact normalized-name match is the fallback. When both
 * exist but point at DIFFERENT students, the row is left unlinked with
 * `link_mismatch` — an admin must resolve it explicitly via linkResult.
 */
export async function linkStudentForRow(
  db: Db,
  schoolId: string,
  classId: string,
  row: { roll_no: number | null; student_name: string },
): Promise<{ studentId: string | null; method: 'roll' | 'name' | null; mismatch: boolean }> {
  let byRoll: any = null;
  let byName: any = null;
  if (row.roll_no !== null && row.roll_no !== undefined) {
    byRoll = await db.student.findFirst({ where: { schoolId, classId, rollNo: row.roll_no, deletedAt: null } });
  }
  const inClass = await db.student.findMany({ where: { schoolId, classId, deletedAt: null } });
  const norm = normalizeName(row.student_name);
  const nameMatches = inClass.filter((s: any) => normalizeName(s.name) === norm);
  if (nameMatches.length === 1) byName = nameMatches[0];
  if (byRoll && byName && byRoll.id !== byName.id) {
    return { studentId: null, method: null, mismatch: true };
  }
  if (byRoll) return { studentId: byRoll.id, method: 'roll', mismatch: false };
  if (byName) return { studentId: byName.id, method: 'name', mismatch: false };
  return { studentId: null, method: null, mismatch: false };
}

/** Dense-rank positions within (exam, class) by percentage desc; ties share a position. */
export async function recomputePositions(db: Db, schoolId: string, examId: string, classId: string): Promise<void> {
  const rows = await db.result.findMany({ where: { schoolId, examId, classId, deletedAt: null } });
  const sorted = [...rows].sort((a: any, b: any) => {
    const pa = a.percentage ?? -1;
    const pb = b.percentage ?? -1;
    if (pb !== pa) return pb - pa;
    return (a.rollNo ?? 0) - (b.rollNo ?? 0);
  });
  let position = 0;
  let lastPct: number | null = null;
  let seenAny = false;
  for (const r of sorted) {
    const pct = r.percentage ?? -1;
    if (!seenAny || pct !== lastPct) {
      position += 1;
      lastPct = pct;
      seenAny = true;
    }
    if (r.position !== position) {
      await db.result.update({ where: { id: r.id }, data: { position } });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Upload (OCR) + review                                               */
/* ------------------------------------------------------------------ */

export async function uploadResultSheet(
  db: Db,
  schoolId: string,
  classId: string,
  input: { exam_name: string; session_id?: string | null; file_path: string },
  actorId?: string | null,
  opts: { runOcr?: (filePath: string) => Promise<{ raw_text: string; engine: string; warnings: string[] }> } = {},
): Promise<UploadResult> {
  await assertClassInSchool(db, schoolId, classId);
  const exam = await upsertExam(db, schoolId, { name: input.exam_name, session_id: input.session_id ?? null });
  const sheet = await db.resultSheet.create({
    data: {
      schoolId,
      examId: exam.id,
      classId,
      sessionId: input.session_id ?? null,
      filePath: input.file_path,
      status: 'processing',
    },
  });
  try {
    const ocr = opts.runOcr ? await opts.runOcr(input.file_path) : await runOcr(input.file_path);
    const parsed = parseResultSheet(ocr.raw_text);
    await db.resultSheet.update({ where: { id: sheet.id }, data: { status: 'review', rawText: ocr.raw_text } });
    await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'result_sheet.upload', entity: 'result_sheet', entityId: sheet.id, details: { class_id: classId, exam_id: exam.id, engine: ocr.engine, rows_found: parsed.rows.length } });
    return {
      result_sheet_id: sheet.id,
      exam_id: exam.id,
      raw_text: ocr.raw_text,
      headings: parsed.headings,
      rows: parsed.rows,
      engine: ocr.engine,
      warnings: [...(ocr.warnings ?? []), ...parsed.warnings],
    };
  } catch (err) {
    await db.resultSheet.update({ where: { id: sheet.id }, data: { status: 'failed' } }).catch(() => undefined);
    throw err;
  }
}

/** Review data for a sheet: re-parse the stored raw text + link preview per row. */
export async function getSheetForReview(db: Db, schoolId: string, sheetId: string): Promise<Record<string, unknown>> {
  const sheet = await db.resultSheet.findFirst({ where: { id: sheetId, schoolId, deletedAt: null } });
  if (!sheet) throw ApiError.notFound('Result sheet not found');
  const exam = await assertExamInSchool(db, schoolId, sheet.examId);
  const klass = await assertClassInSchool(db, schoolId, sheet.classId);
  const parsed = parseResultSheet(sheet.rawText ?? '');
  const rows = [];
  for (const row of parsed.rows) {
    const link = await linkStudentForRow(db, schoolId, sheet.classId, row);
    rows.push({ ...row, link_preview: link });
  }
  return {
    result_sheet_id: sheet.id,
    exam: toPublicExam(exam),
    class: { id: klass.id, name: klass.name, section: klass.section, display_name: `${klass.name}-${klass.section}` },
    status: sheet.status,
    raw_text: sheet.rawText ?? '',
    headings: parsed.headings,
    warnings: parsed.warnings,
    rows,
  };
}

/* ------------------------------------------------------------------ */
/* Save (confirm) + manual entry                                       */
/* ------------------------------------------------------------------ */

/**
 * Save reviewed rows as results. Upserts by the unique (exam, class,
 * roll_no) key; existing rows are updated (change_logs written), never
 * duplicated. Flags (obtained_gt_total, duplicate_roll, link_mismatch)
 * are reported but do not block a reviewed save — the admin saw them in
 * the review table. Positions are recomputed for the whole exam+class.
 */
export async function saveResultRows(
  db: Db,
  schoolId: string,
  input: { exam_id: string; class_id: string; result_sheet_id?: string | null; rows: ResultRowInput[] },
  actorId?: string | null,
): Promise<SaveResult> {
  const exam = await assertExamInSchool(db, schoolId, input.exam_id);
  const klass = await assertClassInSchool(db, schoolId, input.class_id);
  if (!Array.isArray(input.rows) || input.rows.length === 0) {
    throw ApiError.validation('rows must be a non-empty array');
  }
  if (input.result_sheet_id) {
    const sheet = await db.resultSheet.findFirst({ where: { id: input.result_sheet_id, schoolId, deletedAt: null } });
    if (!sheet) throw ApiError.notFound('Result sheet not found');
    if (sheet.examId !== input.exam_id || sheet.classId !== input.class_id) {
      throw ApiError.validation('Result sheet does not belong to this exam and class');
    }
  }
  const out: SaveResult = { saved: 0, linked: 0, unlinked: 0, exam_id: input.exam_id, exam_name: exam.name, skipped: [], flagged: [] };
  const seenRolls = new Set<number>();
  for (let i = 0; i < input.rows.length; i++) {
    const row = input.rows[i]!;
    const label = `row ${i + 1}`;
    if (row.roll_no === null || row.roll_no === undefined || !Number.isInteger(row.roll_no)) {
      out.skipped.push({ row: i + 1, reason: `${label}: roll_no is required` });
      continue;
    }
    const name = (row.student_name ?? '').trim();
    if (!name) {
      out.skipped.push({ row: i + 1, reason: `${label}: student_name is required` });
      continue;
    }
    if (seenRolls.has(row.roll_no)) {
      out.skipped.push({ row: i + 1, reason: `${label}: duplicate roll_no ${row.roll_no} in this upload` });
      continue;
    }
    seenRolls.add(row.roll_no);
    const { obtained, total, percentage } = computeDerived({ ...row, student_name: name });
    const { grade } = await gradeForPercentage(db, schoolId, input.class_id, percentage);
    const flags: string[] = [];
    if (obtained !== null && total !== null && obtained > total) flags.push('obtained_gt_total');

    // Link: explicit student_id from the review table wins (admin-confirmed);
    // otherwise roll/name auto-match; mismatch stays unlinked.
    let studentId: string | null = null;
    let linkMismatch = false;
    if (row.student_id) {
      const s = await db.student.findFirst({ where: { id: row.student_id, schoolId, deletedAt: null } });
      if (!s) {
        out.skipped.push({ row: i + 1, reason: `${label}: linked student not found in this school` });
        continue;
      }
      if (s.classId !== input.class_id) {
        out.skipped.push({ row: i + 1, reason: `${label}: linked student is not in class ${klass.name}-${klass.section}` });
        continue;
      }
      studentId = s.id;
    } else {
      const link = await linkStudentForRow(db, schoolId, input.class_id, { roll_no: row.roll_no, student_name: name });
      studentId = link.studentId;
      linkMismatch = link.mismatch;
      if (linkMismatch) flags.push('link_mismatch');
    }

    const data = {
      schoolId,
      resultSheetId: input.result_sheet_id ?? null,
      examId: input.exam_id,
      classId: input.class_id,
      studentId,
      rollNo: row.roll_no,
      studentName: name,
      fatherName: row.father_name?.trim() || null,
      subjectMarks: row.subject_marks ?? {},
      obtainedMarks: obtained,
      totalMarks: total,
      percentage,
      grade: row.grade ?? grade,
      remarks: row.remarks?.trim() || null,
      confidence: row.confidence ?? null,
      linkedAt: studentId ? new Date() : null,
    };
    const existing = await db.result.findFirst({
      where: { schoolId, examId: input.exam_id, classId: input.class_id, rollNo: row.roll_no, deletedAt: null },
    });
    if (existing) {
      const beforeView = resultChangeView(existing);
      const updated = await db.result.update({ where: { id: existing.id }, data });
      await writeChangeLogs(db, { schoolId, actorId: actorId ?? null, entity: 'result', entityId: existing.id, before: beforeView, after: resultChangeView(updated) });
    } else {
      await db.result.create({ data });
    }
    out.saved += 1;
    if (studentId) out.linked += 1;
    else out.unlinked += 1;
    if (flags.length > 0) out.flagged.push({ roll_no: row.roll_no, flags });
  }
  await recomputePositions(db, schoolId, input.exam_id, input.class_id);
  if (input.result_sheet_id) {
    await db.resultSheet.update({ where: { id: input.result_sheet_id }, data: { status: 'saved' } });
  }
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'result.save', entity: 'exam', entityId: input.exam_id, details: { class_id: input.class_id, exam_name: exam.name, saved: out.saved, linked: out.linked, unlinked: out.unlinked } });
  return out;
}

/** Manual entry without a sheet: creates the exam row if needed, then saves. */
export async function saveManualResults(
  db: Db,
  schoolId: string,
  input: { exam_name?: string; exam_id?: string; class_id: string; session_id?: string | null; rows: ResultRowInput[] },
  actorId?: string | null,
): Promise<SaveResult> {
  let examId = input.exam_id ?? null;
  if (!examId) {
    if (!input.exam_name) throw ApiError.validation('exam_id or exam_name is required');
    const exam = await upsertExam(db, schoolId, { name: input.exam_name, session_id: input.session_id ?? null });
    examId = exam.id;
  }
  if (!examId) throw ApiError.validation('exam_id or exam_name is required');
  return saveResultRows(db, schoolId, { exam_id: examId, class_id: input.class_id, result_sheet_id: null, rows: input.rows }, actorId);
}

/* ------------------------------------------------------------------ */
/* Read / update / link / delete                                       */
/* ------------------------------------------------------------------ */

export async function listResults(
  db: Db,
  schoolId: string,
  query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  const where: Record<string, unknown> = { schoolId, deletedAt: null };
  if (query.exam_id) where.examId = String(query.exam_id);
  if (query.class_id) where.classId = String(query.class_id);
  if (query.student_id) where.studentId = String(query.student_id);
  if (query.linked === 'true') where.studentId = { not: null };
  if (query.linked === 'false') where.studentId = null;
  const search = String(query.search ?? '').trim();
  const or: Record<string, unknown>[] = [];
  if (search) {
    or.push({ studentName: { contains: search, mode: 'insensitive' } });
    const asNum = Number.parseInt(search, 10);
    if (!Number.isNaN(asNum)) or.push({ rollNo: asNum });
  }
  const whereWithSearch = or.length > 0 ? { ...where, OR: or } : where;
  const [items, total] = await Promise.all([
    db.result.findMany({ where: whereWithSearch, orderBy: [{ position: 'asc' }, { rollNo: 'asc' }], skip, take: limit }),
    db.result.count({ where: whereWithSearch }),
  ]);
  return paginatedResponse(items.map(toPublicResult), total, { page, limit, skip });
}

export async function getResult(db: Db, schoolId: string, id: string): Promise<any> {
  const r = await db.result.findFirst({ where: { id, schoolId, deletedAt: null } });
  if (!r) throw ApiError.notFound('Result not found');
  return r;
}

export async function updateResult(
  db: Db,
  schoolId: string,
  id: string,
  patch: Partial<ResultRowInput>,
  actorId?: string | null,
): Promise<any> {
  const existing = await getResult(db, schoolId, id);
  const merged: ResultRowInput = {
    roll_no: patch.roll_no ?? existing.rollNo,
    student_name: patch.student_name ?? existing.studentName,
    father_name: patch.father_name !== undefined ? patch.father_name : existing.fatherName,
    subject_marks: patch.subject_marks ?? existing.subjectMarks ?? {},
    obtained_marks: patch.obtained_marks !== undefined ? patch.obtained_marks : existing.obtainedMarks,
    total_marks: patch.total_marks !== undefined ? patch.total_marks : existing.totalMarks,
    percentage: patch.percentage !== undefined ? patch.percentage : existing.percentage,
    remarks: patch.remarks !== undefined ? patch.remarks : existing.remarks,
  };
  if (patch.roll_no !== undefined && patch.roll_no !== existing.rollNo) {
    const clash = await db.result.findFirst({ where: { schoolId, examId: existing.examId, classId: existing.classId, rollNo: patch.roll_no, deletedAt: null } });
    if (clash && clash.id !== id) throw ApiError.conflict(`Roll number ${patch.roll_no} already has a result in this exam and class`);
  }
  const { obtained, total, percentage } = computeDerived(merged);
  const { grade } = await gradeForPercentage(db, schoolId, existing.classId, percentage);
  const beforeView = resultChangeView(existing);
  const updated = await db.result.update({
    where: { id },
    data: {
      rollNo: merged.roll_no,
      studentName: merged.student_name.trim(),
      fatherName: merged.father_name?.trim() || null,
      subjectMarks: merged.subject_marks,
      obtainedMarks: obtained,
      totalMarks: total,
      percentage,
      grade: patch.grade ?? grade,
      remarks: merged.remarks?.trim() || null,
    },
  });
  await writeChangeLogs(db, { schoolId, actorId: actorId ?? null, entity: 'result', entityId: id, before: beforeView, after: resultChangeView(updated) });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'result.update', entity: 'result', entityId: id, details: { roll_no: merged.roll_no } });
  await recomputePositions(db, schoolId, existing.examId, existing.classId);
  return db.result.findFirst({ where: { id, schoolId, deletedAt: null } });
}

/**
 * Explicit link (admin-confirmed in the UI via ConfirmDialog): attach an
 * unlinked result row to an existing student in the SAME class. Never
 * creates or overwrites a student.
 */
export async function linkResult(db: Db, schoolId: string, id: string, studentId: string, actorId?: string | null): Promise<any> {
  const existing = await getResult(db, schoolId, id);
  const student = await db.student.findFirst({ where: { id: studentId, schoolId, deletedAt: null } });
  if (!student) throw ApiError.notFound('Student not found');
  if (student.classId !== existing.classId) {
    throw ApiError.validation('Student is not in the same class as this result');
  }
  const beforeView = resultChangeView(existing);
  const updated = await db.result.update({ where: { id }, data: { studentId, linkedAt: new Date() } });
  await writeChangeLogs(db, { schoolId, actorId: actorId ?? null, entity: 'result', entityId: id, before: beforeView, after: resultChangeView(updated) });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'result.link', entity: 'result', entityId: id, details: { student_id: studentId, roll_no: existing.rollNo } });
  return updated;
}

/** Soft delete (6A recycle-bin helpers): result / sheet / exam. */
export async function deleteResult(db: Db, schoolId: string, id: string, actorId?: string | null): Promise<void> {
  await getResult(db, schoolId, id);
  await softDeleteEntity(db, { schoolId, entity: 'result', entityId: id, deletedBy: actorId ?? null });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'result.delete', entity: 'result', entityId: id, details: { soft_deleted: true } });
}

export async function deleteResultSheet(db: Db, schoolId: string, id: string, actorId?: string | null): Promise<void> {
  const sheet = await db.resultSheet.findFirst({ where: { id, schoolId, deletedAt: null } });
  if (!sheet) throw ApiError.notFound('Result sheet not found');
  await softDeleteEntity(db, { schoolId, entity: 'result_sheet', entityId: id, deletedBy: actorId ?? null });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'result_sheet.delete', entity: 'result_sheet', entityId: id, details: { soft_deleted: true } });
}

/* ------------------------------------------------------------------ */
/* Toppers / summary / report card / export                             */
/* ------------------------------------------------------------------ */

export async function getToppers(db: Db, schoolId: string, query: Record<string, any>): Promise<Record<string, unknown>[]> {
  const examId = String(query.exam_id ?? '');
  const classId = String(query.class_id ?? '');
  if (!examId || !classId) throw ApiError.validation('exam_id and class_id are required');
  await assertExamInSchool(db, schoolId, examId);
  await assertClassInSchool(db, schoolId, classId);
  const limit = Math.min(50, Math.max(1, Number(query.limit ?? 10) || 10));
  const rows = await db.result.findMany({
    where: { schoolId, examId, classId, deletedAt: null },
    orderBy: [{ position: 'asc' }, { percentage: 'desc' }],
    take: limit,
  });
  return rows.map(toPublicResult);
}

export async function getSummary(db: Db, schoolId: string, query: Record<string, any>): Promise<Record<string, unknown>> {
  const examId = String(query.exam_id ?? '');
  const classId = String(query.class_id ?? '');
  if (!examId || !classId) throw ApiError.validation('exam_id and class_id are required');
  const exam = await assertExamInSchool(db, schoolId, examId);
  const klass = await assertClassInSchool(db, schoolId, classId);
  const rows = await db.result.findMany({ where: { schoolId, examId, classId, deletedAt: null } });
  const threshold = await passingThreshold(db, schoolId, classId);
  const withPct = rows.filter((r: any) => r.percentage !== null && r.percentage !== undefined);
  const passed = withPct.filter((r: any) => r.percentage >= threshold).length;
  const failed = withPct.length - passed;
  const avg = withPct.length > 0 ? Math.round((withPct.reduce((a: number, r: any) => a + r.percentage, 0) / withPct.length) * 100) / 100 : null;
  const topper = [...rows].sort((a: any, b: any) => (b.percentage ?? -1) - (a.percentage ?? -1))[0];
  return {
    exam_id: examId,
    exam_name: exam.name,
    class_id: classId,
    class_name: `${klass.name}-${klass.section}`,
    total: rows.length,
    passed,
    failed,
    not_graded: rows.length - withPct.length,
    pass_rate: withPct.length > 0 ? Math.round((passed / withPct.length) * 10000) / 100 : null,
    average_percentage: avg,
    passing_threshold_percent: threshold,
    topper: topper ? { student_name: topper.studentName, percentage: topper.percentage, grade: topper.grade } : null,
  };
}

export interface ReportCardData {
  school_name: string;
  exam_name: string;
  student: { id: string; name: string; father_name: string | null; admission_no: string | null; roll_no: number | null };
  class_name: string;
  results: Array<Record<string, unknown>>;
  obtained: number | null;
  total: number | null;
  percentage: number | null;
  grade: string | null;
  position: number | null;
  /** Remarks entered with the results (manual entry / review table). */
  remarks: string[];
}

export async function getReportCard(db: Db, schoolId: string, studentId: string, examId: string): Promise<ReportCardData> {
  const student = await db.student.findFirst({ where: { id: studentId, schoolId, deletedAt: null } });
  if (!student) throw ApiError.notFound('Student not found');
  const exam = await assertExamInSchool(db, schoolId, examId);
  const school = await db.school.findFirst({ where: { id: schoolId } });
  const klass = await db.class.findFirst({ where: { id: student.classId, schoolId } });
  const rows = await db.result.findMany({
    where: { schoolId, examId, studentId, deletedAt: null },
    orderBy: [{ rollNo: 'asc' }],
  });
  if (rows.length === 0) throw ApiError.notFound('No results for this student in this exam');
  const first = rows[0]!;
  const obtained = rows.reduce((a: number, r: any) => a + (r.obtainedMarks ?? 0), 0);
  const total = rows.reduce((a: number, r: any) => a + (r.totalMarks ?? 0), 0);
  const percentage = total > 0 ? Math.round((obtained / total) * 10000) / 100 : null;
  const { grade } = await gradeForPercentage(db, schoolId, first.classId, percentage);
  const position = rows.map((r: any) => r.position).filter((p: any) => p !== null && p !== undefined).sort((a: number, b: number) => a - b)[0] ?? null;
  // Father's name: the student record wins; fall back to the father's name
  // entered with the result itself (manual entry / review table), so a
  // result entered for a student whose profile has no father still shows one.
  const resultFather = rows.map((r: any) => (r.fatherName ?? '').trim()).find((f: string) => f) ?? null;
  const remarks = rows.map((r: any) => (r.remarks ?? '').trim()).filter((m: string) => m);
  return {
    school_name: (school as any)?.name ?? 'School',
    exam_name: exam.name,
    student: {
      id: student.id,
      name: student.name,
      father_name: student.fatherName ?? resultFather,
      admission_no: student.admissionNo ?? null,
      roll_no: student.rollNo ?? null,
    },
    class_name: klass ? `${klass.name}-${klass.section}` : '—',
    results: rows.map(toPublicResult),
    obtained,
    total,
    percentage,
    grade,
    position,
    remarks,
  };
}

export function renderReportCardHtml(card: ReportCardData): string {
  const subjectRows = card.results
    .map((r: any) => {
      const subjects = Object.entries(r.subject_marks ?? {}) as Array<[string, number]>;
      if (subjects.length === 0) {
        return `<tr><td>All subjects</td><td>${r.obtained_marks ?? '—'}</td><td>${r.total_marks ?? '—'}</td></tr>`;
      }
      return subjects.map(([subject, marks]) => `<tr><td>${subject}</td><td>${marks}</td><td>—</td></tr>`).join('');
    })
    .join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Report Card — ${card.student.name}</title>
<style>body{font-family:system-ui,sans-serif;margin:40px;color:#111}h1{font-size:22px}table{border-collapse:collapse;width:100%;margin-top:16px}td,th{border:1px solid #999;padding:8px;text-align:left}th{background:#eee}</style></head><body>
<h1>${card.school_name}</h1><p><strong>${card.exam_name} — Report Card</strong></p>
<p>Student: <strong>${card.student.name}</strong> &nbsp; Roll no: ${card.student.roll_no ?? '—'} &nbsp; Class: ${card.class_name}<br>
Father: ${card.student.father_name ?? '—'} &nbsp; Admission no: ${card.student.admission_no ?? '—'}</p>
<table><tr><th>Subject</th><th>Obtained</th><th>Total</th></tr>${subjectRows}</table>
<p><strong>Total: ${card.obtained ?? '—'} / ${card.total ?? '—'}</strong> &nbsp; Percentage: ${card.percentage ?? '—'}% &nbsp; Grade: ${card.grade ?? '—'} &nbsp; Position: ${card.position ?? '—'}</p>
${card.remarks.length > 0 ? `<p>Remarks: ${card.remarks.join('; ')}</p>` : ''}
<button onclick="window.print()" style="margin-top:16px">Print</button></body></html>`;
}

export async function renderReportCardPdf(card: ReportCardData): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 48, size: 'A4' });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  doc.fontSize(20).text(card.school_name, { align: 'center' });
  doc.fontSize(14).text(`${card.exam_name} — Report Card`, { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(`Student: ${card.student.name}`);
  doc.text(`Roll no: ${card.student.roll_no ?? '—'}    Class: ${card.class_name}`);
  doc.text(`Father: ${card.student.father_name ?? '—'}    Admission no: ${card.student.admission_no ?? '—'}`);
  doc.moveDown();
  for (const r of card.results as any[]) {
    const subjects = Object.entries(r.subject_marks ?? {}) as Array<[string, number]>;
    if (subjects.length === 0) {
      doc.text(`All subjects: ${r.obtained_marks ?? '—'} / ${r.total_marks ?? '—'}`);
    } else {
      for (const [subject, marks] of subjects) doc.text(`${subject}: ${marks}`);
    }
  }
  doc.moveDown();
  doc.fontSize(13).text(`Total: ${card.obtained ?? '—'} / ${card.total ?? '—'}    Percentage: ${card.percentage ?? '—'}%    Grade: ${card.grade ?? '—'}    Position: ${card.position ?? '—'}`);
  if (card.remarks.length > 0) {
    doc.moveDown();
    doc.fontSize(12).text(`Remarks: ${card.remarks.join('; ')}`);
  }
  doc.end();
  return done;
}

export async function exportResults(
  db: Db,
  schoolId: string,
  query: Record<string, any>,
): Promise<{ buffer: Buffer; filename: string; contentType: string }> {
  const format = String(query.format ?? 'xlsx');
  if (!['xlsx', 'pdf'].includes(format)) throw ApiError.validation('format must be xlsx or pdf');
  const examId = String(query.exam_id ?? '');
  const classId = String(query.class_id ?? '');
  // exam_id is optional: with no exam selected the export covers every
  // exam in the class (the "All exams" filter). class_id is still required.
  if (!classId) throw ApiError.validation('class_id is required');
  const klass = await assertClassInSchool(db, schoolId, classId);
  const exam = examId ? await assertExamInSchool(db, schoolId, examId) : null;
  const where: Record<string, unknown> = { schoolId, classId, deletedAt: null };
  if (examId) where.examId = examId;
  const rows = await db.result.findMany({
    where,
    orderBy: [{ position: 'asc' }, { rollNo: 'asc' }],
  });
  const title = exam
    ? `Results — ${exam.name} — ${klass.name}-${klass.section}`
    : `Results — All exams — ${klass.name}-${klass.section}`;
  const headers = ['Position', 'Roll', 'Student', 'Father', 'Obtained', 'Total', 'Percentage', 'Grade', 'Linked', 'Remarks'];
  const data = rows.map((r: any) => [
    r.position ?? '—',
    r.rollNo,
    r.studentName,
    r.fatherName ?? '',
    r.obtainedMarks ?? '',
    r.totalMarks ?? '',
    r.percentage ?? '',
    r.grade ?? '',
    r.studentId ? 'Yes' : 'No',
    r.remarks ?? '',
  ]);
  if (format === 'pdf') {
    const buffer = await exportPdf(title, headers, data);
    return { buffer, filename: `results-${(examId || classId).slice(0, 8)}.pdf`, contentType: 'application/pdf' };
  }
  const buffer = await exportXlsx(title, headers, data);
  return { buffer, filename: `results-${(examId || classId).slice(0, 8)}.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

/* ------------------------------------------------------------------ */
/* Publish: admin-approved SMS to parents (via message_drafts)         */
/* ------------------------------------------------------------------ */

/**
 * Publish a saved sheet and draft result SMS to linked students' parents.
 *
 * The drafts land in `message_drafts` (status 'draft') — the SAME approval
 * flow as custom messages (SCHEMA.md §11): an admin submits the draft for
 * approval, approval builds `message_queue` rows (opted-out parents
 * auto-excluded, skipped count returned). There is deliberately NO direct
 * `message_queue` insert here: queue rows are born APPROVED (approved_by/at
 * set at creation), so writing one would send without approval; drafts are
 * the pending-approval vehicle, and the draft-send path types approved
 * drafts as 'custom' (see `messaging/custom-messages.ts` sendDraft).
 * (Note: migration 20261106232000 extended the message_queue.type CHECK
 * to include 'result'/'announcement'/'custom', so a 'result' queue type is
 * legal — but it does not change the approval-first flow.)
 * Variables rendered: {student_name} {father_name} {class} {section}
 * {date} {school_name} plus result context {exam_name} {percentage}
 * {grade} {position}.
 */
export async function publishSheetSms(
  db: Db,
  schoolId: string,
  sheetId: string,
  actorId?: string | null,
): Promise<{ published: boolean; drafts_created: number; skipped: Array<{ student_name: string; reason: string }> }> {
  const sheet = await db.resultSheet.findFirst({ where: { id: sheetId, schoolId, deletedAt: null } });
  if (!sheet) throw ApiError.notFound('Result sheet not found');
  if (sheet.status !== 'saved' && sheet.status !== 'published') {
    throw ApiError.validation('Publish the sheet only after its results are saved (status must be saved)');
  }
  const exam = await assertExamInSchool(db, schoolId, sheet.examId);
  const klass = await assertClassInSchool(db, schoolId, sheet.classId);
  const school = await db.school.findFirst({ where: { id: schoolId } });
  const schoolName = (school as any)?.name ?? 'School';
  const date = new Date().toISOString().slice(0, 10);
  const results = await db.result.findMany({ where: { schoolId, resultSheetId: sheetId, deletedAt: null } });
  const out = { published: true, drafts_created: 0, skipped: [] as Array<{ student_name: string; reason: string }> };
  for (const r of results) {
    if (!r.studentId) {
      out.skipped.push({ student_name: r.studentName, reason: 'not_linked_to_student' });
      continue;
    }
    const student = await db.student.findFirst({ where: { id: r.studentId, schoolId, deletedAt: null } });
    if (!student) {
      out.skipped.push({ student_name: r.studentName, reason: 'student_not_found' });
      continue;
    }
    // Parent 1 first, then parent 2; opted-out numbers are never used.
    const hasPhone = (student.parentPhoneEnc && !student.parentOptOut) || (student.parent2PhoneEnc && !student.parent2OptOut);
    if (!hasPhone) {
      out.skipped.push({ student_name: r.studentName, reason: student.parentOptOut || student.parent2OptOut ? 'parent_opted_out' : 'missing_phone' });
      continue;
    }
    const body =
      `Dear parent, ${r.studentName} (${klass.name}-${klass.section}) scored ${r.percentage ?? '—'}% ` +
      `(Grade ${r.grade ?? '—'}, Position ${r.position ?? '—'}) in ${exam.name} at ${schoolName}.`;
    await db.messageDraft.create({
      data: {
        schoolId,
        createdBy: actorId ?? null,
        recipientType: 'selected_students',
        targetClassId: sheet.classId,
        targetStudentIds: [student.id],
        body,
        status: 'draft',
        scheduledFor: null,
      },
    });
    out.drafts_created += 1;
  }
  await db.resultSheet.update({ where: { id: sheetId }, data: { status: 'published' } });
  await writeAudit(db, { schoolId, actorId: actorId ?? null, actorType: 'user', action: 'result_sheet.publish', entity: 'result_sheet', entityId: sheetId, details: { exam_name: exam.name, drafts_created: out.drafts_created, skipped: out.skipped.length, date } });
  return out;
}
