/**
 * Custom Messages — Section 11 (contracts/SCHEMA.md §11, API.md §Custom Messages).
 *
 * The composer / drafts / preview / approval-send flow. Rules:
 *  - NOTHING sends without admin approval: a draft only reaches
 *    message_queue via sendDraft(), which runs after an approval
 *    (direct approve-send, or an approved approval_requests row).
 *  - Sending reuses the EXISTING message_queue (type 'custom', dedupe
 *    `custom:{draftId}:{studentId}`) — there is no second sending path.
 *    The companion app / gateway picks approved rows up exactly like v1.
 *  - Opted-out parents and missing/invalid numbers are auto-excluded at
 *    queue-build time; the build returns a skipped count + reasons.
 *  - All 8 variables render per recipient: {student_name} {father_name}
 *    {class} {section} {date} {amount} {month} {school_name}. {amount}
 *    comes from the student's remaining fee balance for the render month
 *    (undefined leaves it literal); {date}/{month} are school-local.
 *  - A scheduled draft without a prior approval NEVER sends: the
 *    scheduled-messages job checks hasApprovedDraftApproval() and leaves
 *    unapproved drafts scheduled.
 *  - Every query is scoped by JWT school_id (store methods all take it).
 *  - Phone crypto is unchanged (AES-256-GCM via the v1 helpers).
 */

import {
  decryptPhone,
  encryptPhone,
  isValidPK,
  maskPhone,
  normalizePK,
} from './phone';
import {
  renderTemplate,
  smsPartCount,
  variablesUsed,
  type TemplateVars,
} from './templates';
import {
  dedupeKeyCustom,
  type DraftRow,
  type MessagingStore,
  type RecipientQuery,
  type RecipientStudent,
} from './store';

export interface PhoneCrypto {
  encrypt(e164: string): string;
  decrypt(enc: string): string;
}

const defaultCrypto: PhoneCrypto = {
  encrypt: (e164: string) => encryptPhone(e164),
  decrypt: (enc: string) => decryptPhone(enc),
};

export interface CustomMessagesDeps {
  store: MessagingStore;
  crypto?: PhoneCrypto;
  now?: () => Date;
}

export type RecipientSkipReason = 'opted_out' | 'missing_phone' | 'invalid_phone' | 'already_queued';

export interface RecipientSkip {
  studentId: string;
  studentName: string;
  reason: RecipientSkipReason;
}

export interface PreviewSample {
  studentId: string;
  studentName: string;
  parentPhoneMasked: string;
  /** Exactly what this parent will receive. */
  body: string;
  charCount: number;
  smsParts: number;
  isUnicode: boolean;
}

export interface PreviewResult {
  samples: PreviewSample[];
  /** Recipients who will actually receive the message. */
  recipientCount: number;
  skippedCount: number;
  skipped: RecipientSkip[];
  /** Worst-case counts over the samples (longest rendered body). */
  charCount: number;
  smsParts: number;
  isUnicode: boolean;
  variablesUsed: string[];
}

export interface SendResult {
  draftId: string;
  queued: number;
  queueIds: string[];
  skipped: RecipientSkip[];
  skippedOptedOut: number;
}

/** Queue type a draft sends as. 'custom' is the default (Section 11
 *  drafts); announcement SMS sends as 'announcement' so the log/filter
 *  shows it as such. The dedupe key is prefixed with the same type. */
export type DraftQueueType = 'custom' | 'announcement' | 'result';
export function dedupeKeyForQueueType(type: DraftQueueType, draftId: string, studentId: string): string {
  if (type === 'custom') return dedupeKeyCustom(draftId, studentId);
  return `${type}:${draftId}:${studentId}`;
}

/** School-local YYYY-MM-DD for an instant (Intl, no date-library dep). */
export function schoolLocalDate(timezone: string, now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return parts; // en-CA yields YYYY-MM-DD
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { code: 'NOT_FOUND' });
}
function validation(message: string): Error {
  return Object.assign(new Error(message), { code: 'VALIDATION' });
}
function conflict(message: string): Error {
  return Object.assign(new Error(message), { code: 'CONFLICT' });
}

export function validateDraftInput(input: {
  recipientType: string;
  targetClassId?: string | null;
  targetStudentIds?: string[];
  body: string;
}): void {
  const { recipientType, targetClassId, targetStudentIds, body } = input;
  if (!['all_parents', 'class', 'selected_students', 'single_parent'].includes(recipientType)) {
    throw validation(`recipient_type must be one of: all_parents, class, selected_students, single_parent`);
  }
  if (!body || !body.trim()) throw validation('Body must not be empty');
  if (recipientType === 'class' && !targetClassId) {
    throw validation('target_class_id is required for recipient_type=class');
  }
  if (recipientType === 'selected_students' && (!targetStudentIds || targetStudentIds.length === 0)) {
    throw validation('target_student_ids is required for recipient_type=selected_students');
  }
  if (recipientType === 'single_parent') {
    if (!targetStudentIds || targetStudentIds.length !== 1) {
      throw validation('target_student_ids must contain exactly one student for recipient_type=single_parent');
    }
  }
}

function varsForRecipient(
  recipient: RecipientStudent,
  schoolName: string,
  date: string,
  month: string,
): TemplateVars {
  return {
    student_name: recipient.name,
    father_name: recipient.fatherName ?? undefined,
    class: recipient.className,
    section: recipient.section,
    date,
    month,
    amount: recipient.amountDue !== undefined ? String(recipient.amountDue) : undefined,
    school_name: schoolName,
  };
}

interface Classified {
  sendable: Array<{ recipient: RecipientStudent; e164: string }>;
  skipped: RecipientSkip[];
}

/** Split resolved recipients into sendable vs skipped (opt-out / phone). */
function classifyRecipients(
  recipients: RecipientStudent[],
  cryptoImpl: PhoneCrypto,
): Classified {
  const sendable: Classified['sendable'] = [];
  const skipped: RecipientSkip[] = [];
  for (const r of recipients) {
    if (r.parentOptOut) {
      skipped.push({ studentId: r.id, studentName: r.name, reason: 'opted_out' });
      continue;
    }
    if (!r.parentPhoneEnc) {
      skipped.push({ studentId: r.id, studentName: r.name, reason: 'missing_phone' });
      continue;
    }
    let e164: string | null = null;
    try {
      e164 = normalizePK(cryptoImpl.decrypt(r.parentPhoneEnc));
    } catch {
      e164 = null;
    }
    if (!e164 || !isValidPK(e164)) {
      skipped.push({ studentId: r.id, studentName: r.name, reason: 'invalid_phone' });
      continue;
    }
    sendable.push({ recipient: r, e164 });
  }
  return { sendable, skipped };
}

/**
 * Live preview: resolve recipients, render the first 3 sendable bodies
 * (exactly what each parent will receive), count characters + SMS parts
 * (160 GSM / 70 Unicode — see templates.smsPartCount), and report the
 * recipient + skipped/opted-out counts. Pure read — queues nothing.
 */
export async function previewMessage(
  deps: CustomMessagesDeps,
  input: {
    schoolId: string;
    body?: string;
    templateId?: string;
    recipientType: RecipientQuery['recipientType'];
    targetClassId?: string | null;
    targetStudentIds?: string[];
    filter?: RecipientQuery['filter'];
    date?: string;
    month?: string;
  },
): Promise<PreviewResult> {
  const { store } = deps;
  const cryptoImpl = deps.crypto ?? defaultCrypto;
  const now = deps.now ?? (() => new Date());

  let body = input.body;
  if (!body && input.templateId) {
    const template = await store.getTemplateById(input.templateId, input.schoolId);
    if (!template) throw notFound('Template not found');
    body = template.body;
  }
  if (!body || !body.trim()) throw validation('Provide a body or a template_id');
  body = body.trim();

  const school = await store.getSchool(input.schoolId);
  const schoolName = school?.name ?? '';
  const timezone = school?.timezone ?? 'Asia/Karachi';
  const today = schoolLocalDate(timezone, now());
  const date = input.date ?? today;
  const month = input.month ?? today.slice(0, 7);

  const recipients = await store.listRecipients(input.schoolId, {
    recipientType: input.recipientType,
    targetClassId: input.targetClassId,
    targetStudentIds: input.targetStudentIds,
    filter: input.filter,
    date,
    month,
  });
  const { sendable, skipped } = classifyRecipients(recipients, cryptoImpl);

  const samples: PreviewSample[] = [];
  for (const { recipient, e164 } of sendable.slice(0, 3)) {
    const rendered = renderTemplate(body, varsForRecipient(recipient, schoolName, date, month));
    const count = smsPartCount(rendered);
    samples.push({
      studentId: recipient.id,
      studentName: recipient.name,
      parentPhoneMasked: maskPhone(e164) ?? '+92 3XX XXXX???',
      body: rendered,
      charCount: count.length,
      smsParts: count.parts,
      isUnicode: count.isUnicode,
    });
  }

  // Top-level counts = worst case over the samples; with no sendable
  // recipients, count the raw body (variables literal) so the UI still
  // shows a number.
  const counted = samples.length > 0
    ? samples.reduce((worst, s) => (s.charCount > worst.charCount ? s : worst), samples[0])
    : (() => {
        const c = smsPartCount(body);
        return { charCount: c.length, smsParts: c.parts, isUnicode: c.isUnicode };
      })();

  return {
    samples,
    recipientCount: sendable.length,
    skippedCount: skipped.length,
    skipped,
    charCount: counted.charCount,
    smsParts: counted.smsParts,
    isUnicode: counted.isUnicode,
    variablesUsed: variablesUsed(body),
  };
}

/** Resolve + classify a draft's recipients (shared by preview/send paths). */
async function resolveDraftRecipients(
  deps: CustomMessagesDeps,
  schoolId: string,
  draft: DraftRow,
  timezone: string,
  now: Date,
): Promise<{ sendable: Classified['sendable']; skipped: RecipientSkip[]; date: string; month: string }> {
  const { store } = deps;
  const cryptoImpl = deps.crypto ?? defaultCrypto;
  const date = schoolLocalDate(timezone, now);
  const month = date.slice(0, 7);
  const recipients = await store.listRecipients(schoolId, {
    recipientType: draft.recipientType,
    targetClassId: draft.targetClassId,
    targetStudentIds: draft.targetStudentIds,
    date,
    month,
  });
  const { sendable, skipped } = classifyRecipients(recipients, cryptoImpl);
  return { sendable, skipped, date, month };
}

/**
 * Build message_queue rows for an APPROVED draft and mark it sent.
 * Only ever called after an approval (direct approve-send, an approved
 * approval_requests row, or the scheduled job's approval check). Rows are
 * created approved (approved_by/at set, scheduled_for staggered 2 s apart
 * — the v1 SIM rate limit), so the companion app can pick them up.
 * Idempotent per recipient: dedupe `{queueType}:{draftId}:{studentId}`.
 */
export async function sendDraft(
  deps: CustomMessagesDeps,
  input: { schoolId: string; draftId: string; approvedBy: string | null; queueType?: DraftQueueType },
): Promise<SendResult> {
  const { store } = deps;
  const cryptoImpl = deps.crypto ?? defaultCrypto;
  const now = deps.now ?? (() => new Date());
  const queueType: DraftQueueType = input.queueType ?? 'custom';

  const draft = await store.getDraftById(input.draftId, input.schoolId);
  if (!draft) throw notFound('Draft not found');
  if (draft.status === 'sent') throw conflict('Draft has already been sent');
  if (draft.status === 'cancelled') throw validation('Draft was cancelled');

  const school = await store.getSchool(input.schoolId);
  const schoolName = school?.name ?? '';
  const timezone = school?.timezone ?? 'Asia/Karachi';
  const at = now();
  const { sendable, skipped, date, month } = await resolveDraftRecipients(
    deps, input.schoolId, draft, timezone, at,
  );

  const queueIds: string[] = [];
  let slot = 0;
  for (const { recipient, e164 } of sendable) {
    const body = renderTemplate(draft.body, varsForRecipient(recipient, schoolName, date, month));
    const dedupeKey = dedupeKeyForQueueType(queueType, draft.id, recipient.id);
    const existing = await store.findQueueByDedupeKey(dedupeKey, input.schoolId);
    if (existing) {
      skipped.push({ studentId: recipient.id, studentName: recipient.name, reason: 'already_queued' });
      continue;
    }
    const { row } = await store.createQueue({
      schoolId: input.schoolId,
      type: queueType,
      studentId: recipient.id,
      classId: recipient.classId,
      parentPhoneEnc: cryptoImpl.encrypt(e164),
      body,
      dedupeKey,
      scheduledFor: new Date(at.getTime() + slot * 2000),
    });
    // Same as the v1 approval flow: the row is born approved.
    await store.updateQueue(row.id, {
      approvedBy: input.approvedBy,
      approvedAt: at,
      scheduledFor: new Date(at.getTime() + slot * 2000),
    }, input.schoolId);
    queueIds.push(row.id);
    slot += 1;
  }

  await store.updateDraft(draft.id, { status: 'sent' }, input.schoolId);
  await store.createAuditLog({
    schoolId: input.schoolId,
    actorId: input.approvedBy,
    actorType: 'user',
    action: 'draft.send',
    entity: 'message_draft',
    entityId: draft.id,
    details: { queued: queueIds.length, skipped: skipped.length, skipped_opted_out: skipped.filter((s) => s.reason === 'opted_out').length },
  });

  return {
    draftId: draft.id,
    queued: queueIds.length,
    queueIds,
    skipped,
    skippedOptedOut: skipped.filter((s) => s.reason === 'opted_out').length,
  };
}

/**
 * Apply an already-approved draft: send now, unless it carries a future
 * scheduled_for — then it becomes 'scheduled' and the scheduled-messages
 * job picks it up when due (the job re-checks the approval). Shared by the
 * direct approve-send path and the approval_requests applier.
 */
export async function applyApprovedDraft(
  deps: CustomMessagesDeps,
  input: { schoolId: string; draftId: string; approvedBy: string; queueType?: DraftQueueType },
): Promise<SendResult | { draftId: string; scheduled: true; scheduledFor: Date }> {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const draft = await store.getDraftById(input.draftId, input.schoolId);
  if (!draft) throw notFound('Draft not found');
  if (draft.status === 'sent') throw conflict('Draft has already been sent');
  if (draft.status === 'cancelled') throw validation('Draft was cancelled');

  const at = now();
  if (draft.scheduledFor && draft.scheduledFor.getTime() > at.getTime()) {
    await store.updateDraft(draft.id, { status: 'scheduled' }, input.schoolId);
    return { draftId: draft.id, scheduled: true, scheduledFor: draft.scheduledFor };
  }
  return sendDraft(deps, input);
}

/**
 * Direct admin approve-send (POST /messages/drafts/:id/approve-send):
 * records an APPROVED approval_requests row as the audit trail, then
 * applies the draft (send now, or schedule it for later).
 */
export async function approveDraftForSending(
  deps: CustomMessagesDeps,
  input: { schoolId: string; draftId: string; approvedBy: string; queueType?: DraftQueueType },
): Promise<SendResult | { draftId: string; scheduled: true; scheduledFor: Date }> {
  const { store } = deps;
  const draft = await store.getDraftById(input.draftId, input.schoolId);
  if (!draft) throw notFound('Draft not found');
  await store.recordDraftApproval({
    schoolId: input.schoolId,
    draftId: draft.id,
    adminId: input.approvedBy,
    payload: { draft_id: draft.id, scheduled_for: draft.scheduledFor?.toISOString() ?? null, queue_type: input.queueType ?? 'custom' },
  });
  return applyApprovedDraft(deps, input);
}

/**
 * Scheduled-messages job core (one school): pick up due 'scheduled'
 * drafts and send them — but ONLY when an approved approval_requests row
 * exists for the draft. A scheduled draft without approval stays
 * scheduled and is reported, never sent.
 */
export async function processDueScheduledDrafts(
  deps: CustomMessagesDeps,
  input: { schoolId: string },
): Promise<{
  checked: number;
  sent: number;
  skippedUnapproved: number;
  errors: Array<{ draftId: string; error: string }>;
}> {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const at = now();
  const { items } = await store.listDrafts(input.schoolId, {
    status: 'scheduled',
    page: 1,
    limit: 100,
  });
  const due = items.filter((d) => d.scheduledFor && d.scheduledFor.getTime() <= at.getTime());
  let sent = 0;
  let skippedUnapproved = 0;
  const errors: Array<{ draftId: string; error: string }> = [];
  for (const draft of due) {
    const approved = await store.hasApprovedDraftApproval(draft.id, input.schoolId);
    if (!approved) {
      skippedUnapproved += 1;
      continue;
    }
    // The approver is the admin who decided the approval request (a UUID —
    // message_queue.approved_by / audit_logs.actor_id are UUID columns, so
    // the literal 'system' would be rejected by Prisma).
    const approval = await store.getDraftApproval(draft.id, input.schoolId);
    try {
      await sendDraft(deps, { schoolId: input.schoolId, draftId: draft.id, approvedBy: approval?.decidedBy ?? null });
      sent += 1;
    } catch (err) {
      errors.push({ draftId: draft.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { checked: due.length, sent, skippedUnapproved, errors };
}
