/**
 * MessagingStore — the data-access boundary for the Messaging module.
 *
 * The service never touches Prisma (or any DB) directly: it talks only to
 * this interface. Tests use an in-memory fake; production uses
 * createPrismaMessagingStore(prisma) below, which the integration phase wires
 * to the real Prisma client (Database agent owns prisma/schema.prisma).
 *
 * Why: the Database agent's generated client may not exist yet while this
 * module is built in parallel. The adapter takes `prisma: any` on purpose —
 * it is verified at integration time, and the interface is the contract.
 */

import type { TemplateLanguage, TemplateType } from './templates';
import { todayInTz, currentMonthInTz } from '../../lib/dates';

/**
 * Tenant-isolation rule for this store (ISOLATION-AUDIT 2026-11-06):
 * every lookup that takes an id which a client could supply from another
 * school ALSO takes the caller's schoolId and returns null / throws when
 * the row belongs to a different school. Callers must pass their JWT
 * schoolId; a missing schoolId keeps the old behaviour only for internal
 * callers that already proved ownership (none remain in production paths).
 */
function notFoundError(message: string): Error {
  return Object.assign(new Error(message), { code: 'NOT_FOUND' });
}
function conflictError(message: string): Error {
  return Object.assign(new Error(message), { code: 'CONFLICT' });
}

/**
 * Section 11: Prisma rejects malformed UUIDs in `where: {id}` with a 500
 * instead of "not found". Client-supplied ids (route params, target lists)
 * must behave as "no such row" (null / NOT_FOUND / empty list), never a 500.
 * Do NOT pre-filter ids with isUuid() before a lookup: ids are not always
 * UUIDs (e.g. the isolation test fake DB uses readable string ids), so the
 * lookup is attempted and only Prisma's own malformed-UUID validation error
 * is mapped to "no such row" (orNullOnBadId / orNotFoundOnBadId below).
 * isUuid() is still used for `id: {in: [...]}` list filters, where a bad id
 * would otherwise poison the whole query.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
/** True when Prisma rejected an id as a malformed UUID (P2023 / validation error). */
function isInvalidIdError(err: any): boolean {
  if (err?.code === 'P2023') return true;
  const msg = String(err?.message ?? '');
  return /malformed uuid|invalid.*uuid/i.test(msg);
}
/** Run an id lookup; a malformed UUID is "no such row" (null), never a 500. */
async function orNullOnBadId<T>(fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (isInvalidIdError(err)) return null;
    throw err;
  }
}
/** Run an id mutation; a malformed UUID is NOT_FOUND, never a 500. */
async function orNotFoundOnBadId<T>(fn: () => Promise<T>, message: string): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isInvalidIdError(err)) throw notFoundError(message);
    throw err;
  }
}

export type QueueStatus = 'queued' | 'sent' | 'failed' | 'cancelled';
export type QueueType = TemplateType;

export interface SchoolInfo {
  id: string;
  name: string;
  timezone: string;
  smsProvider: 'sim' | 'gateway';
}

export interface TemplateRow {
  id: string;
  schoolId: string;
  type: TemplateType;
  language: TemplateLanguage;
  body: string;
  isActive: boolean;
  /** Section 11: admin-editable label (NULL on old rows — backfilled by migration). */
  name: string | null;
  /** Section 11: false = seeded default, true = admin-created. NOT a lock — any template may be edited/renamed/duplicated/deleted. */
  isCustom: boolean;
}

export type RecipientType =
  | 'all_parents'
  | 'class'
  | 'selected_students'
  | 'single_parent';
export type DraftStatus = 'draft' | 'scheduled' | 'sent' | 'cancelled';

export interface DraftRow {
  id: string;
  schoolId: string;
  createdBy: string | null;
  recipientType: RecipientType;
  targetClassId: string | null;
  targetStudentIds: string[];
  body: string;
  status: DraftStatus;
  scheduledFor: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewDraft {
  schoolId: string;
  createdBy: string | null;
  recipientType: RecipientType;
  targetClassId?: string | null;
  targetStudentIds?: string[];
  body: string;
  scheduledFor?: Date | null;
}

export interface DraftPatch {
  recipientType?: RecipientType;
  targetClassId?: string | null;
  targetStudentIds?: string[];
  body?: string;
  status?: DraftStatus;
  scheduledFor?: Date | null;
}

export interface DraftFilters {
  status?: DraftStatus;
  page: number;
  limit: number;
}

/**
 * One resolved recipient for a custom message: an active student of this
 * school with the class context needed to render all 8 variables.
 * `amountDue` is the remaining fee balance for the render month (if any) —
 * it feeds {amount}; undefined leaves {amount} literal.
 */
export interface RecipientStudent {
  id: string;
  name: string;
  fatherName: string | null;
  classId: string;
  className: string;
  section: string;
  parentPhoneEnc: string | null;
  parentOptOut: boolean;
  amountDue?: number;
}

export interface RecipientQuery {
  recipientType: RecipientType;
  targetClassId?: string | null;
  targetStudentIds?: string[];
  /** Quick filter: 'absent' (today's absent list) or 'fee_unpaid'. */
  filter?: 'absent' | 'fee_unpaid';
  /** School-local date for the absent filter (YYYY-MM-DD, default today). */
  date?: string;
  /** Month for the fee-unpaid filter / {amount} (YYYY-MM, default current). */
  month?: string;
}

export interface DeliveryRow {
  queueId: string;
  provider: string;
  status: string;
  deliveredAt: Date | null;
  error: string | null;
  createdAt: Date;
}

/** Minimal public view of an approval_requests row about a draft. */
export interface DraftApproval {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  createdAt: Date;
}

export interface QueueRow {
  id: string;
  schoolId: string;
  type: QueueType;
  studentId: string | null;
  classId: string | null;
  parentPhoneEnc: string;
  body: string;
  status: QueueStatus;
  attempts: number;
  dedupeKey: string;
  scheduledFor: Date;
  sentAt: Date | null;
  error: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
}

export interface NewQueueRow {
  schoolId: string;
  type: QueueType;
  studentId?: string | null;
  classId?: string | null;
  parentPhoneEnc: string;
  body: string;
  dedupeKey: string;
  /** Drafts are created held: approvedAt stays null until admin approves. */
  scheduledFor?: Date;
}

export interface DeviceRow {
  id: string;
  schoolId: string;
  deviceId: string;
  name: string;
  lastSeenAt: Date | null;
  status: 'online' | 'offline';
}

export interface AuditLogInput {
  schoolId: string;
  actorId: string | null;
  actorType: 'user' | 'teacher_link' | 'system' | 'device';
  action: string;
  entity: string;
  entityId?: string | null;
  details?: Record<string, unknown>;
}

export interface QueueFilters {
  status?: QueueStatus;
  type?: QueueType;
  date?: string; // YYYY-MM-DD, matches createdAt date (school-local, best effort)
  classId?: string;
  page: number;
  limit: number;
}

export interface MessagingStore {
  getSchool(schoolId: string): Promise<SchoolInfo | null>;
  /** Minimal student lookup (id + name) for the pending-approval list. Scoped: only students of `schoolId` are ever returned. */
  getStudentsByIds(ids: string[], schoolId: string): Promise<Array<{ id: string; name: string }>>;
  isHoliday(schoolId: string, date: string): Promise<boolean>;
  getActiveTemplate(
    schoolId: string,
    type: TemplateType,
    language: TemplateLanguage,
  ): Promise<TemplateRow | null>;
  listTemplates(schoolId: string): Promise<TemplateRow[]>;
  getTemplateById(id: string, schoolId?: string): Promise<TemplateRow | null>;
  updateTemplate(
    id: string,
    patch: { body?: string; isActive?: boolean; name?: string | null; type?: TemplateType; language?: TemplateLanguage },
    schoolId?: string,
  ): Promise<TemplateRow>;
  /** Create a template (is_custom=true for admin-created rows). Throws CONFLICT on the (schoolId, type, language) unique slot. */
  createTemplate(input: {
    schoolId: string;
    name: string;
    type: TemplateType;
    language: TemplateLanguage;
    body: string;
    isCustom?: boolean;
  }): Promise<TemplateRow>;
  /** Hard delete, school-scoped (route snapshots it into deleted_records first). Throws NOT_FOUND on mismatch. */
  deleteTemplate(id: string, schoolId: string): Promise<void>;

  /* ---------------- Section 11: drafts, recipients, approvals -------- */
  createDraft(draft: NewDraft): Promise<DraftRow>;
  getDraftById(id: string, schoolId: string): Promise<DraftRow | null>;
  listDrafts(
    schoolId: string,
    filters: DraftFilters,
  ): Promise<{ items: DraftRow[]; total: number }>;
  updateDraft(id: string, patch: DraftPatch, schoolId: string): Promise<DraftRow>;
  deleteDraft(id: string, schoolId: string): Promise<void>;
  /** Resolve the students a draft/preview targets (school-scoped, active, not soft-deleted). */
  listRecipients(schoolId: string, query: RecipientQuery): Promise<RecipientStudent[]>;
  /** Latest delivery attempt per queue row (for history detail). */
  listDeliveriesForQueueIds(queueIds: string[], schoolId: string): Promise<DeliveryRow[]>;
  /** Latest approval_requests row about a draft (any status), or null. */
  getDraftApproval(draftId: string, schoolId: string): Promise<DraftApproval | null>;
  /** True when an APPROVED approval_requests row exists for the draft (the scheduled job's approval gate). */
  hasApprovedDraftApproval(draftId: string, schoolId: string): Promise<boolean>;
  /** Record a direct admin approval of a draft (approve-send path): inserts an APPROVED approval_requests row as the audit trail. */
  recordDraftApproval(input: {
    schoolId: string;
    draftId: string;
    adminId: string;
    payload: Record<string, unknown>;
  }): Promise<DraftApproval>;

  findQueueByDedupeKey(dedupeKey: string, schoolId?: string): Promise<QueueRow | null>;
  /** Insert a queue row. On unique-dedupe-key conflict, returns the existing row. */
  createQueue(row: NewQueueRow): Promise<{ row: QueueRow; created: boolean }>;
  listPendingApproval(schoolId: string): Promise<QueueRow[]>;
  listDueApproved(schoolId: string, limit: number): Promise<QueueRow[]>;
  listQueue(
    schoolId: string,
    filters: QueueFilters,
  ): Promise<{ items: QueueRow[]; total: number }>;
  getQueueById(id: string, schoolId?: string): Promise<QueueRow | null>;
  updateQueue(id: string, patch: Partial<QueueRow>, schoolId?: string): Promise<QueueRow>;
  createDelivery(input: {
    queueId: string;
    provider: 'sim' | 'gateway';
    deviceId?: string | null;
    status: string;
    error?: string | null;
  }): Promise<void>;
  createAuditLog(log: AuditLogInput): Promise<void>;

  getDeviceByDeviceId(deviceId: string): Promise<DeviceRow | null>;
  upsertDevice(input: {
    schoolId: string;
    deviceId: string;
    name: string;
  }): Promise<DeviceRow>;
  touchDevice(deviceId: string): Promise<void>;
  getDevicesStatus(schoolId: string): Promise<{ lastSeenAt: Date | null; onlineCount: number }>;
  countQueued(schoolId: string): Promise<{ queued: number; pendingApproval: number }>;
}

/** Dedupe key formats (SCHEMA.md message_queue). */
export const dedupeKeyAbsent = (studentId: string, date: string) =>
  `absent:${studentId}:${date}`;
export const dedupeKeyFee = (studentId: string, month: string) =>
  `fee:${studentId}:${month}`;
export const dedupeKeyTeacher = (classId: string, date: string) =>
  `teacher:${classId}:${date}`;

/** True if the school-local date is a school day (not Sunday, not a holiday). */
export async function isSchoolDay(
  store: MessagingStore,
  schoolId: string,
  date: string,
): Promise<boolean> {
  // date is a school-local YYYY-MM-DD; day-of-week is computed on the date itself.
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (day === 0) return false; // Sunday — always a non-school day (SCHEMA.md)
  return !(await store.isHoliday(schoolId, date));
}

/* ------------------------------------------------------------------ */
/* Prisma adapter (integration wiring; `prisma: any` by design — see header) */
/* ------------------------------------------------------------------ */

function mapQueueRow(r: any): QueueRow {
  return {
    id: r.id,
    schoolId: r.schoolId,
    type: r.type,
    studentId: r.studentId ?? null,
    classId: r.classId ?? null,
    parentPhoneEnc: r.parentPhoneEnc,
    body: r.body,
    status: r.status,
    attempts: r.attempts,
    dedupeKey: r.dedupeKey,
    scheduledFor: new Date(r.scheduledFor),
    sentAt: r.sentAt ? new Date(r.sentAt) : null,
    error: r.error ?? null,
    approvedBy: r.approvedBy ?? null,
    approvedAt: r.approvedAt ? new Date(r.approvedAt) : null,
    createdAt: new Date(r.createdAt),
  };
}

function mapTemplateRow(r: any): TemplateRow {
  return {
    id: r.id,
    schoolId: r.schoolId,
    type: r.type,
    language: r.language,
    body: r.body,
    isActive: r.isActive,
    name: r.name ?? null,
    isCustom: r.isCustom ?? false,
  };
}

/** Dedupe key for a custom-draft send: one queue row per draft+student, ever. */
export const dedupeKeyCustom = (draftId: string, studentId: string) =>
  `custom:${draftId}:${studentId}`;

function mapDraftRow(r: any): DraftRow {
  const ids = Array.isArray(r.targetStudentIds) ? r.targetStudentIds : [];
  return {
    id: r.id,
    schoolId: r.schoolId,
    createdBy: r.createdBy ?? null,
    recipientType: r.recipientType,
    targetClassId: r.targetClassId ?? null,
    targetStudentIds: ids.map(String),
    body: r.body,
    status: r.status,
    scheduledFor: r.scheduledFor ? new Date(r.scheduledFor) : null,
    createdAt: new Date(r.createdAt),
    updatedAt: new Date(r.updatedAt),
  };
}

function mapDeliveryRow(r: any): DeliveryRow {
  return {
    queueId: r.queueId,
    provider: r.provider,
    status: r.status,
    deliveredAt: r.deliveredAt ? new Date(r.deliveredAt) : null,
    error: r.error ?? null,
    createdAt: new Date(r.createdAt),
  };
}

function mapDraftApproval(r: any): DraftApproval {
  return {
    id: r.id,
    status: r.status,
    requestedBy: r.requestedBy,
    decidedBy: r.decidedBy ?? null,
    decidedAt: r.decidedAt ? new Date(r.decidedAt) : null,
    createdAt: new Date(r.createdAt),
  };
}

function mapDeviceRow(r: any): DeviceRow {
  return {
    id: r.id,
    schoolId: r.schoolId,
    deviceId: r.deviceId,
    name: r.name,
    lastSeenAt: r.lastSeenAt ? new Date(r.lastSeenAt) : null,
    status: r.status,
  };
}

/**
 * Build a MessagingStore on top of a Prisma client instance.
 * `prisma` is typed `any` so this file compiles before `prisma generate`
 * runs; the model/field names below follow contracts/SCHEMA.md exactly.
 */
export function createPrismaMessagingStore(prisma: any): MessagingStore {
  const settingsProvider = (settings: any): 'sim' | 'gateway' =>
    settings?.sms_provider === 'gateway' ? 'gateway' : 'sim';

  return {
    async getSchool(schoolId) {
      const s = await prisma.school.findUnique({ where: { id: schoolId } });
      if (!s) return null;
      return {
        id: s.id,
        name: s.name,
        timezone: s.timezone ?? 'Asia/Karachi',
        smsProvider: settingsProvider(s.settings),
      };
    },

    async getStudentsByIds(ids, schoolId) {
      const rows = await prisma.student.findMany({
        where: { schoolId: schoolId, id: { in: ids } },
        select: { id: true, name: true },
      });
      return rows.map((r: any) => ({ id: r.id, name: r.name }));
    },

    async isHoliday(schoolId, date) {
      const h = await prisma.holiday.findFirst({
        where: { schoolId: schoolId, date: new Date(`${date}T00:00:00Z`) },
      });
      return Boolean(h);
    },

    async getActiveTemplate(schoolId, type, language) {
      const t = await prisma.messageTemplate.findFirst({
        where: { schoolId: schoolId, type, language, isActive: true },
      });
      return t ? mapTemplateRow(t) : null;
    },

    async listTemplates(schoolId) {
      const rows = await prisma.messageTemplate.findMany({
        where: { schoolId: schoolId },
        orderBy: [{ type: 'asc' }, { language: 'asc' }],
      });
      return rows.map(mapTemplateRow);
    },

    async getTemplateById(id, schoolId) {
      return orNullOnBadId(async () => {
        const t = schoolId
          ? await prisma.messageTemplate.findFirst({ where: { id, schoolId } })
          : await prisma.messageTemplate.findUnique({ where: { id } });
        return t ? mapTemplateRow(t) : null;
      });
    },

    async updateTemplate(id, patch, schoolId) {
      return orNotFoundOnBadId(async () => {
        if (schoolId) {
          const owned = await prisma.messageTemplate.findFirst({ where: { id, schoolId } });
          if (!owned) throw notFoundError('Template not found');
        }
        const data: any = {};
        if (patch.body !== undefined) data.body = patch.body;
        if (patch.isActive !== undefined) data.isActive = patch.isActive;
        if (patch.name !== undefined) data.name = patch.name;
        if (patch.type !== undefined) data.type = patch.type;
        if (patch.language !== undefined) data.language = patch.language;
        try {
          const t = await prisma.messageTemplate.update({ where: { id }, data });
          return mapTemplateRow(t);
        } catch (err: any) {
          if (err?.code === 'P2002') throw conflictError('A template already exists for this type and language');
          throw err;
        }
      }, 'Template not found');
    },

    async createTemplate(input) {
      try {
        const t = await prisma.messageTemplate.create({
          data: {
            schoolId: input.schoolId,
            name: input.name,
            type: input.type,
            language: input.language,
            body: input.body,
            isCustom: input.isCustom ?? true,
            isActive: true,
          },
        });
        return mapTemplateRow(t);
      } catch (err: any) {
        if (err?.code === 'P2002') throw conflictError('A template already exists for this type and language');
        throw err;
      }
    },

    async deleteTemplate(id, schoolId) {
      return orNotFoundOnBadId(async () => {
        const owned = await prisma.messageTemplate.findFirst({ where: { id, schoolId } });
        if (!owned) throw notFoundError('Template not found');
        await prisma.messageTemplate.delete({ where: { id } });
      }, 'Template not found');
    },

    /* ---------------- Section 11: drafts ---------------- */
    async createDraft(draft) {
      const created = await prisma.messageDraft.create({
        data: {
          schoolId: draft.schoolId,
          createdBy: draft.createdBy ?? null,
          recipientType: draft.recipientType,
          targetClassId: draft.targetClassId ?? null,
          targetStudentIds: draft.targetStudentIds ?? [],
          body: draft.body,
          status: 'draft',
          scheduledFor: draft.scheduledFor ?? null,
        },
      });
      return mapDraftRow(created);
    },

    async getDraftById(id, schoolId) {
      return orNullOnBadId(async () => {
        const d = await prisma.messageDraft.findFirst({ where: { id, schoolId } });
        return d ? mapDraftRow(d) : null;
      });
    },

    async listDrafts(schoolId, filters) {
      const where: any = { schoolId };
      if (filters.status) where.status = filters.status;
      const [rows, total] = await Promise.all([
        prisma.messageDraft.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          skip: (filters.page - 1) * filters.limit,
          take: filters.limit,
        }),
        prisma.messageDraft.count({ where }),
      ]);
      return { items: rows.map(mapDraftRow), total };
    },

    async updateDraft(id, patch, schoolId) {
      return orNotFoundOnBadId(async () => {
        const owned = await prisma.messageDraft.findFirst({ where: { id, schoolId } });
        if (!owned) throw notFoundError('Draft not found');
        const data: any = {};
        if (patch.recipientType !== undefined) data.recipientType = patch.recipientType;
        if (patch.targetClassId !== undefined) data.targetClassId = patch.targetClassId;
        if (patch.targetStudentIds !== undefined) data.targetStudentIds = patch.targetStudentIds;
        if (patch.body !== undefined) data.body = patch.body;
        if (patch.status !== undefined) data.status = patch.status;
        if (patch.scheduledFor !== undefined) data.scheduledFor = patch.scheduledFor;
        const updated = await prisma.messageDraft.update({ where: { id }, data });
        return mapDraftRow(updated);
      }, 'Draft not found');
    },

    async deleteDraft(id, schoolId) {
      return orNotFoundOnBadId(async () => {
        const owned = await prisma.messageDraft.findFirst({ where: { id, schoolId } });
        if (!owned) throw notFoundError('Draft not found');
        await prisma.messageDraft.delete({ where: { id } });
      }, 'Draft not found');
    },

    /* ---------------- Section 11: recipients ---------------- */
    async listRecipients(schoolId, query) {
      // Phase 9: the default month/date used to come from
      // `new Date().toISOString()` (UTC) — in PKT that is a day behind
      // before 05:00. Default to the SCHOOL-local day/month instead.
      const schoolRow: any = await prisma.school.findUnique({ where: { id: schoolId } }).catch(() => null);
      const tz = (schoolRow?.timezone as string | undefined) ?? 'Asia/Karachi';
      const month = query.month ?? currentMonthInTz(tz);
      const date = query.date ?? todayInTz(tz);
      // Malformed UUIDs never match a row — drop them instead of letting
      // Prisma throw a 500 on the `id: {in: [...]}` filter.
      const targetIds = (query.targetStudentIds ?? []).filter(isUuid);
      const targetClassId = query.targetClassId && isUuid(query.targetClassId) ? query.targetClassId : null;

      let students: any[];
      if (query.filter === 'absent') {
        const days: any[] = await prisma.attendanceDay.findMany({
          where: {
            schoolId,
            date: new Date(`${date}T00:00:00Z`),
            ...(targetClassId ? { classId: targetClassId } : {}),
          },
          select: { id: true },
        });
        const dayIds = days.map((d) => d.id);
        if (dayIds.length === 0) return [];
        const records: any[] = await prisma.attendanceRecord.findMany({
          where: { attendanceDayId: { in: dayIds }, status: 'absent' },
          select: { studentId: true },
        });
        const ids = [...new Set(records.map((r) => r.studentId))];
        if (ids.length === 0) return [];
        students = await prisma.student.findMany({
          where: { schoolId, id: { in: ids }, status: 'active', deletedAt: null },
          include: { class: { select: { name: true, section: true } } },
        });
      } else if (query.filter === 'fee_unpaid') {
        const records: any[] = await prisma.feeRecord.findMany({
          where: { schoolId, month, status: 'unpaid', deletedAt: null },
          select: { studentId: true },
        });
        let ids = [...new Set(records.map((r) => r.studentId))];
        if (ids.length === 0) return [];
        const where: any = { schoolId, id: { in: ids }, status: 'active', deletedAt: null };
        if (targetClassId) where.classId = targetClassId;
        students = await prisma.student.findMany({
          where,
          include: { class: { select: { name: true, section: true } } },
        });
      } else if (query.recipientType === 'class') {
        if (!targetClassId) return [];
        students = await prisma.student.findMany({
          where: { schoolId, classId: targetClassId, status: 'active', deletedAt: null },
          include: { class: { select: { name: true, section: true } } },
        });
      } else if (query.recipientType === 'selected_students' || query.recipientType === 'single_parent') {
        const ids = targetIds;
        if (ids.length === 0) return [];
        students = await prisma.student.findMany({
          where: { schoolId, id: { in: ids }, status: 'active', deletedAt: null },
          include: { class: { select: { name: true, section: true } } },
        });
      } else {
        // all_parents
        students = await prisma.student.findMany({
          where: { schoolId, status: 'active', deletedAt: null },
          include: { class: { select: { name: true, section: true } } },
        });
      }

      // {amount}: remaining fee balance for the render month (best effort).
      const feeRows: any[] =
        students.length > 0
          ? await prisma.feeRecord.findMany({
              where: { schoolId, month, studentId: { in: students.map((s: any) => s.id) } },
              select: { studentId: true, amountDue: true, amountPaid: true, discount: true },
            })
          : [];
      const balanceByStudent = new Map<string, number>();
      for (const f of feeRows) {
        const remaining = f.amountDue - f.amountPaid - f.discount;
        if (remaining > 0) balanceByStudent.set(f.studentId, remaining);
      }

      return students.map((s: any): RecipientStudent => {
        const rec: RecipientStudent = {
          id: s.id,
          name: s.name,
          fatherName: s.fatherName ?? null,
          classId: s.classId,
          className: s.class?.name ?? '',
          section: s.class?.section ?? '',
          parentPhoneEnc: s.parentPhoneEnc ?? null,
          parentOptOut: s.parentOptOut ?? false,
        };
        const due = balanceByStudent.get(s.id);
        if (due !== undefined) rec.amountDue = due;
        return rec;
      });
    },

    async listDeliveriesForQueueIds(queueIds, schoolId) {
      if (queueIds.length === 0) return [];
      // Scope: only deliveries whose queue row belongs to this school.
      const rows: any[] = await prisma.messageDelivery.findMany({
        where: { queueId: { in: queueIds }, queue: { schoolId } },
        orderBy: [{ createdAt: 'desc' }],
      });
      const seen = new Set<string>();
      const out: DeliveryRow[] = [];
      for (const r of rows) {
        if (seen.has(r.queueId)) continue; // latest only, per queue row
        seen.add(r.queueId);
        out.push(mapDeliveryRow(r));
      }
      return out;
    },

    /* ---------------- Section 11: draft approvals ---------------- */
    async getDraftApproval(draftId, schoolId) {
      return orNullOnBadId(async () => {
        const row = await prisma.approvalRequest.findFirst({
          where: { schoolId, entity: 'message_draft', entityId: draftId },
          orderBy: [{ createdAt: 'desc' }],
        });
        return row ? mapDraftApproval(row) : null;
      });
    },

    async hasApprovedDraftApproval(draftId, schoolId) {
      const row = await orNullOnBadId(async () =>
        prisma.approvalRequest.findFirst({
          where: { schoolId, entity: 'message_draft', entityId: draftId, status: 'approved' },
          select: { id: true },
        }),
      );
      return Boolean(row);
    },

    async recordDraftApproval(input) {
      const created = await prisma.approvalRequest.create({
        data: {
          schoolId: input.schoolId,
          requestedBy: input.adminId,
          actionType: 'create',
          entity: 'message_draft',
          entityId: input.draftId,
          payload: input.payload,
          status: 'approved',
          decidedBy: input.adminId,
          decidedAt: new Date(),
        },
      });
      return mapDraftApproval(created);
    },

    async findQueueByDedupeKey(dedupeKey, schoolId) {
      const r = await prisma.messageQueue.findUnique({ where: { dedupeKey: dedupeKey } });
      if (!r) return null;
      // Dedupe keys are globally unique, but the row still belongs to one
      // school: never hand another school's row to this caller.
      if (schoolId && r.schoolId !== schoolId) return null;
      return mapQueueRow(r);
    },

    async createQueue(row) {
      try {
        const created = await prisma.messageQueue.create({
          data: {
            schoolId: row.schoolId,
            type: row.type,
            studentId: row.studentId ?? null,
            classId: row.classId ?? null,
            parentPhoneEnc: row.parentPhoneEnc,
            body: row.body,
            dedupeKey: row.dedupeKey,
            scheduledFor: row.scheduledFor ?? new Date(),
          },
        });
        return { row: mapQueueRow(created), created: true };
      } catch (err: any) {
        // Unique-violation on dedupe_key (P2002) = the backstop doing its job.
        if (err?.code === 'P2002') {
          const existing = await this.findQueueByDedupeKey(row.dedupeKey, row.schoolId);
          if (existing) return { row: existing, created: false };
        }
        throw err;
      }
    },

    async listPendingApproval(schoolId) {
      const rows = await prisma.messageQueue.findMany({
        where: { schoolId: schoolId, status: 'queued', approvedAt: null },
        orderBy: [{ createdAt: 'asc' }],
      });
      return rows.map(mapQueueRow);
    },

    async listDueApproved(schoolId, limit) {
      const rows = await prisma.messageQueue.findMany({
        where: {
          schoolId: schoolId,
          status: 'queued',
          approvedAt: { not: null },
          scheduledFor: { lte: new Date() },
        },
        orderBy: [{ scheduledFor: 'asc' }],
        take: limit,
      });
      return rows.map(mapQueueRow);
    },

    async listQueue(schoolId, filters) {
      const where: any = { schoolId: schoolId };
      if (filters.status) where.status = filters.status;
      if (filters.type) where.type = filters.type;
      if (filters.classId) where.classId = filters.classId;
      if (filters.date) {
        const start = new Date(`${filters.date}T00:00:00Z`);
        const end = new Date(`${filters.date}T23:59:59Z`);
        where.createdAt = { gte: start, lte: end };
      }
      const [rows, total] = await Promise.all([
        prisma.messageQueue.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }],
          skip: (filters.page - 1) * filters.limit,
          take: filters.limit,
        }),
        prisma.messageQueue.count({ where }),
      ]);
      return { items: rows.map(mapQueueRow), total };
    },

    async getQueueById(id, schoolId) {
      return orNullOnBadId(async () => {
        const r = await prisma.messageQueue.findUnique({ where: { id } });
        if (!r) return null;
        if (schoolId && r.schoolId !== schoolId) return null;
        return mapQueueRow(r);
      });
    },

    async updateQueue(id, patch, schoolId) {
      return orNotFoundOnBadId(async () => {
        if (schoolId) {
          const owned = await prisma.messageQueue.findFirst({ where: { id, schoolId } });
          if (!owned) throw notFoundError('Message not found');
        }
        const data: any = {};
        if (patch.body !== undefined) data.body = patch.body;
        if (patch.status !== undefined) data.status = patch.status;
        if (patch.attempts !== undefined) data.attempts = patch.attempts;
        if (patch.scheduledFor !== undefined) data.scheduledFor = patch.scheduledFor;
        if (patch.sentAt !== undefined) data.sentAt = patch.sentAt;
        if (patch.error !== undefined) data.error = patch.error;
        if (patch.approvedBy !== undefined) data.approvedBy = patch.approvedBy;
        if (patch.approvedAt !== undefined) data.approvedAt = patch.approvedAt;
        const r = await prisma.messageQueue.update({ where: { id }, data });
        return mapQueueRow(r);
      }, 'Message not found');
    },

    async createDelivery(input) {
      await prisma.messageDelivery.create({
        data: {
          queueId: input.queueId,
          provider: input.provider,
          deviceId: input.deviceId ?? null,
          status: input.status,
          deliveredAt: input.status === 'sent' ? new Date() : null,
          error: input.error ?? null,
        },
      });
    },

    async createAuditLog(log) {
      await prisma.auditLog.create({
        data: {
          schoolId: log.schoolId,
          actorId: log.actorId,
          actorType: log.actorType,
          action: log.action,
          entity: log.entity,
          entityId: log.entityId ?? null,
          details: log.details ?? {},
        },
      });
    },

    async getDeviceByDeviceId(deviceId) {
      const d = await prisma.smsDevice.findUnique({ where: { deviceId: deviceId } });
      return d ? mapDeviceRow(d) : null;
    },

    async upsertDevice(input) {
      // device_id is globally UNIQUE: without this check, school B could
      // re-register school A's device_id and steal it (the upsert would
      // silently reassign the row to B's schoolId, cutting A off).
      const existing = await prisma.smsDevice.findUnique({ where: { deviceId: input.deviceId } });
      if (existing && existing.schoolId !== input.schoolId) {
        throw conflictError('device_id is already registered to another school');
      }
      const d = await prisma.smsDevice.upsert({
        where: { deviceId: input.deviceId },
        update: { name: input.name, schoolId: input.schoolId },
        create: { schoolId: input.schoolId, deviceId: input.deviceId, name: input.name },
      });
      return mapDeviceRow(d);
    },

    async touchDevice(deviceId) {
      await prisma.smsDevice.update({
        where: { deviceId: deviceId },
        data: { lastSeenAt: new Date(), status: 'online' },
      });
    },

    async getDevicesStatus(schoolId) {
      const devices: any[] = await prisma.smsDevice.findMany({ where: { schoolId: schoolId } });
      const now = Date.now();
      const onlineCount = devices.filter(
        (d: any) => d.lastSeenAt && now - new Date(d.lastSeenAt).getTime() <= 90_000,
      ).length;
      let lastSeenAt: Date | null = null;
      for (const d of devices) {
        if (!d.lastSeenAt) continue;
        const t = new Date(d.lastSeenAt);
        if (!lastSeenAt || t > lastSeenAt) lastSeenAt = t;
      }
      return { lastSeenAt, onlineCount };
    },

    async countQueued(schoolId) {
      const [queued, pendingApproval] = await Promise.all([
        prisma.messageQueue.count({ where: { schoolId: schoolId, status: 'queued' } }),
        prisma.messageQueue.count({
          where: { schoolId: schoolId, status: 'queued', approvedAt: null },
        }),
      ]);
      return { queued, pendingApproval };
    },
  };
}
