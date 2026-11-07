// Sessions routes (6C-1). Mounted BEFORE adminRouter in app.ts so these
// handlers supersede the v1 admin session routes (same paths, snake_case
// public views + is_archived + PATCH/DELETE/archive/promote, which the v1
// routes did not have). GET /sessions and POST /sessions/:id/make-current
// keep the v1 contract the Settings page relies on.
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

export const sessionsRouter = Router();
sessionsRouter.use(authenticate, requireSchool);

sessionsRouter.get(
  '/sessions',
  asyncHandler(async (req, res) => {
    const data = await service.listSessions(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data });
  }),
);

sessionsRouter.post(
  '/sessions',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ name: z.string().min(2).max(120), start_date: dateSchema, end_date: dateSchema }), req.body);
    const created = await service.createSession(getDb(), schoolIdOf(req), body, req.user!.sub);
    res.status(201).json({ ok: true, data: created });
  }),
);

sessionsRouter.get(
  '/sessions/:id',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const data = await service.getSession(getDb(), schoolIdOf(req), id);
    res.json({ ok: true, data });
  }),
);

sessionsRouter.patch(
  '/sessions/:id',
  requireAdminOrClerk,
  requireQueueable('academic_sessions', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const body = parseBody(
      z.object({ name: z.string().min(2).max(120).optional(), start_date: dateSchema.optional(), end_date: dateSchema.optional() }),
      req.body,
    );
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'academic_session', entityId: id, payload: { id, patch: body } })) return;
    const updated = await service.updateSession(getDb(), schoolIdOf(req), id, body, req.user!.sub);
    res.json({ ok: true, data: updated });
  }),
);

sessionsRouter.delete(
  '/sessions/:id',
  requireAdminOrClerk,
  requireQueueable('academic_sessions', 'delete'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'academic_session', entityId: id, payload: { id } })) return;
    await service.deleteSession(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Session deleted' } });
  }),
);

sessionsRouter.post(
  '/sessions/:id/make-current',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const session = await service.makeSessionCurrent(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: session });
  }),
);

sessionsRouter.post(
  '/sessions/:id/archive',
  requireAdminOrClerk,
  requireQueueable('academic_sessions', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'academic_session', entityId: id, payload: { id, archive: true } })) return;
    const session = await service.archiveSession(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: session });
  }),
);

sessionsRouter.post(
  '/sessions/:id/unarchive',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const session = await service.unarchiveSession(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: session });
  }),
);

const promotionMappingSchema = z.object({
  student_id: uuidSchema,
  to_class_id: uuidSchema.nullable().optional(),
  outcome: z.enum(['promoted', 'graduated', 'held']).optional(),
});

sessionsRouter.post(
  '/sessions/:id/promote',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const body = parseBody(
      z.object({
        from_class_id: uuidSchema,
        to_class_id: uuidSchema.nullable().optional(),
        student_ids: z.array(uuidSchema).optional(),
        outcome: z.enum(['promoted', 'graduated', 'held']).optional(),
      }),
      req.body,
    );
    const result = await service.promoteClassSection(getDb(), schoolIdOf(req), id, body, req.user!.sub);
    res.json({ ok: true, data: result });
  }),
);

// Promotion rebuild (Module D): preview before confirm, explicit per-student
// mappings, batch undo, single-student edit, batch history.
sessionsRouter.post(
  '/sessions/:id/promotions/preview',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const body = parseBody(z.object({ mappings: z.array(promotionMappingSchema).min(1) }), req.body);
    const data = await service.previewPromotion(getDb(), schoolIdOf(req), id, body);
    res.json({ ok: true, data });
  }),
);

sessionsRouter.post(
  '/sessions/:id/promotions',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const body = parseBody(z.object({ mappings: z.array(promotionMappingSchema).min(1) }), req.body);
    const data = await service.applyPromotion(getDb(), schoolIdOf(req), id, body, req.user!.sub);
    res.json({ ok: true, data });
  }),
);

sessionsRouter.get(
  '/sessions/:id/promotion-batches',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const data = await service.listPromotionBatches(getDb(), schoolIdOf(req), id);
    res.json({ ok: true, data: { items: data, total: data.length, page: 1, pages: 1 } });
  }),
);

sessionsRouter.post(
  '/sessions/:id/promotion-batches/:batchId/undo',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id, batchId } = parseBody(z.object({ id: uuidSchema, batchId: z.string().min(1).max(80) }), req.params);
    const data = await service.undoPromotion(getDb(), schoolIdOf(req), batchId, req.user!.sub);
    res.json({ ok: true, data });
  }),
);

sessionsRouter.patch(
  '/sessions/:id/promotions/:promotionId',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id, promotionId } = parseBody(z.object({ id: uuidSchema, promotionId: uuidSchema }), req.params);
    const body = parseBody(
      z.object({ to_class_id: uuidSchema.nullable().optional(), outcome: z.enum(['promoted', 'graduated', 'held']).optional() }),
      req.body,
    );
    const data = await service.editPromotion(getDb(), schoolIdOf(req), promotionId, body, req.user!.sub);
    res.json({ ok: true, data });
  }),
);

sessionsRouter.get(
  '/sessions/:id/promotions',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const data = await service.listSessionPromotions(getDb(), schoolIdOf(req), id, req.query as Record<string, any>);
    res.json({ ok: true, data });
  }),
);
