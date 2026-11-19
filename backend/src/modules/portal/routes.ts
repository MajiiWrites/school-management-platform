// Parent portal routes (Gap #1, 2026-11-20).
// Public: GET /p/:token (no JWT — same pattern as the teacher link).
// Admin: token management under /students/:id/parent-token*.
// Clerk mutations are queue-gated like classes (see approvals.ts).
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../lib/db';
import { parseBody, uuidSchema } from '../../lib/validate';
import { asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdmin, requireAdminOrClerk } from '../../middleware/rbac';
import { requireQueueable } from '../../middleware/permissions';
import { publicLinkLimiter } from '../../middleware/rateLimit';
import { queueIfClerk } from '../hardening/queueGate';
import * as service from './service';

export const portalRouter = Router();

// --- Public parent link (NO JWT) ------------------------------------------
portalRouter.get(
  '/p/:token',
  publicLinkLimiter,
  asyncHandler(async (req, res) => {
    const data = await service.getParentPortal(getDb(), req.params.token);
    res.json({ ok: true, data });
  }),
);

// --- Admin token management (JWT) ------------------------------------------
// NOTE: auth is applied PER-ROUTE (same reason as attendance/routes.ts):
// a router-level use() would 401 later-mounted public routes.
const authed = Router();
const idParams = z.object({ id: uuidSchema });

authed.get(
  '/students/:id/parent-token',
  authenticate,
  requireSchool,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const info = await service.getParentTokenInfo(getDb(), schoolIdOf(req), id);
    res.json({ ok: true, data: info });
  }),
);

authed.post(
  '/students/:id/parent-token',
  authenticate,
  requireSchool,
  requireAdminOrClerk,
  requireQueueable('parent_tokens', 'create'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'parent_token', payload: { student_id: id } })) return;
    const info = await service.createParentToken(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.status(201).json({ ok: true, data: info });
  }),
);

authed.delete(
  '/students/:id/parent-token',
  authenticate,
  requireSchool,
  requireAdminOrClerk,
  requireQueueable('parent_tokens', 'delete'),
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'parent_token', entityId: id, payload: { student_id: id } })) return;
    const result = await service.revokeParentToken(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.json({ ok: true, data: result });
  }),
);

// Held SMS draft with the link — the admin still approves it in Messages;
// nothing is sent by this endpoint.
authed.post(
  '/students/:id/send-parent-link',
  authenticate,
  requireSchool,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = parseBody(idParams, req.params);
    const result = await service.sendParentLinkSms(getDb(), schoolIdOf(req), id, req.user!.sub);
    res.status(201).json({ ok: true, data: result });
  }),
);

portalRouter.use(authed);
