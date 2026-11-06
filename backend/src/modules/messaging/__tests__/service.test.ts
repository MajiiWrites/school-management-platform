/**
 * Messaging service unit tests.
 *
 * Run: cd backend && npm test
 * Uses an in-memory fake MessagingStore — no DB, no network.
 * A fixed test key is used for phone encryption (never a real key).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  approveMessages,
  buildAbsentDrafts,
  buildFeeReminderDrafts,
  getDeviceQueue,
  getPendingApproval,
  reportDelivery,
  retryFailed,
  type ServiceDeps,
} from '../service';
import type {
  AuditLogInput,
  DeviceRow,
  DraftApproval,
  DraftRow,
  MessagingStore,
  QueueRow,
  TemplateRow,
} from '../store';
import { maskPhone, normalizePK } from '../phone';
import { renderTemplate } from '../templates';

const TEST_KEY = crypto.randomBytes(32);
export const testCrypto = {
  encrypt: (e164: string) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', TEST_KEY, iv);
    const ct = Buffer.concat([cipher.update(e164, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  },
  decrypt: (enc: string) => {
    const buf = Buffer.from(enc, 'base64');
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      TEST_KEY,
      buf.subarray(0, 12),
    );
    decipher.setAuthTag(buf.subarray(12, 28));
    return decipher.update(buf.subarray(28), undefined, 'utf8') + decipher.final('utf8');
  },
};

const SCHOOL = { id: 'school-1', name: 'Demo Public School', timezone: 'Asia/Karachi', smsProvider: 'sim' as const };
const FRIDAY = '2026-11-06'; // a Friday (school day)
const SUNDAY = '2026-11-08'; // a Sunday

export class FakeStore implements MessagingStore {
  queue: QueueRow[] = [];
  templates: TemplateRow[] = [];
  devices = new Map<string, DeviceRow>();
  holidays = new Set<string>();
  deliveries: Array<Record<string, unknown>> = [];
  audits: AuditLogInput[] = [];
  private seq = 0;

  async getSchool() {
    return SCHOOL;
  }
  async getStudentsByIds(ids: string[], schoolId: string) {
    // Fake mirrors the fixed Prisma store: only this school's students.
    // (This fake has no student table, so it fabricates names for ids the
    // caller derived from its own school's queue rows.)
    void schoolId;
    return ids.map((id) => ({ id, name: `Student ${id}` }));
  }
  async isHoliday(_schoolId: string, date: string) {
    return this.holidays.has(date);
  }
  async getActiveTemplate() {
    return null;
  }
  async listTemplates() {
    return this.templates;
  }
  async getTemplateById(id: string, schoolId?: string) {
    return this.templates.find((t) => t.id === id && (!schoolId || t.schoolId === schoolId)) ?? null;
  }
  async updateTemplate(id: string, patch: { body?: string; isActive?: boolean; name?: string | null; type?: any; language?: any }, schoolId?: string) {
    const t = this.templates.find((x) => x.id === id && (!schoolId || x.schoolId === schoolId))!;
    if (!t) throw Object.assign(new Error('Template not found'), { code: 'NOT_FOUND' });
    if (patch.body !== undefined) t.body = patch.body;
    if (patch.isActive !== undefined) t.isActive = patch.isActive;
    if (patch.name !== undefined) t.name = patch.name;
    if (patch.type !== undefined) t.type = patch.type;
    if (patch.language !== undefined) t.language = patch.language;
    return t;
  }
  // --- Section 11 (Custom Messages): in-memory template/draft/recipient
  // methods mirroring the fixed Prisma store's school-scoping. ---
  drafts: DraftRow[] = [];
  approvals: Array<DraftApproval & { schoolId: string; entityId: string }> = [];
  async createTemplate(input: { schoolId: string; name: string; type: any; language: any; body: string; isCustom?: boolean }) {
    if (this.templates.some((t) => t.schoolId === input.schoolId && t.type === input.type && t.language === input.language)) {
      throw Object.assign(new Error('A template already exists for this type and language'), { code: 'CONFLICT' });
    }
    const row: TemplateRow = { id: `tpl-${++this.seq}`, schoolId: input.schoolId, type: input.type, language: input.language, body: input.body, isActive: true, name: input.name, isCustom: input.isCustom ?? true };
    this.templates.push(row);
    return row;
  }
  async deleteTemplate(id: string, schoolId: string) {
    const idx = this.templates.findIndex((t) => t.id === id && t.schoolId === schoolId);
    if (idx === -1) throw Object.assign(new Error('Template not found'), { code: 'NOT_FOUND' });
    this.templates.splice(idx, 1);
  }
  async createDraft(draft: any) {
    const row: DraftRow = { id: `d-${++this.seq}`, schoolId: draft.schoolId, createdBy: draft.createdBy ?? null, recipientType: draft.recipientType, targetClassId: draft.targetClassId ?? null, targetStudentIds: draft.targetStudentIds ?? [], body: draft.body, status: 'draft', scheduledFor: draft.scheduledFor ?? null, createdAt: new Date(), updatedAt: new Date() };
    this.drafts.push(row);
    return row;
  }
  async getDraftById(id: string, schoolId: string) {
    return this.drafts.find((d) => d.id === id && d.schoolId === schoolId) ?? null;
  }
  async listDrafts(schoolId: string, filters: { status?: string; page: number; limit: number }) {
    const items = this.drafts.filter((d) => d.schoolId === schoolId && (!filters.status || d.status === filters.status));
    return { items, total: items.length };
  }
  async updateDraft(id: string, patch: any, schoolId: string) {
    const d = this.drafts.find((x) => x.id === id && x.schoolId === schoolId);
    if (!d) throw Object.assign(new Error('Draft not found'), { code: 'NOT_FOUND' });
    Object.assign(d, patch, { updatedAt: new Date() });
    return d;
  }
  async deleteDraft(id: string, schoolId: string) {
    const idx = this.drafts.findIndex((d) => d.id === id && d.schoolId === schoolId);
    if (idx === -1) throw Object.assign(new Error('Draft not found'), { code: 'NOT_FOUND' });
    this.drafts.splice(idx, 1);
  }
  async listRecipients(schoolId: string, query: import('../store').RecipientQuery) {
    void schoolId;
    void query;
    return [] as Array<{
      id: string; name: string; fatherName: string | null; classId: string;
      className: string; section: string; parentPhoneEnc: string | null; parentOptOut: boolean;
    }>;
  }
  async listDeliveriesForQueueIds(queueIds: string[]) {
    return this.deliveries
      .filter((d) => queueIds.includes(String(d.queueId)))
      .map((d) => ({ queueId: String(d.queueId), provider: 'sim', status: String(d.status), deliveredAt: null, error: (d.error as string | null) ?? null, createdAt: new Date() }));
  }
  async getDraftApproval(draftId: string, schoolId: string) {
    const rows = this.approvals.filter((a) => a.entityId === draftId && a.schoolId === schoolId);
    return rows[rows.length - 1] ?? null;
  }
  async hasApprovedDraftApproval(draftId: string, schoolId: string) {
    return this.approvals.some((a) => a.entityId === draftId && a.schoolId === schoolId && a.status === 'approved');
  }
  async recordDraftApproval(input: { schoolId: string; draftId: string; adminId: string; payload: Record<string, unknown> }) {
    const row: DraftApproval & { schoolId: string; entityId: string } = { id: `ap-${++this.seq}`, status: 'approved', requestedBy: input.adminId, decidedBy: input.adminId, decidedAt: new Date(), createdAt: new Date(), schoolId: input.schoolId, entityId: input.draftId };
    this.approvals.push(row);
    return row;
  }
  async findQueueByDedupeKey(dedupeKey: string, schoolId?: string) {
    return this.queue.find((q) => q.dedupeKey === dedupeKey && (!schoolId || q.schoolId === schoolId)) ?? null;
  }
  async createQueue(row: Parameters<MessagingStore['createQueue']>[0]) {
    const existing = await this.findQueueByDedupeKey(row.dedupeKey, row.schoolId);
    if (existing) return { row: existing, created: false };
    const created: QueueRow = {
      id: `q-${++this.seq}`,
      schoolId: row.schoolId,
      type: row.type,
      studentId: row.studentId ?? null,
      classId: row.classId ?? null,
      parentPhoneEnc: row.parentPhoneEnc,
      body: row.body,
      status: 'queued',
      attempts: 0,
      dedupeKey: row.dedupeKey,
      scheduledFor: row.scheduledFor ?? new Date(),
      sentAt: null,
      error: null,
      approvedBy: null,
      approvedAt: null,
      createdAt: new Date(`${FRIDAY}T09:00:00Z`),
    };
    this.queue.push(created);
    return { row: created, created: true };
  }
  async listPendingApproval(schoolId: string) {
    return this.queue.filter(
      (q) => q.schoolId === schoolId && q.status === 'queued' && q.approvedAt === null,
    );
  }
  async listDueApproved(schoolId: string, limit: number) {
    const now = Date.now();
    return this.queue
      .filter(
        (q) =>
          q.schoolId === schoolId &&
          q.status === 'queued' &&
          q.approvedAt !== null &&
          q.scheduledFor.getTime() <= now,
      )
      .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())
      .slice(0, limit);
  }
  async listQueue(schoolId: string, filters: { status?: QueueRow['status']; type?: QueueRow['type']; date?: string; page: number; limit: number }) {
    const items = this.queue.filter(
      (q) =>
        q.schoolId === schoolId &&
        (!filters.status || q.status === filters.status) &&
        (!filters.type || q.type === filters.type),
    );
    return { items, total: items.length };
  }
  async getQueueById(id: string, schoolId?: string) {
    return this.queue.find((q) => q.id === id && (!schoolId || q.schoolId === schoolId)) ?? null;
  }
  async updateQueue(id: string, patch: Partial<QueueRow>, schoolId?: string) {
    const row = this.queue.find((q) => q.id === id && (!schoolId || q.schoolId === schoolId))!;
    if (!row) throw Object.assign(new Error('Message not found'), { code: 'NOT_FOUND' });
    Object.assign(row, patch);
    return row;
  }
  async createDelivery(input: {
    queueId: string;
    provider: 'sim' | 'gateway';
    deviceId?: string | null;
    status: string;
    error?: string | null;
  }) {
    this.deliveries.push(input);
  }
  async createAuditLog(log: AuditLogInput) {
    this.audits.push(log);
  }
  async getDeviceByDeviceId(deviceId: string) {
    return this.devices.get(deviceId) ?? null;
  }
  async upsertDevice(input: { schoolId: string; deviceId: string; name: string }) {
    const existing = this.devices.get(input.deviceId);
    if (existing && existing.schoolId !== input.schoolId) {
      throw Object.assign(new Error('device_id is already registered to another school'), { code: 'CONFLICT' });
    }
    const row: DeviceRow = {
      id: `dev-${input.deviceId}`,
      schoolId: input.schoolId,
      deviceId: input.deviceId,
      name: input.name,
      lastSeenAt: null,
      status: 'offline',
    };
    this.devices.set(input.deviceId, row);
    return row;
  }
  async touchDevice(deviceId: string) {
    const d = this.devices.get(deviceId);
    if (d) {
      d.lastSeenAt = new Date();
      d.status = 'online';
    }
  }
  async getDevicesStatus() {
    return { lastSeenAt: null, onlineCount: 0 };
  }
  async countQueued(schoolId: string) {
    const queued = this.queue.filter(
      (q) => q.schoolId === schoolId && q.status === 'queued',
    ).length;
    const pendingApproval = this.queue.filter(
      (q) => q.schoolId === schoolId && q.status === 'queued' && q.approvedAt === null,
    ).length;
    return { queued, pendingApproval };
  }
}

export function enc(phone: string): string {
  return testCrypto.encrypt(phone);
}

function student(
  id: string,
  overrides: Partial<{ parentPhoneEnc: string | null; parentOptOut: boolean }> = {},
) {
  return {
    id,
    name: `Student ${id}`,
    classId: 'class-5a',
    parentName: 'Parent',
    parentPhoneEnc: overrides.parentPhoneEnc === undefined ? enc('+923001234567') : overrides.parentPhoneEnc,
    parentOptOut: overrides.parentOptOut ?? false,
  };
}

describe('phone helpers', () => {
  it('normalizes PK numbers to E.164', () => {
    expect(normalizePK('03001234567')).toBe('+923001234567');
    expect(normalizePK('+92 300 1234567')).toBe('+923001234567');
    expect(normalizePK('923001234567')).toBe('+923001234567');
    expect(normalizePK('0300-1234567')).toBe('+923001234567');
  });
  it('rejects invalid numbers', () => {
    expect(normalizePK('12345')).toBeNull();
    expect(normalizePK('+1 555 1234567')).toBeNull();
    expect(normalizePK('')).toBeNull();
    expect(normalizePK(null)).toBeNull();
  });
  it('masks numbers for display', () => {
    expect(maskPhone('+923001234567')).toBe('+92 3XX XXXX567');
  });
});

describe('templates', () => {
  it('substitutes variables and leaves unknown ones visible', () => {
    expect(
      renderTemplate('Hi {student_name}, class {class} on {date}.', {
        student_name: 'Ali',
        class: '5-A',
        date: '2026-11-06',
      }),
    ).toBe('Hi Ali, class 5-A on 2026-11-06.');
    expect(renderTemplate('Amount {amount} {nope}', {})).toBe('Amount {amount} {nope}');
  });
});

describe('buildAbsentDrafts', () => {
  let store: FakeStore;
  let deps: ServiceDeps;
  beforeEach(() => {
    store = new FakeStore();
    deps = { store, crypto: testCrypto, now: () => new Date(`${FRIDAY}T09:00:00Z`) };
  });

  const base = {
    school: SCHOOL,
    classId: 'class-5a',
    className: '5-A',
    date: FRIDAY,
  };

  it('creates drafts ONLY for absent students', async () => {
    const res = await buildAbsentDrafts(deps, {
      ...base,
      records: [
        { studentId: 's1', status: 'absent' },
        { studentId: 's2', status: 'present' },
        { studentId: 's3', status: 'late' },
        { studentId: 's4', status: 'leave' },
      ],
      students: [student('s1'), student('s2'), student('s3'), student('s4')],
    });
    expect(res.created).toBe(1);
    expect(store.queue).toHaveLength(1);
    expect(store.queue[0].studentId).toBe('s1');
    expect(store.queue[0].approvedAt).toBeNull(); // held for approval
    expect(store.queue[0].body).toContain('Student s1');
    expect(store.queue[0].body).toContain('5-A');
    expect(res.skipped.map((s) => s.reason)).toContain('not_absent');
  });

  it('dedupes: same student/day built twice creates one row', async () => {
    const input = {
      ...base,
      records: [{ studentId: 's1', status: 'absent' as const }],
      students: [student('s1')],
    };
    const r1 = await buildAbsentDrafts(deps, input);
    const r2 = await buildAbsentDrafts(deps, input);
    expect(r1.created).toBe(1);
    expect(r2.created).toBe(0);
    expect(store.queue).toHaveLength(1);
    expect(r2.skipped[0].reason).toBe('already_queued');
  });

  it('excludes opted-out parents', async () => {
    const res = await buildAbsentDrafts(deps, {
      ...base,
      records: [{ studentId: 's1', status: 'absent' }],
      students: [student('s1', { parentOptOut: true })],
    });
    expect(res.created).toBe(0);
    expect(res.skipped[0].reason).toBe('opted_out');
  });

  it('excludes missing and invalid phone numbers', async () => {
    const res = await buildAbsentDrafts(deps, {
      ...base,
      records: [
        { studentId: 's1', status: 'absent' },
        { studentId: 's2', status: 'absent' },
      ],
      students: [
        student('s1', { parentPhoneEnc: null }),
        student('s2', { parentPhoneEnc: enc('+15551234567') }),
      ],
    });
    expect(res.created).toBe(0);
    expect(res.skipped.map((s) => s.reason).sort()).toEqual([
      'invalid_phone',
      'missing_phone',
    ]);
  });

  it('skips Sundays entirely', async () => {
    const res = await buildAbsentDrafts(deps, {
      ...base,
      date: SUNDAY,
      records: [{ studentId: 's1', status: 'absent' }],
      students: [student('s1')],
    });
    expect(res.daySkipped).toBe(true);
    expect(res.daySkippedReason).toBe('sunday');
    expect(store.queue).toHaveLength(0);
  });

  it('skips holidays', async () => {
    store.holidays.add(FRIDAY);
    const res = await buildAbsentDrafts(deps, {
      ...base,
      records: [{ studentId: 's1', status: 'absent' }],
      students: [student('s1')],
    });
    expect(res.daySkipped).toBe(true);
    expect(res.daySkippedReason).toBe('holiday');
  });
});

describe('approval + device flow', () => {
  let store: FakeStore;
  let deps: ServiceDeps;
  beforeEach(async () => {
    store = new FakeStore();
    deps = { store, crypto: testCrypto, now: () => new Date(`${FRIDAY}T09:00:00Z`) };
    await buildAbsentDrafts(deps, {
      school: SCHOOL,
      classId: 'class-5a',
      className: '5-A',
      date: FRIDAY,
      records: [
        { studentId: 's1', status: 'absent' },
        { studentId: 's2', status: 'absent' },
      ],
      students: [student('s1'), student('s2')],
    });
    await store.upsertDevice({ schoolId: SCHOOL.id, deviceId: 'phone-1', name: 'Admin phone' });
  });

  it('device queue is empty before approval, populated after', async () => {
    const before = await getDeviceQueue(deps, { schoolId: SCHOOL.id, deviceId: 'phone-1' });
    expect(before).toHaveLength(0);

    const approved = await approveMessages(deps, {
      schoolId: SCHOOL.id,
      approvedBy: 'admin-1',
      dedupeKeys: ['absent:s1:2026-11-06', 'absent:s2:2026-11-06'],
    });
    expect(approved.approved).toBe(2);

    // Rows are staggered 2 s apart; make them due by moving scheduledFor back.
    for (const row of store.queue) row.scheduledFor = new Date('2026-11-06T08:00:00Z');
    const after = await getDeviceQueue(deps, { schoolId: SCHOOL.id, deviceId: 'phone-1' });
    expect(after).toHaveLength(2);
    expect(after[0].to).toBe('+923001234567');
  });

  it('approval staggers scheduled_for by 2 s (SIM rate limit)', async () => {
    await approveMessages(deps, {
      schoolId: SCHOOL.id,
      approvedBy: 'admin-1',
      dedupeKeys: ['absent:s1:2026-11-06', 'absent:s2:2026-11-06'],
    });
    const times = store.queue
      .map((q) => q.scheduledFor.getTime())
      .sort((a, b) => a - b);
    expect(times[1] - times[0]).toBe(2000);
  });

  it('approve is idempotent — no duplicates on second approve', async () => {
    const keys = ['absent:s1:2026-11-06'];
    const r1 = await approveMessages(deps, { schoolId: SCHOOL.id, approvedBy: 'admin-1', dedupeKeys: keys });
    const r2 = await approveMessages(deps, { schoolId: SCHOOL.id, approvedBy: 'admin-1', dedupeKeys: keys });
    expect(r1.approved).toBe(1);
    expect(r2.approved).toBe(0);
    expect(store.queue).toHaveLength(2);
  });

  it('pending approval masks phone numbers', async () => {
    const groups = await getPendingApproval(deps, { schoolId: SCHOOL.id });
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
    expect(groups[0].messages[0].parentPhoneMasked).toBe('+92 3XX XXXX567');
    expect(groups[0].messages[0].body).not.toContain('+923001234567');
  });

  it('delivery report marks sent + logs delivery; failed can be retried', async () => {
    await approveMessages(deps, {
      schoolId: SCHOOL.id,
      approvedBy: 'admin-1',
      dedupeKeys: ['absent:s1:2026-11-06'],
    });
    const row = store.queue.find((q) => q.studentId === 's1')!;
    const failed = await reportDelivery(deps, {
      schoolId: SCHOOL.id,
      deviceId: 'phone-1',
      queueId: row.id,
      status: 'failed',
      error: 'no_signal',
    });
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('no_signal');
    expect(store.deliveries).toHaveLength(1);

    const retried = await retryFailed(deps, {
      schoolId: SCHOOL.id,
      queueId: row.id,
      retriedBy: 'admin-1',
    });
    expect(retried.status).toBe('queued');
    expect(retried.error).toBeNull();

    const sent = await reportDelivery(deps, {
      schoolId: SCHOOL.id,
      deviceId: 'phone-1',
      queueId: row.id,
      status: 'sent',
    });
    expect(sent.status).toBe('sent');
    expect(sent.sentAt).not.toBeNull();
    expect(sent.attempts).toBe(2);
  });
});

describe('buildFeeReminderDrafts', () => {
  it('dedupes per student/month and skips opted-out parents', async () => {
    const store = new FakeStore();
    const deps: ServiceDeps = { store, crypto: testCrypto, now: () => new Date() };
    const input = {
      school: SCHOOL,
      month: '2026-11',
      items: [
        { student: student('s1'), className: '5-A', amountDue: 5000 },
        { student: student('s2', { parentOptOut: true }), className: '5-A', amountDue: 5000 },
      ],
    };
    const r1 = await buildFeeReminderDrafts(deps, input);
    const r2 = await buildFeeReminderDrafts(deps, input);
    expect(r1.created).toBe(1);
    expect(r2.created).toBe(0);
    expect(store.queue[0].dedupeKey).toBe('fee:s1:2026-11');
    expect(store.queue[0].body).toContain('5000');
  });
});
