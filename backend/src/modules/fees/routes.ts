// Fee routes — mounted by the integration phase at /api/v1/fees (see MOUNT.md):
//   import { feesRouter } from './modules/fees/routes';
//   app.use('/api/v1/fees', feesRouter);
// Follows the codebase pattern (see modules/classes/routes.ts): the router
// uses getDb() directly, authenticate + requireSchool middleware, schoolIdOf,
// asyncHandler, and ApiError. Success envelope follows contracts/API.md:
// { ok:true, data }; errors render via the shared error middleware.

import { Router, type Request } from 'express';
import { getDb } from '../../lib/db';
import { ApiError, asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireAdmin, requireAdminOrClerk } from '../../middleware/rbac';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { renderReceiptHtml, renderReceiptPdf } from './receipts';
import {
  createFeeStructure,
  deleteFeeStructure,
  getReceiptByNo,
  listFees,
  listFeeStructures,
  monthlyFeeReport,
  payFee,
  rolloverMonth,
  updateFeeStructure,
} from './service';
import type { FeeStatus } from './types';

export const feesRouter = Router();
feesRouter.use(authenticate, requireSchool);

function parsePageLimit(req: Request): { page: number; limit: number } {
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 50);
  return {
    page: Number.isFinite(page) && page > 0 ? Math.floor(page) : 1,
    limit: Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50,
  };
}

/** First string value of a query param (Express may parse repeats as arrays). */
function queryStr(req: Request, key: string): string | undefined {
  const v = req.query[key];
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

async function schoolTimezone(schoolId: string): Promise<string> {
  const school = await getDb().school.findUnique({ where: { id: schoolId } });
  return (school?.timezone as string | undefined) ?? 'Asia/Karachi';
}

// ---- Fee structures (read: admin+clerk; write: admin only) ----
feesRouter.get(
  '/structures',
  requireAdminOrClerk,
  asyncHandler(async (req, res) => {
    const data = await listFeeStructures(getDb(), schoolIdOf(req));
    res.json({ ok: true, data });
  }),
);

feesRouter.post(
  '/structures',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const data = await createFeeStructure(getDb(), schoolIdOf(req), req.body);
    res.status(201).json({ ok: true, data });
  }),
);

feesRouter.patch(
  '/structures/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const data = await updateFeeStructure(getDb(), schoolIdOf(req), req.params.id, req.body);
    res.json({ ok: true, data });
  }),
);

feesRouter.delete(
  '/structures/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    await deleteFeeStructure(getDb(), schoolIdOf(req), req.params.id);
    res.json({ ok: true, data: { deleted: true } });
  }),
);

// ---- Monthly fee list ----
feesRouter.get(
  '/',
  requireAdminOrClerk,
  asyncHandler(async (req, res) => {
    const { page, limit } = parsePageLimit(req);
    const status = queryStr(req, 'status') as FeeStatus | undefined;
    if (status && !['unpaid', 'partial', 'paid'].includes(status)) {
      throw ApiError.validation('status must be unpaid, partial or paid');
    }
    const schoolId = schoolIdOf(req);
    const tz = await schoolTimezone(schoolId);
    const result = await listFees(
      getDb(),
      schoolId,
      {
        month: queryStr(req, 'month'),
        class_id: queryStr(req, 'class_id'),
        status,
        search: queryStr(req, 'search'),
        page,
        limit,
      },
      tz,
    );
    res.json({
      ok: true,
      data: { items: result.items, total: result.total, page: result.page, pages: result.pages },
      month: result.month,
    });
  }),
);

// ---- Pay a fee (admin + clerk) ----
feesRouter.post(
  '/:student_id/pay',
  requireAdminOrClerk,
  asyncHandler(async (req, res) => {
    // req.user is AccessPayload: the actor id is `sub`.
    const actorId = req.user?.sub ?? 'unknown';
    const receipt = await payFee(getDb(), schoolIdOf(req), req.params.student_id, req.body, actorId);
    res.status(201).json({
      ok: true,
      data: {
        ...receipt,
        receipt_url: `/api/v1/fees/receipts/${encodeURIComponent(receipt.receipt_no)}`,
      },
    });
  }),
);

// ---- Printable receipt (HTML by default; ?format=pdf for a real PDF) ----
feesRouter.get(
  '/receipts/:receipt_no',
  requireAdminOrClerk,
  asyncHandler(async (req, res) => {
    const receipt = await getReceiptByNo(getDb(), schoolIdOf(req), req.params.receipt_no);
    if (queryStr(req, 'format') === 'pdf') {
      try {
        const pdf = await renderReceiptPdf(receipt);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${receipt.receipt_no}.pdf"`);
        res.send(pdf);
        return;
      } catch (err) {
        const code = (err as Error & { code?: string }).code;
        if (code !== 'PDF_UNAVAILABLE') throw err;
        // Fall through to HTML when pdfkit is not installed.
      }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderReceiptHtml(receipt));
  }),
);

// ---- Monthly fee report (collected vs pending, by class) ----
feesRouter.get(
  '/report/monthly',
  requireAdminOrClerk,
  asyncHandler(async (req, res) => {
    const month = queryStr(req, 'month');
    if (!month) throw ApiError.validation('month query param (YYYY-MM) is required');
    const data = await monthlyFeeReport(getDb(), schoolIdOf(req), month);
    res.json({ ok: true, data });
  }),
);

// ---- Manual month rollover (admin; the scheduler also runs this) ----
feesRouter.post(
  '/rollover',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const month = (req.body?.month as string | undefined) ?? queryStr(req, 'month');
    if (!month) throw ApiError.validation('month (YYYY-MM) is required');
    const data = await rolloverMonth(getDb(), schoolIdOf(req), month);
    res.json({ ok: true, data });
  }),
);
