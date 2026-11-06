import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../lib/db';
import { parseBody, uuidSchema } from '../../lib/validate';
import { asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdmin, requireAdminOrClerk } from '../../middleware/rbac';
import { requirePermission, requireQueueable } from '../../middleware/permissions';
import { queueIfClerk } from '../hardening/queueGate';
import * as service from './service';

export const classesRouter = Router();
classesRouter.use(authenticate, requireSchool);

const classSchema = z.object({
  name: z.string().min(1, 'Class name is required').max(20),
  section: z.string().min(1, 'Section is required').max(10),
  teacher_name: z.string().min(2, 'Teacher name is required').max(120),
  teacher_phone: z.string().optional().nullable(),
});
const classPatchSchema = classSchema.partial();

classesRouter.post(
  '/',
  requireAdminOrClerk,
  requireQueueable('classes', 'create'),
  asyncHandler(async (req, res) => {
    const body = parseBody(classSchema, req.body);
    // 6A: clerk creates go to the approval queue (202); admin applies directly.
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'class', payload: body })) return;
    const created = await service.createClass(getDb(), schoolIdOf(req), body, req.user!.sub);
    res.status(201).json({ ok: true, data: service.toPublicClass(created, 0) });
  }),
);

classesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const items = await service.listClasses(getDb(), schoolIdOf(req));
    res.json({ ok: true, data: { items, total: items.length, page: 1, pages: 1 } });
  }),
);

classesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseBody(z.object({ id: uuidSchema }), req.params).id;
    const item = await service.getClass(getDb(), schoolIdOf(req), id);
    res.json({ ok: true, data: item });
  }),
);

classesRouter.patch(
  '/:id',
  requireAdminOrClerk,
  requireQueueable('classes', 'update'),
  asyncHandler(async (req, res) => {
    const id = parseBody(z.object({ id: uuidSchema }), req.params).id;
    const patch = parseBody(classPatchSchema, req.body);
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'class', entityId: id, payload: { id, patch } })) return;
    const updated = await service.updateClass(getDb(), schoolIdOf(req), id, patch, req.user!.sub);
    res.json({ ok: true, data: service.toPublicClass(updated) });
  }),
);

classesRouter.delete(
  '/:id',
  requireAdminOrClerk,
  requireQueueable('classes', 'delete'),
  asyncHandler(async (req, res) => {
    const id = parseBody(z.object({ id: uuidSchema }), req.params).id;
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'class', entityId: id, payload: { id } })) return;
    await service.deleteClass(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Class deleted (moved to recycle bin — restorable for 30 days)' } });
  }),
);

classesRouter.post(
  '/:id/attendance-link/regenerate',
  requireAdmin,
  requirePermission('classes', 'update'),
  asyncHandler(async (req, res) => {
    const id = parseBody(z.object({ id: uuidSchema }), req.params).id;
    const result = await service.regenerateLink(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: result });
  }),
);

classesRouter.post(
  '/:id/attendance-link/revoke',
  requireAdmin,
  requirePermission('classes', 'update'),
  asyncHandler(async (req, res) => {
    const id = parseBody(z.object({ id: uuidSchema }), req.params).id;
    await service.revokeLink(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Attendance link revoked' } });
  }),
);
