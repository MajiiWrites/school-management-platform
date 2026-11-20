/**
 * Platform Admin Panel routes (2026-11-20) — mounted at /api/v1/platform.
 *
 * - GET /platform/status is PUBLIC (no auth): the signup page reads it.
 * - GET /platform/notice needs any authenticated user (any role): school
 *   dashboards read it.
 * - Everything else requires requirePlatformAdmin (JWT + DB role check +
 *   TOTP enabled). Never use requireSchool/tenant middleware here.
 * - Envelope: {ok:true, data}. Lists use paginatedResponse
 *   {items, total, page, pages}.
 */
import { Router } from 'express';
import { z } from 'zod';
import { getDb } from '../../lib/db';
import { parseBody, uuidSchema } from '../../lib/validate';
import { asyncHandler } from '../../lib/errors';
import { authenticate } from '../../middleware/auth';
import { requirePlatformAdmin } from './guard';
import * as service from './service';

export const platformRouter = Router();

// --- Public: platform status (signup page reads this without logging in) ---
platformRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const data = await service.getPublicStatus(getDb());
    res.json({ ok: true, data });
  }),
);

// --- Any authenticated user: the platform notice (school dashboards) -------
platformRouter.get(
  '/notice',
  authenticate,
  asyncHandler(async (_req, res) => {
    const settings = await service.getPlatformSettings(getDb());
    res.json({ ok: true, data: { notice: settings.notice } });
  }),
);

// --- Everything below: platform admin + 2FA --------------------------------
platformRouter.use(requirePlatformAdmin);

const actorId = (req: any): string => req.user!.sub;

platformRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, data: await service.getOverview(getDb()) });
  }),
);

// --- Schools ----------------------------------------------------------------
platformRouter.get(
  '/schools',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await service.listSchools(getDb(), req.query as Record<string, any>) });
  }),
);

platformRouter.get(
  '/schools/:id',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    res.json({ ok: true, data: await service.getSchoolDetail(getDb(), id) });
  }),
);

platformRouter.post(
  '/schools/:id/suspend',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const body = parseBody(z.object({ reason: z.string().max(500).optional() }), req.body ?? {});
    res.json({ ok: true, data: await service.suspendSchool(getDb(), id, actorId(req), body.reason) });
  }),
);

platformRouter.post(
  '/schools/:id/activate',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    res.json({ ok: true, data: await service.activateSchool(getDb(), id, actorId(req)) });
  }),
);

platformRouter.delete(
  '/schools/:id',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const body = parseBody(z.object({ confirm: z.string() }), req.body ?? {});
    res.json({ ok: true, data: await service.deleteSchool(getDb(), id, actorId(req), body.confirm) });
  }),
);

// --- School data browser + exports ------------------------------------------
platformRouter.get(
  '/schools/:id/data/:entity',
  asyncHandler(async (req, res) => {
    const { id, entity } = parseBody(
      z.object({ id: uuidSchema, entity: z.enum(service.SCHOOL_DATA_ENTITIES as [string, ...string[]]) }),
      req.params,
    );
    res.json({ ok: true, data: await service.listSchoolEntityData(getDb(), id, entity, req.query as Record<string, any>) });
  }),
);

platformRouter.get(
  '/schools/:id/data/:entity/export',
  asyncHandler(async (req, res) => {
    const { id, entity } = parseBody(
      z.object({ id: uuidSchema, entity: z.enum(service.SCHOOL_DATA_ENTITIES as [string, ...string[]]) }),
      req.params,
    );
    const format = String((req.query as Record<string, any>).format ?? 'csv');
    if (format !== 'csv') {
      res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'format must be csv' } });
      return;
    }
    const { filename, csv } = await service.exportSchoolEntityCsv(getDb(), id, entity, req.query as Record<string, any>, actorId(req));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  }),
);

platformRouter.get(
  '/schools/:id/export',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    res.json({ ok: true, data: await service.exportSchoolFull(getDb(), id, actorId(req)) });
  }),
);

// --- Users -------------------------------------------------------------------
platformRouter.get(
  '/users',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await service.listPlatformUsers(getDb(), req.query as Record<string, any>) });
  }),
);

platformRouter.get(
  '/users/:id',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    res.json({ ok: true, data: await service.getPlatformUser(getDb(), id) });
  }),
);

platformRouter.post(
  '/users/:id/disable',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    res.json({ ok: true, data: await service.disableUser(getDb(), id, actorId(req)) });
  }),
);

platformRouter.post(
  '/users/:id/enable',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    res.json({ ok: true, data: await service.enableUser(getDb(), id, actorId(req)) });
  }),
);

platformRouter.post(
  '/users/:id/reverify',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    res.json({ ok: true, data: await service.reverifyUser(getDb(), id, actorId(req)) });
  }),
);

platformRouter.post(
  '/users/:id/reset-password',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    res.json({ ok: true, data: await service.resetUserPassword(getDb(), id, actorId(req)) });
  }),
);

platformRouter.post(
  '/users/:id/promote',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const body = parseBody(z.object({ role: z.literal('platform_admin') }), req.body ?? {});
    res.json({ ok: true, data: await service.promoteUser(getDb(), id, actorId(req), body.role) });
  }),
);

platformRouter.post(
  '/users/:id/demote',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const body = parseBody(z.object({ role: z.literal('admin') }), req.body ?? {});
    res.json({ ok: true, data: await service.demoteUser(getDb(), id, actorId(req), body.role) });
  }),
);

// --- Recycle bin (cross-school) ----------------------------------------------
platformRouter.get(
  '/recycle-bin',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await service.listPlatformRecycleBin(getDb(), req.query as Record<string, any>) });
  }),
);

platformRouter.post(
  '/recycle-bin/:id/restore',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    res.json({ ok: true, data: await service.restorePlatformRecycleBinRecord(getDb(), id, actorId(req)) });
  }),
);

platformRouter.post(
  '/recycle-bin/:id/permanent-delete',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    const body = parseBody(z.object({ confirm: z.string() }), req.body ?? {});
    res.json({ ok: true, data: await service.permanentDeletePlatformRecycleBinRecord(getDb(), id, actorId(req), body.confirm) });
  }),
);

// --- Audit logs (merged platform + school) ------------------------------------
platformRouter.get(
  '/audit-logs',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await service.listMergedAuditLogs(getDb(), req.query as Record<string, any>) });
  }),
);

// --- Messaging -----------------------------------------------------------------
platformRouter.get(
  '/messaging/queue',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await service.listMessagingQueue(getDb(), req.query as Record<string, any>) });
  }),
);

platformRouter.get(
  '/messaging/failed',
  asyncHandler(async (req, res) => {
    res.json({ ok: true, data: await service.listFailedMessages(getDb(), req.query as Record<string, any>) });
  }),
);

platformRouter.post(
  '/messaging/queue/:id/retry',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    res.json({ ok: true, data: await service.retryQueueMessage(getDb(), id, actorId(req)) });
  }),
);

// --- Mail health / settings / security / backups --------------------------------
platformRouter.get(
  '/mail-health',
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, data: await service.getMailHealth(getDb()) });
  }),
);

platformRouter.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, data: await service.getPlatformSettings(getDb()) });
  }),
);

platformRouter.patch(
  '/settings',
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({
        registration_open: z.boolean().optional(),
        maintenance_mode: z.boolean().optional(),
        notice: z.union([z.object({ text: z.string().min(1).max(2000) }), z.null()]).optional(),
      }),
      req.body ?? {},
    );
    res.json({ ok: true, data: await service.updatePlatformSettings(getDb(), actorId(req), body) });
  }),
);

platformRouter.get(
  '/security/logins',
  asyncHandler(async (req, res) => {
    const days = Math.min(90, Math.max(1, Number.parseInt(String((req.query as Record<string, any>).days ?? '7'), 10) || 7));
    res.json({ ok: true, data: await service.listRecentLogins(getDb(), days) });
  }),
);

platformRouter.get(
  '/security/platform-admins',
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, data: await service.listPlatformAdmins(getDb()) });
  }),
);

platformRouter.get(
  '/security/sessions',
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, data: await service.listSessions(getDb()) });
  }),
);

platformRouter.post(
  '/security/users/:id/revoke-sessions',
  asyncHandler(async (req, res) => {
    const { id } = parseBody(z.object({ id: uuidSchema }), req.params);
    res.json({ ok: true, data: await service.revokeUserSessions(getDb(), id, actorId(req)) });
  }),
);

platformRouter.get(
  '/backups',
  asyncHandler(async (_req, res) => {
    res.json({ ok: true, data: await service.getBackups(getDb()) });
  }),
);
