// Timetable routes (6C-1).
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../lib/db';
import { parseBody, uuidSchema } from '../../lib/validate';
import { asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdminOrClerk } from '../../middleware/rbac';
import { requireQueueable } from '../../middleware/permissions';
import { queueIfClerk } from '../hardening/queueGate';
import * as service from './service';

export const timetableRouter = Router();
timetableRouter.use(authenticate, requireSchool);

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM (24h)');
const entryBody = z.object({
  class_id: uuidSchema,
  teacher_id: z.string().uuid().optional().nullable(),
  day_of_week: z.number().int().min(0).max(6),
  period_no: z.number().int().min(1),
  subject: z.string().min(1).max(120),
  start_time: timeSchema,
  end_time: timeSchema,
  room: z.string().max(60).optional().nullable(),
});

timetableRouter.get(
  '/timetable',
  asyncHandler(async (req, res) => {
    const data = await service.listTimetable(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data });
  }),
);

timetableRouter.get(
  '/timetable/class/:class_id',
  asyncHandler(async (req, res) => {
    const { class_id } = parseBody(z.object({ class_id: uuidSchema }), req.params);
    const data = await service.getClassTimetable(getDb(), schoolIdOf(req), class_id);
    res.json({ ok: true, data });
  }),
);

timetableRouter.get(
  '/timetable/teacher/:staff_id',
  asyncHandler(async (req, res) => {
    const { staff_id } = parseBody(z.object({ staff_id: uuidSchema }), req.params);
    const data = await service.getTeacherTimetable(getDb(), schoolIdOf(req), staff_id);
    res.json({ ok: true, data });
  }),
);

timetableRouter.post(
  '/timetable',
  requireAdminOrClerk,
  requireQueueable('timetable', 'create'),
  asyncHandler(async (req, res) => {
    const body = parseBody(entryBody, req.body);
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'timetable_entry', payload: body })) return;
    const created = await service.createTimetableEntry(getDb(), schoolIdOf(req), body as any, req.user!.sub);
    res.status(201).json({ ok: true, data: created });
  }),
);

timetableRouter.patch(
  '/timetable/:id',
  requireAdminOrClerk,
  requireQueueable('timetable', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const body = parseBody(
      z.object({
        teacher_id: z.string().uuid().optional().nullable(),
        day_of_week: z.number().int().min(0).max(6).optional(),
        period_no: z.number().int().min(1).optional(),
        subject: z.string().min(1).max(120).optional(),
        start_time: timeSchema.optional(),
        end_time: timeSchema.optional(),
        room: z.string().max(60).optional().nullable(),
      }),
      req.body,
    );
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'timetable_entry', entityId: id, payload: { id, patch: body } })) return;
    const updated = await service.updateTimetableEntry(getDb(), schoolIdOf(req), id, body as any, req.user!.sub);
    res.json({ ok: true, data: updated });
  }),
);

timetableRouter.delete(
  '/timetable/:id',
  requireAdminOrClerk,
  requireQueueable('timetable', 'delete'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'timetable_entry', entityId: id, payload: { id } })) return;
    await service.deleteTimetableEntry(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Timetable entry deleted' } });
  }),
);
