/**
 * Announcement SMS hook — Phase 8 QA tests.
 *
 * POST /announcements/:id/send (was a 501 in 6C-2) now creates a Section 11
 * message draft for the announcement's audience and routes it through the
 * existing draft → approval → queue flow (approveDraftForSending, queue
 * type 'announcement'). No DB, no network: a minimal fake Db + fake
 * messaging deps for the service orchestration, plus one FakeStore
 * end-to-end check that queueType 'announcement' really lands queue rows
 * of type 'announcement' with dedupe `announcement:{draftId}:{studentId}`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  sendAnnouncementSms,
  type AnnouncementSmsDeps,
} from '../service';
import { approveDraftForSending } from '../../messaging/custom-messages';
import { FakeStore, enc, testCrypto } from '../../messaging/__tests__/service.test';

const SCHOOL_ID = 'school-1';
const OTHER_SCHOOL = 'school-2';
const ADMIN = 'admin-1';

interface Row {
  id: string;
  schoolId: string;
  title: string;
  body: string;
  targetType: 'all' | 'class';
  targetClassId: string | null;
  smsSend: boolean;
  status: 'draft' | 'approved' | 'sent';
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function mkRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'ann-1',
    schoolId: SCHOOL_ID,
    title: 'Parent-teacher meeting',
    body: 'Meeting on Friday at 10am. {school_name}',
    targetType: 'all',
    targetClassId: null,
    smsSend: true,
    status: 'approved',
    createdBy: ADMIN,
    createdAt: new Date('2026-11-06T09:00:00Z'),
    updatedAt: new Date('2026-11-06T09:00:00Z'),
    ...overrides,
  };
}

/** Minimal fake Db: only the delegates sendAnnouncementSms touches. */
function fakeDb(rows: Row[]) {
  const audits: any[] = [];
  const changeLogs: any[] = [];
  const db: any = {
    announcement: {
      findFirst: async ({ where }: any) =>
        rows.find((r) => r.id === where.id && r.schoolId === where.schoolId) ?? null,
      update: async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      },
    },
    class: {
      findFirst: async ({ where }: any) =>
        where.id === 'class-5a' && where.schoolId === SCHOOL_ID
          ? { id: 'class-5a', name: '5', section: 'A' }
          : null,
    },
    auditLog: { create: async ({ data }: any) => { audits.push(data); return data; } },
    changeLog: { create: async ({ data }: any) => { changeLogs.push(data); return data; } },
  };
  return { db, audits, changeLogs };
}

function fakeDeps(queued = 2, skipped: any[] = []): { deps: AnnouncementSmsDeps; calls: any } {
  const calls: any = { drafts: [], approvals: [] };
  const deps: AnnouncementSmsDeps = {
    createDraft: async (input) => {
      calls.drafts.push(input);
      return { id: 'draft-1' };
    },
    approveDraftForSending: async (input) => {
      calls.approvals.push(input);
      return { draftId: 'draft-1', queued, queueIds: ['q-1', 'q-2'].slice(0, queued), skipped, skippedOptedOut: skipped.filter((s) => s.reason === 'opted_out').length };
    },
  };
  return { deps, calls };
}

describe('announcement SMS hook (Phase 8)', () => {
  it('sends an approved sms_send announcement: draft per audience + approval → queue, status flips to sent', async () => {
    const row = mkRow();
    const { db, audits, changeLogs } = fakeDb([row]);
    const { deps, calls } = fakeDeps(2);
    const result = await sendAnnouncementSms(db, SCHOOL_ID, 'ann-1', ADMIN, deps);
    expect(calls.drafts).toHaveLength(1);
    expect(calls.drafts[0].recipientType).toBe('all_parents');
    expect(calls.drafts[0].targetClassId).toBeNull();
    expect(calls.drafts[0].body).toContain('Parent-teacher meeting');
    expect(calls.drafts[0].body).toContain('Meeting on Friday');
    expect(calls.approvals).toHaveLength(1);
    expect(calls.approvals[0].queueType).toBe('announcement');
    expect(calls.approvals[0].draftId).toBe('draft-1');
    expect(result.queued).toBe(2);
    expect(result.draft_id).toBe('draft-1');
    expect(result.announcement.status).toBe('sent');
    expect(row.status).toBe('sent');
    expect(changeLogs.some((c) => c.field === 'status' && c.newValue === 'sent')).toBe(true);
    expect(audits.some((a) => a.action === 'announcement.send')).toBe(true);
  });

  it('class-targeted announcement creates a class draft for that class', async () => {
    const row = mkRow({ targetType: 'class', targetClassId: 'class-5a' });
    const { db } = fakeDb([row]);
    const { deps, calls } = fakeDeps(1);
    const result = await sendAnnouncementSms(db, SCHOOL_ID, 'ann-1', ADMIN, deps);
    expect(calls.drafts[0].recipientType).toBe('class');
    expect(calls.drafts[0].targetClassId).toBe('class-5a');
    expect(result.announcement.target_class_name).toBe('5-A');
    expect(result.announcement.status).toBe('sent');
  });

  it('draft (not approved) announcement → 409 and no draft is created', async () => {
    const row = mkRow({ status: 'draft' });
    const { db } = fakeDb([row]);
    const { deps, calls } = fakeDeps();
    await expect(sendAnnouncementSms(db, SCHOOL_ID, 'ann-1', ADMIN, deps)).rejects.toMatchObject({
      status: 409,
    });
    expect(calls.drafts).toHaveLength(0);
    expect(calls.approvals).toHaveLength(0);
  });

  it('approved but sms_send=false → 409 and no draft is created', async () => {
    const row = mkRow({ smsSend: false });
    const { db } = fakeDb([row]);
    const { deps, calls } = fakeDeps();
    await expect(sendAnnouncementSms(db, SCHOOL_ID, 'ann-1', ADMIN, deps)).rejects.toMatchObject({
      status: 409,
    });
    expect(calls.drafts).toHaveLength(0);
  });

  it('already-sent announcement → 409 (no double send)', async () => {
    const row = mkRow({ status: 'sent' });
    const { db } = fakeDb([row]);
    const { deps, calls } = fakeDeps();
    await expect(sendAnnouncementSms(db, SCHOOL_ID, 'ann-1', ADMIN, deps)).rejects.toMatchObject({
      status: 409,
    });
    expect(calls.drafts).toHaveLength(0);
  });

  it('another school cannot send it → 404 and no draft is created', async () => {
    const row = mkRow();
    const { db } = fakeDb([row]);
    const { deps, calls } = fakeDeps();
    await expect(sendAnnouncementSms(db, OTHER_SCHOOL, 'ann-1', ADMIN, deps)).rejects.toMatchObject({
      status: 404,
    });
    expect(calls.drafts).toHaveLength(0);
  });

  it('zero queueable recipients → stays approved (retryable), skipped reasons returned', async () => {
    const row = mkRow();
    const { db, audits } = fakeDb([row]);
    const skipped = [{ studentId: 's-1', studentName: 'A', reason: 'opted_out' }];
    const { deps } = fakeDeps(0, skipped);
    const result = await sendAnnouncementSms(db, SCHOOL_ID, 'ann-1', ADMIN, deps);
    expect(result.queued).toBe(0);
    expect(result.skipped_opted_out).toBe(1);
    expect(result.announcement.status).toBe('approved');
    expect(row.status).toBe('approved');
    expect(audits.some((a) => a.action === 'announcement.send_no_recipients')).toBe(true);
  });
});

describe('announcement queue type end-to-end (FakeStore)', () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore();
    store.listRecipients = async () => [
      {
        id: 'stu-1', name: 'Ahmed Raza', fatherName: 'Muhammad Raza',
        classId: 'class-5a', className: '5', section: 'A',
        parentPhoneEnc: enc('+923001234567'), parentOptOut: false,
      },
      {
        id: 'stu-2', name: 'Sara Ahmed', fatherName: 'Ahmed Khan',
        classId: 'class-5a', className: '5', section: 'A',
        parentPhoneEnc: enc('+923009998888'), parentOptOut: true,
      },
    ];
  });

  it("approveDraftForSending with queueType 'announcement' queues type 'announcement' with announcement dedupe, opt-out skipped", async () => {
    const draft = await store.createDraft({
      schoolId: SCHOOL_ID, createdBy: ADMIN, recipientType: 'all_parents',
      targetClassId: null, targetStudentIds: [],
      body: 'PTM Friday {student_name} — {school_name}', scheduledFor: null,
    } as never);
    const result = await approveDraftForSending(
      { store, crypto: testCrypto },
      { schoolId: SCHOOL_ID, draftId: draft.id, approvedBy: ADMIN, queueType: 'announcement' },
    );
    expect('queued' in result && result.queued).toBe(1);
    expect('skippedOptedOut' in result && result.skippedOptedOut).toBe(1);
    const { items } = await store.listQueue(SCHOOL_ID, { page: 1, limit: 10 });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('announcement');
    expect(items[0].dedupeKey).toBe(`announcement:${draft.id}:stu-1`);
    expect(items[0].body).toContain('Ahmed Raza');
    const sent = await store.getDraftById(draft.id, SCHOOL_ID);
    expect(sent?.status).toBe('sent');
  });

  it("default queueType stays 'custom' with the custom dedupe key", async () => {
    const draft = await store.createDraft({
      schoolId: SCHOOL_ID, createdBy: ADMIN, recipientType: 'all_parents',
      targetClassId: null, targetStudentIds: [],
      body: 'Hello {student_name}', scheduledFor: null,
    } as never);
    await approveDraftForSending(
      { store, crypto: testCrypto },
      { schoolId: SCHOOL_ID, draftId: draft.id, approvedBy: ADMIN },
    );
    const { items } = await store.listQueue(SCHOOL_ID, { page: 1, limit: 10 });
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe('custom');
    expect(items[0].dedupeKey).toBe(`custom:${draft.id}:stu-1`);
  });
});
