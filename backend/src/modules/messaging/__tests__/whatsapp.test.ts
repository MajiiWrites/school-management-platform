/**
 * Messaging Center tests (2026-11-20): WhatsApp links, honest "opened"
 * recording, one-channel rule (SIM never picks up a WhatsApp row), the
 * email channel, and the parent-portal inbox.
 *
 * Run: cd backend && npm test
 * In-memory fakes only — no DB, no network, no real mail.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { waLink, toWaNumber } from '../whatsapp';
import {
  approveMessages,
  getDeviceQueue,
  prepareWhatsAppLinks,
  recordWhatsAppOpened,
  sendQueueRowByEmail,
  type ServiceDeps,
} from '../service';
import { getPortalInbox } from '../portal-inbox';
import { FakeStore, testCrypto, enc } from './service.test';
import { hashToken } from '../../../lib/crypto';

const SCHOOL_ID = 'school-1';
const FRIDAY = '2026-11-06';
const SUNDAY = '2026-11-08';

function deps(store: FakeStore): ServiceDeps {
  return { store, crypto: testCrypto };
}

async function seedHeldRow(
  store: FakeStore,
  opts: { studentId?: string; date?: string; phone?: string; body?: string } = {},
) {
  const studentId = opts.studentId ?? 'stu-1';
  const date = opts.date ?? FRIDAY;
  const { row } = await store.createQueue({
    schoolId: SCHOOL_ID,
    type: 'absent',
    studentId,
    classId: 'class-1',
    parentPhoneEnc: enc(opts.phone ?? '+923001234567'),
    body: opts.body ?? 'Dear Parent, Ayesha Khan was absent today.',
    dedupeKey: `absent:${studentId}:${date}`,
    scheduledFor: new Date(`${date}T09:00:00Z`),
  });
  return row;
}

describe('wa.me links', () => {
  it('builds a wa.me link from an E.164 number', () => {
    expect(waLink('+923001234567', 'Hello parent')).toBe(
      'https://wa.me/923001234567?text=Hello%20parent',
    );
  });

  it('normalizes a local 03xx number to 92…', () => {
    expect(toWaNumber('03001234567')).toBe('923001234567');
  });

  it('URL-encodes Urdu text intact', () => {
    const url = waLink('+923001234567', 'عائشہ آج غیر حاضر تھی');
    expect(url).toContain('https://wa.me/923001234567?text=');
    expect(decodeURIComponent(url!.split('text=')[1])).toBe('عائشہ آج غیر حاضر تھی');
  });

  it('returns null for an invalid phone or an empty body', () => {
    expect(waLink('0301-123', 'hi')).toBeNull();
    expect(waLink('+923001234567', '   ')).toBeNull();
    expect(waLink(null, 'hi')).toBeNull();
  });
});

describe('prepareWhatsAppLinks (Approve & WhatsApp, one tap)', () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
  });

  it('approves held drafts and returns wa.me links', async () => {
    const row = await seedHeldRow(store);
    const res = await prepareWhatsAppLinks(deps(store), {
      schoolId: SCHOOL_ID,
      approvedBy: 'admin-1',
      groupId: `class-1:${FRIDAY}:absent`,
    });
    expect(res.approved).toBe(1);
    expect(res.cancelled).toBe(0);
    expect(res.links).toHaveLength(1);
    expect(res.links[0].queueId).toBe(row.id);
    expect(res.links[0].waUrl).toBe(
      'https://wa.me/923001234567?text=Dear%20Parent%2C%20Ayesha%20Khan%20was%20absent%20today.',
    );
    expect(res.links[0].parentPhoneMasked).toBe('+92 3XX XXXX567');
    // A pending WhatsApp delivery row marks the channel — the SIM must
    // never pick this row up afterwards.
    expect(store.deliveries).toContainEqual(
      expect.objectContaining({ queueId: row.id, provider: 'whatsapp', status: 'pending' }),
    );
    const after = await store.getQueueById(row.id, SCHOOL_ID);
    expect(after?.approvedAt).not.toBeNull();
  });

  it('cancels a Sunday group instead of linking it', async () => {
    await seedHeldRow(store, { date: SUNDAY });
    const res = await prepareWhatsAppLinks(deps(store), {
      schoolId: SCHOOL_ID,
      approvedBy: 'admin-1',
      groupId: `class-1:${SUNDAY}:absent`,
    });
    expect(res.approved).toBe(0);
    expect(res.cancelled).toBe(1);
    expect(res.links).toHaveLength(0);
  });

  it('refuses a still-held row passed by queue id (approval must go through review)', async () => {
    const row = await seedHeldRow(store);
    await expect(
      prepareWhatsAppLinks(deps(store), {
        schoolId: SCHOOL_ID,
        approvedBy: 'admin-1',
        queueIds: [row.id],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('links an already-approved row without re-approving', async () => {
    const row = await seedHeldRow(store);
    await approveMessages(deps(store), {
      schoolId: SCHOOL_ID,
      approvedBy: 'admin-1',
      dedupeKeys: [row.dedupeKey],
    });
    const res = await prepareWhatsAppLinks(deps(store), {
      schoolId: SCHOOL_ID,
      approvedBy: 'admin-1',
      queueIds: [row.id],
    });
    expect(res.approved).toBe(0);
    expect(res.alreadyApproved).toBe(1);
    expect(res.links).toHaveLength(1);
  });

  it('skips a row whose number became undecryptable instead of linking it', async () => {
    const { row } = await store.createQueue({
      schoolId: SCHOOL_ID,
      type: 'absent',
      studentId: 'stu-1',
      classId: 'class-1',
      parentPhoneEnc: 'not-valid-base64!!!',
      body: 'Absent today.',
      dedupeKey: `absent:stu-1:${FRIDAY}`,
      scheduledFor: new Date(`${FRIDAY}T09:00:00Z`),
    });
    void row;
    const res = await prepareWhatsAppLinks(deps(store), {
      schoolId: SCHOOL_ID,
      approvedBy: 'admin-1',
      groupId: `class-1:${FRIDAY}:absent`,
    });
    expect(res.links).toHaveLength(0);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0].reason).toBe('invalid_phone');
  });
});

describe('recordWhatsAppOpened — honest, never "delivered"', () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
  });

  it('marks the row handed off and records delivery status opened', async () => {
    const row = await seedHeldRow(store);
    await prepareWhatsAppLinks(deps(store), {
      schoolId: SCHOOL_ID,
      approvedBy: 'admin-1',
      groupId: `class-1:${FRIDAY}:absent`,
    });
    const updated = await recordWhatsAppOpened(deps(store), {
      schoolId: SCHOOL_ID,
      queueId: row.id,
      openedBy: 'admin-1',
    });
    expect(updated.status).toBe('sent');
    const deliveries = await store.listDeliveriesForQueueIds([row.id], SCHOOL_ID);
    expect(deliveries.some((d) => d.provider === 'whatsapp' && d.status === 'opened')).toBe(true);
    // Never recorded as delivered.
    expect(deliveries.some((d) => d.status === 'delivered')).toBe(false);
  });

  it('is idempotent — opening the same link twice records once', async () => {
    const row = await seedHeldRow(store);
    await prepareWhatsAppLinks(deps(store), {
      schoolId: SCHOOL_ID,
      approvedBy: 'admin-1',
      groupId: `class-1:${FRIDAY}:absent`,
    });
    await recordWhatsAppOpened(deps(store), { schoolId: SCHOOL_ID, queueId: row.id, openedBy: 'admin-1' });
    await recordWhatsAppOpened(deps(store), { schoolId: SCHOOL_ID, queueId: row.id, openedBy: 'admin-1' });
    const deliveries = await store.listDeliveriesForQueueIds([row.id], SCHOOL_ID);
    expect(deliveries.filter((d) => d.provider === 'whatsapp' && d.status === 'opened')).toHaveLength(1);
  });
});

describe('one channel per message — SIM never picks up a WhatsApp row', () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
  });

  it('excludes WhatsApp rows from the device queue but keeps SIM rows', async () => {
    await store.upsertDevice({ schoolId: SCHOOL_ID, deviceId: 'dev-1', name: 'Admin phone' });
    const waRow = await seedHeldRow(store, { studentId: 'stu-1' });
    const simRow = await seedHeldRow(store, { studentId: 'stu-2', phone: '+923001234568' });
    await prepareWhatsAppLinks(deps(store), {
      schoolId: SCHOOL_ID,
      approvedBy: 'admin-1',
      dedupeKeys: [waRow.dedupeKey],
    });
    await approveMessages(deps(store), {
      schoolId: SCHOOL_ID,
      approvedBy: 'admin-1',
      dedupeKeys: [simRow.dedupeKey],
    });
    const due = await getDeviceQueue(deps(store), { schoolId: SCHOOL_ID, deviceId: 'dev-1' });
    expect(due.map((d) => d.queueId)).toEqual([simRow.id]);
  });
});

describe('email channel (existing mail service, honest failure)', () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
  });

  it('sends via the injected mailer and records provider email / sent', async () => {
    const row = await seedHeldRow(store);
    const sent: Array<{ to: string; subject: string; text: string }> = [];
    const res = await sendQueueRowByEmail(
      deps(store),
      { schoolId: SCHOOL_ID, queueId: row.id, to: 'parent@example.com', sentBy: 'admin-1' },
      async (opts) => {
        sent.push(opts);
      },
    );
    expect(res).toEqual({ sent: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('parent@example.com');
    expect(sent[0].text).toBe(row.body);
    const after = await store.getQueueById(row.id, SCHOOL_ID);
    expect(after?.status).toBe('sent');
    const deliveries = await store.listDeliveriesForQueueIds([row.id], SCHOOL_ID);
    expect(deliveries).toContainEqual(
      expect.objectContaining({ provider: 'email', status: 'sent' }),
    );
  });

  it('records a failed send honestly — row stays queued with the error', async () => {
    const row = await seedHeldRow(store);
    const res = await sendQueueRowByEmail(
      deps(store),
      { schoolId: SCHOOL_ID, queueId: row.id, to: 'parent@example.com', sentBy: 'admin-1' },
      async () => {
        throw new Error('Connection timeout');
      },
    );
    expect(res.sent).toBe(false);
    expect(res.error).toBe('Connection timeout');
    const after = await store.getQueueById(row.id, SCHOOL_ID);
    expect(after?.status).toBe('queued');
    expect(after?.error).toBe('Connection timeout');
    const deliveries = await store.listDeliveriesForQueueIds([row.id], SCHOOL_ID);
    expect(deliveries).toContainEqual(
      expect.objectContaining({ provider: 'email', status: 'failed' }),
    );
  });

  it('rejects a bad email address and an already-sent row', async () => {
    const row = await seedHeldRow(store);
    await expect(
      sendQueueRowByEmail(
        deps(store),
        { schoolId: SCHOOL_ID, queueId: row.id, to: 'not-an-email', sentBy: 'admin-1' },
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    await store.updateQueue(row.id, { status: 'sent' }, SCHOOL_ID);
    await expect(
      sendQueueRowByEmail(
        deps(store),
        { schoolId: SCHOOL_ID, queueId: row.id, to: 'parent@example.com', sentBy: 'admin-1' },
        async () => {},
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('parent-portal inbox', () => {
  const RAW_TOKEN = 'test-parent-token-1234567890abcdef';
  const OTHER_TOKEN = 'test-parent-token-other-1234567890';

  function fakeDb() {
    const schools: any[] = [
      { id: SCHOOL_ID, name: 'Test School', timezone: 'Asia/Karachi' },
      { id: 'school-2', name: 'Other School', timezone: 'Asia/Karachi' },
    ];
    const classes: any[] = [{ id: 'class-1', schoolId: SCHOOL_ID, name: '5', section: 'A' }];
    const students: any[] = [
      { id: 'stu-1', schoolId: SCHOOL_ID, classId: 'class-1', name: 'Ayesha Khan', deletedAt: null },
      { id: 'stu-2', schoolId: SCHOOL_ID, classId: 'class-1', name: 'Bilal Ahmed', deletedAt: null },
    ];
    const parentTokens: any[] = [
      { id: 'tok-1', schoolId: SCHOOL_ID, studentId: 'stu-1', tokenHash: hashToken(RAW_TOKEN), tokenEnc: 'enc', revoked: false, expiresAt: new Date(Date.now() + 86400000) },
      { id: 'tok-2', schoolId: SCHOOL_ID, studentId: 'stu-2', tokenHash: hashToken(OTHER_TOKEN), tokenEnc: 'enc', revoked: false, expiresAt: new Date(Date.now() + 86400000) },
    ];
    const messageQueue: any[] = [
      { id: 'q-1', schoolId: SCHOOL_ID, studentId: 'stu-1', classId: 'class-1', type: 'absent', body: 'Ayesha was absent.', status: 'sent', sentAt: new Date('2026-11-19T08:00:00Z'), createdAt: new Date('2026-11-19T08:00:00Z') },
      { id: 'q-2', schoolId: SCHOOL_ID, studentId: 'stu-1', classId: 'class-1', type: 'fee_reminder', body: 'Fee due Rs 2000.', status: 'queued', sentAt: null, createdAt: new Date('2026-11-19T09:00:00Z') },
      { id: 'q-3', schoolId: SCHOOL_ID, studentId: 'stu-2', classId: 'class-1', type: 'absent', body: 'Bilal was absent.', status: 'sent', sentAt: new Date('2026-11-19T08:30:00Z'), createdAt: new Date('2026-11-19T08:30:00Z') },
    ];
    const messageDeliveries: any[] = [
      { id: 'd-1', queueId: 'q-1', provider: 'whatsapp', status: 'opened', deliveredAt: null, createdAt: new Date('2026-11-19T08:05:00Z') },
      { id: 'd-2', queueId: 'q-3', provider: 'sim', status: 'sent', deliveredAt: new Date('2026-11-19T08:31:00Z'), createdAt: new Date('2026-11-19T08:31:00Z') },
    ];
    const announcements: any[] = [
      { id: 'a-1', schoolId: SCHOOL_ID, title: 'PTM Friday', body: 'Meeting at 10am.', targetType: 'all', targetClassId: null, status: 'approved', createdAt: new Date('2026-11-18T00:00:00Z') },
      { id: 'a-2', schoolId: SCHOOL_ID, title: 'Draft secret', body: 'not for parents', targetType: 'all', targetClassId: null, status: 'draft', createdAt: new Date('2026-11-18T00:00:00Z') },
    ];
    const norm = (v: any) => (v instanceof Date ? v.getTime() : v);
    const matches = (row: any, where: any): boolean =>
      Object.entries(where ?? {}).every(([k, v]) => {
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          if ('in' in (v as any)) return (v as any).in.map(norm).includes(norm(row[k]));
        }
        if (v === null) return row[k] == null;
        return norm(row[k]) === norm(v);
      });
    const take = (rows: any[], args: any) => {
      let out = rows.filter((r) => matches(r, args?.where));
      if (args?.orderBy) {
        const [spec] = Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy];
        const [key, dir] = Object.entries(spec)[0] as [string, string];
        out = [...out].sort((a, b) => (dir === 'desc' ? norm(b[key]) - norm(a[key]) : norm(a[key]) - norm(b[key])));
      }
      if (typeof args?.take === 'number') out = out.slice(0, args.take);
      return out;
    };
    return {
      parentToken: { findFirst: async (a: any) => parentTokens.find((r) => matches(r, a.where)) ?? null },
      student: { findFirst: async (a: any) => students.find((r) => matches(r, a.where)) ?? null },
      school: { findUnique: async (a: any) => schools.find((r) => r.id === a.where.id) ?? null },
      class: { findFirst: async (a: any) => classes.find((r) => matches(r, a.where)) ?? null },
      messageQueue: { findMany: async (a: any) => take(messageQueue, a) },
      messageDelivery: { findMany: async (a: any) => take(messageDeliveries, a) },
      announcement: { findMany: async (a: any) => take(announcements, a) },
      // No read marks seeded here — every item starts unread.
      parentMessageRead: { findMany: async () => [] },
    } as any;
  }

  it('shows only this student’s sent messages + approved announcements', async () => {
    const inbox = await getPortalInbox(fakeDb(), RAW_TOKEN);
    expect(inbox.student.name).toBe('Ayesha Khan');
    const bodies = inbox.messages.map((m) => m.body);
    expect(bodies).toContain('Ayesha was absent.');
    expect(bodies).toContain('Meeting at 10am.');
    // Not shown: the other student's message, the unsent fee draft, the draft announcement.
    expect(bodies).not.toContain('Bilal was absent.');
    expect(bodies).not.toContain('Fee due Rs 2000.');
    expect(bodies).not.toContain('not for parents');
    const absent = inbox.messages.find((m) => m.body === 'Ayesha was absent.');
    expect(absent?.channel).toBe('WhatsApp');
    expect(absent?.delivery_status).toBe('opened');
  });

  it('rejects an unknown token', async () => {
    await expect(getPortalInbox(fakeDb(), 'no-such-token')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
