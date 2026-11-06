import type { Db } from './db';

/** Every mutation writes an audit_logs row (contracts/API.md rule 5). */
export async function writeAudit(
  db: Db,
  entry: {
    schoolId: string;
    actorId?: string | null;
    actorType: 'user' | 'teacher_link' | 'system' | 'device';
    action: string;
    entity: string;
    entityId?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        schoolId: entry.schoolId,
        actorId: entry.actorId ?? null,
        actorType: entry.actorType,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        details: entry.details ?? {},
      },
    });
  } catch (err) {
    // Audit must never break the business operation; log and continue.
    // eslint-disable-next-line no-console
    console.error('[audit] failed to write audit log:', (err as Error).message);
  }
}
