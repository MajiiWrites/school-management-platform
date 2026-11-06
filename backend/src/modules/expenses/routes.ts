// Expenses routes (6C-2) — mounted in app.ts at /api/v1/expenses.
// Clerk creates/updates/deletes go to the approval queue (202) via
// queueIfClerk; the applier lives in modules/hardening/approvals.ts
// (6C-2 block). Principal is view-only (requireAdminOrClerk rejects).

import { Router, type Request } from 'express';
import { getDb } from '../../lib/db';
import { ApiError, asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdminOrClerk } from '../../middleware/rbac';
import { requireQueueable } from '../../middleware/permissions';
import { queueIfClerk } from '../hardening/queueGate';
import { createExpense, deleteExpense, incomeVsExpense, listExpenses, updateExpense } from './service';

export const expensesRouter = Router();
expensesRouter.use(authenticate, requireSchool);

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

expensesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, limit } = parsePageLimit(req);
    const data = await listExpenses(getDb(), schoolIdOf(req), {
      month: queryStr(req, 'month'),
      category: queryStr(req, 'category'),
      page,
      limit,
    });
    res.json({ ok: true, data });
  }),
);

expensesRouter.post(
  '/',
  requireAdminOrClerk,
  requireQueueable('expenses', 'create'),
  asyncHandler(async (req, res) => {
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'expense', payload: req.body })) return;
    const data = await createExpense(getDb(), schoolIdOf(req), req.body, req.user?.sub ?? 'unknown');
    res.status(201).json({ ok: true, data });
  }),
);

expensesRouter.patch(
  '/:id',
  requireAdminOrClerk,
  requireQueueable('expenses', 'update'),
  asyncHandler(async (req, res) => {
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'expense', entityId: req.params.id, payload: { id: req.params.id, patch: req.body } })) return;
    const data = await updateExpense(getDb(), schoolIdOf(req), req.params.id, req.body, req.user?.sub ?? 'unknown');
    res.json({ ok: true, data });
  }),
);

expensesRouter.delete(
  '/:id',
  requireAdminOrClerk,
  requireQueueable('expenses', 'delete'),
  asyncHandler(async (req, res) => {
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'expense', entityId: req.params.id, payload: { id: req.params.id } })) return;
    await deleteExpense(getDb(), schoolIdOf(req), req.params.id, req.user?.sub ?? 'unknown');
    res.json({ ok: true, data: { deleted: true } });
  }),
);

// Daily + monthly income-vs-expense (also exposed as /reports/income-expense).
expensesRouter.get(
  '/report/income-expense',
  asyncHandler(async (req, res) => {
    const month = queryStr(req, 'month');
    if (!month) throw ApiError.validation('month query param (YYYY-MM) is required');
    const data = await incomeVsExpense(getDb(), schoolIdOf(req), month);
    res.json({ ok: true, data });
  }),
);
