// Announcements — notice board ONLY (6C-2).
// Title, body, audience (all classes or one specific class), date
// (created_at), pinned is NOT a schema column — pinning is done by ordering
// (see listAnnouncements: approved+recent first is NOT pinning; see below).
//
// PINNING NOTE: `announcements` has no `pinned` column in the v2 schema and
// this phase does not change the schema, so there is no persisted pinned
// flag. The list orders by created_at desc; the frontend keeps a
// per-browser pinned set in localStorage (see FEATURES-6C2.md). If a
// persisted pin is ever needed it is one nullable boolean column away.
//
// SMS: wired in Phase 8 QA (was a 501 hook point in 6C-2).
// `POST /announcements/:id/send` (admin only) turns an APPROVED
// announcement with sms_send=true into a Section 11 message draft
// (recipients per the announcement's audience: all parents, or one
// class) and routes it through the existing draft → approval → queue
// flow via CustomMessages approve-send — the same path as
// POST /messages/drafts/:id/approve-send. The admin already approved
// the announcement itself, so /send records that same admin approval
// on the draft (an APPROVED approval_requests row) and sends now.
// Queue rows are type 'announcement' (dedupe
// `announcement:{draftId}:{studentId}`); opted-out / missing / invalid
// numbers are auto-excluded with a skipped count, exactly as for custom
// drafts. There is NO second sending path and this module never writes
// message_queue rows directly. If nobody is queueable (queued == 0) the
// announcement stays 'approved' so the admin can retry after fixing
// numbers/opt-outs; it flips to 'sent' only once >= 1 row is queued.

import { ApiError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { writeChangeLogs } from '../hardening/helpers';
import type { Db } from '../../lib/db';
import type { SendResult } from '../messaging/custom-messages';

export interface AnnouncementView {
  id: string;
  title: string;
  body: string;
  target_type: 'all' | 'class';
  target_class_id: string | null;
  target_class_name: string | null;
  sms_send: boolean;
  status: 'draft' | 'approved' | 'sent';
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function toView(r: any, className: string | null): AnnouncementView {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    target_type: r.targetType,
    target_class_id: r.targetClassId ?? null,
    target_class_name: className,
    sms_send: r.smsSend ?? false,
    status: r.status,
    created_by: r.createdBy ?? null,
    created_at: r.createdAt ? new Date(r.createdAt).toISOString() : new Date().toISOString(),
    updated_at: r.updatedAt ? new Date(r.updatedAt).toISOString() : new Date().toISOString(),
  };
}

async function assertTargetClass(db: Db, schoolId: string, targetClassId: string | undefined): Promise<string | null> {
  if (!targetClassId) return null;
  const klass: any = await db.class.findFirst({ where: { id: targetClassId, schoolId, deletedAt: null } });
  if (!klass) throw ApiError.notFound('Target class not found');
  return `${klass.name}-${klass.section}`;
}

export async function listAnnouncements(
  db: Db,
  schoolId: string,
  query: { status?: string; page?: number; limit?: number },
): Promise<{ items: AnnouncementView[]; total: number; page: number; pages: number }> {
  const where: Record<string, unknown> = { schoolId };
  if (query.status) {
    if (!['draft', 'approved', 'sent'].includes(query.status)) throw ApiError.validation('status must be draft, approved or sent');
    where.status = query.status;
  }
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(200, Math.max(1, query.limit ?? 50));
  const [rows, total] = await Promise.all([
    db.announcement.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    db.announcement.count({ where }),
  ]);
  const classes: any[] = await db.class.findMany({ where: { schoolId } });
  const nameById = new Map(classes.map((c: any) => [c.id, `${c.name}-${c.section}`]));
  return {
    items: rows.map((r: any) => toView(r, r.targetClassId ? nameById.get(r.targetClassId) ?? null : null)),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

export async function getAnnouncement(db: Db, schoolId: string, id: string): Promise<AnnouncementView> {
  const row: any = await db.announcement.findFirst({ where: { id, schoolId } });
  if (!row) throw ApiError.notFound('Announcement not found');
  const className = row.targetClassId ? await assertTargetClass(db, schoolId, row.targetClassId) : null;
  return toView(row, className);
}

export async function createAnnouncement(
  db: Db,
  schoolId: string,
  input: { title: string; body: string; target_type?: string; target_class_id?: string; sms_send?: boolean },
  actorId: string,
): Promise<AnnouncementView> {
  if (typeof input.title !== 'string' || input.title.trim().length < 2 || input.title.trim().length > 200) {
    throw ApiError.validation('title is required (2–200 chars)');
  }
  if (typeof input.body !== 'string' || input.body.trim().length === 0 || input.body.trim().length > 5000) {
    throw ApiError.validation('body is required (max 5000 chars)');
  }
  const targetType = input.target_type ?? 'all';
  if (targetType !== 'all' && targetType !== 'class') throw ApiError.validation("target_type must be 'all' or 'class'");
  if (targetType === 'class' && !input.target_class_id) throw ApiError.validation('target_class_id is required when target_type is class');
  if (targetType === 'all' && input.target_class_id) throw ApiError.validation('target_class_id must be empty when target_type is all');
  const className = await assertTargetClass(db, schoolId, input.target_class_id);
  const created: any = await db.announcement.create({
    data: {
      schoolId,
      title: input.title.trim(),
      body: input.body.trim(),
      targetType,
      targetClassId: input.target_class_id ?? null,
      smsSend: input.sms_send === true,
      status: 'draft',
      createdBy: actorId,
    },
  });
  await writeAudit(db, {
    schoolId,
    actorId,
    actorType: 'user',
    action: 'announcement.create',
    entity: 'announcement',
    entityId: created.id,
    details: { title: created.title, target_type: targetType },
  });
  return toView(created, className);
}

export async function updateAnnouncement(
  db: Db,
  schoolId: string,
  id: string,
  patch: { title?: string; body?: string; target_type?: string; target_class_id?: string | null; sms_send?: boolean },
  actorId: string,
): Promise<AnnouncementView> {
  const existing: any = await db.announcement.findFirst({ where: { id, schoolId } });
  if (!existing) throw ApiError.notFound('Announcement not found');
  if (existing.status === 'sent') throw ApiError.conflict('A sent announcement cannot be edited');
  const data: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string' || patch.title.trim().length < 2) throw ApiError.validation('title is required (2–200 chars)');
    data.title = patch.title.trim();
  }
  if (patch.body !== undefined) {
    if (typeof patch.body !== 'string' || patch.body.trim().length === 0) throw ApiError.validation('body is required');
    data.body = patch.body.trim();
  }
  if (patch.target_type !== undefined) {
    if (patch.target_type !== 'all' && patch.target_type !== 'class') throw ApiError.validation("target_type must be 'all' or 'class'");
    data.targetType = patch.target_type;
  }
  const targetType = (data.targetType as string) ?? existing.targetType;
  if (patch.target_class_id !== undefined) data.targetClassId = patch.target_class_id;
  const targetClassId = (data.targetClassId as string | null | undefined) ?? existing.targetClassId;
  if (targetType === 'class' && !targetClassId) throw ApiError.validation('target_class_id is required when target_type is class');
  if (targetType === 'all') data.targetClassId = null;
  if (patch.sms_send !== undefined) data.smsSend = patch.sms_send === true;
  const before = { title: existing.title, body: existing.body, target_type: existing.targetType, target_class_id: existing.targetClassId ?? null, sms_send: existing.smsSend ?? false };
  const updated: any = await db.announcement.update({ where: { id }, data });
  await writeChangeLogs(db, {
    schoolId,
    actorId,
    entity: 'announcement',
    entityId: id,
    before,
    after: { title: updated.title, body: updated.body, target_type: updated.targetType, target_class_id: updated.targetClassId ?? null, sms_send: updated.smsSend ?? false },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'announcement.update', entity: 'announcement', entityId: id, details: {} });
  const className = updated.targetClassId ? await assertTargetClass(db, schoolId, updated.targetClassId) : null;
  return toView(updated, className);
}

export async function approveAnnouncement(db: Db, schoolId: string, id: string, actorId: string): Promise<AnnouncementView> {
  const existing: any = await db.announcement.findFirst({ where: { id, schoolId } });
  if (!existing) throw ApiError.notFound('Announcement not found');
  if (existing.status !== 'draft') throw ApiError.conflict(`Only a draft can be approved (current status: ${existing.status})`);
  const before = { status: existing.status };
  const updated: any = await db.announcement.update({ where: { id }, data: { status: 'approved' } });
  await writeChangeLogs(db, { schoolId, actorId, entity: 'announcement', entityId: id, before, after: { status: 'approved' } });
  await writeAudit(db, {
    schoolId,
    actorId,
    actorType: 'user',
    action: 'announcement.approve',
    entity: 'announcement',
    entityId: id,
    details: { sms_send: existing.smsSend ?? false, note: 'Approved for the notice board. SMS (if sms_send) is sent via POST /announcements/:id/send, which routes through the Section 11 draft → approval → queue flow — no message_queue rows were created by approving.' },
  });
  const className = updated.targetClassId ? await assertTargetClass(db, schoolId, updated.targetClassId) : null;
  return toView(updated, className);
}

export async function deleteAnnouncement(db: Db, schoolId: string, id: string, actorId: string): Promise<void> {
  const existing: any = await db.announcement.findFirst({ where: { id, schoolId } });
  if (!existing) throw ApiError.notFound('Announcement not found');
  await db.announcement.delete({ where: { id } });
  await writeAudit(db, {
    schoolId,
    actorId,
    actorType: 'user',
    action: 'announcement.delete',
    entity: 'announcement',
    entityId: id,
    details: { title: existing.title, status: existing.status },
  });
}

/** Messaging deps for sendAnnouncementSms — injected so unit tests can
 *  use fakes; the route passes the real Prisma messaging store +
 *  approveDraftForSending (see routes.ts). */
export interface AnnouncementSmsDeps {
  createDraft(input: {
    schoolId: string;
    createdBy: string | null;
    recipientType: 'all_parents' | 'class';
    targetClassId: string | null;
    targetStudentIds: string[];
    body: string;
  }): Promise<{ id: string }>;
  approveDraftForSending(input: {
    schoolId: string;
    draftId: string;
    approvedBy: string;
    queueType: 'announcement';
  }): Promise<SendResult | { draftId: string; scheduled: true; scheduledFor: Date }>;
}

export interface AnnouncementSmsResult {
  announcement: AnnouncementView;
  draft_id: string;
  queued: number;
  queue_ids: string[];
  skipped: Array<{ studentId: string; studentName: string; reason: string }>;
  skipped_opted_out: number;
}

/**
 * Send an approved announcement by SMS (Phase 8 QA — the former 501).
 * Guards, in order: announcement exists in this school (404), not
 * already sent (409), approved (409 otherwise), sms_send=true (409
 * otherwise). Creates a Section 11 message_draft addressed per the
 * announcement's audience, then routes it through the existing
 * draft → approval → queue path (approveDraftForSending, queue type
 * 'announcement'). Marks the announcement 'sent' only when >= 1 queue
 * row was built; with 0 queueable recipients it stays 'approved' so
 * the admin can retry. Never writes message_queue rows directly.
 */
export async function sendAnnouncementSms(
  db: Db,
  schoolId: string,
  id: string,
  actorId: string,
  deps: AnnouncementSmsDeps,
): Promise<AnnouncementSmsResult> {
  const existing: any = await db.announcement.findFirst({ where: { id, schoolId } });
  if (!existing) throw ApiError.notFound('Announcement not found');
  if (existing.status === 'sent') throw ApiError.conflict('This announcement has already been sent by SMS');
  if (existing.status !== 'approved') {
    throw ApiError.conflict(`Only an approved announcement can be sent by SMS (current status: ${existing.status}). Approve it first.`);
  }
  if (!existing.smsSend) {
    throw ApiError.conflict('This announcement was not marked for SMS (sms_send=false). Enable SMS on the announcement and approve it again.');
  }
  const className = existing.targetClassId ? await assertTargetClass(db, schoolId, existing.targetClassId) : null;
  const view = toView(existing, className);
  const draft = await deps.createDraft({
    schoolId,
    createdBy: actorId,
    recipientType: existing.targetType === 'class' ? 'class' : 'all_parents',
    targetClassId: existing.targetClassId ?? null,
    targetStudentIds: [],
    body: `${existing.title}\n${existing.body}`,
  });
  const result = await deps.approveDraftForSending({
    schoolId,
    draftId: draft.id,
    approvedBy: actorId,
    queueType: 'announcement',
  });
  if ('scheduled' in result) {
    throw ApiError.conflict('The announcement draft was scheduled instead of sent — it has no scheduled time, so this should not happen');
  }
  const sendResult = result as SendResult;
  if (sendResult.queued > 0) {
    const before = { status: existing.status };
    const updated: any = await db.announcement.update({ where: { id }, data: { status: 'sent' } });
    await writeChangeLogs(db, { schoolId, actorId, entity: 'announcement', entityId: id, before, after: { status: 'sent' } });
    await writeAudit(db, {
      schoolId, actorId, actorType: 'user', action: 'announcement.send', entity: 'announcement', entityId: id,
      details: { draft_id: draft.id, queued: sendResult.queued, skipped: sendResult.skipped.length },
    });
    return {
      announcement: toView(updated, className),
      draft_id: draft.id,
      queued: sendResult.queued,
      queue_ids: sendResult.queueIds,
      skipped: sendResult.skipped,
      skipped_opted_out: sendResult.skippedOptedOut,
    };
  }
  await writeAudit(db, {
    schoolId, actorId, actorType: 'user', action: 'announcement.send_no_recipients', entity: 'announcement', entityId: id,
    details: { draft_id: draft.id, queued: 0, skipped: sendResult.skipped.length, note: 'No queueable recipients — announcement stays approved so it can be retried.' },
  });
  return {
    announcement: view,
    draft_id: draft.id,
    queued: 0,
    queue_ids: [],
    skipped: sendResult.skipped,
    skipped_opted_out: sendResult.skippedOptedOut,
  };
}