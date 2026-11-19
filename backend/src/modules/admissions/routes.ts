// Admissions routes (Gap #2, 2026-11-20).
// Public: GET/POST /admissions/:slug (no JWT — same pattern as the
// teacher link). Admin: pipeline list / status / admit.
// Clerk mutations are queue-gated like classes (see approvals.ts).
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../lib/db';
import { parseBody, uuidSchema, emailSchema } from '../../lib/validate';
import { asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdminOrClerk } from '../../middleware/rbac';
import { requireQueueable } from '../../middleware/permissions';
import { publicLinkLimiter } from '../../middleware/rateLimit';
import { queueIfClerk } from '../hardening/queueGate';
import * as service from './service';

export const admissionsRouter = Router();

const inquirySchema = z.object({
  student_name: z.string().min(1, 'Student name is required').max(120),
  class_id: uuidSchema,
  parent_name: z.string().min(1, 'Parent name is required').max(120),
  parent_phone: z.string().min(1, 'Parent phone is required').max(20),
  parent_email: emailSchema.optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
  // Honeypot — a real parent never sees or fills this field.
  website: z.string().max(200).optional().nullable(),
});

// --- Public inquiry form (NO JWT) ------------------------------------------
admissionsRouter.get(
  '/admissions/:slug',
  publicLinkLimiter,
  asyncHandler(async (req, res) => {
    const data = await service.getPublicAdmissionsForm(getDb(), req.params.slug);
    res.json({ ok: true, data });
  }),
);

admissionsRouter.post(
  '/admissions/:slug',
  publicLinkLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(inquirySchema, req.body);
    const result = await service.submitInquiry(getDb(), req.params.slug, body);
    res.status(201).json({ ok: true, data: result });
  }),
);

// --- Admin pipeline (JWT) ----------------------------------------------------
const authed = Router();
const idParams = z.object({ id: uuidSchema });

authed.get(
  '/admissions',
  authenticate,
  requireSchool,
  asyncHandler(async (req, res) => {
    const data = await service.listInquiries(getDb(), schoolIdOf(req), req.query as Record<string, any>);
    res.json({ ok: true, data });
  }),
);

authed.patch(
  '/admissions/:id/status',
  authenticate,
  requireSchool,
  requireAdminOrClerk,
  requireQueueable('admission_inquiry', 'update'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const { status } = parseBody(z.object({ status: z.string() }), req.body);
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'admission_inquiry', entityId: id, payload: { id, status } })) return;
    const updated = await service.updateInquiryStatus(getDb(), schoolIdOf(req), id, status, req.user!.sub);
    res.json({ ok: true, data: { inquiry: updated } });
  }),
);

const admitSchema = z.object({
  class_id: uuidSchema,
  roll_no: z.number().int().min(1).optional().nullable(),
  admission_no: z.string().max(50).optional().nullable(),
});

authed.post(
  '/admissions/:id/admit',
  authenticate,
  requireSchool,
  requireAdminOrClerk,
  requireQueueable('admission_inquiry', 'create'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const body = parseBody(admitSchema, req.body);
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'admission_inquiry', entityId: id, payload: { id, admit: true, ...body } })) return;
    const result = await service.admitInquiry(getDb(), schoolIdOf(req), id, body, req.user!.sub);
    res.status(201).json({ ok: true, data: result });
  }),
);

admissionsRouter.use(authed);
