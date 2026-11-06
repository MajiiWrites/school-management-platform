// Events routes (6C-2) — mounted in app.ts at /api/v1/events.
// GET /events/calendar?month=YYYY-MM merges holidays + events.

import { Router, type Request } from 'express';
import { getDb } from '../../lib/db';
import { ApiError, asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdminOrClerk } from '../../middleware/rbac';
import { requireQueueable } from '../../middleware/permissions';
import { queueIfClerk } from '../hardening/queueGate';
import { createEvent, deleteEvent, listEvents, monthCalendar, updateEvent } from './service';

export const eventsRouter = Router();
eventsRouter.use(authenticate, requireSchool);

function parsePageLimit(req: Request): { page: number; limit: number } {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 50);
  return {
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50,
  };
}

function queryStr(req: Request, key: string): string | undefined {
  const v = req.query[key];
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

eventsRouter.get(
  '/calendar',
  asyncHandler(async (req, res) => {
    const month = queryStr(req, 'month');
    if (!month) throw ApiError.validation('month query param (YYYY-MM) is required');
    const data = await monthCalendar(getDb(), schoolIdOf(req), month);
    res.json({ ok: true, data });
  }),
);

eventsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, limit } = parsePageLimit(req);
    const data = await listEvents(getDb(), schoolIdOf(req), { month: queryStr(req, 'month'), page, limit });
    res.json({ ok: true, data });
  }),
);

eventsRouter.post(
  '/',
  requireAdminOrClerk,
  requireQueueable('events', 'create'),
  asyncHandler(async (req, res) => {
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'event', payload: req.body })) return;
    const data = await createEvent(getDb(), schoolIdOf(req), req.body, req.user?.sub ?? 'unknown');
    res.status(201).json({ ok: true, data });
  }),
);

eventsRouter.patch(
  '/:id',
  requireAdminOrClerk,
  requireQueueable('events', 'update'),
  asyncHandler(async (req, res) => {
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'event', entityId: req.params.id, payload: { id: req.params.id, patch: req.body } })) return;
    const data = await updateEvent(getDb(), schoolIdOf(req), req.params.id, req.body, req.user?.sub ?? 'unknown');
    res.json({ ok: true, data });
  }),
);

eventsRouter.delete(
  '/:id',
  requireAdminOrClerk,
  requireQueueable('events', 'delete'),
  asyncHandler(async (req, res) => {
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'event', entityId: req.params.id, payload: { id: req.params.id } })) return;
    await deleteEvent(getDb(), schoolIdOf(req), req.params.id, req.user?.sub ?? 'unknown');
    res.json({ ok: true, data: { deleted: true } });
  }),
);
