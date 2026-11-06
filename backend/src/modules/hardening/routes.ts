/**
 * Hardening routes (6A) — mounted at /api/v1 in app.ts.
 * Approvals, recycle bin, change history, roles/permissions, data export,
 * account deletion requests, backups. All routes: authenticate +
 * requireSchool (school_id from JWT only). Admin-only routes use
 * requireAdmin; the approval list is scoped (clerks see only their own).
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../lib/db';
import { parseBody, uuidSchema } from '../../lib/validate';
import { ApiError, asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdmin } from '../../middleware/rbac';
import { requirePermission } from '../../middleware/permissions';
import * as approvals from './approvals';
import * as recycleBin from './recycleBin';
import * as service from './service';
import { exportSchoolData, verifyAdminPassword } from './export';

export const hardeningRouter = Router();
hardeningRouter.use(authenticate, requireSchool);

const approvalSchema = z.object({
  action_type: z.enum(['create', 'update', 'delete', 'bulk']),
  entity: z.string().min(1).max(60),
  entity_id: uuidSchema.optional().nullable(),
  payload: z.record(z.unknown()),
});
const idParams = z.object({ id: uuidSchema });

// --- Approvals ---------------------------------------------------------------
hardeningRouter.get(
  '/approvals',
  asyncHandler(async (req, res) => {
    const isAdmin = req.user!.role === 'admin';
    const result = await approvals.listApprovalRequests(
      getDb(),
      schoolIdOf(req),
      req.query as Record<string, any>,
      isAdmin ? null : req.user!.sub,
    );
    res.json({ ok: true, data: result });
  }),
);

hardeningRouter.get(
  '/approvals/:id',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const row = await approvals.getApprovalRequest(getDb(), schoolIdOf(req), id);
    if (req.user!.role !== 'admin' && row.requestedBy !== req.user!.sub) {
      throw ApiError.forbidden('You can only view your own approval requests');
    }
    res.json({ ok: true, data: approvals.toPublicApproval(row) });
  }),
);

hardeningRouter.post(
  '/approvals',
  asyncHandler(async (req, res) => {
    const body = parseBody(approvalSchema, req.body);
    const created = await approvals.createApprovalRequest(getDb(), {
      schoolId: schoolIdOf(req),
      requestedBy: req.user!.sub,
      actionType: body.action_type,
      entity: body.entity,
      entityId: body.entity_id ?? null,
      payload: body.payload as Record<string, unknown>,
    });
    res.status(201).json({ ok: true, data: approvals.toPublicApproval(created) });
  }),
);

hardeningRouter.post(
  '/approvals/:id/approve',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const result = await approvals.approveApprovalRequest(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: result });
  }),
);

hardeningRouter.post(
  '/approvals/:id/reject',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const reason = typeof (req.body as any)?.reason === 'string' ? (req.body as any).reason : undefined;
    const result = await approvals.rejectApprovalRequest(getDb(), schoolIdOf(req), id, req.user!.sub, reason);
    res.json({ ok: true, data: result });
  }),
);

// --- Recycle bin ---------------------------------------------------------------
hardeningRouter.get(
  '/recycle-bin',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const result = await recycleBin.listRecycleBin(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data: result });
  }),
);

hardeningRouter.post(
  '/recycle-bin/:id/restore',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const result = await recycleBin.restoreDeletedRecord(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: result });
  }),
);

hardeningRouter.post(
  '/recycle-bin/:id/permanent-delete',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const confirm = (req.body as any)?.confirm;
    const result = await recycleBin.permanentDeleteRecord(getDb(), schoolIdOf(req), id, confirm, req.user!.sub);
    res.json({ ok: true, data: result });
  }),
);

// --- Change history ---------------------------------------------------------------
const changeHistoryHandler = asyncHandler(async (req, res) => {
  const result = await service.listChangeHistory(getDb(), schoolIdOf(req), req.query as Record<string, any>);
  res.json({ ok: true, data: result });
});
hardeningRouter.get('/change-history', changeHistoryHandler);
hardeningRouter.get('/change-logs', changeHistoryHandler);

// --- Roles & permissions ---------------------------------------------------------------
hardeningRouter.get(
  '/roles/permissions',
  asyncHandler(async (req, res) => {
    const items = await service.listRolePermissions(getDb(), schoolIdOf(req));
    res.json({ ok: true, data: { items, total: items.length, page: 1, pages: 1 } });
  }),
);

hardeningRouter.patch(
  '/roles/permissions',
  requireAdmin,
  requirePermission('users', 'update'),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        role: z.enum(['admin', 'clerk', 'principal']),
        resource: z.string().min(1),
        action: z.enum(['view', 'create', 'update', 'delete', 'approve', 'export']),
        allowed: z.boolean(),
      }),
      req.body,
    );
    const updated = await service.updateRolePermission(getDb(), schoolIdOf(req), body, req.user!.sub);
    res.json({ ok: true, data: updated });
  }),
);

hardeningRouter.get(
  '/roles/me',
  asyncHandler(async (req, res) => {
    const items = await service.getMyPermissions(getDb(), schoolIdOf(req), req.user!.role);
    res.json({ ok: true, data: { role: req.user!.role, items, total: items.length } });
  }),
);

// --- Data export (password-confirmed) ---------------------------------------------------------------
const exportHandler = asyncHandler(async (req, res) => {
  const password = (req.body as any)?.password;
  if (typeof password !== 'string' || !password) {
    throw ApiError.validation('password is required to confirm the export');
  }
  await verifyAdminPassword(getDb(), req.user!.sub, password);
  const data = await exportSchoolData(getDb(), schoolIdOf(req), req.user!.sub);
  res.json({ ok: true, data });
});
hardeningRouter.post('/export/all', requireAdmin, exportHandler);
hardeningRouter.get('/export/all', requireAdmin, exportHandler);

// --- Account deletion requests (request only — execution is manual) ---------------------------------------------------------------
hardeningRouter.post(
  '/account/delete-request',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const password = (req.body as any)?.password;
    if (typeof password !== 'string' || !password) {
      throw ApiError.validation('password is required to confirm the deletion request');
    }
    await verifyAdminPassword(getDb(), req.user!.sub, password);
    const created = await service.createAccountDeletionRequest(getDb(), schoolIdOf(req), req.user!.sub);
    res.status(201).json({ ok: true, data: created });
  }),
);

hardeningRouter.get(
  '/account/delete-requests',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const items = await service.listAccountDeletionRequests(getDb(), schoolIdOf(req));
    res.json({ ok: true, data: { items, total: items.length, page: 1, pages: 1 } });
  }),
);

hardeningRouter.patch(
  '/account/delete-requests/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const { status } = parseBody(
      z.object({ status: z.enum(['pending', 'approved', 'completed', 'rejected']) }),
      req.body,
    );
    const updated = await service.decideAccountDeletionRequest(getDb(), schoolIdOf(req), id, status, req.user!.sub);
    res.json({ ok: true, data: updated });
  }),
);

// --- Backups log (the backup job itself is Phase 6D/DevOps) ---------------------------------------------------------------
hardeningRouter.get(
  '/backups',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const items = await service.listBackups(getDb(), schoolIdOf(req));
    res.json({ ok: true, data: { items, total: items.length, page: 1, pages: 1 } });
  }),
);
