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
import { requirePermission, requireQueueable } from '../../middleware/permissions';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { queueIfClerk } from '../hardening/queueGate';
import { renderReceiptHtml, renderReceiptPdf } from './receipts';
import { generateVoucher, generateVoucherForStudent, getVoucherByNo, listVouchers, renderVoucherHtml, renderVoucherPdf } from './vouchers';
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

// ---- Fee structures (read: any authed role — principal is view-only; write: admin, clerk via queue) ----
feesRouter.get(
  '/structures',
  asyncHandler(async (req, res) => {
    const data = await listFeeStructures(getDb(), schoolIdOf(req));
    res.json({ ok: true, data });
  }),
);

feesRouter.post(
  '/structures',
  requireAdminOrClerk,
  requireQueueable('fees', 'create'),
  asyncHandler(async (req, res) => {
    // 6A: clerk structure creates go to the approval queue (202).
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'fee_structure', payload: req.body })) return;
    const data = await createFeeStructure(getDb(), schoolIdOf(req), req.body, undefined, req.user!.sub);
    res.status(201).json({ ok: true, data });
  }),
);

feesRouter.patch(
  '/structures/:id',
  requireAdminOrClerk,
  requireQueueable('fees', 'update'),
  asyncHandler(async (req, res) => {
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'fee_structure', entityId: req.params.id, payload: { id: req.params.id, patch: req.body } })) return;
    const data = await updateFeeStructure(getDb(), schoolIdOf(req), req.params.id, req.body, req.user!.sub);
    res.json({ ok: true, data });
  }),
);

feesRouter.delete(
  '/structures/:id',
  requireAdmin,
  requirePermission('fees', 'delete'),
  asyncHandler(async (req, res) => {
    await deleteFeeStructure(getDb(), schoolIdOf(req), req.params.id, req.user!.sub);
    res.json({ ok: true, data: { deleted: true } });
  }),
);

// ---- Monthly fee list ----
feesRouter.get(
  '/',
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

// ---- Pay a fee (admin applies directly; clerk goes to the approval queue) ----
feesRouter.post(
  '/:student_id/pay',
  requireAdminOrClerk,
  requireQueueable('fees', 'update'),
  asyncHandler(async (req, res) => {
    // req.user is AccessPayload: the actor id is `sub`.
    const actorId = req.user?.sub ?? 'unknown';
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'fee_record', payload: { student_id: req.params.student_id, ...(req.body as object) } })) return;
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

// ---- Printable receipt (HTML by default; ?format=pdf for a real PDF;
// ?format=json for the receipt data — the Fees page reads the receipt
// through the JSON API client, which cannot parse the HTML page). ----
feesRouter.get(
  '/receipts/:receipt_no',
  asyncHandler(async (req, res) => {
    const receipt = await getReceiptByNo(getDb(), schoolIdOf(req), req.params.receipt_no);
    if (queryStr(req, 'format') === 'json') {
      res.json({ ok: true, data: receipt });
      return;
    }
    // Fix C note (Phase 9): this block had a stray closing brace (line 172)
    // that broke `tsc` for the whole backend, and the PDF attempt ran for
    // every non-JSON request instead of only ?format=pdf (per the route
    // comment above). Guarded to ?format=pdf; anything else falls through
    // to the HTML receipt.
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

// ---- Fee vouchers / challans (6C-2) ----
// NOTE: these routes must sit above '/receipts/:receipt_no' only in the
// sense that they are distinct paths; '/vouchers' never collides with
// '/:student_id/pay' (POST) or '/receipts/:receipt_no'.
feesRouter.get(
  '/vouchers',
  asyncHandler(async (req, res) => {
    const { page, limit } = parsePageLimit(req);
    const data = await listVouchers(getDb(), schoolIdOf(req), {
      month: queryStr(req, 'month'),
      status: queryStr(req, 'status'),
      page,
      limit,
    });
    res.json({ ok: true, data });
  }),
);

feesRouter.post(
  '/vouchers',
  requireAdminOrClerk,
  requireQueueable('fees', 'create'),
  asyncHandler(async (req, res) => {
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'fee_voucher', payload: req.body })) return;
    const data = await generateVoucher(getDb(), schoolIdOf(req), req.body, req.user?.sub ?? 'unknown');
    res.status(201).json({ ok: true, data });
  }),
);

feesRouter.post(
  '/vouchers/by-student',
  requireAdminOrClerk,
  requireQueueable('fees', 'create'),
  asyncHandler(async (req, res) => {
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'fee_voucher', payload: req.body })) return;
    const body = req.body as { student_id: string; month: string; due_date?: string };
    const data = await generateVoucherForStudent(getDb(), schoolIdOf(req), body.student_id, body.month, body.due_date, req.user?.sub ?? 'unknown');
    res.status(201).json({ ok: true, data });
  }),
);

feesRouter.get(
  '/vouchers/:voucher_no',
  asyncHandler(async (req, res) => {
    const voucher = await getVoucherByNo(getDb(), schoolIdOf(req), req.params.voucher_no);
    if (queryStr(req, 'format') === 'pdf') {
      try {
        const pdf = await renderVoucherPdf(voucher);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="${voucher.voucher_no}.pdf"`);
        res.send(pdf);
        return;
      } catch (err) {
        const code = (err as Error & { code?: string }).code;
        if (code !== 'PDF_UNAVAILABLE') throw err;
      }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderVoucherHtml(voucher));
  }),
);

// ---- Monthly fee report (collected vs pending, by class) ----
feesRouter.get(
  '/report/monthly',
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
  requirePermission('fees', 'create'),
  asyncHandler(async (req, res) => {
    const month = (req.body?.month as string | undefined) ?? queryStr(req, 'month');
    if (!month) throw ApiError.validation('month (YYYY-MM) is required');
    const data = await rolloverMonth(getDb(), schoolIdOf(req), month, req.user?.sub ?? null);
    res.json({ ok: true, data });
  }),
);
