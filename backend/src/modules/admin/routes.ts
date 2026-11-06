import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../lib/db';
import { parseBody, passwordSchema, emailSchema, uuidSchema, dateSchema } from '../../lib/validate';
import { asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdmin, requireAdminOrClerk } from '../../middleware/rbac';
import { requirePermission, requireQueueable } from '../../middleware/permissions';
import { queueIfClerk } from '../hardening/queueGate';
import * as hardeningSvc from '../hardening/service';
import * as service from './service';

export const adminRouter = Router();
adminRouter.use(authenticate, requireSchool);

// --- Dashboard --------------------------------------------------------------
adminRouter.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const data = await service.getDashboard(getDb(), schoolIdOf(req));
    res.json({ ok: true, data });
  }),
);

// --- Settings ----------------------------------------------------------------
adminRouter.get(
  '/settings',
  asyncHandler(async (req, res) => {
    const data = await service.getSettings(getDb(), schoolIdOf(req));
    res.json({ ok: true, data });
  }),
);

adminRouter.patch(
  '/settings',
  requireAdmin,
  requirePermission('settings', 'update'),
  asyncHandler(async (req, res) => {
    const data = await service.updateSettings(getDb(), schoolIdOf(req), req.body as Record<string, unknown>, req.user!.sub);
    res.json({ ok: true, data });
  }),
);

// --- Users / clerks ------------------------------------------------------------
adminRouter.post(
  '/users/clerks',
  requireAdminOrClerk,
  requireQueueable('users', 'create'),
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ email: emailSchema, password: passwordSchema }), req.body);
    // 6A: clerk-proposed user creates go to the approval queue (202).
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'user', payload: body })) return;
    const clerk = await service.createClerk(getDb(), schoolIdOf(req), body, req.user!.sub);
    res.status(201).json({ ok: true, data: clerk });
  }),
);

// 6A: principal login (admin only). Login works like a clerk; every mutation 403s.
adminRouter.post(
  '/users/principals',
  requireAdmin,
  requirePermission('users', 'create'),
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ email: emailSchema, password: passwordSchema }), req.body);
    const principal = await hardeningSvc.createPrincipal(getDb(), schoolIdOf(req), body, req.user!.sub);
    res.status(201).json({ ok: true, data: principal });
  }),
);

adminRouter.get(
  '/users',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const items = await service.listUsers(getDb(), schoolIdOf(req));
    res.json({ ok: true, data: { items, total: items.length, page: 1, pages: 1 } });
  }),
);

adminRouter.delete(
  '/users/:id',
  requireAdminOrClerk,
  requireQueueable('users', 'delete'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'user', entityId: id, payload: { id } })) return;
    await service.deleteUser(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'User deleted' } });
  }),
);

// --- Holidays ------------------------------------------------------------------
adminRouter.get(
  '/holidays',
  asyncHandler(async (req, res) => {
    const items = await service.listHolidays(getDb(), schoolIdOf(req));
    res.json({ ok: true, data: { items, total: items.length, page: 1, pages: 1 } });
  }),
);

adminRouter.post(
  '/holidays',
  requireAdminOrClerk,
  requireQueueable('holidays', 'create'),
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ date: dateSchema, name: z.string().min(2).max(120) }), req.body);
    // 6A: clerk holiday creates go to the approval queue (202).
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'holiday', payload: body })) return;
    const created = await service.createHoliday(getDb(), schoolIdOf(req), body, req.user!.sub);
    res.status(201).json({ ok: true, data: created });
  }),
);

adminRouter.delete(
  '/holidays/:id',
  requireAdminOrClerk,
  requireQueueable('holidays', 'delete'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'holiday', entityId: id, payload: { id } })) return;
    await service.deleteHoliday(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Holiday deleted' } });
  }),
);

// --- Academic sessions ----------------------------------------------------------
adminRouter.get(
  '/sessions',
  asyncHandler(async (req, res) => {
    const items = await service.listSessions(getDb(), schoolIdOf(req));
    res.json({ ok: true, data: { items, total: items.length, page: 1, pages: 1 } });
  }),
);

adminRouter.post(
  '/sessions',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ name: z.string().min(2).max(120), start_date: dateSchema, end_date: dateSchema }), req.body);
    const created = await service.createSession(getDb(), schoolIdOf(req), body, req.user!.sub);
    res.status(201).json({ ok: true, data: created });
  }),
);

adminRouter.post(
  '/sessions/:id/make-current',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const session = await service.makeSessionCurrent(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: session });
  }),
);

// --- Promotions ------------------------------------------------------------------
adminRouter.post(
  '/promotions',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        session_id: uuidSchema,
        mappings: z.array(z.object({ student_id: uuidSchema, to_class_id: uuidSchema })).min(1),
      }),
      req.body,
    );
    const result = await service.promoteStudents(getDb(), schoolIdOf(req), body, req.user!.sub);
    res.json({ ok: true, data: result });
  }),
);

// --- Leaves -----------------------------------------------------------------------
adminRouter.get(
  '/leaves',
  asyncHandler(async (req, res) => {
    const items = await service.listLeaves(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data: { items, total: items.length, page: 1, pages: 1 } });
  }),
);

// 6C-2: late arrivals — read from attendance_records with status 'late'
// (see service.listLateArrivals + FEATURES-6C2.md; no separate table).
adminRouter.get(
  '/leaves/late',
  asyncHandler(async (req, res) => {
    const items = await service.listLateArrivals(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data: { items, total: items.length, page: 1, pages: 1 } });
  }),
);

adminRouter.post(
  '/leaves',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ student_id: uuidSchema, from_date: dateSchema, to_date: dateSchema, reason: z.string().min(2).max(500) }),
      req.body,
    );
    const created = await service.createLeave(getDb(), schoolIdOf(req), body, req.user!.sub);
    res.status(201).json({ ok: true, data: created });
  }),
);

adminRouter.patch(
  '/leaves/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const { status } = parseBody(z.object({ status: z.enum(['approved', 'rejected']) }), req.body);
    const updated = await service.decideLeave(getDb(), schoolIdOf(req), id, status, req.user!.sub);
    res.json({ ok: true, data: updated });
  }),
);

// --- Audit logs & notifications ------------------------------------------------------
adminRouter.get(
  '/audit-logs',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const result = await service.listAuditLogs(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data: result });
  }),
);

adminRouter.get(
  '/notifications',
  asyncHandler(async (req, res) => {
    const result = await service.listNotifications(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data: result });
  }),
);

adminRouter.post(
  '/notifications/:id/read',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const updated = await service.markNotificationRead(getDb(), schoolIdOf(req), id);
    res.json({ ok: true, data: updated });
  }),
);
