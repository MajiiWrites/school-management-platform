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
  page: number;
  limit: number;
}

export interface MessagingStore {
  getSchool(schoolId: string): Promise<SchoolInfo | null>;
  /** Minimal student lookup (id + name) for the pending-approval list. */
  getStudentsByIds(ids: string[]): Promise<Array<{ id: string; name: string }>>;
  isHoliday(schoolId: string, date: string): Promise<boolean>;
  getActiveTemplate(
    schoolId: string,
    type: TemplateType,
    language: TemplateLanguage,
  ): Promise<TemplateRow | null>;
  listTemplates(schoolId: string): Promise<TemplateRow[]>;
  getTemplateById(id: string): Promise<TemplateRow | null>;
  updateTemplate(
    id: string,
    patch: { body?: string; isActive?: boolean },
  ): Promise<TemplateRow>;

  findQueueByDedupeKey(dedupeKey: string): Promise<QueueRow | null>;
  /** Insert a queue row. On unique-dedupe-key conflict, returns the existing row. */
  createQueue(row: NewQueueRow): Promise<{ row: QueueRow; created: boolean }>;
  listPendingApproval(schoolId: string): Promise<QueueRow[]>;
  listDueApproved(schoolId: string, limit: number): Promise<QueueRow[]>;
  listQueue(
    schoolId: string,
    filters: QueueFilters,
  ): Promise<{ items: QueueRow[]; total: number }>;
  getQueueById(id: string): Promise<QueueRow | null>;
  updateQueue(id: string, patch: Partial<QueueRow>): Promise<QueueRow>;
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

    async getStudentsByIds(ids) {
      const rows = await prisma.student.findMany({
        where: { id: { in: ids } },
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

    async getTemplateById(id) {
      const t = await prisma.messageTemplate.findUnique({ where: { id } });
      return t ? mapTemplateRow(t) : null;
    },

    async updateTemplate(id, patch) {
      const data: any = {};
      if (patch.body !== undefined) data.body = patch.body;
      if (patch.isActive !== undefined) data.isActive = patch.isActive;
      const t = await prisma.messageTemplate.update({ where: { id }, data });
      return mapTemplateRow(t);
    },

    async findQueueByDedupeKey(dedupeKey) {
      const r = await prisma.messageQueue.findUnique({ where: { dedupeKey: dedupeKey } });
      return r ? mapQueueRow(r) : null;
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
          const existing = await this.findQueueByDedupeKey(row.dedupeKey);
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

    async getQueueById(id) {
      const r = await prisma.messageQueue.findUnique({ where: { id } });
      return r ? mapQueueRow(r) : null;
    },

    async updateQueue(id, patch) {
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
