/**
 * Approval queue (6A, contracts/SCHEMA.md §3).
 *
 * Clerk add/update/delete/bulk actions NEVER apply directly: they create an
 * approval_requests row (action_type, entity, entity_id, payload JSONB,
 * status pending) and the caller gets 202 + the request id. An admin
 * approves (the payload is applied via the existing service function) or
 * rejects. Every decision writes an audit log + a notification.
 *
 * Payload conventions (see HARDENING.md for the full table):
 *  student.create  {class_id, ...student fields}
 *  student.update  {id, patch} | {id, parent: {...}} (parent-only update)
 *  student.delete  {id}
 *  class.create    {name, section, teacher_name, teacher_phone?}
 *  class.update    {id, patch}
 *  class.delete    {id}
 *  fee_record.update {student_id, month, amount_paid, discount?, payment_method?, receipt?} (pay)
 *  fee_structure.create {class_id, monthly_amount, effective_from, ...}
 *  fee_structure.update {id, patch}
 *  fee_structure.delete {id}
 *  holiday.create  {date, name}
 *  holiday.delete  {id}
 *  message_template.update {id, patch: {body?, name?, type?, language?}}
 *  message_draft.create {draft_id, recipient_type, body, ...} (Section 11)
 *  user.create     {email, password} (clerk)
 *  user.delete     {id}
 */
import { ApiError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { paginatedResponse, parsePagination } from '../../lib/pagination';
import type { Db } from '../../lib/db';
import { notifyAdmins, softDeleteEntity, writeChangeLogs } from './helpers';
import * as studentsSvc from '../students/service';
import * as classesSvc from '../classes/service';
// --- 6B: approval appliers for results / result sheets ---
import * as resultsSvc from '../results/service';
import * as feesSvc from '../fees/service';
import * as adminSvc from '../admin/service';
// --- Section 11 (Custom Messages): draft sends via the approval queue ---
import { createPrismaMessagingStore } from '../messaging/store';
import { applyApprovedDraft } from '../messaging/custom-messages';
// --- 6C-1: approval appliers for sessions / exams / timetable / staff ---
import * as sessionsSvc from '../sessions/service';
import * as examsSvc from '../exams/service';
import * as timetableSvc from '../timetable/service';
import * as staffSvc from '../staff/service';
// --- 6C-2: approval appliers for expenses / announcements / events / certificates ---
import * as expensesSvc from '../expenses/service';
import * as announcementsSvc from '../announcements/service';
import * as eventsSvc from '../events/service';
import * as certificatesSvc from '../certificates/service';
import { generateVoucher } from '../fees/vouchers';

const ACTION_TYPES = ['create', 'update', 'delete', 'bulk'];

/** Public (snake_case) view of an approval_requests row. */
export function toPublicApproval(r: any): Record<string, unknown> {
  return {
    id: r.id,
    school_id: r.schoolId,
    requested_by: r.requestedBy,
    action_type: r.actionType,
    entity: r.entity,
    entity_id: r.entityId ?? null,
    payload: r.payload,
    status: r.status,
    decided_by: r.decidedBy ?? null,
    decided_at: r.decidedAt ?? null,
    created_at: r.createdAt,
  };
}

export interface ApprovalInput {
  action_type: string;
  entity: string;
  entity_id?: string | null;
  payload: Record<string, unknown>;
}

function describeRequest(actionType: string, entity: string, payload: Record<string, unknown>): string {
  const id = (payload.id as string | undefined) ?? '';
  const name =
    (payload.name as string | undefined) ??
    (payload.email as string | undefined) ??
    (payload.student_id as string | undefined) ??
    '';
  return `${actionType} ${entity}${name ? ` (${name})` : ''}${id ? ` [${id.slice(0, 8)}]` : ''}`;
}

export async function createApprovalRequest(
  db: Db,
  input: { schoolId: string; requestedBy: string; actionType: string; entity: string; entityId?: string | null; payload: Record<string, unknown> },
): Promise<any> {
  if (!ACTION_TYPES.includes(input.actionType)) {
    throw ApiError.validation(`action_type must be one of: ${ACTION_TYPES.join(', ')}`);
  }
  if (!input.entity || typeof input.entity !== 'string') throw ApiError.validation('entity is required');
  if (!input.payload || typeof input.payload !== 'object') throw ApiError.validation('payload is required');
  const created = await (db as any).approvalRequest.create({
    data: {
      schoolId: input.schoolId,
      requestedBy: input.requestedBy,
      actionType: input.actionType,
      entity: input.entity,
      entityId: input.entityId ?? null,
      payload: input.payload,
      status: 'pending',
    },
  });
  await writeAudit(db, {
    schoolId: input.schoolId,
    actorId: input.requestedBy,
    actorType: 'user',
    action: 'approval.requested',
    entity: 'approval_request',
    entityId: created.id,
    details: { action_type: input.actionType, entity: input.entity, entity_id: input.entityId ?? null },
  });
  await notifyAdmins(db, input.schoolId, {
    type: 'approval_requested',
    title: 'Approval requested',
    body: `A clerk requested: ${describeRequest(input.actionType, input.entity, input.payload)}. Review it in the approval queue.`,
    relatedType: 'approval_request',
    relatedId: created.id,
  });
  return created;
}

export async function listApprovalRequests(
  db: Db,
  schoolId: string,
  query: Record<string, any>,
  requestedBy?: string | null,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  const where: Record<string, unknown> = { schoolId };
  if (query.status) where.status = String(query.status);
  if (requestedBy) where.requestedBy = requestedBy;
  const [items, total] = await Promise.all([
    (db as any).approvalRequest.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip, take: limit }),
    (db as any).approvalRequest.count({ where }),
  ]);
  return paginatedResponse(items.map(toPublicApproval), total, { page, limit, skip });
}

export async function getApprovalRequest(db: Db, schoolId: string, id: string): Promise<any> {
  const row = await (db as any).approvalRequest.findFirst({ where: { id, schoolId } });
  if (!row) throw ApiError.notFound('Approval request not found');
  return row;
}

/** Apply an approved request's payload via the existing service function. Returns a short summary. */
export async function applyApproval(db: Db, schoolId: string, req: any, adminId: string): Promise<Record<string, unknown>> {
  const payload = (req.payload ?? {}) as Record<string, unknown>;
  const entity = req.entity as string;
  const actionType = req.actionType as string;

  if (entity === 'student') {
    if (actionType === 'create') {
      const classId = payload.class_id as string;
      if (!classId) throw ApiError.validation('payload.class_id is required for student.create');
      const created = await studentsSvc.createStudent(db, schoolId, classId, payload as any, adminId);
      return { student_id: created.id };
    }
    if (actionType === 'update') {
      const id = (payload.id as string) ?? req.entityId;
      if (!id) throw ApiError.validation('payload.id is required for student.update');
      if (payload.parent && typeof payload.parent === 'object') {
        const updated = await studentsSvc.updateParent(db, schoolId, id, payload.parent as any, adminId);
        return { student_id: updated.id };
      }
      const updated = await studentsSvc.updateStudent(db, schoolId, id, (payload.patch ?? {}) as any, adminId);
      return { student_id: updated.id };
    }
    if (actionType === 'delete') {
      const id = (payload.id as string) ?? req.entityId;
      if (!id) throw ApiError.validation('payload.id is required for student.delete');
      await softDeleteEntity(db, { schoolId, entity: 'student', entityId: id, deletedBy: adminId });
      return { student_id: id, soft_deleted: true };
    }
    if (actionType === 'bulk') {
      const classId = payload.class_id as string;
      if (!classId) throw ApiError.validation('payload.class_id is required for student bulk import');
      const rows = (payload.rows ?? []) as any[];
      const result = await studentsSvc.importStudents(db, schoolId, classId, rows, adminId);
      return { imported: result.imported, duplicates_flagged: result.duplicates_flagged, invalid_rows: result.invalid_rows.length };
    }
  }

  if (entity === 'class') {
    if (actionType === 'create') {
      const created = await classesSvc.createClass(db, schoolId, payload as any, adminId);
      return { class_id: created.id };
    }
    if (actionType === 'update') {
      const id = (payload.id as string) ?? req.entityId;
      if (!id) throw ApiError.validation('payload.id is required for class.update');
      const updated = await classesSvc.updateClass(db, schoolId, id, (payload.patch ?? {}) as any, adminId);
      return { class_id: updated.id };
    }
    if (actionType === 'delete') {
      const id = (payload.id as string) ?? req.entityId;
      if (!id) throw ApiError.validation('payload.id is required for class.delete');
      const students = await db.student.count({ where: { classId: id, schoolId, deletedAt: null } });
      if (students > 0) throw ApiError.conflict('Cannot delete a class that has students. Move or remove the students first.');
      await softDeleteEntity(db, { schoolId, entity: 'class', entityId: id, deletedBy: adminId });
      return { class_id: id, soft_deleted: true };
    }
  }

  if (entity === 'fee_record' && actionType === 'update') {
    const studentId = payload.student_id as string;
    if (!studentId) throw ApiError.validation('payload.student_id is required for fee pay');
    const receipt = await feesSvc.payFee(db, schoolId, studentId, payload as any, adminId);
    return { receipt_no: receipt.receipt_no };
  }

  if (entity === 'fee_structure') {
    if (actionType === 'create') {
      const created = await feesSvc.createFeeStructure(db, schoolId, payload as any, undefined, adminId);
      return { fee_structure_id: created.id };
    }
    if (actionType === 'update') {
      const id = (payload.id as string) ?? req.entityId;
      if (!id) throw ApiError.validation('payload.id is required for fee_structure.update');
      const updated = await feesSvc.updateFeeStructure(db, schoolId, id, (payload.patch ?? {}) as any, adminId);
      return { fee_structure_id: updated.id };
    }
    if (actionType === 'delete') {
      const id = (payload.id as string) ?? req.entityId;
      if (!id) throw ApiError.validation('payload.id is required for fee_structure.delete');
      await feesSvc.deleteFeeStructure(db, schoolId, id, adminId);
      return { fee_structure_id: id, deleted: true };
    }
  }

  if (entity === 'holiday') {
    if (actionType === 'create') {
      const created = await adminSvc.createHoliday(db, schoolId, payload as any, adminId);
      return { holiday_id: created.id };
    }
    if (actionType === 'delete') {
      const id = (payload.id as string) ?? req.entityId;
      if (!id) throw ApiError.validation('payload.id is required for holiday.delete');
      await adminSvc.deleteHoliday(db, schoolId, id, adminId);
      return { holiday_id: id, deleted: true };
    }
  }

  if (entity === 'message_template' && actionType === 'update') {
    const id = (payload.id as string) ?? req.entityId;
    if (!id) throw ApiError.validation('payload.id is required for message_template.update');
    const patch = (payload.patch ?? {}) as Record<string, unknown>;
    const before = await db.messageTemplate.findFirst({ where: { id, schoolId } });
    if (!before) throw ApiError.notFound('Message template not found');
    const data: Record<string, unknown> = {};
    if (patch.body !== undefined) data.body = String(patch.body).trim();
    if (patch.name !== undefined) data.name = patch.name === null ? null : String(patch.name);
    if (patch.type !== undefined) data.type = String(patch.type);
    if (patch.language !== undefined) data.language = String(patch.language);
    // Snapshot before-values BEFORE the update (in-place mutation would erase them).
    const beforeTemplate = { body: before.body, name: before.name ?? null, type: before.type, language: before.language };
    const updated = await db.messageTemplate.update({ where: { id }, data });
    await writeChangeLogs(db, {
      schoolId,
      actorId: adminId,
      entity: 'message_template',
      entityId: id,
      before: beforeTemplate,
      after: { body: updated.body, name: updated.name ?? null, type: updated.type, language: updated.language },
    });
    await writeAudit(db, {
      schoolId,
      actorId: adminId,
      actorType: 'user',
      action: 'template.update',
      entity: 'message_template',
      entityId: id,
      details: { type: updated.type, language: updated.language },
    });
    return { template_id: updated.id };
  }

  // --- Section 11 (Custom Messages): approve a submitted draft --------
  // Payload: message_draft.create {draft_id, ...}. Approving sends the
  // draft now (queue rows via the existing message_queue) unless it
  // carries a future scheduled_for — then it becomes 'scheduled' and the
  // scheduled-messages job picks it up when due (it re-checks this very
  // approval row, which is marked approved right after this returns).
  if (entity === 'message_draft' && actionType === 'create') {
    const draftId = (payload.draft_id as string) ?? req.entityId;
    if (!draftId) throw ApiError.validation('payload.draft_id is required for message_draft.create');
    const store = createPrismaMessagingStore(db as any);
    const result = await applyApprovedDraft({ store }, { schoolId, draftId, approvedBy: adminId });
    if ('scheduled' in result) {
      return { draft_id: draftId, scheduled: true, scheduled_for: result.scheduledFor.toISOString() };
    }
    return { draft_id: draftId, queued: result.queued, skipped: result.skipped.length, skipped_opted_out: result.skippedOptedOut };
  }

  if (entity === 'user') {
    if (actionType === 'create') {
      const created = await adminSvc.createClerk(
        db,
        schoolId,
        { email: String(payload.email ?? ''), password: String(payload.password ?? '') },
        adminId,
      );
      return { user_id: created.id };
    }
    if (actionType === 'delete') {
      const id = (payload.id as string) ?? req.entityId;
      if (!id) throw ApiError.validation('payload.id is required for user.delete');
      await adminSvc.deleteUser(db, schoolId, id, adminId);
      return { user_id: id, deleted: true };
    }
  }

  // --- 6C-1 appliers: sessions / exams / datesheets / grading / timetable / staff / payroll ---
  if (entity === 'academic_session') {
    const id = (payload.id as string) ?? req.entityId;
    if (!id) throw ApiError.validation('payload.id is required for academic_session');
    if (actionType === 'update') {
      if (payload.archive === true) {
        const s = await sessionsSvc.archiveSession(db, schoolId, id, adminId);
        return { session_id: s.id, archived: true };
      }
      const updated = await sessionsSvc.updateSession(db, schoolId, id, (payload.patch ?? {}) as any, adminId);
      return { session_id: updated.id };
    }
    if (actionType === 'delete') {
      await sessionsSvc.deleteSession(db, schoolId, id, adminId);
      return { session_id: id, deleted: true };
    }
  }

  if (entity === 'exam') {
    if (actionType === 'create') {
      const created = await examsSvc.createExam(db, schoolId, payload as any, adminId);
      return { exam_id: created.id };
    }
    const id = (payload.id as string) ?? req.entityId;
    if (!id) throw ApiError.validation('payload.id is required for exam');
    if (actionType === 'update') {
      const updated = await examsSvc.updateExam(db, schoolId, id, (payload.patch ?? {}) as any, adminId);
      return { exam_id: updated.id };
    }
    if (actionType === 'delete') {
      await examsSvc.deleteExam(db, schoolId, id, adminId);
      return { exam_id: id, soft_deleted: true };
    }
  }

  if (entity === 'exam_datesheet') {
    if (actionType === 'create') {
      const examId = payload.exam_id as string;
      if (!examId) throw ApiError.validation('payload.exam_id is required for exam_datesheet.create');
      const created = await examsSvc.createDatesheet(db, schoolId, examId, payload as any, adminId);
      return { datesheet_id: created.id };
    }
    const id = (payload.id as string) ?? req.entityId;
    if (!id) throw ApiError.validation('payload.id is required for exam_datesheet');
    if (actionType === 'update') {
      const updated = await examsSvc.updateDatesheet(db, schoolId, id, (payload.patch ?? {}) as any, adminId);
      return { datesheet_id: updated.id };
    }
    if (actionType === 'delete') {
      await examsSvc.deleteDatesheet(db, schoolId, id, adminId);
      return { datesheet_id: id, deleted: true };
    }
  }

  if (entity === 'grading_scale') {
    if (actionType === 'create') {
      const created = await examsSvc.createGradingScale(db, schoolId, payload as any, adminId);
      return { grading_scale_id: created.id };
    }
    const id = (payload.id as string) ?? req.entityId;
    if (!id) throw ApiError.validation('payload.id is required for grading_scale');
    if (actionType === 'update') {
      const updated = await examsSvc.updateGradingScale(db, schoolId, id, (payload.patch ?? {}) as any, adminId);
      return { grading_scale_id: updated.id };
    }
    if (actionType === 'delete') {
      await examsSvc.deleteGradingScale(db, schoolId, id, adminId);
      return { grading_scale_id: id, deleted: true };
    }
  }

  if (entity === 'timetable_entry') {
    if (actionType === 'create') {
      const created = await timetableSvc.createTimetableEntry(db, schoolId, payload as any, adminId);
      return { timetable_entry_id: created.id };
    }
    const id = (payload.id as string) ?? req.entityId;
    if (!id) throw ApiError.validation('payload.id is required for timetable_entry');
    if (actionType === 'update') {
      const updated = await timetableSvc.updateTimetableEntry(db, schoolId, id, (payload.patch ?? {}) as any, adminId);
      return { timetable_entry_id: updated.id };
    }
    if (actionType === 'delete') {
      await timetableSvc.deleteTimetableEntry(db, schoolId, id, adminId);
      return { timetable_entry_id: id, deleted: true };
    }
  }

  if (entity === 'staff') {
    if (actionType === 'create') {
      const created = await staffSvc.createStaff(db, schoolId, payload as any, adminId);
      return { staff_id: created.id };
    }
    const id = (payload.id as string) ?? req.entityId;
    if (!id) throw ApiError.validation('payload.id is required for staff');
    if (actionType === 'update') {
      const updated = await staffSvc.updateStaff(db, schoolId, id, (payload.patch ?? {}) as any, adminId);
      return { staff_id: updated.id };
    }
    if (actionType === 'delete') {
      await staffSvc.deleteStaff(db, schoolId, id, adminId);
      return { staff_id: id, deleted: true };
    }
  }

  if (entity === 'staff_assignment') {
    if (actionType === 'create') {
      const staffId = payload.staff_id as string;
      if (!staffId) throw ApiError.validation('payload.staff_id is required for staff_assignment.create');
      const created = await staffSvc.assignStaff(db, schoolId, staffId, payload as any, adminId);
      return { assignment_id: created.id };
    }
    if (actionType === 'delete') {
      const id = (payload.id as string) ?? req.entityId;
      const staffId = payload.staff_id as string;
      if (!id || !staffId) throw ApiError.validation('payload.id and payload.staff_id are required for staff_assignment.delete');
      await staffSvc.removeAssignment(db, schoolId, staffId, id, adminId);
      return { assignment_id: id, deleted: true };
    }
  }

  if (entity === 'salary_record') {
    if (actionType === 'create') {
      const created = await staffSvc.createSalaryRecord(db, schoolId, payload as any, adminId);
      return { salary_record_id: created.id };
    }
    const id = (payload.id as string) ?? req.entityId;
    if (!id) throw ApiError.validation('payload.id is required for salary_record');
    if (actionType === 'update') {
      const updated = await staffSvc.updateSalaryRecord(db, schoolId, id, (payload.patch ?? {}) as any, adminId);
      return { salary_record_id: updated.id };
    }
    if (actionType === 'delete') {
      await staffSvc.deleteSalaryRecord(db, schoolId, id, adminId);
      return { salary_record_id: id, deleted: true };
    }
  }

  // --- 6C-2: expenses / announcements / events / certificates -----------
  // Payload conventions:
  //  expense.create      {date, category, description?, amount, paid_by?}
  //  expense.update      {id, patch}
  //  expense.delete      {id}
  //  announcement.create {title, body, target_type?, target_class_id?, sms_send?}
  //  announcement.update {id, patch}
  //  announcement.delete {id}
  //  event.create        {date, title, description?}
  //  event.update        {id, patch}
  //  event.delete        {id}
  //  fee_voucher.create  {fee_record_id, month, due_date?}
  //  certificate.create  {student_id, type}
  //  student_id_card.update {student_id} (issue ID card)
  if (entity === 'expense') {
    if (actionType === 'create') {
      const created = await expensesSvc.createExpense(db, schoolId, payload as any, adminId);
      return { expense_id: created.id };
    }
    if (actionType === 'update') {
      const id = (payload.id as string) ?? req.entityId;
      if (!id) throw ApiError.validation('payload.id is required for expense.update');
      const updated = await expensesSvc.updateExpense(db, schoolId, id, (payload.patch ?? {}) as any, adminId);
      return { expense_id: updated.id };
    }
    if (actionType === 'delete') {
      const id = (payload.id as string) ?? req.entityId;
      if (!id) throw ApiError.validation('payload.id is required for expense.delete');
      await expensesSvc.deleteExpense(db, schoolId, id, adminId);
      return { expense_id: id, deleted: true };
    }
  }

  if (entity === 'announcement') {
    if (actionType === 'create') {
      const created = await announcementsSvc.createAnnouncement(db, schoolId, payload as any, adminId);
      return { announcement_id: created.id };
    }
    if (actionType === 'update') {
      const id = (payload.id as string) ?? req.entityId;
      if (!id) throw ApiError.validation('payload.id is required for announcement.update');
      const updated = await announcementsSvc.updateAnnouncement(db, schoolId, id, (payload.patch ?? {}) as any, adminId);
      return { announcement_id: updated.id };
    }
    if (actionType === 'delete') {
      const id = (payload.id as string) ?? req.entityId;
      if (!id) throw ApiError.validation('payload.id is required for announcement.delete');
      await announcementsSvc.deleteAnnouncement(db, schoolId, id, adminId);
      return { announcement_id: id, deleted: true };
    }
  }

  if (entity === 'event') {
    if (actionType === 'create') {
      const created = await eventsSvc.createEvent(db, schoolId, payload as any, adminId);
      return { event_id: created.id };
    }
    if (actionType === 'update') {
      const id = (payload.id as string) ?? req.entityId;
      if (!id) throw ApiError.validation('payload.id is required for event.update');
      const updated = await eventsSvc.updateEvent(db, schoolId, id, (payload.patch ?? {}) as any, adminId);
      return { event_id: updated.id };
    }
    if (actionType === 'delete') {
      const id = (payload.id as string) ?? req.entityId;
      if (!id) throw ApiError.validation('payload.id is required for event.delete');
      await eventsSvc.deleteEvent(db, schoolId, id, adminId);
      return { event_id: id, deleted: true };
    }
  }

  if (entity === 'fee_voucher' && actionType === 'create') {
    const created = await generateVoucher(db, schoolId, payload as any, adminId);
    return { voucher_no: created.voucher_no };
  }

  if (entity === 'certificate' && actionType === 'create') {
    const studentId = payload.student_id as string;
    if (!studentId) throw ApiError.validation('payload.student_id is required for certificate.create');
    // Module F (Point 9): forward the leaving reason + reviewed details
    // the clerk submitted, so an approved leaving certificate keeps them.
    const created = await certificatesSvc.issueCertificate(db, schoolId, studentId, String(payload.type ?? ''), adminId, {
      leaving_reason_option: (payload as any).leaving_reason_option,
      leaving_reason_other: (payload as any).leaving_reason_other,
      details: (payload as any).details,
    });
    return { certificate_id: created.id, certificate_no: created.certificate_no };
  }

  if (entity === 'student_id_card' && actionType === 'update') {
    const studentId = (payload.student_id as string) ?? req.entityId;
    if (!studentId) throw ApiError.validation('payload.student_id is required for student_id_card.update');
    const card = await certificatesSvc.issueIdCard(db, schoolId, studentId, adminId);
    return { student_id: card.student_id, id_card_issued_at: card.id_card_issued_at };
  }

  // --- 6B: results / result sheets ---------------------------------------
  // Payload conventions:
  //  result.create       {result_sheet_id, rows} (sheet confirm) OR
  //                      {exam_id?, exam_name?, class_id, session_id?, rows} (manual)
  //  result.update       {id, patch} | {id, link_student_id}
  //  result.delete       {id}
  //  result_sheet.create {class_id, exam_name, session_id?, file_path}
  //                      (clerk upload: OCR runs here, at approve time)
  //  result_sheet.delete {id}
  if (entity === 'result') {
    if (actionType === 'create') {
      const rows = (payload.rows ?? []) as any[];
      if (payload.result_sheet_id) {
        const sheet = await db.resultSheet.findFirst({ where: { id: payload.result_sheet_id as string, schoolId } });
        if (!sheet) throw ApiError.notFound('Result sheet not found');
        const out = await resultsSvc.saveResultRows(db, schoolId, { exam_id: sheet.examId, class_id: sheet.classId, result_sheet_id: sheet.id, rows }, adminId);
        return { saved: out.saved, linked: out.linked, unlinked: out.unlinked };
      }
      const out = await resultsSvc.saveManualResults(db, schoolId, payload as any, adminId);
      return { saved: out.saved, linked: out.linked, unlinked: out.unlinked };
    }
    const id = (payload.id as string) ?? req.entityId;
    if (!id) throw ApiError.validation('payload.id is required for result');
    if (actionType === 'update') {
      if (payload.link_student_id) {
        const updated = await resultsSvc.linkResult(db, schoolId, id, payload.link_student_id as string, adminId);
        return { result_id: updated.id, student_id: updated.studentId };
      }
      const updated = await resultsSvc.updateResult(db, schoolId, id, (payload.patch ?? {}) as any, adminId);
      return { result_id: updated.id };
    }
    if (actionType === 'delete') {
      await resultsSvc.deleteResult(db, schoolId, id, adminId);
      return { result_id: id, soft_deleted: true };
    }
  }

  if (entity === 'result_sheet') {
    if (actionType === 'create') {
      const classId = payload.class_id as string;
      const examName = String(payload.exam_name ?? '');
      const filePath = payload.file_path as string;
      if (!classId || !examName || !filePath) throw ApiError.validation('payload.class_id, exam_name and file_path are required for result_sheet.create');
      const out = await resultsSvc.uploadResultSheet(db, schoolId, classId, { exam_name: examName, exam_type: (payload.exam_type as string) ?? null, session_id: (payload.session_id as string) ?? null, file_path: filePath }, adminId);
      return { result_sheet_id: out.result_sheet_id, rows_found: out.rows.length };
    }
    if (actionType === 'delete') {
      const id = (payload.id as string) ?? req.entityId;
      if (!id) throw ApiError.validation('payload.id is required for result_sheet.delete');
      await resultsSvc.deleteResultSheet(db, schoolId, id, adminId);
      return { result_sheet_id: id, soft_deleted: true };
    }
  }

  throw ApiError.validation(`No applier for ${actionType} ${entity}`);
}

export async function approveApprovalRequest(db: Db, schoolId: string, id: string, adminId: string): Promise<any> {
  const req = await getApprovalRequest(db, schoolId, id);
  if (req.status !== 'pending') throw ApiError.conflict(`Approval request is already ${req.status}`);
  const result = await applyApproval(db, schoolId, req, adminId);
  const updated = await (db as any).approvalRequest.update({
    where: { id },
    data: { status: 'approved', decidedBy: adminId, decidedAt: new Date() },
  });
  await writeAudit(db, {
    schoolId,
    actorId: adminId,
    actorType: 'user',
    action: 'approval.approved',
    entity: 'approval_request',
    entityId: id,
    details: { action_type: req.actionType, entity: req.entity, result },
  });
  await notifyAdmins(db, schoolId, {
    type: 'approval_decided',
    title: 'Approval request approved',
    body: `Approved: ${describeRequest(req.actionType, req.entity, (req.payload ?? {}) as Record<string, unknown>)}.`,
    relatedType: 'approval_request',
    relatedId: id,
  });
  return { ...toPublicApproval(updated), applied: result };
}

export async function rejectApprovalRequest(
  db: Db,
  schoolId: string,
  id: string,
  adminId: string,
  reason?: string,
): Promise<any> {
  const req = await getApprovalRequest(db, schoolId, id);
  if (req.status !== 'pending') throw ApiError.conflict(`Approval request is already ${req.status}`);
  const updated = await (db as any).approvalRequest.update({
    where: { id },
    data: { status: 'rejected', decidedBy: adminId, decidedAt: new Date() },
  });
  await writeAudit(db, {
    schoolId,
    actorId: adminId,
    actorType: 'user',
    action: 'approval.rejected',
    entity: 'approval_request',
    entityId: id,
    details: { action_type: req.actionType, entity: req.entity, reason: reason ?? null },
  });
  await notifyAdmins(db, schoolId, {
    type: 'approval_decided',
    title: 'Approval request rejected',
    body: `Rejected: ${describeRequest(req.actionType, req.entity, (req.payload ?? {}) as Record<string, unknown>)}.${reason ? ` Reason: ${reason}` : ''}`,
    relatedType: 'approval_request',
    relatedId: id,
  });
  return toPublicApproval(updated);
}
