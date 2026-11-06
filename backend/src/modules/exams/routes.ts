// Exams routes (6C-1): exam definitions, datesheets, grading scales.
// Clerk mutations go through the approval queue (202); admin applies
// directly. Results endpoints belong to 6B — nothing here touches results.
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

export const examsRouter = Router();
examsRouter.use(authenticate, requireSchool);

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM (24h)');
const optionalUuid = z.string().uuid().optional().nullable();

// --- Exams -------------------------------------------------------------------
examsRouter.get(
  '/exams',
  asyncHandler(async (req, res) => {
    const data = await service.listExams(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data });
  }),
);

examsRouter.post(
  '/exams',
  requireAdminOrClerk,
  requireQueueable('exams', 'create'),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ name: z.string().min(2).max(120), session_id: optionalUuid, start_date: dateSchema.optional().nullable(), end_date: dateSchema.optional().nullable() }),
      req.body,
    );
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'exam', payload: body })) return;
    const created = await service.createExam(getDb(), schoolIdOf(req), body as any, req.user!.sub);
    res.status(201).json({ ok: true, data: created });
  }),
);

examsRouter.get(
  '/exams/:id',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const data = await service.getExam(getDb(), schoolIdOf(req), id);
    res.json({ ok: true, data });
  }),
);

examsRouter.patch(
  '/exams/:id',
  requireAdminOrClerk,
  requireQueueable('exams', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const body = parseBody(
      z.object({ name: z.string().min(2).max(120).optional(), session_id: optionalUuid, start_date: dateSchema.optional().nullable(), end_date: dateSchema.optional().nullable() }),
      req.body,
    );
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'exam', entityId: id, payload: { id, patch: body } })) return;
    const updated = await service.updateExam(getDb(), schoolIdOf(req), id, body as any, req.user!.sub);
    res.json({ ok: true, data: updated });
  }),
);

examsRouter.delete(
  '/exams/:id',
  requireAdminOrClerk,
  requireQueueable('exams', 'delete'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'exam', entityId: id, payload: { id } })) return;
    await service.deleteExam(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Exam deleted (moved to the recycle bin)' } });
  }),
);

// --- Datesheets ---------------------------------------------------------------
examsRouter.get(
  '/exams/:id/datesheet',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const data = await service.listDatesheet(getDb(), schoolIdOf(req), id, req.query as Record<string, any>);
    res.json({ ok: true, data });
  }),
);

examsRouter.post(
  '/exams/:id/datesheet',
  requireAdminOrClerk,
  requireQueueable('exams', 'create'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const body = parseBody(
      z.object({ class_id: uuidSchema, subject: z.string().min(1).max(120), date: dateSchema, start_time: timeSchema, end_time: timeSchema }),
      req.body,
    );
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'exam_datesheet', payload: { exam_id: id, ...body } })) return;
    const created = await service.createDatesheet(getDb(), schoolIdOf(req), id, body, req.user!.sub);
    res.status(201).json({ ok: true, data: created });
  }),
);

examsRouter.patch(
  '/exams/datesheet/:id',
  requireAdminOrClerk,
  requireQueueable('exams', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const body = parseBody(
      z.object({ subject: z.string().min(1).max(120).optional(), date: dateSchema.optional(), start_time: timeSchema.optional(), end_time: timeSchema.optional() }),
      req.body,
    );
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'exam_datesheet', entityId: id, payload: { id, patch: body } })) return;
    const updated = await service.updateDatesheet(getDb(), schoolIdOf(req), id, body, req.user!.sub);
    res.json({ ok: true, data: updated });
  }),
);

examsRouter.delete(
  '/exams/datesheet/:id',
  requireAdminOrClerk,
  requireQueueable('exams', 'delete'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'exam_datesheet', entityId: id, payload: { id } })) return;
    await service.deleteDatesheet(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Datesheet entry deleted' } });
  }),
);

// --- Grading scales ------------------------------------------------------------
// NOTE: /grading-scales/passing must be registered before /grading-scales/:id.
examsRouter.get(
  '/grading-scales/passing',
  asyncHandler(async (req, res) => {
    const data = await service.getPassingMarks(getDb(), schoolIdOf(req), (req.query.class_id as string | undefined) ?? null);
    res.json({ ok: true, data });
  }),
);

examsRouter.get(
  '/grading-scales',
  asyncHandler(async (req, res) => {
    const items = await service.listGradingScales(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data: { items, total: items.length, page: 1, pages: 1 } });
  }),
);

examsRouter.post(
  '/grading-scales',
  requireAdminOrClerk,
  requireQueueable('exams', 'create'),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ class_id: optionalUuid, min_marks: z.number().int(), max_marks: z.number().int(), grade: z.string().min(1).max(10), gpa_points: z.number(), is_passing: z.boolean().optional() }),
      req.body,
    );
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'grading_scale', payload: body })) return;
    const created = await service.createGradingScale(getDb(), schoolIdOf(req), body as any, req.user!.sub);
    res.status(201).json({ ok: true, data: created });
  }),
);

examsRouter.post(
  '/grading-scales/seed-defaults',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const items = await service.seedDefaultGradingScales(getDb(), schoolIdOf(req), req.user!.sub);
    res.status(201).json({ ok: true, data: { items, total: items.length, page: 1, pages: 1 } });
  }),
);

examsRouter.patch(
  '/grading-scales/:id',
  requireAdminOrClerk,
  requireQueueable('exams', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const body = parseBody(
      z.object({ min_marks: z.number().int().optional(), max_marks: z.number().int().optional(), grade: z.string().min(1).max(10).optional(), gpa_points: z.number().optional(), is_passing: z.boolean().optional() }),
      req.body,
    );
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'grading_scale', entityId: id, payload: { id, patch: body } })) return;
    const updated = await service.updateGradingScale(getDb(), schoolIdOf(req), id, body, req.user!.sub);
    res.json({ ok: true, data: updated });
  }),
);

examsRouter.delete(
  '/grading-scales/:id',
  requireAdminOrClerk,
  requireQueueable('exams', 'delete'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'grading_scale', entityId: id, payload: { id } })) return;
    await service.deleteGradingScale(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Grading band deleted' } });
  }),
);
