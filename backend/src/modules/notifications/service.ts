// Notification center (6C-2) — READ-ONLY aggregation over existing tables.
// One endpoint: GET /notifications/center → pending approvals count +
// items, failed messages, OCR items needing review, fee dues.
// This module does NOT change how notifications are created (6A-4 owns
// that): it only reads approval_requests, message_queue, ocr_uploads /
// result_sheets, fee_records, and notifications. Every query is scoped to
// the JWT school_id.

import { currentMonthInTz } from '../../lib/dates';
import type { Db } from '../../lib/db';

export interface NotificationCenter {
  month: string;
  counts: {
    pending_approvals: number;
    failed_messages: number;
    ocr_needing_review: number;
    fee_dues: number;
    fee_dues_amount: number;
    unread_notifications: number;
  };
  items: {
    pending_approvals: Array<{ id: string; action_type: string; entity: string; requested_by: string | null; created_at: string }>;
    failed_messages: Array<{ id: string; type: string; student_id: string | null; error: string | null; created_at: string }>;
    ocr_needing_review: Array<{ id: string; kind: 'student_list' | 'result_sheet'; class_id: string | null; created_at: string }>;
    fee_dues: Array<{ student_id: string; student_name: string; class_name: string | null; month: string; balance: number; status: string }>;
  };
}

function iso(d: any): string {
  return d ? new Date(d).toISOString() : new Date().toISOString();
}

export async function getNotificationCenter(db: Db, schoolId: string): Promise<NotificationCenter> {
  const school: any = await db.school.findUnique({ where: { id: schoolId } });
  const month = currentMonthInTz((school?.timezone as string | undefined) ?? 'Asia/Karachi');

  const [pendingApprovals, failedMessages, ocrUploads, resultSheets, unread] = await Promise.all([
    db.approvalRequest.findMany({ where: { schoolId, status: 'pending' }, orderBy: { createdAt: 'desc' }, take: 10 }),
    db.messageQueue.findMany({ where: { schoolId, status: 'failed' }, orderBy: { createdAt: 'desc' }, take: 10 }),
    db.ocrUpload.findMany({ where: { schoolId, status: 'review' }, orderBy: { createdAt: 'desc' }, take: 10 }),
    db.resultSheet.findMany({ where: { schoolId, status: 'review' }, orderBy: { createdAt: 'desc' }, take: 10 }),
    db.notification.count({ where: { schoolId, isRead: false } }),
  ]);

  const [pendingCount, failedCount, ocrCount] = await Promise.all([
    db.approvalRequest.count({ where: { schoolId, status: 'pending' } }),
    db.messageQueue.count({ where: { schoolId, status: 'failed' } }),
    Promise.all([
      db.ocrUpload.count({ where: { schoolId, status: 'review' } }),
      db.resultSheet.count({ where: { schoolId, status: 'review' } }),
    ]).then(([a, b]) => a + b),
  ]);

  // Fee dues this month: unpaid/partial records with a remaining balance.
  const feeRecords: any[] = await db.feeRecord.findMany({ where: { schoolId, month, deletedAt: null } });
  const dues = feeRecords.filter((r: any) => (r.amountDue ?? 0) - (r.amountPaid ?? 0) - (r.discount ?? 0) > 0);
  const studentIds = [...new Set(dues.map((r: any) => r.studentId))];
  const students: any[] = studentIds.length
    ? await db.student.findMany({ where: { schoolId, id: { in: studentIds } } })
    : [];
  const studentById = new Map(students.map((s: any) => [s.id, s]));
  const classes: any[] = await db.class.findMany({ where: { schoolId } });
  const classById = new Map(classes.map((c: any) => [c.id, c]));
  const feeDues = dues
    .map((r: any) => {
      const s = studentById.get(r.studentId);
      const c = s ? classById.get(s.classId) : null;
      return {
        student_id: r.studentId,
        student_name: s?.name ?? '(unknown student)',
        class_name: c ? `${c.name}-${c.section}` : null,
        month,
        balance: (r.amountDue ?? 0) - (r.amountPaid ?? 0) - (r.discount ?? 0),
        status: r.status ?? 'unpaid',
      };
    })
    .sort((a, b) => b.balance - a.balance);
  const feeDuesAmount = feeDues.reduce((a, d) => a + d.balance, 0);

  return {
    month,
    counts: {
      pending_approvals: pendingCount,
      failed_messages: failedCount,
      ocr_needing_review: ocrCount,
      fee_dues: feeDues.length,
      fee_dues_amount: feeDuesAmount,
      unread_notifications: unread,
    },
    items: {
      pending_approvals: pendingApprovals.map((r: any) => ({
        id: r.id,
        action_type: r.actionType,
        entity: r.entity,
        requested_by: r.requestedBy ?? null,
        created_at: iso(r.createdAt),
      })),
      failed_messages: failedMessages.map((r: any) => ({
        id: r.id,
        type: r.type,
        student_id: r.studentId ?? null,
        error: r.error ?? null,
        created_at: iso(r.createdAt),
      })),
      ocr_needing_review: [
        ...ocrUploads.map((r: any) => ({ id: r.id, kind: 'student_list' as const, class_id: r.classId ?? null, created_at: iso(r.createdAt) })),
        ...resultSheets.map((r: any) => ({ id: r.id, kind: 'result_sheet' as const, class_id: r.classId ?? null, created_at: iso(r.createdAt) })),
      ],
      fee_dues: feeDues.slice(0, 10),
    },
  };
}
