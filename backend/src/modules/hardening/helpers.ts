/**
 * Hardening helpers (6A) — shared low-level building blocks.
 *
 * These helpers import ONLY lib/* so the v1 services (students, classes,
 * fees, admin) can use them without creating import cycles. The approval
 * applier (approvals.ts) is the only file that imports the v1 services.
 */
import { ApiError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import type { Db } from '../../lib/db';

/** Entities that support soft delete (contracts/SCHEMA.md §4/§10). */
export const SOFT_DELETE_ENTITIES = ['student', 'class', 'fee_record', 'exam', 'result', 'result_sheet'] as const;
export type SoftDeleteEntity = (typeof SOFT_DELETE_ENTITIES)[number];

/** Entity name (as stored in approval_requests / deleted_records) -> Db delegate. */
export const ENTITY_DELEGATES: Record<string, keyof Db> = {
  student: 'student',
  class: 'class',
  fee_record: 'feeRecord',
  exam: 'exam',
  result: 'result',
  result_sheet: 'resultSheet',
};

/** Serialize a row for the recycle-bin snapshot (Dates -> ISO strings). */
export function snapshotOf(row: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(row, (_key, value) => (value instanceof Date ? value.toISOString() : value)),
  ) as Record<string, unknown>;
}

function stringifyValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Write one change_logs row per changed field (contracts/SCHEMA.md §5).
 * `before` / `after` are flat field->value maps (Prisma field names).
 * Unchanged fields and keys absent from both maps produce no row.
 * Never throws: change history must not break the business operation.
 */
export async function writeChangeLogs(
  db: Db,
  entry: {
    schoolId: string;
    actorId?: string | null;
    actorType?: 'user' | 'teacher_link' | 'system' | 'device';
    entity: string;
    entityId?: string | null;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  },
): Promise<number> {
  const keys = new Set([...Object.keys(entry.before), ...Object.keys(entry.after)]);
  let written = 0;
  for (const field of keys) {
    const oldValue = stringifyValue(entry.before[field]);
    const newValue = stringifyValue(entry.after[field]);
    if (oldValue === newValue) continue;
    try {
      await (db as any).changeLog.create({
        data: {
          schoolId: entry.schoolId,
          actorId: entry.actorId ?? null,
          actorType: entry.actorType ?? 'user',
          entity: entry.entity,
          entityId: entry.entityId ?? null,
          field,
          oldValue,
          newValue,
        },
      });
      written += 1;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[change-log] failed to write change log:', (err as Error).message);
    }
  }
  return written;
}

/** True when the error is a Prisma unique-constraint violation (P2002). */
export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'P2002';
}

/**
 * Soft-delete a row: set deleted_at + write a deleted_records snapshot row
 * (restore deadline = deleted_at + 30 days). Throws 404 when the row does
 * not exist in this school, 409 when it is already soft-deleted.
 */
export async function softDeleteEntity(
  db: Db,
  input: { schoolId: string; entity: SoftDeleteEntity | string; entityId: string; deletedBy?: string | null },
): Promise<{ deletedAt: Date; restoreBy: Date; recordId: string }> {
  const delegateKey = ENTITY_DELEGATES[input.entity];
  if (!delegateKey) throw ApiError.validation(`Entity does not support soft delete: ${input.entity}`);
  const delegate = (db as any)[delegateKey];
  const existing = await delegate.findFirst({
    where: { id: input.entityId, schoolId: input.schoolId },
  });
  if (!existing) throw ApiError.notFound(`${input.entity} not found`);
  if (existing.deletedAt) throw ApiError.conflict(`${input.entity} is already deleted`);
  const deletedAt = new Date();
  const restoreBy = new Date(deletedAt.getTime() + 30 * 24 * 60 * 60 * 1000);
  await delegate.update({ where: { id: input.entityId }, data: { deletedAt } });
  const record = await (db as any).deletedRecord.create({
    data: {
      schoolId: input.schoolId,
      entity: input.entity,
      entityId: input.entityId,
      snapshot: snapshotOf(existing),
      deletedBy: input.deletedBy ?? null,
      deletedAt,
      restoreBy,
    },
  });
  await writeAudit(db, {
    schoolId: input.schoolId,
    actorId: input.deletedBy ?? null,
    actorType: 'user',
    action: 'recycle_bin.soft_delete',
    entity: input.entity,
    entityId: input.entityId,
    details: { restore_by: restoreBy.toISOString() },
  });
  return { deletedAt, restoreBy, recordId: record.id };
}

/** Create a school-scoped notification. Never throws (notifications are best-effort). */
export async function notifySchool(
  db: Db,
  input: {
    schoolId: string;
    type: string;
    title: string;
    body: string;
    relatedType?: string | null;
    relatedId?: string | null;
  },
): Promise<void> {
  try {
    await db.notification.create({
      data: {
        schoolId: input.schoolId,
        type: input.type,
        title: input.title,
        body: input.body,
        relatedType: input.relatedType ?? null,
        relatedId: input.relatedId ?? null,
        isRead: false,
      },
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notify] failed to write notification:', (err as Error).message);
  }
}

/** Notify every admin of the school (school-scoped notification row). */
export async function notifyAdmins(
  db: Db,
  schoolId: string,
  input: { type: string; title: string; body: string; relatedType?: string | null; relatedId?: string | null },
): Promise<void> {
  await notifySchool(db, { schoolId, ...input });
}
