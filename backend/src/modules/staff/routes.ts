// Staff & payroll routes (6C-1).
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../lib/db';
import { parseBody, uuidSchema, dateSchema, monthSchema } from '../../lib/validate';
import { asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdminOrClerk } from '../../middleware/rbac';
import { requireQueueable } from '../../middleware/permissions';
import { queueIfClerk } from '../hardening/queueGate';
import * as service from './service';

export const staffRouter = Router();
staffRouter.use(authenticate, requireSchool);

const staffBody = z.object({
  name: z.string().min(2).max(120),
  role: z.enum(['teacher', 'staff']),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  joining_date: dateSchema.optional().nullable(),
  subjects: z.array(z.string()).optional(),
  salary_monthly: z.number().int().min(0).optional().nullable(),
});

// --- Staff -------------------------------------------------------------------
staffRouter.get(
  '/staff',
  asyncHandler(async (req, res) => {
    const data = await service.listStaff(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data });
  }),
);

staffRouter.post(
  '/staff',
  requireAdminOrClerk,
  requireQueueable('staff', 'create'),
  asyncHandler(async (req, res) => {
    const body = parseBody(staffBody, req.body);
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'staff', payload: body })) return;
    const created = await service.createStaff(getDb(), schoolIdOf(req), body as any, req.user!.sub);
    res.status(201).json({ ok: true, data: created });
  }),
);

staffRouter.get(
  '/staff/:id',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const data = await service.getStaff(getDb(), schoolIdOf(req), id);
    res.json({ ok: true, data });
  }),
);

staffRouter.patch(
  '/staff/:id',
  requireAdminOrClerk,
  requireQueueable('staff', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const body = parseBody(staffBody.partial(), req.body);
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'staff', entityId: id, payload: { id, patch: body } })) return;
    const updated = await service.updateStaff(getDb(), schoolIdOf(req), id, body as any, req.user!.sub);
    res.json({ ok: true, data: updated });
  }),
);

staffRouter.delete(
  '/staff/:id',
  requireAdminOrClerk,
  requireQueueable('staff', 'delete'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'staff', entityId: id, payload: { id } })) return;
    await service.deleteStaff(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Staff member deleted' } });
  }),
);

// --- Assignments ---------------------------------------------------------------
staffRouter.get(
  '/staff/:id/assignments',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const items = await service.listAssignments(getDb(), schoolIdOf(req), { staff_id: id });
    res.json({ ok: true, data: { items, total: items.length, page: 1, pages: 1 } });
  }),
);

staffRouter.post(
  '/staff/:id/assign',
  requireAdminOrClerk,
  requireQueueable('staff', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const body = parseBody(z.object({ class_id: uuidSchema, subject: z.string().min(1).max(120) }), req.body);
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'staff_assignment', payload: { staff_id: id, ...body } })) return;
    const created = await service.assignStaff(getDb(), schoolIdOf(req), id, body, req.user!.sub);
    res.status(201).json({ ok: true, data: created });
  }),
);

staffRouter.delete(
  '/staff/:id/assign/:assignment_id',
  requireAdminOrClerk,
  requireQueueable('staff', 'update'),
  asyncHandler(async (req, res) => {
    const { id, assignment_id } = parseBody(z.object({ id: uuidSchema, assignment_id: uuidSchema }), req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'staff_assignment', entityId: assignment_id, payload: { id: assignment_id, staff_id: id } })) return;
    await service.removeAssignment(getDb(), schoolIdOf(req), id, assignment_id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Assignment removed' } });
  }),
);

// --- Payroll -------------------------------------------------------------------
// NOTE: /payroll/:id/payslip must be registered before /payroll/:id.
staffRouter.get(
  '/payroll',
  asyncHandler(async (req, res) => {
    const data = await service.listPayroll(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data });
  }),
);

staffRouter.post(
  '/payroll',
  requireAdminOrClerk,
  requireQueueable('staff', 'create'),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ staff_id: uuidSchema, month: monthSchema, base_salary: z.number().int().min(0).optional().nullable(), deductions: z.number().int().min(0).optional(), payslip_no: z.string().max(60).optional().nullable() }),
      req.body,
    );
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'salary_record', payload: body })) return;
    const created = await service.createSalaryRecord(getDb(), schoolIdOf(req), body as any, req.user!.sub);
    res.status(201).json({ ok: true, data: created });
  }),
);

staffRouter.get(
  '/payroll/:id/payslip',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const data = await service.getPayslipData(getDb(), schoolIdOf(req), id);
    res.type('html').send(service.renderPayslipHtml(data as any));
  }),
);

staffRouter.get(
  '/payroll/:id',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const data = await service.getSalaryRecord(getDb(), schoolIdOf(req), id);
    res.json({ ok: true, data });
  }),
);

staffRouter.patch(
  '/payroll/:id',
  requireAdminOrClerk,
  requireQueueable('staff', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const body = parseBody(
      z.object({ base_salary: z.number().int().min(0).optional(), deductions: z.number().int().min(0).optional(), paid: z.boolean().optional() }),
      req.body,
    );
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'salary_record', entityId: id, payload: { id, patch: body } })) return;
    const updated = await service.updateSalaryRecord(getDb(), schoolIdOf(req), id, body, req.user!.sub);
    res.json({ ok: true, data: updated });
  }),
);

staffRouter.delete(
  '/payroll/:id',
  requireAdminOrClerk,
  requireQueueable('staff', 'delete'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'salary_record', entityId: id, payload: { id } })) return;
    await service.deleteSalaryRecord(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: { message: 'Salary record deleted' } });
  }),
);
