/**
 * Recycle bin (6A, contracts/SCHEMA.md §4).
 *
 * DELETE endpoints on soft-deletable entities set deleted_at + write a
 * deleted_records snapshot (see helpers.softDeleteEntity). This module is
 * the read/restore/purge side:
 *  - GET  /recycle-bin — deleted_records list (30-day window).
 *  - POST /recycle-bin/:id/restore — clears deleted_at (within 30 days).
 *  - POST /recycle-bin/:id/permanent-delete — admin only, SECOND
 *    confirmation: body {confirm: true} + the record id, else 400.
 *    Removes the row AND its snapshot.
 */
import { ApiError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { paginatedResponse, parsePagination } from '../../lib/pagination';
import type { Db } from '../../lib/db';
import { ENTITY_DELEGATES, isUniqueViolation, writeChangeLogs } from './helpers';

/** Public (snake_case) view of a deleted_records row (snapshot kept as-is). */
export function toPublicDeletedRecord(r: any): Record<string, unknown> {
  return {
    id: r.id,
    school_id: r.schoolId,
    entity: r.entity,
    entity_id: r.entityId,
    snapshot: r.snapshot,
    deleted_by: r.deletedBy ?? null,
    deleted_at: r.deletedAt,
    restore_by: r.restoreBy ?? null,
    permanently_deleted_at: r.permanentlyDeletedAt ?? null,
  };
}

export async function listRecycleBin(
  db: Db,
  schoolId: string,
  query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  const where: Record<string, unknown> = { schoolId, permanentlyDeletedAt: null };
  if (query.entity) where.entity = String(query.entity);
  const [items, total] = await Promise.all([
    (db as any).deletedRecord.findMany({ where, orderBy: [{ deletedAt: 'desc' }], skip, take: limit }),
    (db as any).deletedRecord.count({ where }),
  ]);
  return paginatedResponse(items.map(toPublicDeletedRecord), total, { page, limit, skip });
}

export async function restoreDeletedRecord(db: Db, schoolId: string, id: string, actorId: string): Promise<any> {
  const record = await (db as any).deletedRecord.findFirst({ where: { id, schoolId } });
  if (!record) throw ApiError.notFound('Recycle bin record not found');
  if (record.permanentlyDeletedAt) throw ApiError.conflict('This record was permanently deleted');
  if (record.restoreBy && new Date(record.restoreBy) < new Date()) {
    throw ApiError.conflict('The 30-day restore window has expired');
  }
  const delegateKey = ENTITY_DELEGATES[record.entity];
  if (!delegateKey) throw ApiError.validation(`Entity cannot be restored: ${record.entity}`);
  const delegate = (db as any)[delegateKey];
  const row = await delegate.findFirst({ where: { id: record.entityId, schoolId } });
  if (!row) throw ApiError.notFound(`${record.entity} row no longer exists`);
  try {
    await delegate.update({ where: { id: record.entityId }, data: { deletedAt: null } });
  } catch (err) {
    // A live row already holds the unique key (e.g. a class with the same
    // name was created after the delete): the DB unique index blocks the
    // un-delete. Say so plainly instead of surfacing a raw P2002 500.
    if (isUniqueViolation(err)) {
      throw ApiError.conflict(
        `Cannot restore this ${record.entity}: a live record with the same name or number already exists. Rename or delete the live record first, then restore.`,
      );
    }
    throw err;
  }
  await (db as any).deletedRecord.delete({ where: { id } });
  // Round 2: a restore IS a change — log deleted_at <ts> -> null.
  await writeChangeLogs(db, {
    schoolId,
    actorId,
    entity: record.entity,
    entityId: record.entityId,
    before: { deleted_at: record.deletedAt ? new Date(record.deletedAt).toISOString() : null },
    after: { deleted_at: null },
  });
  await writeAudit(db, {
    schoolId,
    actorId,
    actorType: 'user',
    action: 'recycle_bin.restore',
    entity: record.entity,
    entityId: record.entityId,
    details: { deleted_record_id: id },
  });
  return { entity: record.entity, entity_id: record.entityId, restored: true };
}

export async function permanentDeleteRecord(
  db: Db,
  schoolId: string,
  id: string,
  confirm: unknown,
  actorId: string,
): Promise<{ entity: string; entity_id: string; permanently_deleted: boolean }> {
  // SECOND confirmation: body {confirm: true} plus the record id in the path, else 400.
  if (confirm !== true) {
    throw ApiError.validation('Permanent delete requires a second confirmation: send {confirm: true}');
  }
  const record = await (db as any).deletedRecord.findFirst({ where: { id, schoolId } });
  if (!record) throw ApiError.notFound('Recycle bin record not found');
  if (record.permanentlyDeletedAt) throw ApiError.conflict('This record was already permanently deleted');
  const delegateKey = ENTITY_DELEGATES[record.entity];
  if (delegateKey) {
    const delegate = (db as any)[delegateKey];
    const row = await delegate.findFirst({ where: { id: record.entityId, schoolId } });
    if (row) await delegate.delete({ where: { id: record.entityId } });
  }
  // Remove the row AND its snapshot.
  await (db as any).deletedRecord.delete({ where: { id } });
  // Round 2: a permanent delete IS a change — log status deleted -> permanently_deleted.
  await writeChangeLogs(db, {
    schoolId,
    actorId,
    entity: record.entity,
    entityId: record.entityId,
    before: { status: 'deleted' },
    after: { status: 'permanently_deleted' },
  });
  await writeAudit(db, {
    schoolId,
    actorId,
    actorType: 'user',
    action: 'recycle_bin.permanent_delete',
    entity: record.entity,
    entityId: record.entityId,
    details: { deleted_record_id: id },
  });
  return { entity: record.entity, entity_id: record.entityId, permanently_deleted: true };
}
