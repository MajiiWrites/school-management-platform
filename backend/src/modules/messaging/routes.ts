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
import { decryptPhone, deriveDeviceKey, maskPhone, normalizePK } from './phone';
import { getDb } from '../../lib/db';
import { requireAdminOrClerk } from '../../middleware/rbac';
import { requireQueueable } from '../../middleware/permissions';
import { queueIfClerk } from '../hardening/queueGate';
import { snapshotOf, writeChangeLogs } from '../hardening/helpers';
import {
  createApprovalRequest,
  rejectApprovalRequest,
} from '../hardening/approvals';
import {
  approveDraftForSending,
  previewMessage,
  validateDraftInput,
  type CustomMessagesDeps,
} from './custom-messages';
import type { DraftRow } from './store';
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
  // Section 11: the custom-messages service shares the same store/crypto.
  const customDeps: CustomMessagesDeps = {
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
        ? await store.getStudentsByIds(studentIds, schoolId)
        : [];
      const studentNames = new Map(students.map((s) => [s.id, s.name]));
      // Class display names (e.g. "5-A") for the group headers.
      const db = getDb();
      const classRows: any[] = await (db as any).class.findMany({
        where: { schoolId },
        select: { id: true, name: true, section: true },
      });
      const classNames = new Map(
        classRows.map((c) => [c.id, `${c.name}-${c.section}`]),
      );
      const groups = await getPendingApproval(serviceDeps, { schoolId, studentNames, classNames });
      // Serialize to the contract (snake_case) shape the frontend uses.
      ok(res, {
        groups: groups.map((g) => ({
          group_id: g.groupId,
          class: classNames.get(g.classId ?? '') ?? '—',
          class_id: g.classId,
          date: g.date,
          absent_count: g.count,
          messages: g.messages.map((m) => ({
            id: m.queueId,
            student: m.studentName,
            parent_phone_masked: m.parentPhoneMasked,
            body: m.body,
            dedupe_key: m.dedupeKey,
          })),
        })),
      });
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
      const classQ = req.query.class_id;
      const { items, total } = await store.listQueue(schoolId, {
        status:
          typeof statusQ === 'string'
            ? (statusQ as 'queued' | 'sent' | 'failed' | 'cancelled')
            : undefined,
        type:
          typeof typeQ === 'string'
            ? (typeQ as 'absent' | 'fee_reminder' | 'teacher_reminder' | 'result' | 'announcement' | 'custom')
            : undefined,
        date: typeof dateQ === 'string' ? dateQ : undefined,
        classId: typeof classQ === 'string' ? classQ : undefined,
        page,
        limit,
      });
      // Section 11: attach the latest delivery attempt per row (from
      // message_deliveries) so history shows the real send outcome.
      const deliveries = await store.listDeliveriesForQueueIds(
        items.map((i) => i.id),
        schoolId,
      );
      const deliveryByQueue = new Map(deliveries.map((d) => [d.queueId, d]));
      // Serialize to the contract (snake_case) shape the frontend uses:
      // student names + masked parent numbers + delivery detail.
      const studentIds = [...new Set(items.map((i) => i.studentId).filter(Boolean))] as string[];
      const students = studentIds.length
        ? await store.getStudentsByIds(studentIds, schoolId)
        : [];
      const studentNames = new Map(students.map((s) => [s.id, s.name]));
      const serialized = items.map((i) => {
        let masked = '+92 3XX XXXX???';
        try {
          const e164 = normalizePK(decryptPhone(i.parentPhoneEnc));
          if (e164) masked = maskPhone(e164) ?? masked;
        } catch {
          // undecryptable — keep the placeholder so the row still lists
        }
        const delivery = deliveryByQueue.get(i.id);
        return {
          id: i.id,
          type: i.type,
          student_id: i.studentId,
          student_name: i.studentId ? studentNames.get(i.studentId) ?? null : null,
          class_id: i.classId,
          parent_phone_masked: masked,
          body: i.body,
          status: i.status,
          created_at: i.createdAt.toISOString(),
          sent_at: i.sentAt ? i.sentAt.toISOString() : null,
          error: i.error,
          dedupe_key: i.dedupeKey,
          delivery: delivery
            ? {
                status: delivery.status,
                delivered_at: delivery.deliveredAt ? delivery.deliveredAt.toISOString() : null,
                error: delivery.error,
              }
            : null,
        };
      });
      ok(res, {
        items: serialized,
        total,
        page,
        pages: Math.ceil(total / limit),
      });
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
    requireAdminOrClerk,
    requireQueueable('messages', 'update'),
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const template = await store.getTemplateById(param(req, 'id'), schoolId);
      if (!template || template.schoolId !== schoolId) {
        throw Object.assign(new Error('Template not found'), { code: 'NOT_FOUND' });
      }
      const body = (req.body as { body?: unknown }).body;
      const name = (req.body as { name?: unknown }).name;
      const type = (req.body as { type?: unknown }).type;
      const language = (req.body as { language?: unknown }).language;
      const patch: {
        body?: string;
        name?: string | null;
        type?: 'absent' | 'fee_reminder' | 'teacher_reminder' | 'result' | 'announcement' | 'custom';
        language?: 'en' | 'ur';
      } = {};
      if (typeof body === 'string') {
        if (!body.trim()) {
          throw Object.assign(new Error('Template body must not be empty'), {
            code: 'VALIDATION',
          });
        }
        patch.body = body.trim();
      }
      if (name !== undefined) {
        if (typeof name !== 'string' || !name.trim()) {
          throw Object.assign(new Error('Template name must not be empty'), {
            code: 'VALIDATION',
          });
        }
        patch.name = name.trim();
      }
      if (type !== undefined) {
        if (
          typeof type !== 'string' ||
          !['absent', 'fee_reminder', 'teacher_reminder', 'result', 'announcement', 'custom'].includes(type)
        ) {
          throw Object.assign(new Error('Invalid template type'), { code: 'VALIDATION' });
        }
        patch.type = type as 'absent' | 'fee_reminder' | 'teacher_reminder' | 'result' | 'announcement' | 'custom';
      }
      if (language !== undefined) {
        if (typeof language !== 'string' || !['en', 'ur'].includes(language)) {
          throw Object.assign(new Error('Invalid template language'), { code: 'VALIDATION' });
        }
        patch.language = language as 'en' | 'ur';
      }
      if (Object.keys(patch).length === 0) {
        throw Object.assign(new Error('Nothing to update'), { code: 'VALIDATION' });
      }
      // 6A: clerk template edits go to the approval queue (202); admin applies directly.
      if (
        await queueIfClerk(req, res, {
          actionType: 'update',
          entity: 'message_template',
          entityId: template.id,
          payload: { id: template.id, patch },
        })
      ) {
        return;
      }
      const before = {
        body: template.body,
        name: template.name ?? null,
        type: template.type,
        language: template.language,
      };
      const updated = await store.updateTemplate(param(req, 'id'), patch, schoolId);
      await writeChangeLogs(getDb(), {
        schoolId,
        actorId: req.user?.sub ?? null,
        entity: 'message_template',
        entityId: updated.id,
        before,
        after: {
          body: updated.body,
          name: updated.name ?? null,
          type: updated.type,
          language: updated.language,
        },
      });
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

  /* ------------------------------------------------------------------ */
  /* Section 11 — Custom Messages (contracts/SCHEMA.md §11)             */
  /* Templates: full CRUD (nothing locked, incl. seeded defaults).       */
  /* Drafts: composer → draft → approval → message_queue (no second      */
  /* sending path). Clerk drafts go through the approval queue.          */
  /* ------------------------------------------------------------------ */

  const TEMPLATE_TYPE_LIST = [
    'absent',
    'fee_reminder',
    'teacher_reminder',
    'result',
    'announcement',
    'custom',
  ] as const;

  /** Load a draft or 404 (school-scoped). */
  async function loadDraft(req: AuthedRequest, id: string): Promise<DraftRow> {
    const schoolId = requireSchool(req);
    const draft = await store.getDraftById(id, schoolId);
    if (!draft) throw Object.assign(new Error('Draft not found'), { code: 'NOT_FOUND' });
    return draft;
  }

  /** Admins may touch any draft; clerks only their own. */
  function assertDraftWritable(req: AuthedRequest, draft: DraftRow): void {
    if (req.user?.role === 'admin') return;
    if (req.user?.role === 'clerk' && draft.createdBy === req.user.sub) return;
    throw Object.assign(new Error('You can only change your own drafts'), { code: 'FORBIDDEN' });
  }

  function parseScheduledFor(value: unknown): Date | null {
    if (value === undefined || value === null || value === '') return null;
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) {
      throw Object.assign(new Error('scheduled_for must be a valid date-time'), { code: 'VALIDATION' });
    }
    return d;
  }

  router.post(
    '/messages/templates',
    deps.requireAuth,
    deps.requireAdmin,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const { name, type, language, body } = req.body as {
        name?: unknown;
        type?: unknown;
        language?: unknown;
        body?: unknown;
      };
      if (typeof name !== 'string' || !name.trim()) {
        throw Object.assign(new Error('Template name is required'), { code: 'VALIDATION' });
      }
      if (typeof type !== 'string' || !(TEMPLATE_TYPE_LIST as readonly string[]).includes(type)) {
        throw Object.assign(new Error('Invalid template type'), { code: 'VALIDATION' });
      }
      if (typeof language !== 'string' || !['en', 'ur'].includes(language)) {
        throw Object.assign(new Error('Invalid template language'), { code: 'VALIDATION' });
      }
      if (typeof body !== 'string' || !body.trim()) {
        throw Object.assign(new Error('Template body must not be empty'), { code: 'VALIDATION' });
      }
      const created = await store.createTemplate({
        schoolId,
        name: name.trim(),
        type: type as (typeof TEMPLATE_TYPE_LIST)[number],
        language: language as 'en' | 'ur',
        body: body.trim(),
        isCustom: true,
      });
      await writeChangeLogs(getDb(), {
        schoolId,
        actorId: req.user?.sub ?? null,
        entity: 'message_template',
        entityId: created.id,
        before: {},
        after: { name: created.name, type: created.type, language: created.language, body: created.body },
      });
      await store.createAuditLog({
        schoolId,
        actorId: req.user?.sub ?? null,
        actorType: 'user',
        action: 'template.create',
        entity: 'message_templates',
        entityId: created.id,
        details: { name: created.name, type: created.type, language: created.language },
      });
      ok(res, { template: created }, 201);
    }),
  );

  router.post(
    '/messages/templates/:id/duplicate',
    deps.requireAuth,
    deps.requireAdmin,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const source = await store.getTemplateById(param(req, 'id'), schoolId);
      if (!source || source.schoolId !== schoolId) {
        throw Object.assign(new Error('Template not found'), { code: 'NOT_FOUND' });
      }
      // Duplicates are always type 'custom': the (school, type, language)
      // slot of the source is already taken. If a custom template of this
      // language already exists the store throws CONFLICT (409).
      const copyName = `Copy of ${source.name ?? source.type}`;
      const created = await store.createTemplate({
        schoolId,
        name: copyName,
        type: 'custom',
        language: source.language,
        body: source.body,
        isCustom: true,
      });
      await store.createAuditLog({
        schoolId,
        actorId: req.user?.sub ?? null,
        actorType: 'user',
        action: 'template.duplicate',
        entity: 'message_templates',
        entityId: created.id,
        details: { source_template_id: source.id, name: created.name },
      });
      ok(res, { template: created }, 201);
    }),
  );

  router.delete(
    '/messages/templates/:id',
    deps.requireAuth,
    deps.requireAdmin,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const template = await store.getTemplateById(param(req, 'id'), schoolId);
      if (!template || template.schoolId !== schoolId) {
        throw Object.assign(new Error('Template not found'), { code: 'NOT_FOUND' });
      }
      // Recycle-bin record: message_templates has no deleted_at column, so
      // the delete is a hard delete + a deleted_records snapshot (the row
      // can be re-created from the snapshot). Nothing is locked — seeded
      // defaults delete exactly like custom templates.
      const db = getDb();
      await (db as any).deletedRecord.create({
        data: {
          schoolId,
          entity: 'message_template',
          entityId: template.id,
          snapshot: snapshotOf(template as unknown as Record<string, unknown>),
          deletedBy: req.user?.sub ?? null,
          deletedAt: new Date(),
          restoreBy: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });
      await writeChangeLogs(db, {
        schoolId,
        actorId: req.user?.sub ?? null,
        entity: 'message_template',
        entityId: template.id,
        before: { name: template.name, type: template.type, language: template.language, body: template.body },
        after: {},
      });
      await store.deleteTemplate(template.id, schoolId);
      await store.createAuditLog({
        schoolId,
        actorId: req.user?.sub ?? null,
        actorType: 'user',
        action: 'template.delete',
        entity: 'message_templates',
        entityId: template.id,
        details: { name: template.name, type: template.type, language: template.language },
      });
      ok(res, { deleted: template.id });
    }),
  );

  /* ------------------------- live preview ---------------------------- */

  router.post(
    '/messages/preview',
    deps.requireAuth,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const {
        body,
        template_id,
        recipient_type,
        target_class_id,
        target_student_ids,
        filter,
        date,
        month,
      } = req.body as {
        body?: unknown;
        template_id?: unknown;
        recipient_type?: unknown;
        target_class_id?: unknown;
        target_student_ids?: unknown;
        filter?: unknown;
        date?: unknown;
        month?: unknown;
      };
      if (typeof recipient_type !== 'string') {
        throw Object.assign(new Error('recipient_type is required'), { code: 'VALIDATION' });
      }
      if (!['all_parents', 'class', 'selected_students', 'single_parent'].includes(recipient_type)) {
        throw Object.assign(new Error('Invalid recipient_type'), { code: 'VALIDATION' });
      }
      const result = await previewMessage(customDeps, {
        schoolId,
        body: typeof body === 'string' ? body : undefined,
        templateId: typeof template_id === 'string' ? template_id : undefined,
        recipientType: recipient_type as never,
        targetClassId: typeof target_class_id === 'string' ? target_class_id : null,
        targetStudentIds: Array.isArray(target_student_ids)
          ? (target_student_ids as string[])
          : undefined,
        filter: filter === 'absent' || filter === 'fee_unpaid' ? filter : undefined,
        date: typeof date === 'string' ? date : undefined,
        month: typeof month === 'string' ? month : undefined,
      });
      ok(res, result);
    }),
  );

  /* ------------------------ recipient picker ------------------------- */

  router.get(
    '/messages/recipients',
    deps.requireAuth,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const filterQ = req.query.filter;
      const classQ = req.query.class_id;
      const dateQ = req.query.date;
      const monthQ = req.query.month;
      const typeQ = req.query.recipient_type;
      const idsQ = req.query.target_student_ids;
      if (typeof typeQ === 'string' && !['all_parents', 'class', 'selected_students', 'single_parent'].includes(typeQ)) {
        throw Object.assign(new Error('Invalid recipient_type'), { code: 'VALIDATION' });
      }
      if (filterQ !== undefined && filterQ !== 'absent' && filterQ !== 'fee_unpaid') {
        throw Object.assign(new Error('Invalid filter (absent|fee_unpaid)'), { code: 'VALIDATION' });
      }
      const recipients = await store.listRecipients(schoolId, {
        recipientType:
          typeof typeQ === 'string'
            ? (typeQ as 'all_parents' | 'class' | 'selected_students' | 'single_parent')
            : 'all_parents',
        targetClassId: typeof classQ === 'string' ? classQ : null,
        targetStudentIds:
          typeof idsQ === 'string' && idsQ
            ? idsQ.split(',').map((s) => s.trim()).filter(Boolean)
            : undefined,
        filter: filterQ === 'absent' || filterQ === 'fee_unpaid' ? filterQ : undefined,
        date: typeof dateQ === 'string' ? dateQ : undefined,
        month: typeof monthQ === 'string' ? monthQ : undefined,
      });
      const items = recipients.map((r) => {
        let masked: string | null = null;
        try {
          if (r.parentPhoneEnc) {
            const e164 = normalizePK(decryptPhone(r.parentPhoneEnc));
            masked = e164 ? maskPhone(e164) : null;
          }
        } catch {
          masked = null;
        }
        return {
          studentId: r.id,
          studentName: r.name,
          fatherName: r.fatherName,
          className: r.className,
          section: r.section,
          parentPhoneMasked: masked,
          parentOptOut: r.parentOptOut,
          amountDue: r.amountDue ?? null,
        };
      });
      ok(res, {
        recipients: items,
        total: items.length,
        optedOutCount: items.filter((i) => i.parentOptOut).length,
      });
    }),
  );

  /* ----------------------------- drafts ------------------------------ */

  router.get(
    '/messages/drafts',
    deps.requireAuth,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const { page, limit } = parsePagination(req);
      const statusQ = req.query.status;
      const { items, total } = await store.listDrafts(schoolId, {
        status:
          typeof statusQ === 'string'
            ? (statusQ as 'draft' | 'scheduled' | 'sent' | 'cancelled')
            : undefined,
        page,
        limit,
      });
      ok(res, { items, total, page, pages: Math.ceil(total / limit) });
    }),
  );

  router.post(
    '/messages/drafts',
    deps.requireAuth,
    requireAdminOrClerk,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const { recipient_type, target_class_id, target_student_ids, body, scheduled_for } =
        req.body as {
          recipient_type?: unknown;
          target_class_id?: unknown;
          target_student_ids?: unknown;
          body?: unknown;
          scheduled_for?: unknown;
        };
      validateDraftInput({
        recipientType: typeof recipient_type === 'string' ? recipient_type : '',
        targetClassId: typeof target_class_id === 'string' ? target_class_id : null,
        targetStudentIds: Array.isArray(target_student_ids)
          ? (target_student_ids as string[])
          : undefined,
        body: typeof body === 'string' ? body : '',
      });
      const scheduledFor = parseScheduledFor(scheduled_for);
      const created = await store.createDraft({
        schoolId,
        createdBy: req.user?.sub ?? null,
        recipientType: recipient_type as never,
        targetClassId: typeof target_class_id === 'string' ? target_class_id : null,
        targetStudentIds: Array.isArray(target_student_ids)
          ? (target_student_ids as string[])
          : [],
        body: (body as string).trim(),
        scheduledFor,
      });
      await writeChangeLogs(getDb(), {
        schoolId,
        actorId: req.user?.sub ?? null,
        entity: 'message_draft',
        entityId: created.id,
        before: {},
        after: {
          recipient_type: created.recipientType,
          body: created.body,
          status: created.status,
        },
      });
      await store.createAuditLog({
        schoolId,
        actorId: req.user?.sub ?? null,
        actorType: 'user',
        action: 'draft.create',
        entity: 'message_draft',
        entityId: created.id,
        details: { recipient_type: created.recipientType },
      });
      ok(res, { draft: created }, 201);
    }),
  );

  router.get(
    '/messages/drafts/:id',
    deps.requireAuth,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const draft = await loadDraft(req, param(req, 'id'));
      const approval = await store.getDraftApproval(draft.id, schoolId);
      // Rendered preview against the first recipient (variables resolved).
      let preview: Awaited<ReturnType<typeof previewMessage>> | null = null;
      try {
        preview = await previewMessage(customDeps, {
          schoolId,
          body: draft.body,
          recipientType: draft.recipientType,
          targetClassId: draft.targetClassId,
          targetStudentIds: draft.targetStudentIds,
        });
      } catch {
        preview = null;
      }
      ok(res, { draft, approval, preview });
    }),
  );

  router.patch(
    '/messages/drafts/:id',
    deps.requireAuth,
    requireAdminOrClerk,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const draft = await loadDraft(req, param(req, 'id'));
      assertDraftWritable(req, draft);
      if (draft.status === 'sent' || draft.status === 'cancelled') {
        throw Object.assign(new Error(`A ${draft.status} draft cannot be edited`), { code: 'CONFLICT' });
      }
      const { recipient_type, target_class_id, target_student_ids, body, scheduled_for } =
        req.body as {
          recipient_type?: unknown;
          target_class_id?: unknown;
          target_student_ids?: unknown;
          body?: unknown;
          scheduled_for?: unknown;
        };
      const merged = {
        recipientType:
          typeof recipient_type === 'string' ? recipient_type : draft.recipientType,
        targetClassId:
          target_class_id === undefined
            ? draft.targetClassId
            : typeof target_class_id === 'string'
              ? target_class_id
              : null,
        targetStudentIds:
          target_student_ids === undefined
            ? draft.targetStudentIds
            : Array.isArray(target_student_ids)
              ? (target_student_ids as string[])
              : [],
        body: typeof body === 'string' ? body : draft.body,
      };
      validateDraftInput(merged);
      const before = {
        recipient_type: draft.recipientType,
        target_class_id: draft.targetClassId,
        body: draft.body,
        scheduled_for: draft.scheduledFor?.toISOString() ?? null,
        status: draft.status,
      };
      const updated = await store.updateDraft(
        draft.id,
        {
          recipientType: merged.recipientType as never,
          targetClassId: merged.targetClassId,
          targetStudentIds: merged.targetStudentIds,
          body: merged.body.trim(),
          ...(scheduled_for !== undefined
            ? { scheduledFor: parseScheduledFor(scheduled_for) }
            : {}),
        },
        schoolId,
      );
      await writeChangeLogs(getDb(), {
        schoolId,
        actorId: req.user?.sub ?? null,
        entity: 'message_draft',
        entityId: updated.id,
        before,
        after: {
          recipient_type: updated.recipientType,
          target_class_id: updated.targetClassId,
          body: updated.body,
          scheduled_for: updated.scheduledFor?.toISOString() ?? null,
          status: updated.status,
        },
      });
      await store.createAuditLog({
        schoolId,
        actorId: req.user?.sub ?? null,
        actorType: 'user',
        action: 'draft.update',
        entity: 'message_draft',
        entityId: updated.id,
        details: {},
      });
      ok(res, { draft: updated });
    }),
  );

  router.delete(
    '/messages/drafts/:id',
    deps.requireAuth,
    requireAdminOrClerk,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const draft = await loadDraft(req, param(req, 'id'));
      assertDraftWritable(req, draft);
      if (draft.status !== 'draft') {
        throw Object.assign(
          new Error(`Only drafts in status 'draft' can be deleted (this one is ${draft.status}); cancel it instead`),
          { code: 'CONFLICT' },
        );
      }
      const db = getDb();
      await (db as any).deletedRecord.create({
        data: {
          schoolId,
          entity: 'message_draft',
          entityId: draft.id,
          snapshot: snapshotOf(draft as unknown as Record<string, unknown>),
          deletedBy: req.user?.sub ?? null,
          deletedAt: new Date(),
          restoreBy: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
      });
      await store.deleteDraft(draft.id, schoolId);
      await store.createAuditLog({
        schoolId,
        actorId: req.user?.sub ?? null,
        actorType: 'user',
        action: 'draft.delete',
        entity: 'message_draft',
        entityId: draft.id,
        details: {},
      });
      ok(res, { deleted: draft.id });
    }),
  );

  router.post(
    '/messages/drafts/:id/cancel',
    deps.requireAuth,
    requireAdminOrClerk,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const draft = await loadDraft(req, param(req, 'id'));
      assertDraftWritable(req, draft);
      if (draft.status === 'sent' || draft.status === 'cancelled') {
        throw Object.assign(new Error(`A ${draft.status} draft cannot be cancelled`), { code: 'CONFLICT' });
      }
      const updated = await store.updateDraft(draft.id, { status: 'cancelled' }, schoolId);
      await writeChangeLogs(getDb(), {
        schoolId,
        actorId: req.user?.sub ?? null,
        entity: 'message_draft',
        entityId: updated.id,
        before: { status: draft.status },
        after: { status: 'cancelled' },
      });
      await store.createAuditLog({
        schoolId,
        actorId: req.user?.sub ?? null,
        actorType: 'user',
        action: 'draft.cancel',
        entity: 'message_draft',
        entityId: updated.id,
        details: {},
      });
      ok(res, { draft: updated });
    }),
  );

  /* ---------------------- approval before send ----------------------- */

  router.post(
    '/messages/drafts/:id/submit-for-approval',
    deps.requireAuth,
    requireAdminOrClerk,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const draft = await loadDraft(req, param(req, 'id'));
      assertDraftWritable(req, draft);
      if (draft.status !== 'draft' && draft.status !== 'scheduled') {
        throw Object.assign(
          new Error(`A ${draft.status} draft cannot be submitted for approval`),
          { code: 'CONFLICT' },
        );
      }
      const existing = await store.getDraftApproval(draft.id, schoolId);
      if (existing && existing.status === 'pending') {
        throw Object.assign(new Error('This draft is already waiting for approval'), { code: 'CONFLICT' });
      }
      const created = await createApprovalRequest(getDb(), {
        schoolId,
        requestedBy: req.user?.sub ?? 'unknown',
        actionType: 'create',
        entity: 'message_draft',
        entityId: draft.id,
        payload: {
          draft_id: draft.id,
          recipient_type: draft.recipientType,
          target_class_id: draft.targetClassId,
          target_student_ids: draft.targetStudentIds,
          body: draft.body,
          scheduled_for: draft.scheduledFor?.toISOString() ?? null,
        },
      });
      res.status(202).json({
        ok: true,
        data: {
          approval_request_id: created.id,
          status: 'pending',
          message: 'Submitted for admin approval — nothing will send until it is approved.',
        },
      });
    }),
  );

  router.post(
    '/messages/drafts/:id/approve-send',
    deps.requireAuth,
    deps.requireAdmin,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const draft = await loadDraft(req, param(req, 'id'));
      if (draft.status === 'sent' || draft.status === 'cancelled') {
        throw Object.assign(new Error(`A ${draft.status} draft cannot be approved`), { code: 'CONFLICT' });
      }
      const result = await approveDraftForSending(customDeps, {
        schoolId,
        draftId: draft.id,
        approvedBy: req.user?.sub ?? 'unknown',
      });
      ok(res, result);
    }),
  );

  router.post(
    '/messages/drafts/:id/reject',
    deps.requireAuth,
    deps.requireAdmin,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const draft = await loadDraft(req, param(req, 'id'));
      if (draft.status === 'sent' || draft.status === 'cancelled') {
        throw Object.assign(new Error(`A ${draft.status} draft cannot be rejected`), { code: 'CONFLICT' });
      }
      const { reason } = req.body as { reason?: unknown };
      // Reject any pending approval request for this draft too, so the
      // Approval Queue does not keep offering a dead draft.
      const approval = await store.getDraftApproval(draft.id, schoolId);
      if (approval && approval.status === 'pending') {
        await rejectApprovalRequest(
          getDb(),
          schoolId,
          approval.id,
          req.user?.sub ?? 'unknown',
          typeof reason === 'string' ? reason : 'Draft rejected by admin',
        );
      }
      const updated = await store.updateDraft(draft.id, { status: 'cancelled' }, schoolId);
      await writeChangeLogs(getDb(), {
        schoolId,
        actorId: req.user?.sub ?? null,
        entity: 'message_draft',
        entityId: updated.id,
        before: { status: draft.status },
        after: { status: 'cancelled' },
      });
      await store.createAuditLog({
        schoolId,
        actorId: req.user?.sub ?? null,
        actorType: 'user',
        action: 'draft.reject',
        entity: 'message_draft',
        entityId: updated.id,
        details: { reason: typeof reason === 'string' ? reason : null },
      });
      ok(res, { draft: updated });
    }),
  );

  /* ------------------------ SMS / devices -------------------------- */

  router.get(
    '/sms/status',
    deps.requireAuth,
    wrap(async (req, res) => {
      const schoolId = requireSchool(req);
      const s = await getSmsStatus(serviceDeps, { schoolId });
      // Phase 9 fix: getSmsStatus returns camelCase, but the contract is
      // snake_case (see SmsStatus in the frontend) and ok() does no case
      // conversion — the header read `queued_count` as undefined and
      // always showed "0 queued" (and "SIM offline") while the log showed
      // a Queued row. Serialize explicitly, like the other routes.
      ok(res, {
        provider: s.provider,
        sim_connected: s.simConnected,
        last_seen_at: s.lastSeenAt ? s.lastSeenAt.toISOString() : null,
        queued_count: s.queuedCount,
        pending_approval_count: s.pendingApprovalCount,
      });
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
