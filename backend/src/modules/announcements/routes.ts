// Announcements routes (6C-2) — mounted in app.ts at /api/v1/announcements.
// Notice board + SMS send (Phase 8 QA wired the send to the Section 11
// draft → approval → queue flow). Clerk creates/updates/deletes go to the
// approval queue (202); approve is admin-only. POST /:id/send is admin-only
// and sends only approved + sms_send announcements, via a message draft.

import { Router, type Request } from 'express';
import { getDb } from '../../lib/db';
import { asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requireSchool, schoolIdOf } from '../../middleware/tenant';
import { requireAdmin, requireAdminOrClerk } from '../../middleware/rbac';
import { requireQueueable } from '../../middleware/permissions';
import { queueIfClerk } from '../hardening/queueGate';
import { approveDraftForSending } from '../messaging/custom-messages';
import { createPrismaMessagingStore } from '../messaging/store';
import {
  approveAnnouncement,
  createAnnouncement,
  deleteAnnouncement,
  getAnnouncement,
  listAnnouncements,
  sendAnnouncementSms,
  updateAnnouncement,
} from './service';

export const announcementsRouter = Router();
announcementsRouter.use(authenticate, requireSchool);

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

announcementsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { page, limit } = parsePageLimit(req);
    const data = await listAnnouncements(getDb(), schoolIdOf(req), { status: queryStr(req, 'status'), page, limit });
    res.json({ ok: true, data });
  }),
);

announcementsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = await getAnnouncement(getDb(), schoolIdOf(req), req.params.id);
    res.json({ ok: true, data });
  }),
);

announcementsRouter.post(
  '/',
  requireAdminOrClerk,
  requireQueueable('announcements', 'create'),
  asyncHandler(async (req, res) => {
    if (await queueIfClerk(req, res, { actionType: 'create', entity: 'announcement', payload: req.body })) return;
    const data = await createAnnouncement(getDb(), schoolIdOf(req), req.body, req.user?.sub ?? 'unknown');
    res.status(201).json({ ok: true, data });
  }),
);

announcementsRouter.patch(
  '/:id',
  requireAdminOrClerk,
  requireQueueable('announcements', 'update'),
  asyncHandler(async (req, res) => {
    if (await queueIfClerk(req, res, { actionType: 'update', entity: 'announcement', entityId: req.params.id, payload: { id: req.params.id, patch: req.body } })) return;
    const data = await updateAnnouncement(getDb(), schoolIdOf(req), req.params.id, req.body, req.user?.sub ?? 'unknown');
    res.json({ ok: true, data });
  }),
);

announcementsRouter.delete(
  '/:id',
  requireAdminOrClerk,
  requireQueueable('announcements', 'delete'),
  asyncHandler(async (req, res) => {
    if (await queueIfClerk(req, res, { actionType: 'delete', entity: 'announcement', entityId: req.params.id, payload: { id: req.params.id } })) return;
    await deleteAnnouncement(getDb(), schoolIdOf(req), req.params.id, req.user?.sub ?? 'unknown');
    res.json({ ok: true, data: { deleted: true } });
  }),
);

// Approve for the notice board (admin only). Does NOT send any SMS.
announcementsRouter.post(
  '/:id/approve',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const data = await approveAnnouncement(getDb(), schoolIdOf(req), req.params.id, req.user?.sub ?? 'unknown');
    res.json({ ok: true, data });
  }),
);

// SMS send (Phase 8 QA — was a 501 hook point in 6C-2).
// Admin only; announcement must be approved + sms_send=true. Creates a
// Section 11 message draft for the announcement's audience and routes it
// through the existing draft → approval → queue flow (same as
// POST /messages/drafts/:id/approve-send), queue type 'announcement'.
// Nothing is queued before that approval; opted-out/missing numbers are
// auto-excluded with a skipped count. No second sending path.
announcementsRouter.post(
  '/:id/send',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getDb();
    const store = createPrismaMessagingStore(db as any);
    const result = await sendAnnouncementSms(db, schoolIdOf(req), req.params.id, req.user?.sub ?? 'unknown', {
      createDraft: (input) => store.createDraft(input as never),
      approveDraftForSending: (input) =>
        approveDraftForSending({ store }, { ...input, approvedBy: input.approvedBy }),
    });
    res.json({ ok: true, data: result });
  }),
);
