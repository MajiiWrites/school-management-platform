// Homework diary (Gap #3, 2026-11-20) — teacher adds homework per class;
// parents see it in the parent portal. Optional SMS notify queues one
// held draft per eligible parent (type 'custom') — the admin approves it
// in Messages like every other SMS; nothing is ever auto-sent.
import { ApiError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { logCreate, softDeleteEntity, writeChangeLogs } from '../hardening/helpers';
import { isValidDateString } from '../../lib/dates';
import type { Db } from '../../lib/db';

export interface HomeworkInput {
  class_id: string;
  subject: string;
  title: string;
  description?: string | null;
  due_date: string;
  teacher: string;
}

function toPublicHomework(row: any, classLabel?: string | null): Record<string, unknown> {
  return {
    id: row.id,
    class_id: row.classId,
    class_name: classLabel ?? null,
    subject: row.subject,
    title: row.title,
    description: row.description ?? null,
    due_date: (row.dueDate instanceof Date ? row.dueDate : new Date(row.dueDate)).toISOString().slice(0, 10),
    teacher: row.teacher,
    created_at: row.createdAt,
  };
}

async function assertClassInSchool(db: Db, schoolId: string, classId: string): Promise<any> {
  const cls = await db.class.findFirst({ where: { id: classId, schoolId, deletedAt: null } });
  if (!cls) throw ApiError.notFound('Class not found');
  return cls;
}

async function getHomeworkInSchool(db: Db, schoolId: string, id: string): Promise<any> {
  const row = await db.homework.findFirst({ where: { id, schoolId, deletedAt: null } });
  if (!row) throw ApiError.notFound('Homework not found');
  return row;
}

export async function createHomework(db: Db, schoolId: string, input: HomeworkInput, actorId?: string): Promise<Record<string, unknown>> {
  const cls = await assertClassInSchool(db, schoolId, input.class_id);
  if (!isValidDateString(input.due_date)) throw ApiError.validation('due_date must be YYYY-MM-DD');
  const created = await db.homework.create({
    data: {
      schoolId,
      classId: cls.id,
      subject: input.subject.trim(),
      title: input.title.trim(),
      description: (input.description ?? '').trim() || null,
      dueDate: new Date(`${input.due_date}T00:00:00Z`),
      teacher: input.teacher.trim(),
      createdBy: actorId ?? null,
    },
  });
  await logCreate(db, {
    schoolId,
    actorId: actorId ?? null,
    entity: 'homework',
    entityId: created.id,
    after: { class_id: cls.id, subject: created.subject, title: created.title, due_date: input.due_date, teacher: created.teacher },
  });
  await writeAudit(db, {
    schoolId,
    actorId: actorId ?? null,
    actorType: 'user',
    action: 'homework.create',
    entity: 'homework',
    entityId: created.id,
    details: { class_id: cls.id, subject: created.subject, title: created.title, due_date: input.due_date },
  });
  return toPublicHomework(created, `${cls.name}-${cls.section}`);
}

/** Admin list: all classes, or one class; soonest due first. */
export async function listHomework(db: Db, schoolId: string, query: Record<string, any>): Promise<Record<string, unknown>> {
  const where: Record<string, unknown> = { schoolId, deletedAt: null };
  if (query.class_id) {
    await assertClassInSchool(db, schoolId, String(query.class_id));
    where.classId = String(query.class_id);
  }
  const rows: any[] = await db.homework.findMany({ where, orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }] });
  const classes: any[] = await db.class.findMany({ where: { schoolId } });
  const label = new Map<string, string>(classes.map((c: any) => [c.id, `${c.name}-${c.section}`]));
  return { items: rows.map((r: any) => toPublicHomework(r, label.get(r.classId) ?? null)), total: rows.length };
}

export async function updateHomework(
  db: Db,
  schoolId: string,
  id: string,
  patch: Partial<HomeworkInput>,
  actorId?: string,
): Promise<Record<string, unknown>> {
  const existing = await getHomeworkInSchool(db, schoolId, id);
  const data: Record<string, unknown> = {};
  if (patch.subject !== undefined) data.subject = patch.subject.trim();
  if (patch.title !== undefined) data.title = patch.title.trim();
  if (patch.description !== undefined) data.description = (patch.description ?? '').trim() || null;
  if (patch.teacher !== undefined) data.teacher = patch.teacher.trim();
  if (patch.due_date !== undefined) {
    if (!isValidDateString(patch.due_date)) throw ApiError.validation('due_date must be YYYY-MM-DD');
    data.dueDate = new Date(`${patch.due_date}T00:00:00Z`);
  }
  if (patch.class_id !== undefined && patch.class_id !== existing.classId) {
    await assertClassInSchool(db, schoolId, patch.class_id);
    data.classId = patch.class_id;
  }
  const updated = await db.homework.update({ where: { id }, data });
  await writeChangeLogs(db, {
    schoolId,
    actorId: actorId ?? null,
    entity: 'homework',
    entityId: id,
    before: { subject: existing.subject, title: existing.title, due_date: existing.dueDate },
    after: { subject: updated.subject, title: updated.title, due_date: updated.dueDate },
  });
  await writeAudit(db, {
    schoolId,
    actorId: actorId ?? null,
    actorType: 'user',
    action: 'homework.update',
    entity: 'homework',
    entityId: id,
    details: { title: updated.title },
  });
  const cls = await db.class.findFirst({ where: { id: updated.classId, schoolId } });
  return toPublicHomework(updated, cls ? `${cls.name}-${cls.section}` : null);
}

/** Soft delete → recycle bin (restorable 30 days), like classes/results. */
export async function deleteHomework(db: Db, schoolId: string, id: string, actorId?: string): Promise<void> {
  const existing = await getHomeworkInSchool(db, schoolId, id);
  await softDeleteEntity(db, { schoolId, entity: 'homework', entityId: id, deletedBy: actorId ?? null });
  await writeAudit(db, {
    schoolId,
    actorId: actorId ?? null,
    actorType: 'user',
    action: 'homework.delete',
    entity: 'homework',
    entityId: id,
    details: { title: existing.title, soft_deleted: true },
  });
}

/**
 * Notify the class's parents about one homework entry: one held draft per
 * eligible parent (valid number, not opted out). Dedupe key
 * `homework:{homeworkId}:{studentId}` — notifying twice cannot spam.
 * Drafts wait for admin approval in Messages; the companion app sends them.
 */
export async function notifyHomework(db: Db, schoolId: string, id: string, actorId?: string): Promise<Record<string, unknown>> {
  const hw = await getHomeworkInSchool(db, schoolId, id);
  const school = await db.school.findUnique({ where: { id: schoolId } });
  if (!school) throw ApiError.notFound('School not found');
  const cls = await db.class.findFirst({ where: { id: hw.classId, schoolId } });
  const classLabel = cls ? `${cls.name}-${cls.section}` : '—';
  const students: any[] = await db.student.findMany({
    where: { schoolId, classId: hw.classId, status: 'active', deletedAt: null },
  });
  const due = (hw.dueDate instanceof Date ? hw.dueDate : new Date(hw.dueDate)).toISOString().slice(0, 10);
  let drafted = 0;
  let skipped = 0;
  for (const s of students) {
    if (!s.parentPhoneEnc || s.parentOptOut) {
      skipped += 1;
      continue;
    }
    const dedupeKey = `homework:${hw.id}:${s.id}`;
    const already = await db.messageQueue.findFirst({ where: { schoolId, dedupeKey } });
    if (already) continue;
    const body = `Homework — Class ${classLabel}, ${hw.subject}: ${hw.title} (due ${due}).${hw.description ? ` ${hw.description}` : ''} – ${school.name}`;
    await db.messageQueue.create({
      data: {
        schoolId,
        type: 'custom',
        studentId: s.id,
        classId: hw.classId,
        parentPhoneEnc: s.parentPhoneEnc,
        body,
        status: 'queued',
        attempts: 0,
        dedupeKey,
        scheduledFor: new Date(),
        approvedBy: null,
        approvedAt: null,
      },
    });
    drafted += 1;
  }
  await writeAudit(db, {
    schoolId,
    actorId: actorId ?? null,
    actorType: 'user',
    action: 'homework.notify',
    entity: 'homework',
    entityId: id,
    details: { title: hw.title, drafted, skipped, class_id: hw.classId },
  });
  return { drafted, skipped, total_students: students.length };
}

/** Parent portal slice: this class's homework, soonest due first. */
export async function listHomeworkForClass(db: Db, schoolId: string, classId: string): Promise<Record<string, unknown>[]> {
  const rows: any[] = await db.homework.findMany({
    where: { schoolId, classId, deletedAt: null },
    orderBy: [{ dueDate: 'asc' }],
  });
  return rows.map((r: any) => toPublicHomework(r));
}
