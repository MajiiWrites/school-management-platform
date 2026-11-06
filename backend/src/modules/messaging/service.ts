/**
 * Messaging service — the rules engine for all parent/teacher SMS.
 *
 * HARD RULES (API.md §Rules, enforced here, not just in the UI):
 *  1. Messages go ONLY to parents of ABSENT students, ONLY after admin
 *     approval, NEVER twice for the same (student, day) — dedupe_key unique
 *     constraint is the backstop; the service also checks first.
 *  2. Teacher absence NEVER creates messages (no code path reads
 *     teacher_attendance for messaging at all).
 *  3. No messages on Sundays or holidays (checked on draft creation AND on
 *     approval — a date that becomes a holiday after drafting stays held).
 *  4. Never log or return full phone numbers; mask everywhere humans see them.
 *  5. Opted-out parents and invalid/missing numbers are skipped, with the
 *     reason returned so the admin can fix the data (Parents section).
 *
 * Draft lifecycle: buildAbsentDrafts() creates rows with status='queued' and
 * approved_at=NULL ("held"). The admin reviews them in pending-approval,
 * edits bodies if needed, then approveMessages() sets approved_by/at and
 * staggers scheduled_for (2 s apart — the server-side SIM rate limit).
 * The Android device only ever receives approved, due rows.
 */

import {
  decryptPhone,
  encryptPhone,
  hashPhone,
  isValidPK,
  maskPhone,
  normalizePK,
} from './phone';
import {
  DEFAULT_TEMPLATES,
  renderTemplate,
  type TemplateLanguage,
  type TemplateType,
} from './templates';
import {
  dedupeKeyAbsent,
  dedupeKeyFee,
  dedupeKeyTeacher,
  isSchoolDay,
  type MessagingStore,
  type QueueRow,
  type SchoolInfo,
  type TemplateRow,
} from './store';

export interface PhoneCrypto {
  encrypt(e164: string): string;
  decrypt(enc: string): string;
}

const defaultCrypto: PhoneCrypto = {
  encrypt: (e164) => encryptPhone(e164),
  decrypt: (enc) => decryptPhone(enc),
};

export interface StudentDraftInput {
  id: string;
  name: string;
  classId: string;
  parentName: string | null;
  /** Encrypted parent phone (as stored). Null = missing. */
  parentPhoneEnc: string | null;
  parentOptOut: boolean;
}

export interface AttendanceRecordInput {
  studentId: string;
  status: 'present' | 'absent' | 'late' | 'leave';
}

export interface DraftSkip {
  studentId: string;
  studentName: string;
  reason:
    | 'not_absent'
    | 'opted_out'
    | 'missing_phone'
    | 'invalid_phone'
    | 'already_queued';
}

export interface DraftResult {
  created: number;
  skipped: DraftSkip[];
  /** True when the whole day was skipped (Sunday/holiday). */
  daySkipped: boolean;
  daySkippedReason: 'sunday' | 'holiday' | null;
}

export interface ServiceDeps {
  store: MessagingStore;
  crypto?: PhoneCrypto;
  now?: () => Date;
}

function resolveTemplate(
  row: TemplateRow | null,
  type: TemplateType,
  language: TemplateLanguage,
): string {
  if (row && row.isActive) return row.body;
  return DEFAULT_TEMPLATES[type][language];
}

function decryptToE164(
  enc: string | null,
  cryptoImpl: PhoneCrypto,
): string | null {
  if (!enc) return null;
  try {
    return normalizePK(decryptWith(enc, cryptoImpl));
  } catch {
    return null; // undecryptable (e.g. key rotated) — treat as invalid, never send
  }
}

function decryptWith(enc: string, cryptoImpl: PhoneCrypto): string {
  return cryptoImpl.decrypt(enc);
}

/**
 * Build held absent-message drafts for one submitted attendance day.
 * Called by the attendance submit flow AFTER records are saved.
 * Idempotent: re-running for the same day creates nothing new.
 */
export async function buildAbsentDrafts(
  deps: ServiceDeps,
  input: {
    school: SchoolInfo;
    classId: string;
    className: string;
    date: string; // school-local YYYY-MM-DD
    records: AttendanceRecordInput[];
    students: StudentDraftInput[];
    language?: TemplateLanguage;
  },
): Promise<DraftResult> {
  const { store } = deps;
  const cryptoImpl = deps.crypto ?? defaultCrypto;
  const now = deps.now ?? (() => new Date());
  const language: TemplateLanguage = input.language ?? 'en';

  // Rule 3: no messages on Sundays or holidays.
  const day = new Date(`${input.date}T12:00:00Z`).getUTCDay();
  if (day === 0) {
    return { created: 0, skipped: [], daySkipped: true, daySkippedReason: 'sunday' };
  }
  if (await store.isHoliday(input.school.id, input.date)) {
    return { created: 0, skipped: [], daySkipped: true, daySkippedReason: 'holiday' };
  }

  const template = resolveTemplate(
    await store.getActiveTemplate(input.school.id, 'absent', language),
    'absent',
    language,
  );

  const studentById = new Map(input.students.map((s) => [s.id, s]));
  const skipped: DraftSkip[] = [];
  let created = 0;

  for (const record of input.records) {
    const student = studentById.get(record.studentId);
    if (!student) continue;

    // Rule 1: ONLY absent students. Present/late/leave never get messages.
    if (record.status !== 'absent') {
      skipped.push({ studentId: student.id, studentName: student.name, reason: 'not_absent' });
      continue;
    }
    if (student.parentOptOut) {
      skipped.push({ studentId: student.id, studentName: student.name, reason: 'opted_out' });
      continue;
    }
    if (!student.parentPhoneEnc) {
      skipped.push({ studentId: student.id, studentName: student.name, reason: 'missing_phone' });
      continue;
    }
    const e164 = decryptToE164(student.parentPhoneEnc, cryptoImpl);
    if (!e164 || !isValidPK(e164)) {
      skipped.push({ studentId: student.id, studentName: student.name, reason: 'invalid_phone' });
      continue;
    }

    const dedupeKey = dedupeKeyAbsent(student.id, input.date);
    const existing = await store.findQueueByDedupeKey(dedupeKey);
    if (existing) {
      skipped.push({ studentId: student.id, studentName: student.name, reason: 'already_queued' });
      continue;
    }

    const body = renderTemplate(template, {
      student_name: student.name,
      class: input.className,
      date: input.date,
      school_name: input.school.name,
    });

    const { created: wasCreated } = await store.createQueue({
      schoolId: input.school.id,
      type: 'absent',
      studentId: student.id,
      classId: input.classId,
      parentPhoneEnc: cryptoImpl.encrypt(e164),
      body,
      dedupeKey,
      scheduledFor: now(),
    });
    if (wasCreated) created += 1;
    else {
      skipped.push({ studentId: student.id, studentName: student.name, reason: 'already_queued' });
    }
  }

  return { created, skipped, daySkipped: false, daySkippedReason: null };
}

/**
 * Build held fee-reminder drafts for unpaid fee records.
 * Called by the Fee/Scheduler agent's monthly job. Only unpaid rows should
 * be passed in — paid records are NEVER re-created or re-reminded.
 */
export async function buildFeeReminderDrafts(
  deps: ServiceDeps,
  input: {
    school: SchoolInfo;
    month: string; // YYYY-MM
    items: Array<{
      student: StudentDraftInput;
      className: string;
      amountDue: number;
    }>;
    language?: TemplateLanguage;
  },
): Promise<DraftResult> {
  const { store } = deps;
  const cryptoImpl = deps.crypto ?? defaultCrypto;
  const now = deps.now ?? (() => new Date());
  const language: TemplateLanguage = input.language ?? 'en';

  const template = resolveTemplate(
    await store.getActiveTemplate(input.school.id, 'fee_reminder', language),
    'fee_reminder',
    language,
  );

  const skipped: DraftSkip[] = [];
  let created = 0;

  for (const item of input.items) {
    const student = item.student;
    if (student.parentOptOut) {
      skipped.push({ studentId: student.id, studentName: student.name, reason: 'opted_out' });
      continue;
    }
    if (!student.parentPhoneEnc) {
      skipped.push({ studentId: student.id, studentName: student.name, reason: 'missing_phone' });
      continue;
    }
    const e164 = decryptToE164(student.parentPhoneEnc, cryptoImpl);
    if (!e164 || !isValidPK(e164)) {
      skipped.push({ studentId: student.id, studentName: student.name, reason: 'invalid_phone' });
      continue;
    }
    const dedupeKey = dedupeKeyFee(student.id, input.month);
    if (await store.findQueueByDedupeKey(dedupeKey)) {
      skipped.push({ studentId: student.id, studentName: student.name, reason: 'already_queued' });
      continue;
    }
    const body = renderTemplate(template, {
      student_name: student.name,
      class: item.className,
      month: input.month,
      amount: String(item.amountDue),
      school_name: input.school.name,
    });
    const { created: wasCreated } = await store.createQueue({
      schoolId: input.school.id,
      type: 'fee_reminder',
      studentId: student.id,
      classId: student.classId,
      parentPhoneEnc: cryptoImpl.encrypt(e164),
      body,
      dedupeKey,
      scheduledFor: now(),
    });
    if (wasCreated) created += 1;
    else {
      skipped.push({ studentId: student.id, studentName: student.name, reason: 'already_queued' });
    }
  }

  return { created, skipped, daySkipped: false, daySkippedReason: null };
}

/**
 * Build a held teacher-reminder draft for a class with no attendance yet.
 * Goes to the TEACHER's own phone (never to parents). Called by the daily
 * scheduler job. Teacher absence itself never creates messages — this is a
 * reminder to SUBMIT attendance, sent only when nothing was submitted.
 */
export async function buildTeacherReminderDraft(
  deps: ServiceDeps,
  input: {
    school: SchoolInfo;
    classId: string;
    className: string;
    date: string;
    teacherPhoneEnc: string | null;
    language?: TemplateLanguage;
  },
): Promise<{ created: boolean; reason?: string }> {
  const { store } = deps;
  const cryptoImpl = deps.crypto ?? defaultCrypto;
  const now = deps.now ?? (() => new Date());
  const language: TemplateLanguage = input.language ?? 'en';

  if (!(await isSchoolDay(store, input.school.id, input.date))) {
    return { created: false, reason: 'not_a_school_day' };
  }
  const e164 = decryptToE164(input.teacherPhoneEnc, cryptoImpl);
  if (!e164 || !isValidPK(e164)) return { created: false, reason: 'invalid_phone' };

  const dedupeKey = dedupeKeyTeacher(input.classId, input.date);
  if (await store.findQueueByDedupeKey(dedupeKey)) {
    return { created: false, reason: 'already_queued' };
  }
  const template = resolveTemplate(
    await store.getActiveTemplate(input.school.id, 'teacher_reminder', language),
    'teacher_reminder',
    language,
  );
  const body = renderTemplate(template, {
    class: input.className,
    date: input.date,
    school_name: input.school.name,
  });
  const { created } = await store.createQueue({
    schoolId: input.school.id,
    type: 'teacher_reminder',
    studentId: null,
    classId: input.classId,
    parentPhoneEnc: cryptoImpl.encrypt(e164),
    body,
    dedupeKey,
    scheduledFor: now(),
  });
  return { created };
}

/* ------------------------------------------------------------------ */
/* Approval flow                                                       */
/* ------------------------------------------------------------------ */

export interface PendingMessage {
  queueId: string;
  dedupeKey: string;
  studentId: string | null;
  studentName: string | null;
  parentPhoneMasked: string;
  body: string;
}

export interface PendingGroup {
  groupId: string; // `${classId}:${date}:${type}`
  classId: string | null;
  date: string;
  type: string;
  count: number;
  messages: PendingMessage[];
}

/** Attendance date embedded in the dedupe key (absent:{id}:{date} etc.). */
function dateFromDedupeKey(key: string): string | null {
  const m = key.match(/:(20\d{2}-\d{2}-\d{2})$/);
  return m ? m[1] : null;
}

/** The school-local date a queue row belongs to (dedupe key first, fallback createdAt). */
function rowDate(row: QueueRow): string {
  return dateFromDedupeKey(row.dedupeKey) ?? row.createdAt.toISOString().slice(0, 10);
}

function groupIdFor(row: QueueRow): string {
  return `${row.classId ?? 'none'}:${rowDate(row)}:${row.type}`;
}

/**
 * Pending-approval list, grouped by class/day/type. Bodies are included so
 * the admin can review and edit each message before approving.
 * Phone numbers are masked (Rule 4). Student names are NOT available on the
 * queue row itself — the caller joins students; this function takes an
 * optional name lookup so the service stays DB-agnostic.
 */
export async function getPendingApproval(
  deps: ServiceDeps,
  input: {
    schoolId: string;
    studentNames?: Map<string, string>;
    /** class display names, e.g. "5-A" — keyed by classId. */
    classNames?: Map<string, string>;
  },
): Promise<PendingGroup[]> {
  const { store } = deps;
  const cryptoImpl = deps.crypto ?? defaultCrypto;
  const rows = await store.listPendingApproval(input.schoolId);

  const groups = new Map<string, PendingGroup>();
  for (const row of rows) {
    const groupId = groupIdFor(row);
    let group = groups.get(groupId);
    if (!group) {
      group = {
        groupId,
        classId: row.classId,
        date: rowDate(row),
        type: row.type,
        count: 0,
        messages: [],
      };
      groups.set(groupId, group);
    }
    let masked = '+92 3XX XXXX???';
    try {
      const e164 = normalizePK(decryptWith(row.parentPhoneEnc, cryptoImpl));
      // lib maskPhone returns string|null (null only for nullish input, which
      // e164 cannot be here); keep the same fallback placeholder as before.
      if (e164) masked = maskPhone(e164) ?? '+92 3XX XXXX???';
    } catch {
      // undecryptable — still list it (masked) so admin can see the problem
    }
    group.messages.push({
      queueId: row.id,
      dedupeKey: row.dedupeKey,
      studentId: row.studentId,
      studentName: row.studentId
        ? input.studentNames?.get(row.studentId) ?? null
        : null,
      parentPhoneMasked: masked,
      body: row.body,
    });
    group.count += 1;
  }
  return [...groups.values()];
}

/**
 * Approve held drafts (admin only — enforced at the route).
 * Accepts dedupe keys, a groupId, or both. Idempotent: already-approved rows
 * are skipped. Approved rows get scheduled_for staggered 2 s apart so the
 * SIM never sends faster than 1 msg / 2 s (server-side rate limit).
 * Re-checks school-day: a date that became a holiday after drafting is
 * cancelled instead of sent.
 */
export async function approveMessages(
  deps: ServiceDeps,
  input: {
    schoolId: string;
    approvedBy: string;
    dedupeKeys?: string[];
    groupId?: string;
  },
): Promise<{ approved: number; cancelled: number; alreadyApproved: number }> {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const pending = await store.listPendingApproval(input.schoolId);

  const wanted = new Set(input.dedupeKeys ?? []);
  const selected = pending.filter((row) => {
    if (wanted.has(row.dedupeKey)) return true;
    if (input.groupId && groupIdFor(row) === input.groupId) return true;
    return false;
  });

  let approved = 0;
  let cancelled = 0;
  const approvedAt = now();
  let slot = 0;

  for (const row of selected) {
    // Rule 3 re-check: never send for a date that is now a holiday/Sunday.
    const date = rowDate(row);
    const schoolDay = await isSchoolDay(store, input.schoolId, date);
    if (!schoolDay) {
      await store.updateQueue(row.id, { status: 'cancelled', error: 'not_a_school_day' });
      await store.createAuditLog({
        schoolId: input.schoolId,
        actorId: input.approvedBy,
        actorType: 'user',
        action: 'message.cancel',
        entity: 'message_queue',
        entityId: row.id,
        details: { dedupeKey: row.dedupeKey, reason: 'not_a_school_day' },
      });
      cancelled += 1;
      continue;
    }
    const scheduledFor = new Date(approvedAt.getTime() + slot * 2000);
    slot += 1;
    await store.updateQueue(row.id, {
      approvedBy: input.approvedBy,
      approvedAt,
      scheduledFor,
    });
    approved += 1;
  }

  if (approved > 0) {
    await store.createAuditLog({
      schoolId: input.schoolId,
      actorId: input.approvedBy,
      actorType: 'user',
      action: 'message.approve',
      entity: 'message_queue',
      entityId: null,
      details: { approved, dedupeKeys: selected.map((r) => r.dedupeKey) },
    });
  }

  return { approved, cancelled, alreadyApproved: 0 };
}

/** Edit a held/queued message body (before it is sent). */
export async function editQueueBody(
  deps: ServiceDeps,
  input: { schoolId: string; queueId: string; body: string; editedBy: string },
): Promise<QueueRow> {
  const { store } = deps;
  const row = await store.getQueueById(input.queueId);
  if (!row || row.schoolId !== input.schoolId) {
    throw Object.assign(new Error('Message not found'), { code: 'NOT_FOUND' });
  }
  if (row.status === 'sent' || row.status === 'cancelled') {
    throw Object.assign(new Error('Cannot edit a sent or cancelled message'), {
      code: 'VALIDATION',
    });
  }
  if (!input.body || !input.body.trim()) {
    throw Object.assign(new Error('Body must not be empty'), { code: 'VALIDATION' });
  }
  const updated = await store.updateQueue(row.id, { body: input.body.trim() });
  await store.createAuditLog({
    schoolId: input.schoolId,
    actorId: input.editedBy,
    actorType: 'user',
    action: 'message.edit',
    entity: 'message_queue',
    entityId: row.id,
    details: { dedupeKey: row.dedupeKey },
  });
  return updated;
}

/** Retry a failed message: back to queued, error cleared, due immediately. */
export async function retryFailed(
  deps: ServiceDeps,
  input: { schoolId: string; queueId: string; retriedBy: string },
): Promise<QueueRow> {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const row = await store.getQueueById(input.queueId);
  if (!row || row.schoolId !== input.schoolId) {
    throw Object.assign(new Error('Message not found'), { code: 'NOT_FOUND' });
  }
  if (row.status !== 'failed') {
    throw Object.assign(new Error('Only failed messages can be retried'), {
      code: 'VALIDATION',
    });
  }
  const updated = await store.updateQueue(row.id, {
    status: 'queued',
    error: null,
    scheduledFor: now(),
  });
  await store.createAuditLog({
    schoolId: input.schoolId,
    actorId: input.retriedBy,
    actorType: 'user',
    action: 'message.retry',
    entity: 'message_queue',
    entityId: row.id,
    details: { dedupeKey: row.dedupeKey, attempts: row.attempts },
  });
  return updated;
}

/* ------------------------------------------------------------------ */
/* Device (Android companion)                                          */
/* ------------------------------------------------------------------ */

/**
 * Next batch for a device poll: approved rows only, due now, max 10,
 * oldest first. The stagger applied at approval guarantees the device
 * never legitimately has more than one message due per 2 s window.
 */
export async function getDeviceQueue(
  deps: ServiceDeps,
  input: { schoolId: string; deviceId: string; limit?: number },
): Promise<Array<{ queueId: string; to: string; body: string; type: string }>> {
  const { store } = deps;
  const cryptoImpl = deps.crypto ?? defaultCrypto;
  const device = await store.getDeviceByDeviceId(input.deviceId);
  if (!device || device.schoolId !== input.schoolId) {
    throw Object.assign(new Error('Unknown device'), { code: 'NOT_FOUND' });
  }
  await store.touchDevice(input.deviceId);

  const rows = await store.listDueApproved(input.schoolId, input.limit ?? 10);
  const out: Array<{ queueId: string; to: string; body: string; type: string }> = [];
  for (const row of rows) {
    let to: string | null = null;
    try {
      to = normalizePK(decryptWith(row.parentPhoneEnc, cryptoImpl));
    } catch {
      to = null;
    }
    if (!to) {
      // Number became undecryptable/invalid after approval — fail it loudly
      // instead of handing a bad number to the device.
      await store.updateQueue(row.id, { status: 'failed', error: 'invalid_phone_at_send' });
      continue;
    }
    out.push({ queueId: row.id, to, body: row.body, type: row.type });
  }
  return out;
}

/** Device reports a send result. Updates the queue row + delivery log. */
export async function reportDelivery(
  deps: ServiceDeps,
  input: {
    schoolId: string;
    deviceId: string;
    queueId: string;
    status: 'sent' | 'failed';
    error?: string;
  },
): Promise<QueueRow> {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const device = await store.getDeviceByDeviceId(input.deviceId);
  if (!device || device.schoolId !== input.schoolId) {
    throw Object.assign(new Error('Unknown device'), { code: 'NOT_FOUND' });
  }
  const row = await store.getQueueById(input.queueId);
  if (!row || row.schoolId !== input.schoolId) {
    throw Object.assign(new Error('Message not found'), { code: 'NOT_FOUND' });
  }
  await store.touchDevice(input.deviceId);

  const updated = await store.updateQueue(row.id, {
    status: input.status,
    attempts: row.attempts + 1,
    sentAt: input.status === 'sent' ? now() : row.sentAt,
    error: input.status === 'failed' ? input.error ?? 'send_failed' : null,
  });
  await store.createDelivery({
    queueId: row.id,
    provider: 'sim',
    deviceId: device.id,
    status: input.status,
    error: input.status === 'failed' ? input.error ?? 'send_failed' : null,
  });
  return updated;
}

/** Portal SMS status: provider, SIM connectivity, queue depth. */
export async function getSmsStatus(
  deps: ServiceDeps,
  input: { schoolId: string },
): Promise<{
  provider: 'sim' | 'gateway';
  simConnected: boolean;
  lastSeenAt: Date | null;
  queuedCount: number;
  pendingApprovalCount: number;
}> {
  const { store } = deps;
  const school = await store.getSchool(input.schoolId);
  const devices = await store.getDevicesStatus(input.schoolId);
  const counts = await store.countQueued(input.schoolId);
  const simConnected =
    devices.lastSeenAt !== null &&
    Date.now() - devices.lastSeenAt.getTime() <= 90_000;
  return {
    provider: school?.smsProvider ?? 'sim',
    simConnected,
    lastSeenAt: devices.lastSeenAt,
    queuedCount: counts.queued,
    pendingApprovalCount: counts.pendingApproval,
  };
}

export { hashPhone, maskPhone };
