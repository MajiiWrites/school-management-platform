/**
 * Custom Messages (Section 11) unit tests.
 *
 * Run: cd backend && npm test
 * Uses an in-memory fake MessagingStore (extends the v1 FakeStore) — no DB,
 * no network. Covers: template CRUD incl. seeded defaults, all-8-variable
 * rendering, preview counts incl. Urdu SMS parts, recipient picker counts
 * + opt-out exclusion + skipped count, the approval gate (nothing queued
 * before approval), draft scheduling + due-job pickup, cross-tenant 404s.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  approveDraftForSending,
  applyApprovedDraft,
  previewMessage,
  processDueScheduledDrafts,
  sendDraft,
  validateDraftInput,
  type CustomMessagesDeps,
} from '../custom-messages';
import { renderTemplate, smsPartCount, variablesUsed } from '../templates';
import { FakeStore, enc, testCrypto } from './service.test';
import type { RecipientStudent } from '../store';

const SCHOOL = { id: 'school-1', name: 'Demo Public School', timezone: 'Asia/Karachi', smsProvider: 'sim' as const };
const OTHER_SCHOOL = 'school-2';
const FRIDAY = '2026-11-06'; // a Friday (school day)

/** Rich fake: real students + absent/fee data so recipient resolution is exercised. */
class RichFake extends FakeStore {
  students: RecipientStudent[] = [];
  absentIds = new Set<string>();
  unpaid = new Map<string, number>(); // studentId -> remaining fee balance

  constructor() {
    super();
    const mk = (
      id: string,
      name: string,
      opts: Partial<RecipientStudent> & { schoolId?: string } = {},
    ): RecipientStudent => ({
      id,
      name,
      fatherName: opts.fatherName ?? `Father of ${name}`,
      classId: opts.classId ?? 'class-5a',
      className: opts.className ?? '5',
      section: opts.section ?? 'A',
      parentPhoneEnc: opts.parentPhoneEnc === undefined ? enc('+923001234567') : opts.parentPhoneEnc,
      parentOptOut: opts.parentOptOut ?? false,
      amountDue: opts.amountDue,
    });
    this.students = [
      mk('stu-1', 'Ahmed Raza'),
      mk('stu-2', 'Sara Ahmed', { fatherName: 'Ahmed Khan', section: 'B', classId: 'class-5b' }),
      mk('stu-3', 'Bilal Ahmed', { parentOptOut: true }),
      mk('stu-4', 'Noor Fatima', { parentPhoneEnc: null }),
      mk('stu-5', 'Hassan Ali', { parentPhoneEnc: enc('not-a-number') }),
    ];
    this.absentIds = new Set(['stu-1', 'stu-3']);
    this.unpaid.set('stu-1', 2500);
    this.unpaid.set('stu-2', 1800);
  }

  override async listRecipients(schoolId: string, query: any): Promise<RecipientStudent[]> {
    if (schoolId !== SCHOOL.id) return [];
    let list = [...this.students];
    if (query.filter === 'absent') {
      list = list.filter((s) => this.absentIds.has(s.id));
    } else if (query.filter === 'fee_unpaid') {
      list = list.filter((s) => this.unpaid.has(s.id));
    } else if (query.recipientType === 'class') {
      list = list.filter((s) => s.classId === query.targetClassId);
    } else if (query.recipientType === 'selected_students' || query.recipientType === 'single_parent') {
      const ids = new Set<string>(query.targetStudentIds ?? []);
      list = list.filter((s) => ids.has(s.id));
    }
    if (query.targetClassId && query.filter) {
      list = list.filter((s) => s.classId === query.targetClassId);
    }
    return list.map((s) => ({ ...s, amountDue: this.unpaid.get(s.id) }));
  }
}

function deps(store: RichFake, now = new Date(`${FRIDAY}T09:00:00Z`)): CustomMessagesDeps {
  return { store, crypto: testCrypto, now: () => now };
}

async function seedDraft(store: RichFake, overrides: Record<string, unknown> = {}) {
  return store.createDraft({
    schoolId: SCHOOL.id,
    createdBy: 'admin-1',
    recipientType: 'all_parents',
    targetClassId: null,
    targetStudentIds: [],
    body: 'Hello {student_name} ({class}-{section}), fee {amount} for {month} on {date}. From {school_name}, father {father_name}.',
    scheduledFor: null,
    ...overrides,
  } as never);
}

describe('templates: full CRUD, nothing locked', () => {
  let store: RichFake;
  beforeEach(() => {
    store = new RichFake();
  });

  it('creates a custom template and edits/renames a SEEDED default', async () => {
    const seeded = await store.createTemplate({
      schoolId: SCHOOL.id, name: 'Absent Alert (EN)', type: 'absent', language: 'en',
      body: 'seeded body', isCustom: false,
    });
    expect(seeded.isCustom).toBe(false);
    // Nothing is locked: rename + retype + edit the seeded default.
    const renamed = await store.updateTemplate(
      seeded.id,
      { name: 'My Absent Alert', body: 'edited {student_name}', type: 'custom' },
      SCHOOL.id,
    );
    expect(renamed.name).toBe('My Absent Alert');
    expect(renamed.body).toBe('edited {student_name}');
    expect(renamed.type).toBe('custom');
  });

  it('duplicates a template as type custom and deletes any template', async () => {
    const src = await store.createTemplate({
      schoolId: SCHOOL.id, name: 'Fee Reminder (EN)', type: 'fee_reminder', language: 'en',
      body: 'pay {amount}', isCustom: false,
    });
    // Duplicate (service-level shape): a copy is a new custom template.
    const copy = await store.createTemplate({
      schoolId: SCHOOL.id, name: `Copy of ${src.name}`, type: 'custom', language: 'en',
      body: src.body, isCustom: true,
    });
    expect(copy.body).toBe('pay {amount}');
    expect(copy.isCustom).toBe(true);
    await store.deleteTemplate(src.id, SCHOOL.id);
    expect(await store.getTemplateById(src.id, SCHOOL.id)).toBeNull();
  });

  it('rejects a second template in the same (type, language) slot', async () => {
    await store.createTemplate({
      schoolId: SCHOOL.id, name: 'Custom (EN)', type: 'custom', language: 'en', body: 'one',
    });
    await expect(
      store.createTemplate({
        schoolId: SCHOOL.id, name: 'Another Custom (EN)', type: 'custom', language: 'en', body: 'two',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('cross-tenant template reads/updates/deletes 404', async () => {
    const t = await store.createTemplate({
      schoolId: SCHOOL.id, name: 'Mine', type: 'custom', language: 'en', body: 'x',
    });
    expect(await store.getTemplateById(t.id, OTHER_SCHOOL)).toBeNull();
    await expect(store.updateTemplate(t.id, { body: 'hijack' }, OTHER_SCHOOL)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(store.deleteTemplate(t.id, OTHER_SCHOOL)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await store.getTemplateById(t.id, SCHOOL.id)).not.toBeNull();
  });
});

describe('rendering: all 8 variables', () => {
  it('renders every variable; unknown/missing ones stay literal', () => {
    const out = renderTemplate(
      '{student_name} s/o {father_name}, Class {class}-{section}, {date}, {month}, PKR {amount}, {school_name} {unknown_var}',
      {
        student_name: 'Ahmed Raza', father_name: 'Ahmed Khan', class: '5', section: 'A',
        date: '2026-11-06', month: '2026-11', amount: '2500', school_name: 'Demo Public School',
      },
    );
    expect(out).toBe(
      'Ahmed Raza s/o Ahmed Khan, Class 5-A, 2026-11-06, 2026-11, PKR 2500, Demo Public School {unknown_var}',
    );
    // Missing {amount} renders literally, never crashes.
    expect(renderTemplate('Fee: {amount}', { student_name: 'A' })).toBe('Fee: {amount}');
    expect(variablesUsed('Hi {student_name} {amount} {amount}')).toEqual(['student_name', 'amount']);
  });
});

describe('smsPartCount: GSM vs Unicode', () => {
  it('counts GSM 160/153', () => {
    expect(smsPartCount('x'.repeat(160))).toMatchObject({ isUnicode: false, parts: 1, length: 160 });
    expect(smsPartCount('x'.repeat(161))).toMatchObject({ isUnicode: false, parts: 2 });
    expect(smsPartCount('x'.repeat(306))).toMatchObject({ parts: 2 });
    expect(smsPartCount('x'.repeat(307))).toMatchObject({ parts: 3 });
    // Extension-table char ^ costs 2 septets.
    expect(smsPartCount('^'.repeat(80))).toMatchObject({ length: 160, parts: 1 });
    expect(smsPartCount('^'.repeat(81))).toMatchObject({ length: 162, parts: 2 });
    expect(smsPartCount('')).toMatchObject({ parts: 0 });
  });

  it('counts Urdu as Unicode 70/67', () => {
    const urdu70 = 'ا'.repeat(70);
    expect(smsPartCount(urdu70)).toMatchObject({ isUnicode: true, parts: 1, length: 70 });
    expect(smsPartCount('ا'.repeat(71))).toMatchObject({ isUnicode: true, parts: 2 });
    expect(smsPartCount('ا'.repeat(134))).toMatchObject({ parts: 2 });
    expect(smsPartCount('ا'.repeat(135))).toMatchObject({ parts: 3 });
    // Mixed Urdu + English is still Unicode.
    expect(smsPartCount('Hello احمد')).toMatchObject({ isUnicode: true });
    // Emoji = 2 UTF-16 units, forces Unicode.
    expect(smsPartCount('🎉')).toMatchObject({ isUnicode: true, length: 2 });
  });
});

describe('preview', () => {
  let store: RichFake;
  beforeEach(() => {
    store = new RichFake();
  });

  it('renders the first 3 sendable samples exactly + counts + skipped', async () => {
    const res = await previewMessage(deps(store), {
      schoolId: SCHOOL.id,
      body: 'Salam {student_name}, Class {class}-{section}, fee PKR {amount} ({month}). – {school_name}',
      recipientType: 'all_parents',
    });
    // Sendable: stu-1, stu-2 (stu-3 opted out, stu-4 no phone, stu-5 invalid).
    expect(res.recipientCount).toBe(2);
    expect(res.skippedCount).toBe(3);
    expect(res.skipped.map((s) => s.reason).sort()).toEqual(['invalid_phone', 'missing_phone', 'opted_out']);
    expect(res.samples).toHaveLength(2);
    expect(res.samples[0].body).toBe(
      'Salam Ahmed Raza, Class 5-A, fee PKR 2500 (2026-11). – Demo Public School',
    );
    expect(res.samples[1].body).toContain('Sara Ahmed, Class 5-B, fee PKR 1800');
    expect(res.samples[0].parentPhoneMasked).toMatch(/\+92 3XX/);
    expect(res.charCount).toBeGreaterThan(0);
    // The '–' en dash is not GSM-7, so the body is UCS-2: >70 chars = 2 parts.
    expect(res.smsParts).toBe(2);
    expect(res.isUnicode).toBe(true);
    expect(res.variablesUsed).toEqual(['student_name', 'class', 'section', 'amount', 'month', 'school_name']);
  });

  it('counts Urdu preview bodies as Unicode parts', async () => {
    const urduBody = 'محترم والدین، {student_name} کی فیس {amount} روپے واجب الادا ہے۔';
    const res = await previewMessage(deps(store), {
      schoolId: SCHOOL.id,
      body: urduBody.repeat(2),
      recipientType: 'single_parent',
      targetStudentIds: ['stu-1'],
    });
    expect(res.recipientCount).toBe(1);
    expect(res.isUnicode).toBe(true);
    expect(res.smsParts).toBeGreaterThanOrEqual(2);
  });

  it('preview from a template_id resolves the template body', async () => {
    const t = await store.createTemplate({
      schoolId: SCHOOL.id, name: 'Custom (EN)', type: 'custom', language: 'en',
      body: 'Hi {student_name}',
    });
    const res = await previewMessage(deps(store), {
      schoolId: SCHOOL.id,
      templateId: t.id,
      recipientType: 'single_parent',
      targetStudentIds: ['stu-2'],
    });
    expect(res.samples[0].body).toBe('Hi Sara Ahmed');
    await expect(
      previewMessage(deps(store), { schoolId: SCHOOL.id, templateId: t.id, recipientType: 'single_parent', targetStudentIds: ['stu-2'] }),
    ).resolves.toBeDefined();
    await expect(
      previewMessage(deps(store), { schoolId: OTHER_SCHOOL, templateId: t.id, recipientType: 'single_parent', targetStudentIds: ['stu-2'] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('recipient picker: absent + fee-unpaid quick filters with counts', async () => {
    const absent = await store.listRecipients(SCHOOL.id, { recipientType: 'all_parents', filter: 'absent' });
    expect(absent.map((s) => s.id).sort()).toEqual(['stu-1', 'stu-3']);
    const unpaid = await store.listRecipients(SCHOOL.id, { recipientType: 'all_parents', filter: 'fee_unpaid' });
    expect(unpaid.map((s) => s.id).sort()).toEqual(['stu-1', 'stu-2']);
    expect(unpaid.find((s) => s.id === 'stu-1')?.amountDue).toBe(2500);
    const oneClass = await store.listRecipients(SCHOOL.id, { recipientType: 'class', targetClassId: 'class-5b' });
    expect(oneClass.map((s) => s.id)).toEqual(['stu-2']);
    const selected = await store.listRecipients(SCHOOL.id, { recipientType: 'selected_students', targetStudentIds: ['stu-2', 'stu-4'] });
    expect(selected).toHaveLength(2);
    // Cross-tenant: another school sees none of these students.
    expect(await store.listRecipients(OTHER_SCHOOL, { recipientType: 'all_parents' })).toEqual([]);
  });
});

describe('approval gate: nothing queues before approval', () => {
  let store: RichFake;
  beforeEach(() => {
    store = new RichFake();
  });

  it('creating a draft queues nothing', async () => {
    await seedDraft(store);
    expect(store.queue).toHaveLength(0);
  });

  it('a scheduled draft without approval NEVER sends (job leaves it scheduled)', async () => {
    const draft = await seedDraft(store);
    await store.updateDraft(
      draft.id,
      { status: 'scheduled', scheduledFor: new Date('2026-11-06T08:00:00Z') },
      SCHOOL.id,
    );
    const res = await processDueScheduledDrafts(deps(store, new Date('2026-11-06T10:00:00Z')), { schoolId: SCHOOL.id });
    expect(res).toMatchObject({ checked: 1, sent: 0, skippedUnapproved: 1 });
    expect(store.queue).toHaveLength(0);
    expect((await store.getDraftById(draft.id, SCHOOL.id))?.status).toBe('scheduled');
  });

  it('direct approve-send queues approved rows only for sendable parents', async () => {
    const draft = await seedDraft(store);
    const res = await approveDraftForSending(deps(store), {
      schoolId: SCHOOL.id, draftId: draft.id, approvedBy: 'admin-1',
    });
    expect('scheduled' in res).toBe(false);
    if ('scheduled' in res) throw new Error('expected an immediate send');
    expect(res.queued).toBe(2);
    expect(res.skippedOptedOut).toBe(1);
    expect(res.skipped).toHaveLength(3);
    expect(store.queue).toHaveLength(2);
    for (const q of store.queue) {
      expect(q.type).toBe('custom');
      expect(q.approvedBy).toBe('admin-1');
      expect(q.approvedAt).not.toBeNull();
      expect(q.dedupeKey).toMatch(/^custom:/);
    }
    expect((await store.getDraftById(draft.id, SCHOOL.id))?.status).toBe('sent');
    // Second send is refused — never twice.
    await expect(
      sendDraft(deps(store), { schoolId: SCHOOL.id, draftId: draft.id, approvedBy: 'admin-1' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('approval-request approval sends; a future scheduled_for becomes scheduled', async () => {
    const draft = await seedDraft(store, { scheduledFor: new Date('2026-11-07T09:00:00Z') });
    const res = await applyApprovedDraft(deps(store), {
      schoolId: SCHOOL.id, draftId: draft.id, approvedBy: 'admin-1',
    });
    expect(res).toMatchObject({ scheduled: true });
    expect(store.queue).toHaveLength(0);
    expect((await store.getDraftById(draft.id, SCHOOL.id))?.status).toBe('scheduled');
  });

  it('cross-tenant draft approve/send 404s', async () => {
    const draft = await seedDraft(store);
    await expect(
      approveDraftForSending(deps(store), { schoolId: OTHER_SCHOOL, draftId: draft.id, approvedBy: 'admin-1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      sendDraft(deps(store), { schoolId: OTHER_SCHOOL, draftId: draft.id, approvedBy: 'admin-1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(store.queue).toHaveLength(0);
  });
});

describe('draft scheduling + due-job pickup', () => {
  let store: RichFake;
  beforeEach(() => {
    store = new RichFake();
  });

  it('approved scheduled draft sends only when due', async () => {
    const draft = await seedDraft(store, { scheduledFor: new Date('2026-11-07T09:00:00Z') });
    await approveDraftForSending(deps(store), { schoolId: SCHOOL.id, draftId: draft.id, approvedBy: 'admin-1' });
    expect((await store.getDraftById(draft.id, SCHOOL.id))?.status).toBe('scheduled');
    // Job before due: nothing.
    let res = await processDueScheduledDrafts(deps(store, new Date('2026-11-07T08:00:00Z')), { schoolId: SCHOOL.id });
    expect(res).toMatchObject({ checked: 0, sent: 0 });
    expect(store.queue).toHaveLength(0);
    // Job after due: sends (approval exists) and marks sent.
    res = await processDueScheduledDrafts(deps(store, new Date('2026-11-07T10:00:00Z')), { schoolId: SCHOOL.id });
    expect(res).toMatchObject({ checked: 1, sent: 1, skippedUnapproved: 0 });
    expect(store.queue).toHaveLength(2);
    expect((await store.getDraftById(draft.id, SCHOOL.id))?.status).toBe('sent');
    // Re-run is a no-op (already sent).
    res = await processDueScheduledDrafts(deps(store, new Date('2026-11-07T11:00:00Z')), { schoolId: SCHOOL.id });
    expect(res).toMatchObject({ checked: 0, sent: 0 });
    expect(store.queue).toHaveLength(2);
  });

  it('draft input validation rejects bad recipients and empty bodies', () => {
    expect(() => validateDraftInput({ recipientType: 'class', body: 'hi' })).toThrow();
    expect(() =>
      validateDraftInput({ recipientType: 'selected_students', targetStudentIds: [], body: 'hi' }),
    ).toThrow();
    expect(() =>
      validateDraftInput({ recipientType: 'single_parent', targetStudentIds: ['a', 'b'], body: 'hi' }),
    ).toThrow();
    expect(() => validateDraftInput({ recipientType: 'all_parents', body: '   ' })).toThrow();
    expect(() =>
      validateDraftInput({ recipientType: 'all_parents', body: 'ok' }),
    ).not.toThrow();
  });
});

describe('jobs registry: scheduled_messages is registered', () => {
  it('lists the scheduled-messages job on a 5-minute tick', async () => {
    const { JOB_DEFINITIONS } = await import('../../../jobs/registry');
    const def = JOB_DEFINITIONS.find((d) => d.name === 'scheduled_messages');
    expect(def).toBeDefined();
    expect(def?.schedule).toBe('*/5 * * * *');
  });
});
