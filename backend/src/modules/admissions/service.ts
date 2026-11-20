// Online admissions (Gap #2, 2026-11-20) — public inquiry form at
// /admissions/:schoolSlug (no login) → admin pipeline
// new → contacted → test → interview → admitted / rejected.
// "Admit" creates the student + first fee record + first fee voucher in
// ONE transaction and marks the inquiry admitted. Anti-spam: public rate
// limit (route-level) + honeypot field (bots fill it; humans never see it).
import { config } from '../../config';
import { ApiError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { writeChangeLogs } from '../hardening/helpers';
import { normalizePhone, encryptPhone, decryptPhone, sha256Hex, maskPhone } from '../../lib/crypto';
import { isValidDateString, todayInTz, monthRange } from '../../lib/dates';
import { parsePagination, paginatedResponse } from '../../lib/pagination';
import { createStudent } from '../students/service';
import { feeBreakdownForStudent } from '../fees/service';
import { mintVoucher } from '../fees/vouchers';
import type { Db } from '../../lib/db';

export const INQUIRY_STATUSES = ['new', 'contacted', 'test', 'interview', 'admitted', 'rejected'] as const;
export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];
/** Statuses an admin may set by hand — 'admitted' only comes from Admit. */
const SETTABLE_STATUSES = ['new', 'contacted', 'test', 'interview', 'rejected'] as const;

export interface InquiryInput {
  student_name: string;
  class_id: string;
  parent_name: string;
  parent_phone: string;
  parent_email?: string | null;
  notes?: string | null;
  /** Honeypot — must stay empty; a filled value is silently dropped. */
  website?: string | null;
}

function toPublicInquiry(row: any): Record<string, unknown> {
  let phone: string | null = null;
  try {
    phone = row.parentPhoneEnc ? maskPhone(decryptPhone(row.parentPhoneEnc)) : null;
  } catch {
    phone = null;
  }
  return {
    id: row.id,
    student_name: row.studentName,
    class_id: row.classId ?? null,
    class_name: row.className,
    parent_name: row.parentName,
    parent_phone_masked: phone,
    parent_email: row.parentEmail ?? null,
    notes: row.notes ?? null,
    status: row.status,
    admitted_student_id: row.admittedStudentId ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

async function getSchoolBySlug(db: Db, slug: string): Promise<any> {
  const school = await db.school.findFirst({ where: { slug } });
  if (!school) throw ApiError.notFound('School not found');
  return school;
}

async function getInquiryInSchool(db: Db, schoolId: string, id: string): Promise<any> {
  const row = await db.admissionInquiry.findFirst({ where: { id, schoolId } });
  if (!row) throw ApiError.notFound('Admission inquiry not found');
  return row;
}

/** Public form data: school name + the classes a parent can apply for. */
export async function getPublicAdmissionsForm(db: Db, slug: string): Promise<Record<string, unknown>> {
  const school = await getSchoolBySlug(db, slug);
  const classes: any[] = await db.class.findMany({
    where: { schoolId: school.id, deletedAt: null },
    orderBy: [{ name: 'asc' }, { section: 'asc' }],
  });
  return {
    school_name: school.name,
    school_slug: school.slug,
    classes: classes.map((c: any) => ({ id: c.id, name: c.name, section: c.section, display_name: `${c.name}-${c.section}` })),
  };
}

/** Public inquiry submission. Returns { received: true } even for honeypot hits. */
export async function submitInquiry(db: Db, slug: string, input: InquiryInput): Promise<Record<string, unknown>> {
  if (input.website && input.website.trim() !== '') {
    // Honeypot filled — a bot. Pretend success, store nothing.
    return { received: true };
  }
  const school = await getSchoolBySlug(db, slug);
  const cls = await db.class.findFirst({ where: { id: input.class_id, schoolId: school.id, deletedAt: null } });
  if (!cls) throw ApiError.validation('Please choose a class to apply for');
  const phone = normalizePhone(input.parent_phone);
  if (!phone) throw ApiError.validation('Parent phone must be a valid Pakistani mobile (e.g. 03001234567)');
  const email = (input.parent_email ?? '').trim() || null;
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw ApiError.validation('Parent email does not look valid');
  const created = await db.admissionInquiry.create({
    data: {
      schoolId: school.id,
      studentName: input.student_name.trim(),
      classId: cls.id,
      className: `${cls.name}-${cls.section}`,
      parentName: input.parent_name.trim(),
      parentPhoneEnc: encryptPhone(phone),
      parentPhoneHash: sha256Hex(phone),
      parentEmail: email,
      notes: (input.notes ?? '').trim() || null,
      status: 'new',
    },
  });
  await writeAudit(db, {
    schoolId: school.id,
    actorType: 'system',
    action: 'admission.inquiry',
    entity: 'admission_inquiry',
    entityId: created.id,
    details: { student_name: created.studentName, class_name: created.className },
  });
  return { received: true, inquiry_id: created.id };
}

/** Admin: paginated inquiry list (newest first), filterable by status. */
export async function listInquiries(
  db: Db,
  schoolId: string,
  query: Record<string, any>,
): Promise<Record<string, unknown>> {
  const { page, limit, skip } = parsePagination(query);
  const where: Record<string, unknown> = { schoolId };
  if (query.status) {
    if (!INQUIRY_STATUSES.includes(query.status)) throw ApiError.validation(`status must be one of ${INQUIRY_STATUSES.join(', ')}`);
    where.status = query.status;
  }
  const [rows, total] = await Promise.all([
    db.admissionInquiry.findMany({ where, orderBy: [{ createdAt: 'desc' }], skip, take: limit }),
    db.admissionInquiry.count({ where }),
  ]);
  const pageResult = paginatedResponse(rows.map(toPublicInquiry), total, { page, limit, skip });
  const school = await db.school.findUnique({ where: { id: schoolId } });
  return {
    ...pageResult,
    public_form_url: school ? `${config.frontendUrl}/admissions/${school.slug}` : null,
  };
}

/** Admin: move an inquiry along the pipeline (admitted is terminal, admit-only). */
export async function updateInquiryStatus(
  db: Db,
  schoolId: string,
  id: string,
  status: string,
  actorId?: string,
): Promise<Record<string, unknown>> {
  if (!SETTABLE_STATUSES.includes(status as (typeof SETTABLE_STATUSES)[number])) {
    throw ApiError.validation(`status must be one of ${SETTABLE_STATUSES.join(', ')} (admitted comes from Admit)`);
  }
  const row = await getInquiryInSchool(db, schoolId, id);
  if (row.status === 'admitted') throw ApiError.conflict('An admitted inquiry cannot change status');
  const updated = await db.admissionInquiry.update({ where: { id }, data: { status } });
  await writeChangeLogs(db, {
    schoolId,
    actorId: actorId ?? null,
    entity: 'admission_inquiry',
    entityId: id,
    before: { status: row.status },
    after: { status },
  });
  await writeAudit(db, {
    schoolId,
    actorId: actorId ?? null,
    actorType: 'user',
    action: 'admission.status',
    entity: 'admission_inquiry',
    entityId: id,
    details: { student_name: row.studentName, from: row.status, to: status },
  });
  return toPublicInquiry(updated);
}

/**
 * Admit an inquiry: create the student + first fee record + first fee
 * voucher in ONE transaction, then mark the inquiry admitted. When the
 * class has no fee structure, the student is still created and the
 * response says so (voucher: null) — a voucher needs a fee to bill.
 */
export async function admitInquiry(
  db: Db,
  schoolId: string,
  id: string,
  input: { class_id: string; roll_no?: number | null; admission_no?: string | null },
  actorId?: string,
): Promise<Record<string, unknown>> {
  const inquiry = await getInquiryInSchool(db, schoolId, id);
  if (inquiry.status === 'admitted') throw ApiError.conflict('This inquiry is already admitted');
  if (inquiry.status === 'rejected') throw ApiError.conflict('A rejected inquiry cannot be admitted — set it back to an earlier status first');
  const school = await db.school.findUnique({ where: { id: schoolId } });
  if (!school) throw ApiError.notFound('School not found');
  const cls = await db.class.findFirst({ where: { id: input.class_id, schoolId, deletedAt: null } });
  if (!cls) throw ApiError.notFound('Class not found');
  if (input.roll_no !== undefined && input.roll_no !== null && (!Number.isInteger(input.roll_no) || input.roll_no < 1)) {
    throw ApiError.validation('roll_no must be a positive integer');
  }

  const month = todayInTz(school.timezone ?? 'Asia/Karachi').slice(0, 7);
  const parentPhone = decryptPhone(inquiry.parentPhoneEnc);

  const admitted = await db.$transaction(async (tx) => {
    const student = await createStudent(
      tx,
      schoolId,
      cls.id,
      {
        name: inquiry.studentName,
        parent_name: inquiry.parentName,
        parent_phone: parentPhone,
        // Messaging Center wiring: carry the inquiry's parent email onto
        // the student so email delivery works without re-typing it.
        parent_email: inquiry.parentEmail ?? null,
        roll_no: input.roll_no ?? null,
        admission_no: (input.admission_no ?? '').trim() || null,
        admission_date: todayInTz(school.timezone ?? 'Asia/Karachi'),
      } as any,
      actorId,
    );

    // First fee record + voucher from the class's latest fee structure.
    const structures: any[] = await tx.feeStructure.findMany({
      where: { schoolId, classId: cls.id },
      orderBy: [{ effectiveFrom: 'desc' }],
      take: 1,
    });
    let feeRecord: any = null;
    let voucher: any = null;
    if (structures.length > 0) {
      const s = structures[0];
      const breakdown = await feeBreakdownForStudent(tx, schoolId, student, {
        id: s.id,
        monthlyAmount: s.monthlyAmount,
        effectiveFrom: s.effectiveFrom,
        admissionFee: s.admissionFee ?? 0,
        siblingDiscountPct: s.siblingDiscountPct ?? 0,
      }, month);
      feeRecord = await tx.feeRecord.create({
        data: {
          schoolId,
          studentId: student.id,
          month,
          amountDue: breakdown.amount_due,
          amountPaid: 0,
          discount: 0,
          arrears: breakdown.arrears,
          scholarshipDiscount: 0,
        },
      });
      voucher = await mintVoucher(tx, schoolId, school, feeRecord, month, monthRange(month).end);
    }

    const updated = await tx.admissionInquiry.update({
      where: { id },
      data: { status: 'admitted', admittedStudentId: student.id },
    });
    return { student, feeRecord, voucher, inquiry: updated };
  });

  await writeChangeLogs(db, {
    schoolId,
    actorId: actorId ?? null,
    entity: 'admission_inquiry',
    entityId: id,
    before: { status: inquiry.status },
    after: { status: 'admitted', admitted_student_id: admitted.student.id },
  });
  await writeAudit(db, {
    schoolId,
    actorId: actorId ?? null,
    actorType: 'user',
    action: 'admission.admit',
    entity: 'admission_inquiry',
    entityId: id,
    details: {
      student_id: admitted.student.id,
      student_name: admitted.student.name,
      class_id: cls.id,
      month,
      fee_record_id: admitted.feeRecord?.id ?? null,
      voucher_no: admitted.voucher?.voucherNo ?? null,
    },
  });
  return {
    inquiry: toPublicInquiry(admitted.inquiry),
    student_id: admitted.student.id,
    student_name: admitted.student.name,
    fee_record_id: admitted.feeRecord?.id ?? null,
    voucher_no: admitted.voucher?.voucherNo ?? null,
    voucher_id: admitted.voucher?.id ?? null,
  };
}
