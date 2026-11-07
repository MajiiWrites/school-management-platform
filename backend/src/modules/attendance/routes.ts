import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../lib/db';
import { parseBody, uuidSchema, dateSchema } from '../../lib/validate';
import { asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdmin } from '../../middleware/rbac';
import { publicLinkLimiter } from '../../middleware/rateLimit';
import * as service from './service';

export const attendanceRouter = Router();

const recordsSchema = z.object({
  records: z.array(
    z.object({
      student_id: uuidSchema,
      status: z.enum(['present', 'absent']),
    }),
  ),
});

// --- Public teacher link (NO JWT) ------------------------------------------
attendanceRouter.get(
  '/t/:token',
  publicLinkLimiter,
  asyncHandler(async (req, res) => {
    const data = await service.getLinkPage(getDb(), req.params.token);
    res.json({ ok: true, data });
  }),
);

attendanceRouter.post(
  '/t/:token/submit',
  publicLinkLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(recordsSchema, req.body);
    const result = await service.submitAttendance(getDb(), { token: req.params.token, records: body.records });
    res.status(201).json({ ok: true, data: result });
  }),
);

// --- Admin attendance management (JWT) --------------------------------------
// NOTE: auth is applied PER-ROUTE below (authenticate + requireSchool as
// the first handlers), NOT via authed.use(...). A router-level use() runs
// for every request that falls through this router — including paths owned
// by later-mounted routers (e.g. the messaging router's device-key-only
// /sms/devices/* endpoints) — and would 401 them before they are reached
// (QA 2026-11-06: companion-app polling was impossible for this reason).
const authed = Router();

authed.get(
  '/classes/:id/attendance',
  authenticate,
  requireSchool,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const date = parseBody(z.object({ date: dateSchema }), req.query as Record<string, unknown>).date;
    const data = await service.getClassAttendance(getDb(), schoolIdOf(req), id, date);
    res.json({ ok: true, data });
  }),
);

authed.patch(
  '/classes/:id/attendance/unlock',
  authenticate,
  requireSchool,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const { date } = parseBody(z.object({ date: dateSchema }), req.body);
    const day = await service.unlockAttendance(getDb(), schoolIdOf(req), id, date, req.user!.sub);
    res.json({ ok: true, data: { id: day.id, unlocked: true } });
  }),
);

authed.patch(
  '/attendance/:dayId',
  authenticate,
  requireSchool,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { dayId } = parseBody(z.object({ dayId: uuidSchema }), req.params);
    const body = parseBody(recordsSchema, req.body);
    const result = await service.editAttendance(getDb(), schoolIdOf(req), dayId, body.records, req.user!.sub);
    res.json({ ok: true, data: result });
  }),
);

// --- Teacher attendance (admin-marked) ---------------------------------------
authed.post(
  '/teacher-attendance',
  authenticate,
  requireSchool,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        class_id: uuidSchema,
        date: dateSchema,
        status: z.enum(['present', 'absent']),
        note: z.string().max(500).optional().nullable(),
      }),
      req.body,
    );
    const saved = await service.markTeacherAttendance(getDb(), schoolIdOf(req), body, req.user!.sub);
    res.status(201).json({ ok: true, data: saved });
  }),
);

authed.get(
  '/teacher-attendance',
  authenticate,
  requireSchool,
  asyncHandler(async (req, res) => {
    const items = await service.listTeacherAttendance(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data: { items, total: items.length, page: 1, pages: 1 } });
  }),
);

attendanceRouter.use(authed);
