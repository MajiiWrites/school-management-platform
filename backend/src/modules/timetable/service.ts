// Timetable (6C-1) — weekly timetable entries, class-wise + teacher-wise
// views, conflict detection.
//
// CONFLICT RULES (see FEATURES-6C1.md):
//  1. Same class-section + day + period cannot double-book — enforced by
//     the DB unique (school_id, class_id, day_of_week, period_no) AND a
//     friendly 409 in the app layer.
//  2. Same teacher cannot be in two places at once — same teacher + day +
//     period_no (any class) is a 409, and so is any overlapping time
//     interval for that teacher on that day (catches different period
//     numbers with overlapping times).
//  3. Same class-section + day with overlapping times is also a 409, even
//     for different period numbers.
import { ApiError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { writeChangeLogs, logCreate, logDelete } from '../hardening/helpers';
import { paginatedResponse, parsePagination } from '../../lib/pagination';
import type { Db } from '../../lib/db';
import { unlink } from 'node:fs/promises';
import { runTesseractTsv } from '../ocr/ocr-engine.js';
import {
  parseTimetableWords,
  parseTimetableText,
  matchTimetableCells,
  flagTimetableConflicts,
  type MatchedTimetableCell,
  type TimetableWord,
} from './photo.js';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function assertTimeRange(start: string, end: string): void {
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) throw ApiError.validation('start_time and end_time must be HH:MM (24h)');
  if (start >= end) throw ApiError.validation('start_time must be before end_time');
}

function timesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function toPublicTimetableEntry(e: any, className?: string | null, teacherName?: string | null): Record<string, unknown> {
  return {
    id: e.id, school_id: e.schoolId, class_id: e.classId, class_name: className ?? null,
    teacher_id: e.teacherId ?? null, teacher_name: teacherName ?? null,
    day_of_week: e.dayOfWeek, day_name: DAY_NAMES[e.dayOfWeek] ?? null,
    period_no: e.periodNo, subject: e.subject,
    start_time: e.startTime, end_time: e.endTime, room: e.room ?? null, created_at: e.createdAt,
  };
}

async function enrich(db: Db, schoolId: string, rows: any[]): Promise<any[]> {
  const classIds = [...new Set(rows.map((r: any) => r.classId))];
  const teacherIds = [...new Set(rows.map((r: any) => r.teacherId).filter(Boolean))];
  const [classes, teachers] = await Promise.all([
    classIds.length ? db.class.findMany({ where: { schoolId, id: { in: classIds } } }) : Promise.resolve([]),
    teacherIds.length ? db.staff.findMany({ where: { schoolId, id: { in: teacherIds } } }) : Promise.resolve([]),
  ]);
  const classById = new Map<string, string>(classes.map((c: any) => [c.id, `${c.name}-${c.section}`] as [string, string]));
  const teacherById = new Map<string, string>(teachers.map((t: any) => [t.id, t.name] as [string, string]));
  return rows.map((r: any) => toPublicTimetableEntry(r, classById.get(r.classId) ?? null, r.teacherId ? (teacherById.get(r.teacherId) ?? null) : null));
}

async function assertConflicts(
  db: Db, schoolId: string,
  input: { class_id: string; teacher_id?: string | null; day_of_week: number; period_no: number; start_time: string; end_time: string },
  excludeId?: string,
): Promise<void> {
  // Rule 1: same class + day + period.
  const slot = await db.timetableEntry.findFirst({ where: { schoolId, classId: input.class_id, dayOfWeek: input.day_of_week, periodNo: input.period_no } });
  if (slot && slot.id !== excludeId) {
    throw ApiError.conflict(`This class already has a lesson in period ${input.period_no} on ${DAY_NAMES[input.day_of_week]} (${slot.subject}, ${slot.startTime}–${slot.endTime})`);
  }
  const dayRows = await db.timetableEntry.findMany({ where: { schoolId, dayOfWeek: input.day_of_week } });
  const others = dayRows.filter((r: any) => r.id !== excludeId);
  // Rule 3: same class, overlapping time (different period number).
  const classClash = others.find((r: any) => r.classId === input.class_id && timesOverlap(input.start_time, input.end_time, r.startTime, r.endTime));
  if (classClash) throw ApiError.conflict(`This class already has "${classClash.subject}" (${classClash.startTime}–${classClash.endTime}) overlapping that time on ${DAY_NAMES[input.day_of_week]}`);
  // Rule 2: same teacher, same period or overlapping time, any class.
  if (input.teacher_id) {
    const teacherRows = others.filter((r: any) => r.teacherId === input.teacher_id);
    const periodClash = teacherRows.find((r: any) => r.periodNo === input.period_no);
    if (periodClash) throw ApiError.conflict(`This teacher is already teaching ${periodClash.subject} (period ${periodClash.periodNo}) at that time on ${DAY_NAMES[input.day_of_week]}`);
    const timeClash = teacherRows.find((r: any) => timesOverlap(input.start_time, input.end_time, r.startTime, r.endTime));
    if (timeClash) throw ApiError.conflict(`This teacher is already teaching "${timeClash.subject}" (${timeClash.startTime}–${timeClash.endTime}) overlapping that time on ${DAY_NAMES[input.day_of_week]}`);
  }
}

export async function listTimetable(
  db: Db, schoolId: string, query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  const where: Record<string, unknown> = { schoolId };
  if (query.class_id) where.classId = String(query.class_id);
  if (query.teacher_id) where.teacherId = String(query.teacher_id);
  if (query.day !== undefined && query.day !== '') {
    const day = Number(query.day);
    if (!Number.isInteger(day) || day < 0 || day > 6) throw ApiError.validation('day must be 0–6 (0 = Sunday)');
    where.dayOfWeek = day;
  }
  const [rows, total] = await Promise.all([
    db.timetableEntry.findMany({ where, orderBy: [{ dayOfWeek: 'asc' }, { periodNo: 'asc' }], skip, take: limit }),
    db.timetableEntry.count({ where }),
  ]);
  return paginatedResponse(await enrich(db, schoolId, rows), total, { page, limit, skip });
}

/** Class-wise view: entries grouped by day of week, periods ascending. */
export async function getClassTimetable(db: Db, schoolId: string, classId: string): Promise<Record<string, unknown>> {
  const cls = await db.class.findFirst({ where: { id: classId, schoolId, deletedAt: null } });
  if (!cls) throw ApiError.notFound('Class not found');
  const rows = await db.timetableEntry.findMany({ where: { schoolId, classId }, orderBy: [{ dayOfWeek: 'asc' }, { periodNo: 'asc' }] });
  const entries = await enrich(db, schoolId, rows);
  const byDay: Record<string, unknown[]> = {};
  for (let d = 0; d <= 6; d += 1) byDay[String(d)] = [];
  for (const e of entries) (byDay[String((e as any).day_of_week)] as unknown[]).push(e);
  return { class_id: cls.id, class_name: `${cls.name}-${cls.section}`, by_day: byDay, entries };
}

/** Teacher-wise view: entries grouped by day of week, periods ascending. */
export async function getTeacherTimetable(db: Db, schoolId: string, staffId: string): Promise<Record<string, unknown>> {
  const teacher = await db.staff.findFirst({ where: { id: staffId, schoolId } });
  if (!teacher) throw ApiError.notFound('Staff member not found');
  const rows = await db.timetableEntry.findMany({ where: { schoolId, teacherId: staffId }, orderBy: [{ dayOfWeek: 'asc' }, { periodNo: 'asc' }] });
  const entries = await enrich(db, schoolId, rows);
  const byDay: Record<string, unknown[]> = {};
  for (let d = 0; d <= 6; d += 1) byDay[String(d)] = [];
  for (const e of entries) (byDay[String((e as any).day_of_week)] as unknown[]).push(e);
  return { teacher_id: teacher.id, teacher_name: teacher.name, by_day: byDay, entries };
}

export async function createTimetableEntry(
  db: Db, schoolId: string,
  input: { class_id: string; teacher_id?: string | null; day_of_week: number; period_no: number; subject: string; start_time: string; end_time: string; room?: string | null },
  actorId: string,
): Promise<any> {
  const cls = await db.class.findFirst({ where: { id: input.class_id, schoolId, deletedAt: null } });
  if (!cls) throw ApiError.notFound('Class not found');
  if (!Number.isInteger(input.day_of_week) || input.day_of_week < 0 || input.day_of_week > 6) throw ApiError.validation('day_of_week must be 0–6 (0 = Sunday)');
  if (!Number.isInteger(input.period_no) || input.period_no < 1) throw ApiError.validation('period_no must be an integer >= 1');
  const subject = input.subject?.trim();
  if (!subject) throw ApiError.validation('subject is required');
  assertTimeRange(input.start_time, input.end_time);
  let teacherId: string | null = input.teacher_id ?? null;
  if (teacherId) {
    const teacher = await db.staff.findFirst({ where: { id: teacherId, schoolId } });
    if (!teacher) throw ApiError.notFound('Teacher not found');
    if (teacher.role !== 'teacher') throw ApiError.validation('Only staff with role "teacher" can be assigned to the timetable');
  }
  await assertConflicts(db, schoolId, { class_id: input.class_id, teacher_id: teacherId, day_of_week: input.day_of_week, period_no: input.period_no, start_time: input.start_time, end_time: input.end_time });
  const created = await db.timetableEntry.create({
    data: { schoolId, classId: input.class_id, teacherId, dayOfWeek: input.day_of_week, periodNo: input.period_no, subject, startTime: input.start_time, endTime: input.end_time, room: input.room?.trim() || null },
  });
  await logCreate(db, {
    schoolId,
    actorId,
    entity: 'timetable_entry',
    entityId: created.id,
    after: { class_id: input.class_id, teacher_id: teacherId, day_of_week: input.day_of_week, period_no: input.period_no, subject, start_time: input.start_time, end_time: input.end_time, room: created.room ?? null },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'timetable.create', entity: 'timetable_entry', entityId: created.id, details: { class_id: input.class_id, subject, day_of_week: input.day_of_week, period_no: input.period_no } });
  return (await enrich(db, schoolId, [created]))[0];
}

export async function updateTimetableEntry(
  db: Db, schoolId: string, id: string,
  patch: { teacher_id?: string | null; day_of_week?: number; period_no?: number; subject?: string; start_time?: string; end_time?: string; room?: string | null },
  actorId: string,
): Promise<any> {
  const row = await db.timetableEntry.findFirst({ where: { id, schoolId } });
  if (!row) throw ApiError.notFound('Timetable entry not found');
  const before = { teacher_id: row.teacherId, day_of_week: row.dayOfWeek, period_no: row.periodNo, subject: row.subject, start_time: row.startTime, end_time: row.endTime, room: row.room };
  const next = {
    class_id: row.classId,
    teacher_id: patch.teacher_id !== undefined ? patch.teacher_id : row.teacherId,
    day_of_week: patch.day_of_week ?? row.dayOfWeek,
    period_no: patch.period_no ?? row.periodNo,
    start_time: patch.start_time ?? row.startTime,
    end_time: patch.end_time ?? row.endTime,
  };
  if (!Number.isInteger(next.day_of_week) || next.day_of_week < 0 || next.day_of_week > 6) throw ApiError.validation('day_of_week must be 0–6 (0 = Sunday)');
  if (!Number.isInteger(next.period_no) || next.period_no < 1) throw ApiError.validation('period_no must be an integer >= 1');
  assertTimeRange(next.start_time, next.end_time);
  if (next.teacher_id) {
    const teacher = await db.staff.findFirst({ where: { id: next.teacher_id, schoolId } });
    if (!teacher) throw ApiError.notFound('Teacher not found');
    if (teacher.role !== 'teacher') throw ApiError.validation('Only staff with role "teacher" can be assigned to the timetable');
  }
  await assertConflicts(db, schoolId, next, id);
  const data: Record<string, unknown> = {
    teacherId: next.teacher_id, dayOfWeek: next.day_of_week, periodNo: next.period_no,
    startTime: next.start_time, endTime: next.end_time,
  };
  if (patch.subject !== undefined) {
    const subject = patch.subject.trim();
    if (!subject) throw ApiError.validation('subject is required');
    data.subject = subject;
  }
  if (patch.room !== undefined) data.room = patch.room?.trim() || null;
  const updated = await db.timetableEntry.update({ where: { id }, data });
  await writeChangeLogs(db, { schoolId, actorId, entity: 'timetable_entry', entityId: id, before, after: { teacher_id: updated.teacherId, day_of_week: updated.dayOfWeek, period_no: updated.periodNo, subject: updated.subject, start_time: updated.startTime, end_time: updated.endTime, room: updated.room } });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'timetable.update', entity: 'timetable_entry', entityId: id, details: { subject: updated.subject } });
  return (await enrich(db, schoolId, [updated]))[0];
}

export async function deleteTimetableEntry(db: Db, schoolId: string, id: string, actorId: string): Promise<void> {
  const row = await db.timetableEntry.findFirst({ where: { id, schoolId } });
  if (!row) throw ApiError.notFound('Timetable entry not found');
  // timetable_entries has no deleted_at column: hard delete + recycle-bin
  // snapshot (restore via the generic recycle-bin helper is not supported
  // for this entity — see FEATURES-6C1.md).
  const snapshot = JSON.parse(JSON.stringify(row, (_k, v) => (v instanceof Date ? v.toISOString() : v)));
  await db.timetableEntry.delete({ where: { id } });
  await (db as any).deletedRecord.create({
    data: { schoolId, entity: 'timetable_entry', entityId: id, snapshot, deletedBy: actorId, deletedAt: new Date(), restoreBy: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  });
  await logDelete(db, {
    schoolId,
    actorId,
    entity: 'timetable_entry',
    entityId: id,
    before: { class_id: row.classId, teacher_id: row.teacherId, day_of_week: row.dayOfWeek, period_no: row.periodNo, subject: row.subject, start_time: row.startTime, end_time: row.endTime, room: row.room },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'timetable.delete', entity: 'timetable_entry', entityId: id, details: { subject: row.subject } });
}

// ---------------------------------------------------------------------------
// Timetable from photo (FINAL REBUILD, Point 7)
// ---------------------------------------------------------------------------

export interface TimetablePhotoUploadResult {
  raw_text: string;
  cells: MatchedTimetableCell[];
  unmatched_teachers: string[];
  unmatched_classes: string[];
  warnings: string[];
}

export interface TimetablePhotoConfirmEntry {
  class_id: string;
  teacher_id?: string | null;
  day_of_week: number;
  period_no: number;
  subject: string;
  start_time: string;
  end_time: string;
  room?: string | null;
}

/** Rebuild plain text from TSV words (for the review screen + fallback parser). */
function wordsToText(words: TimetableWord[]): string {
  const sorted = [...words].sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: { top: number; words: TimetableWord[] }[] = [];
  for (const w of sorted) {
    const line = lines.find((l) => Math.abs(w.top - l.top) <= 20);
    if (line) line.words.push(w);
    else lines.push({ top: w.top, words: [w] });
  }
  return lines
    .sort((a, b) => a.top - b.top)
    .map((l) => l.words.sort((a, b) => a.left - b.left).map((w) => w.text).join(' '))
    .join('\n');
}

/**
 * Parse a photographed timetable sheet into reviewable cells.
 * School-scoped throughout: teachers/classes/entries are all this school's.
 * The uploaded photo is a TRANSIENT input — it is deleted after parsing
 * (the admin still has the original on their phone, and the frontend shows
 * its own local preview next to the review table). Nothing is saved until
 * the admin confirms via confirmTimetablePhoto.
 */
export async function uploadTimetablePhoto(
  db: Db,
  schoolId: string,
  filePath: string,
  actorId: string,
  opts: {
    class_id?: string | null;
    runTsv?: (filePath: string) => Promise<TimetableWord[]>;
  } = {},
): Promise<TimetablePhotoUploadResult> {
  let sheetClassLabel: string | null = null;
  if (opts.class_id) {
    const cls = await db.class.findFirst({ where: { id: opts.class_id, schoolId, deletedAt: null } });
    if (!cls) throw ApiError.notFound('Class not found');
    sheetClassLabel = `${cls.name}-${cls.section}`;
  }
  try {
    const words = opts.runTsv
      ? await opts.runTsv(filePath)
      : (await runTesseractTsv(filePath, process.env.OCR_LANGS ?? 'eng+urd', '6')).map((w) => ({
          text: w.text,
          conf: w.conf,
          left: w.left,
          top: w.top,
          width: w.width,
          height: w.height,
        }));
    const raw_text = wordsToText(words);
    let cells = parseTimetableWords(words, sheetClassLabel);
    const warnings: string[] = [];
    if (cells.length === 0) {
      // No grid detected — fall back to plain-text line parsing.
      cells = parseTimetableText(raw_text, sheetClassLabel);
      if (cells.length > 0) {
        warnings.push('No timetable grid was detected in the photo, so rows were parsed from the plain text instead — check every row before saving.');
      }
    }
    if (cells.length === 0) {
      warnings.push('No timetable rows could be read from this photo. Try a clearer, straight-on photo, or add the timetable manually below.');
    }
    const [teachers, classes] = await Promise.all([
      db.staff.findMany({ where: { schoolId, role: 'teacher' } }),
      db.class.findMany({ where: { schoolId, deletedAt: null } }),
    ]);
    const matched = matchTimetableCells(
      cells,
      teachers.map((t: any) => ({ id: t.id, name: t.name })),
      classes.map((c: any) => ({ id: c.id, name: c.name, section: c.section })),
    );
    const days = [...new Set(matched.cells.map((c) => c.day_of_week).filter((d): d is number => d !== null))];
    const existing =
      days.length > 0
        ? await db.timetableEntry.findMany({ where: { schoolId, dayOfWeek: { in: days } } })
        : [];
    const flagged = flagTimetableConflicts(
      matched.cells,
      existing.map((e: any) => ({
        class_id: e.classId,
        teacher_id: e.teacherId ?? null,
        day_of_week: e.dayOfWeek,
        period_no: e.periodNo,
        start_time: e.startTime,
        end_time: e.endTime,
        subject: e.subject,
      })),
    );
    await writeAudit(db, {
      schoolId,
      actorId,
      actorType: 'user',
      action: 'timetable.photo_upload',
      entity: 'timetable_entry',
      entityId: null,
      details: { class_id: opts.class_id ?? null, cells_found: flagged.length, unmatched_teachers: matched.unmatched_teachers.length, unmatched_classes: matched.unmatched_classes.length },
    });
    return {
      raw_text,
      cells: flagged,
      unmatched_teachers: matched.unmatched_teachers,
      unmatched_classes: matched.unmatched_classes,
      warnings,
    };
  } finally {
    // Transient input: remove the uploaded photo after parsing (best-effort).
    await unlink(filePath).catch(() => undefined);
  }
}

/**
 * Save admin-reviewed photo rows as timetable entries. Each row goes
 * through createTimetableEntry, so the live conflict rules, change
 * history and audit logging all apply exactly as for manual adds.
 * Conflicting rows are SKIPPED with their reason (never silently dropped
 * and never forced in); the rest are saved.
 */
export async function confirmTimetablePhoto(
  db: Db,
  schoolId: string,
  entries: TimetablePhotoConfirmEntry[],
  actorId: string,
): Promise<{ created: number; skipped: { entry: TimetablePhotoConfirmEntry; reason: string }[] }> {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw ApiError.validation('entries must be a non-empty array');
  }
  const skipped: { entry: TimetablePhotoConfirmEntry; reason: string }[] = [];
  let created = 0;
  for (const entry of entries) {
    try {
      await createTimetableEntry(db, schoolId, entry, actorId);
      created += 1;
    } catch (err) {
      skipped.push({ entry, reason: err instanceof Error ? err.message : 'Could not save this row.' });
    }
  }
  await writeAudit(db, {
    schoolId,
    actorId,
    actorType: 'user',
    action: 'timetable.photo_confirm',
    entity: 'timetable_entry',
    entityId: null,
    details: { created, skipped: skipped.length },
  });
  return { created, skipped };
}
