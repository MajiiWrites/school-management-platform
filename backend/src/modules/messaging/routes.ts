/**
 * Messaging routes (API.md §Messaging).
 *
 * Exported as a factory — `createMessagingRouter(deps)` — because the shared
 * auth middleware (Backend agent: middleware/auth.ts) may not exist yet.
 * The integration phase passes the real `requireAuth` / `requireAdmin`
 * handlers; the router itself never reads JWTs or trusts a client-supplied
 * school_id (tenant is resolved by middleware into req.schoolId).
 *
 * Device endpoints use school-scoped API-key auth (X-Device-Key header):
 * the key is HMAC-SHA256(SMS_DEVICE_SECRET, `device:<schoolId>`) — see
 * phone.ts deriveDeviceKey. The admin obtains it from POST
 * /sms/devices/register and types it into the Android app once.
 *
 * Roles: approve / template edit / queue edit / retry / device register are
 * admin-only (SCHEMA.md: clerk cannot approve messages). Clerk can view the
 * pending list, log, templates and SMS status.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import { deriveDeviceKey } from './phone';
import {
  approveMessages,
  editQueueBody,
  getDeviceQueue,
  getPendingApproval,
  getSmsStatus,
  reportDelivery,
  retryFailed,
  type PhoneCrypto,
  type ServiceDeps,
} from './service';
import type { MessagingStore } from './store';

/**
 * The Backend agent augments Express.Request globally
 * (src/types/express.d.ts): `req.user?: AccessPayload` (sub = user id,
 * school_id, role, email) and `req.schoolId?: string`. This module uses
 * that augmentation directly instead of redeclaring it.
 */
export type AuthedRequest = Request;

export interface MessagingRouterDeps {
  store: MessagingStore;
  crypto?: PhoneCrypto;
  /** Populates req.schoolId + req.user; rejects unauthenticated requests. */
  requireAuth: express.RequestHandler;
  /** Rejects non-admin users (403). Runs after requireAuth. */
  requireAdmin: express.RequestHandler;
  now?: () => Date;
}

type AsyncHandler = (
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
) => Promise<void>;

function wrap(fn: AsyncHandler): express.RequestHandler {
  return (req, res, next) => {
    fn(req as AuthedRequest, res, next).catch(next);
  };
}

function ok(res: Response, data: unknown, status = 200): void {
  res.status(status).json({ ok: true, data });
}

function requireSchool(req: AuthedRequest): string {
  if (!req.schoolId) {
    throw Object.assign(new Error('School context missing'), { code: 'UNAUTHORIZED' });
  }
  return req.schoolId;
}

function parsePagination(req: Request): { page: number; limit: number } {
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20) || 20));
  return { page, limit };
}

/** Express 5 types req.params values as string | string[] — our routes use single segments. */
function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[]>)[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

export function createMessagingRouter(deps: MessagingRouterDeps): express.Router {
  const { store } = deps;
  const serviceDeps: ServiceDeps = {
    store,
    crypto: deps.crypto,
    now: deps.now,
  };
  const router = express.Router();

  /** Device auth: X-Device-Key must match the school-scoped derived key. */
  const deviceAuth: express.RequestHandler = async (req, _res, next) => {
    try {
      const deviceId = param(req, 'device_id');
      const key = req.header('X-Device-Key');
      if (!deviceId || !key) {
        throw Object.assign(new Error('Missing device credentials'), {
          code: 'UNAUTHORIZED',
        });
      }
      const device = await store.getDeviceByDeviceId(deviceId);
      if (!device) {
        throw Object.assign(new Error('Unknown device'), { code: 'NOT_FOUND' });
      }
      if (key !== deriveDeviceKey(device.schoolId)) {
        throw Object.assign(new Error('Invalid device key'), { code: 'UNAUTHORIZED' });
      }
      (req as AuthedRequest).schoolId = device.schoolId;
      next();
    } catch (err) {
      next(err);
    }
  };

  /* ------------------------- approval flow ------------------------- */

  router.get(
    '/messages/pending-approval',
    deps.requireAuth,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const pending = await store.listPendingApproval(schoolId);
      const studentIds = [...new Set(pending.map((r) => r.studentId).filter(Boolean))] as string[];
      const students = studentIds.length
        ? await store.getStudentsByIds(studentIds)
        : [];
      const studentNames = new Map(students.map((s) => [s.id, s.name]));
      const groups = await getPendingApproval(serviceDeps, { schoolId, studentNames });
      ok(res, { groups });
    }),
  );

  router.post(
    '/messages/approve',
    deps.requireAuth,
    deps.requireAdmin,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const { dedupe_keys, group_id } = req.body as {
        dedupe_keys?: string[];
        group_id?: string;
      };
      if (
        (!Array.isArray(dedupe_keys) || dedupe_keys.length === 0) &&
        typeof group_id !== 'string'
      ) {
        throw Object.assign(
          new Error('Provide dedupe_keys[] or group_id'),
          { code: 'VALIDATION' },
        );
      }
      const result = await approveMessages(serviceDeps, {
        schoolId,
        approvedBy: req.user?.sub ?? 'unknown',
        dedupeKeys: dedupe_keys,
        groupId: group_id,
      });
      ok(res, result);
    }),
  );

  router.patch(
    '/messages/queue/:id',
    deps.requireAuth,
    deps.requireAdmin,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const updated = await editQueueBody(serviceDeps, {
        schoolId,
        queueId: param(req, 'id'),
        body: String((req.body as { body?: unknown }).body ?? ''),
        editedBy: req.user?.sub ?? 'unknown',
      });
      ok(res, { queue: updated });
    }),
  );

  router.get(
    '/messages/log',
    deps.requireAuth,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const { page, limit } = parsePagination(req);
      const statusQ = req.query.status;
      const typeQ = req.query.type;
      const dateQ = req.query.date;
      const { items, total } = await store.listQueue(schoolId, {
        status:
          typeof statusQ === 'string'
            ? (statusQ as 'queued' | 'sent' | 'failed' | 'cancelled')
            : undefined,
        type:
          typeof typeQ === 'string'
            ? (typeQ as 'absent' | 'fee_reminder' | 'teacher_reminder')
            : undefined,
        date: typeof dateQ === 'string' ? dateQ : undefined,
        page,
        limit,
      });
      ok(res, { items, total, page, pages: Math.ceil(total / limit) });
    }),
  );

  router.post(
    '/messages/queue/:id/retry',
    deps.requireAuth,
    deps.requireAdmin,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const updated = await retryFailed(serviceDeps, {
        schoolId,
        queueId: param(req, 'id'),
        retriedBy: req.user?.sub ?? 'unknown',
      });
      ok(res, { queue: updated });
    }),
  );

  /* --------------------------- templates --------------------------- */

  router.get(
    '/messages/templates',
    deps.requireAuth,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      ok(res, { templates: await store.listTemplates(schoolId) });
    }),
  );

  router.patch(
    '/messages/templates/:id',
    deps.requireAuth,
    deps.requireAdmin,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const template = await store.getTemplateById(param(req, 'id'));
      if (!template || template.schoolId !== schoolId) {
        throw Object.assign(new Error('Template not found'), { code: 'NOT_FOUND' });
      }
      const body = (req.body as { body?: unknown }).body;
      if (typeof body !== 'string' || !body.trim()) {
        throw Object.assign(new Error('Template body must not be empty'), {
          code: 'VALIDATION',
        });
      }
      const updated = await store.updateTemplate(param(req, 'id'), { body: body.trim() });
      await store.createAuditLog({
        schoolId,
        actorId: req.user?.sub ?? null,
        actorType: 'user',
        action: 'template.update',
        entity: 'message_templates',
        entityId: updated.id,
        details: { type: updated.type, language: updated.language },
      });
      ok(res, { template: updated });
    }),
  );

  /* ------------------------ SMS / devices -------------------------- */

  router.get(
    '/sms/status',
    deps.requireAuth,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      ok(res, await getSmsStatus(serviceDeps, { schoolId }));
    }),
  );

  router.post(
    '/sms/devices/register',
    deps.requireAuth,
    deps.requireAdmin,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const { device_id, name } = req.body as { device_id?: unknown; name?: unknown };
      if (typeof device_id !== 'string' || !device_id.trim()) {
        throw Object.assign(new Error('device_id is required'), { code: 'VALIDATION' });
      }
      const device = await store.upsertDevice({
        schoolId,
        deviceId: device_id.trim(),
        name: typeof name === 'string' && name.trim() ? name.trim() : device_id.trim(),
      });
      let apiKey: string;
      try {
        apiKey = deriveDeviceKey(schoolId);
      } catch {
        throw Object.assign(
          new Error('SMS_DEVICE_SECRET is not configured on the server'),
          { code: 'CONFIG' },
        );
      }
      await store.createAuditLog({
        schoolId,
        actorId: req.user?.sub ?? null,
        actorType: 'user',
        action: 'device.register',
        entity: 'sms_devices',
        entityId: device.id,
        details: { deviceId: device.deviceId },
      });
      // The api_key is shown ONCE here — the admin types it into the app.
      // It is never logged or returned again.
      ok(res, { device, api_key: apiKey }, 201);
    }),
  );

  router.get(
    '/sms/devices/:device_id/queue',
    deviceAuth,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const items = await getDeviceQueue(serviceDeps, {
        schoolId,
        deviceId: param(req, 'device_id'),
        limit: 10,
      });
      ok(res, { messages: items });
    }),
  );

  router.post(
    '/sms/devices/:device_id/delivery',
    deviceAuth,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const { queue_id, status, error } = req.body as {
        queue_id?: unknown;
        status?: unknown;
        error?: unknown;
      };
      if (typeof queue_id !== 'string' || (status !== 'sent' && status !== 'failed')) {
        throw Object.assign(
          new Error('queue_id and status (sent|failed) are required'),
          { code: 'VALIDATION' },
        );
      }
      const updated = await reportDelivery(serviceDeps, {
        schoolId,
        deviceId: param(req, 'device_id'),
        queueId: queue_id,
        status,
        error: typeof error === 'string' ? error : undefined,
      });
      ok(res, { queue: updated });
    }),
  );

  return router;
}

/** Map service error codes to HTTP statuses (shared envelope, API.md). */
export function messagingErrorStatus(code: string): number {
  switch (code) {
    case 'VALIDATION':
      return 400;
    case 'UNAUTHORIZED':
      return 401;
    case 'FORBIDDEN':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'RATE_LIMITED':
      return 429;
    default:
      return 500;
  }
}
