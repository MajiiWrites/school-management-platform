// Homework routes (Gap #3, 2026-11-20). All admin JWT; clerk mutations
// are queue-gated like classes (see approvals.ts).
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../lib/db';
import { parseBody, uuidSchema, dateSchema } from '../../lib/validate';
import { asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdmin, requireAdminOrClerk } from '../../middleware/rbac';
import { requireQueueable } from '../../middleware/permissions';
import { queueIfClerk } from '../hardening/queueGate';
import * as service from './service';

export const homeworkRouter = Router();
homeworkRouter.use(authenticate, requireSchool);

const idParams = z.object({ id: uuidSchema });

const homeworkSchema = z.object({
  class_id: uuidSchema,
  subject: z.string().min(1, 'Subject is required').max(120),
  title: z.string().min(1, 'Title is required').max(200),
  description: z.string().max(1000).optional().nullable(),
  due_date: dateSchema,
  teacher: z.string().min(1, 'Teacher name is required').max(120),
});
const homeworkPatchSchema = homeworkSchema.partial().omit({ class_id: true }).extend({
  class_id: uuidSchema.optional(),
});

homeworkRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const data = await service.listHomework(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data });
  }),
);

homeworkRouter.post(
  '/',
  requireAdminOrClerk,
  requireQueueable('homework', 'create'),
  asyncHandler(async (req, res) => {
    const body = parseBody(homeworkSchema, req.body);
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'homework', payload: body })) return;
    const created = await service.createHomework(getDb(), schoolIdOf(req), body, req.user!.sub);
    res.status(201).json({ ok: true, data: { homework: created } });
  }),
);

homeworkRouter.patch(
  '/:id',
  requireAdminOrClerk,
  requireQueueable('homework', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const patch = parseBody(homeworkPatchSchema, req.body);
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'homework', entityId: id, payload: { id, patch } })) return;
    const updated = await service.updateHomework(getDb(), schoolIdOf(req), id, patch, req.user!.sub);
    res.json({ ok: true, data: { homework: updated } });
  }),
);

homeworkRouter.delete(
  '/:id',
  requireAdminOrClerk,
  requireQueueable('homework', 'delete'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'homework', entityId: id, payload: { id } })) return;
    await service.deleteHomework(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Homework deleted (moved to recycle bin — restorable for 30 days)' } });
  }),
);

// Queue held SMS drafts for the class's parents about one homework entry.
homeworkRouter.post(
  '/:id/notify',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const result = await service.notifyHomework(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.status(201).json({ ok: true, data: result });
  }),
);
