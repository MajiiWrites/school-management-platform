/**
 * Hardening service — roles/permissions, change history, data ownership
 * (account deletion requests, backups list). Approval queue lives in
 * approvals.ts, recycle bin in recycleBin.ts, export in export.ts, 2FA in
 * twofa.ts.
 */
import bcrypt from 'bcrypt';
import { ApiError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { writeChangeLogs } from './helpers';
import { paginatedResponse, parsePagination } from '../../lib/pagination';
import type { Db } from '../../lib/db';
import { ACTIONS, DEFAULT_MATRIX, RESOURCES, getEffectivePermissions } from './permissions';

// ---------------------------------------------------------------------------
// Roles & permissions
// ---------------------------------------------------------------------------

export async function listRolePermissions(db: Db, schoolId: string): Promise<any[]> {
  const rows: any[] = await (db as any).rolePermission.findMany({
    where: { schoolId },
    orderBy: [{ role: 'asc' }, { resource: 'asc' }, { action: 'asc' }],
  });
  if (rows.length > 0) return rows;
  // No stored rows yet (fresh school / pre-seed DB): report the defaults.
  const out: any[] = [];
  for (const [role, pairs] of Object.entries(DEFAULT_MATRIX)) {
    for (const [resource, action] of pairs) {
      out.push({ role, resource, action, allowed: true, schoolId });
    }
  }
  return out;
}

export async function updateRolePermission(
  db: Db,
  schoolId: string,
  input: { role: string; resource: string; action: string; allowed: boolean },
  adminId: string,
): Promise<any> {
  const { role, resource, action, allowed } = input;
  if (!['admin', 'clerk', 'principal'].includes(role)) throw ApiError.validation('role must be admin, clerk or principal');
  if (!(RESOURCES as readonly string[]).includes(resource)) {
    throw ApiError.validation(`Unknown resource: ${resource}`);
  }
  if (!(ACTIONS as readonly string[]).includes(action)) {
    throw ApiError.validation(`action must be one of: ${ACTIONS.join(', ')}`);
  }
  if (typeof allowed !== 'boolean') throw ApiError.validation('allowed must be a boolean');
  if (role === 'admin' && allowed === false) {
    throw ApiError.validation('Admin permissions cannot be revoked (admin bypasses with all allowed)');
  }
  const updated = await (db as any).rolePermission.upsert({
    where: { schoolId_role_resource_action: { schoolId, role, resource, action } },
    update: { allowed },
    create: { schoolId, role, resource, action, allowed },
  });
  await writeAudit(db, {
    schoolId,
    actorId: adminId,
    actorType: 'user',
    action: 'role.permission_update',
    entity: 'role_permission',
    entityId: updated.id,
    details: { role, resource, action, allowed },
  });
  return updated;
}

export async function getMyPermissions(db: Db, schoolId: string, role: string): Promise<any[]> {
  if (role === 'admin') {
    return RESOURCES.flatMap((r) => ACTIONS.map((a) => ({ role, resource: r, action: a, allowed: true })));
  }
  return getEffectivePermissions(db, schoolId, role);
}

/** Create a principal login (admin only). Login works like a clerk; all mutations 403. */
export async function createPrincipal(
  db: Db,
  schoolId: string,
  input: { email: string; password: string },
  adminId: string,
): Promise<any> {
  const email = input.email.trim().toLowerCase();
  const existing = await db.user.findFirst({ where: { email } });
  if (existing) throw ApiError.conflict('An account with this email already exists');
  const passwordHash = await bcrypt.hash(input.password, 12);
  const principal = await db.user.create({
    data: { schoolId, email, passwordHash, role: 'principal', emailVerified: true },
  });
  await writeChangeLogs(db, {
    schoolId,
    actorId: adminId,
    entity: 'user',
    entityId: principal.id,
    before: {},
    after: { email, role: 'principal' },
  });
  await writeAudit(db, {
    schoolId,
    actorId: adminId,
    actorType: 'user',
    action: 'user.principal_create',
    entity: 'user',
    entityId: principal.id,
    details: { email },
  });
  return { id: principal.id, email: principal.email, role: principal.role, school_id: principal.schoolId, email_verified: principal.emailVerified };
}

// ---------------------------------------------------------------------------
// Change history (per-field old/new; audit_logs stays the per-action log)
// ---------------------------------------------------------------------------

export async function listChangeHistory(
  db: Db,
  schoolId: string,
  query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  const where: Record<string, unknown> = { schoolId };
  if (query.entity) where.entity = String(query.entity);
  if (query.entity_id) where.entityId = String(query.entity_id);
  const [items, total] = await Promise.all([
    (db as any).changeLog.findMany({ where, orderBy: [{ changedAt: 'desc' }], skip, take: limit }),
    (db as any).changeLog.count({ where }),
  ]);
  // Round 2: resolve the actor id to the admin's email so the WHO column
  // shows a person, not a bare UUID. Users have no display name — email
  // is the identity. Deleted actors resolve to null (actor_id is SetNull).
  const actorIds = [...new Set(items.map((r: any) => r.actorId).filter((id: unknown): id is string => typeof id === 'string' && id.length > 0))];
  const actors = actorIds.length > 0
    ? await (db as any).user.findMany({ where: { schoolId, id: { in: actorIds } } })
    : [];
  const emailById = new Map<string, string>(actors.map((u: any) => [u.id, u.email] as [string, string]));
  const mapped = items.map((r: any) => ({
    id: r.id,
    school_id: r.schoolId,
    actor_id: r.actorId ?? null,
    actor_email: r.actorId ? (emailById.get(r.actorId) ?? null) : null,
    actor_type: r.actorType,
    entity: r.entity,
    entity_id: r.entityId ?? null,
    field: r.field,
    old_value: r.oldValue ?? null,
    new_value: r.newValue ?? null,
    changed_at: r.changedAt,
  }));
  return paginatedResponse(mapped, total, { page, limit, skip });
}

// ---------------------------------------------------------------------------
// Data ownership — account deletion requests + backups log
// ---------------------------------------------------------------------------

export async function createAccountDeletionRequest(db: Db, schoolId: string, adminId: string): Promise<any> {
  const pending = await (db as any).accountDeletionRequest.findFirst({ where: { schoolId, status: 'pending' } });
  if (pending) throw ApiError.conflict('An account deletion request is already pending');
  const created = await (db as any).accountDeletionRequest.create({
    data: { schoolId, requestedBy: adminId, status: 'pending' },
  });
  await writeAudit(db, {
    schoolId,
    actorId: adminId,
    actorType: 'user',
    action: 'account.delete_requested',
    entity: 'account_deletion_request',
    entityId: created.id,
    details: { note: 'Request only — actual deletion is a separate manual/approved step (see HARDENING.md).' },
  });
  return created;
}

export async function listAccountDeletionRequests(db: Db, schoolId: string): Promise<any[]> {
  return (db as any).accountDeletionRequest.findMany({
    where: { schoolId },
    orderBy: [{ requestedAt: 'desc' }],
  });
}

export async function decideAccountDeletionRequest(
  db: Db,
  schoolId: string,
  id: string,
  status: string,
  adminId: string,
): Promise<any> {
  if (!['pending', 'approved', 'completed', 'rejected'].includes(status)) {
    throw ApiError.validation('status must be pending, approved, completed or rejected');
  }
  const row = await (db as any).accountDeletionRequest.findFirst({ where: { id, schoolId } });
  if (!row) throw ApiError.notFound('Account deletion request not found');
  const data: Record<string, unknown> = { status };
  if (status === 'completed') data.completedAt = new Date();
  const updated = await (db as any).accountDeletionRequest.update({ where: { id }, data });
  await writeAudit(db, {
    schoolId,
    actorId: adminId,
    actorType: 'user',
    action: 'account.delete_request_decided',
    entity: 'account_deletion_request',
    entityId: id,
    details: { status },
  });
  return updated;
}

export async function listBackups(db: Db, schoolId: string): Promise<any[]> {
  return (db as any).schoolBackup.findMany({
    where: { schoolId },
    orderBy: [{ createdAt: 'desc' }],
  });
}
