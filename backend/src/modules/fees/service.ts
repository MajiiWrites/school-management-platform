// Fee service — structures, monthly listing, payments, receipts, reports,
// month rollover. All money is integer PKR. All queries are scoped to
// `schoolId` (multi-tenant isolation); never trust a school id from input.
//
// The service uses the shared `Db` interface (lib/db.ts) like every other
// backend module — delegates are untyped on purpose (the generated Prisma
// client is the runtime source of truth).
//
// Status semantics (mirrors the DB GENERATED column in
// prisma/migrations/.../migration.sql):
//   balance = amount_due - amount_paid - discount
//   balance <= 0            -> 'paid'
//   amount_paid > 0 || discount > 0 (and balance > 0) -> 'partial'
//   otherwise               -> 'unpaid'
// `fee_records.status` is GENERATED ALWAYS in Postgres, so this file NEVER
// writes `status` in a create/update payload — it only reads it back from
// the DB (re-fetching after an update) or computes it in memory for
// not-yet-created records.

import type { Db } from '../../lib/db';
import { ApiError } from '../../lib/errors';
import { isValidDateString, isValidMonthKey, localMonthKey, monthStartDate } from '../../jobs/date-utils';
import type {
  FeeListItem,
  FeeListResult,
  FeeStatus,
  FeeStructureInput,
  FeeStructureView,
  MonthlyFeeReport,
  PayFeeInput,
  ReceiptData,
  RolloverResult,
} from './types';

export function computeFeeStatus(amountDue: number, amountPaid: number, discount: number): FeeStatus {
  const balance = amountDue - amountPaid - discount;
  if (balance <= 0) return 'paid';
  if (amountPaid > 0 || discount > 0) return 'partial';
  return 'unpaid';
}

export function balanceOf(amountDue: number, amountPaid: number, discount: number): number {
  return Math.max(0, amountDue - amountPaid - discount);
}

function classDisplayName(name: string, section: string): string {
  return `${name}-${section}`;
}

function toISODate(d: Date | string): string {
  return new Date(d).toISOString().slice(0, 10);
}

async function getSchoolOr404(db: Db, schoolId: string) {
  const school = await db.school.findUnique({ where: { id: schoolId } });
  if (!school) throw ApiError.notFound('School not found');
  return school;
}

function assertPositiveInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw ApiError.validation(`${field} must be a positive integer (PKR)`);
  }
  return value;
}

function assertNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw ApiError.validation(`${field} must be a non-negative integer (PKR)`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Fee structures
// ---------------------------------------------------------------------------

export async function listFeeStructures(db: Db, schoolId: string): Promise<FeeStructureView[]> {
  const [structures, classes]: [any[], any[]] = await Promise.all([
    db.feeStructure.findMany({ where: { schoolId }, orderBy: { effectiveFrom: 'desc' } }),
    db.class.findMany({ where: { schoolId } }),
  ]);
  const classById = new Map(classes.map((c) => [c.id, c]));
  return structures.map((s) => {
    const c = classById.get(s.classId);
    return {
      id: s.id,
      class_id: s.classId,
      class_name: c ? classDisplayName(c.name, c.section) : '(deleted class)',
      monthly_amount: s.monthlyAmount,
      effective_from: toISODate(s.effectiveFrom),
      created_at: s.createdAt.toISOString(),
    };
  });
}

export async function createFeeStructure(
  db: Db,
  schoolId: string,
  input: FeeStructureInput,
): Promise<FeeStructureView> {
  const amount = assertPositiveInt(input.monthly_amount, 'monthly_amount');
  if (!isValidDateString(input.effective_from)) {
    throw ApiError.validation('effective_from must be a valid YYYY-MM-DD date');
  }
  const klass: any = await db.class.findUnique({ where: { id: input.class_id } });
  if (!klass || klass.schoolId !== schoolId) throw ApiError.notFound('Class not found');
  const created: any = await db.feeStructure.create({
    data: {
      schoolId,
      classId: input.class_id,
      monthlyAmount: amount,
      effectiveFrom: new Date(`${input.effective_from}T00:00:00Z`),
    },
  });
  await db.auditLog.create({
    data: {
      schoolId,
      actorType: 'system',
      action: 'fee.structure.create',
      entity: 'fee_structure',
      entityId: created.id,
      details: { class_id: input.class_id, monthly_amount: amount, effective_from: input.effective_from },
    },
  });
  return {
    id: created.id,
    class_id: created.classId,
    class_name: classDisplayName(klass.name, klass.section),
    monthly_amount: created.monthlyAmount,
    effective_from: toISODate(created.effectiveFrom),
    created_at: created.createdAt.toISOString(),
  };
}

export async function updateFeeStructure(
  db: Db,
  schoolId: string,
  structureId: string,
  patch: Partial<FeeStructureInput>,
): Promise<FeeStructureView> {
  const existing: any = await db.feeStructure.findUnique({ where: { id: structureId } });
  if (!existing || existing.schoolId !== schoolId) throw ApiError.notFound('Fee structure not found');
  const data: { monthlyAmount?: number; effectiveFrom?: Date } = {};
  if (patch.monthly_amount !== undefined) data.monthlyAmount = assertPositiveInt(patch.monthly_amount, 'monthly_amount');
  if (patch.effective_from !== undefined) {
    if (!isValidDateString(patch.effective_from)) throw ApiError.validation('effective_from must be a valid YYYY-MM-DD date');
    data.effectiveFrom = new Date(`${patch.effective_from}T00:00:00Z`);
  }
  const updated: any = await db.feeStructure.update({ where: { id: structureId }, data });
  const klass: any = await db.class.findUnique({ where: { id: updated.classId } });
  return {
    id: updated.id,
    class_id: updated.classId,
    class_name: klass ? classDisplayName(klass.name, klass.section) : '(deleted class)',
    monthly_amount: updated.monthlyAmount,
    effective_from: toISODate(updated.effectiveFrom),
    created_at: updated.createdAt.toISOString(),
  };
}

export async function deleteFeeStructure(db: Db, schoolId: string, structureId: string): Promise<void> {
  const existing: any = await db.feeStructure.findUnique({ where: { id: structureId } });
  if (!existing || existing.schoolId !== schoolId) throw ApiError.notFound('Fee structure not found');
  // A structure that already produced fee records must not vanish silently:
  // block deletion once any record exists for its class on/after its month.
  const fromMonth = toISODate(existing.effectiveFrom).slice(0, 7);
  const students: any[] = await db.student.findMany({
    where: { schoolId, classId: existing.classId },
    select: { id: true },
  });
  const ids = students.map((s) => s.id);
  if (ids.length > 0) {
    const blocking: any = await db.feeRecord.findFirst({
      where: { schoolId, studentId: { in: ids }, month: { gte: fromMonth } },
      select: { id: true },
    });
    if (blocking) {
      throw ApiError.conflict('Cannot delete: fee records already exist for this class from this structure');
    }
  }
  await db.feeStructure.delete({ where: { id: structureId } });
}

/** Latest structure per class effective on or before the given month start. */
async function latestStructuresByClass(
  db: Db,
  schoolId: string,
  monthKey: string,
): Promise<Map<string, { id: string; monthlyAmount: number; effectiveFrom: Date }>> {
  const from = new Date(`${monthStartDate(monthKey)}T00:00:00Z`);
  const all: any[] = await db.feeStructure.findMany({
    where: { schoolId, effectiveFrom: { lte: from } },
    orderBy: { effectiveFrom: 'desc' },
  });
  const byClass = new Map<string, { id: string; monthlyAmount: number; effectiveFrom: Date }>();
  for (const s of all) {
    if (!byClass.has(s.classId)) {
      byClass.set(s.classId, { id: s.id, monthlyAmount: s.monthlyAmount, effectiveFrom: s.effectiveFrom });
    }
  }
  return byClass;
}

// ---------------------------------------------------------------------------
// Monthly fee list
// ---------------------------------------------------------------------------

export interface ListFeesQuery {
  month?: string;
  class_id?: string;
  status?: FeeStatus;
  search?: string;
  page?: number;
  limit?: number;
}

export async function listFees(
  db: Db,
  schoolId: string,
  query: ListFeesQuery,
  timezone: string,
): Promise<FeeListResult> {
  const month = query.month ?? localMonthKey(new Date(), timezone);
  if (!isValidMonthKey(month)) throw ApiError.validation('month must be YYYY-MM');
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(200, Math.max(1, query.limit ?? 50));

  const classes: any[] = await db.class.findMany({
    where: query.class_id ? { schoolId, id: query.class_id } : { schoolId },
    orderBy: [{ name: 'asc' }, { section: 'asc' }],
  });
  if (query.class_id && classes.length === 0) throw ApiError.notFound('Class not found');
  const classById = new Map(classes.map((c) => [c.id, c]));
  const classIds = classes.map((c) => c.id);

  const studentWhere: Record<string, unknown> = { schoolId, classId: { in: classIds }, status: 'active' };
  if (query.search) studentWhere.name = { contains: query.search, mode: 'insensitive' };
  const students: any[] = await db.student.findMany({
    where: studentWhere,
    orderBy: [{ classId: 'asc' }, { rollNo: 'asc' }, { name: 'asc' }],
  });

  const studentIds = students.map((s) => s.id);
  const records: any[] = studentIds.length
    ? await db.feeRecord.findMany({ where: { schoolId, month, studentId: { in: studentIds } } })
    : [];
  const recordByStudent = new Map(records.map((r) => [r.studentId, r]));
  const structures = await latestStructuresByClass(db, schoolId, month);

  let items: FeeListItem[] = students.map((s) => {
    const klass = classById.get(s.classId);
    const rec = recordByStudent.get(s.id);
    const structure = structures.get(s.classId);
    const amountDue = rec ? rec.amountDue : structure ? structure.monthlyAmount : 0;
    const amountPaid = rec ? rec.amountPaid : 0;
    const discount = rec ? rec.discount : 0;
    return {
      student_id: s.id,
      student_name: s.name,
      roll_no: s.rollNo,
      class_id: s.classId,
      class_name: klass ? classDisplayName(klass.name, klass.section) : '(unknown)',
      month,
      amount_due: amountDue,
      amount_paid: amountPaid,
      discount,
      balance: balanceOf(amountDue, amountPaid, discount),
      status: rec ? (rec.status as FeeStatus) : computeFeeStatus(amountDue, 0, 0),
      receipt_no: rec?.receiptNo ?? null,
      paid_at: rec?.paidAt ? rec.paidAt.toISOString() : null,
      payment_method: rec?.paymentMethod ?? null,
      record_exists: !!rec,
      no_structure: !structure && !rec,
    };
  });

  if (query.status) items = items.filter((i) => i.status === query.status);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const paged = items.slice((page - 1) * limit, page * limit);
  return { items: paged, total, page, pages, month };
}

// ---------------------------------------------------------------------------
// Payments + receipts
// ---------------------------------------------------------------------------

async function nextReceiptNo(
  tx: Db,
  schoolId: string,
  schoolSlug: string,
  month: string,
): Promise<string> {
  const prefix = `${schoolSlug}-${month.replace('-', '')}-`;
  const latest = await tx.feeRecord.findFirst({
    where: { schoolId, receiptNo: { startsWith: prefix } },
    orderBy: { receiptNo: 'desc' },
    select: { receiptNo: true },
  });
  let seq = 0;
  if (latest?.receiptNo) {
    const n = Number(latest.receiptNo.slice(prefix.length));
    if (Number.isInteger(n)) seq = n;
  }
  return `${prefix}${String(seq + 1).padStart(3, '0')}`;
}

export async function payFee(
  db: Db,
  schoolId: string,
  studentId: string,
  input: PayFeeInput,
  actorId: string,
): Promise<ReceiptData> {
  if (!isValidMonthKey(input.month)) throw ApiError.validation('month must be YYYY-MM');
  const amountPaid = assertPositiveInt(input.amount_paid, 'amount_paid');
  const discount = input.discount !== undefined ? assertNonNegativeInt(input.discount, 'discount') : 0;
  if (input.payment_method !== undefined && typeof input.payment_method !== 'string') {
    throw ApiError.validation('payment_method must be a string');
  }

  const school = await getSchoolOr404(db, schoolId);

  return db.$transaction(async (tx) => {
    const student: any = await tx.student.findUnique({ where: { id: studentId } });
    if (!student || student.schoolId !== schoolId) throw ApiError.notFound('Student not found');
    if (student.status !== 'active') throw ApiError.conflict('Cannot accept payment for a non-active student');

    let record: any = await tx.feeRecord.findUnique({
      where: { studentId_month: { studentId, month: input.month } },
    });

    if (!record) {
      // No rollover record yet (e.g. payment before the 1st-run job):
      // create it on the fly from the class's current structure.
      const structures = await latestStructuresByClass(tx, schoolId, input.month);
      const structure = structures.get(student.classId);
      if (!structure) throw ApiError.conflict('No fee structure exists for this class/month yet');
      record = await tx.feeRecord.create({
        data: {
          schoolId,
          studentId,
          month: input.month,
          amountDue: structure.monthlyAmount,
          amountPaid: 0,
          discount: 0,
          // NOTE: `status` is a GENERATED column — never written, only read.
        },
      });
    }

    const remaining = record.amountDue - record.amountPaid - record.discount;
    if (amountPaid + discount > remaining) {
      throw ApiError.validation(
        `Payment of ${amountPaid} + discount ${discount} exceeds the remaining balance of ${remaining} PKR`,
      );
    }

    const newPaid = record.amountPaid + amountPaid;
    const newDiscount = record.discount + discount;
    const status = computeFeeStatus(record.amountDue, newPaid, newDiscount);
    const receiptNo = record.receiptNo ?? (await nextReceiptNo(tx, schoolId, school.slug, input.month));

    await tx.feeRecord.update({
      where: { id: record.id },
      data: {
        amountPaid: newPaid,
        discount: newDiscount,
        // NOTE: `status` is GENERATED from the amounts — Postgres recomputes
        // it; it must not be written here.
        paidAt: status === 'paid' ? new Date() : record.paidAt,
        receiptNo,
        paymentMethod: input.payment_method ?? record.paymentMethod,
        markedBy: actorId,
      },
    });
    // Re-read: the update's return value may carry the pre-update generated
    // status, so fetch fresh before building the receipt.
    const updated: any = await tx.feeRecord.findUnique({ where: { id: record.id } });
    if (!updated) throw ApiError.notFound('Fee record not found');

    await tx.auditLog.create({
      data: {
        schoolId,
        actorId,
        actorType: 'user',
        action: 'fee.pay',
        entity: 'fee_record',
        entityId: updated.id,
        details: {
          student_id: studentId,
          month: input.month,
          amount_paid: amountPaid,
          discount,
          payment_method: input.payment_method ?? null,
          payer_reference: input.receipt ?? null,
          receipt_no: receiptNo,
          new_status: status,
        },
      },
    });

    const klass: any = await tx.class.findUnique({ where: { id: student.classId } });
    return toReceiptData(school, student, klass, updated);
  });
}

function toReceiptData(
  school: { name: string; slug: string },
  student: { id: string; name: string; rollNo: number | null },
  klass: { name: string; section: string } | null,
  record: {
    receiptNo: string | null;
    month: string;
    amountDue: number;
    discount: number;
    amountPaid: number;
    status: string;
    paymentMethod: string | null;
    paidAt: Date | null;
  },
): ReceiptData {
  if (!record.receiptNo) throw new Error('Receipt number was not generated');
  return {
    receipt_no: record.receiptNo,
    school_name: school.name,
    school_slug: school.slug,
    student_id: student.id,
    student_name: student.name,
    roll_no: student.rollNo,
    class_name: klass ? classDisplayName(klass.name, klass.section) : '(unknown)',
    month: record.month,
    amount_due: record.amountDue,
    discount: record.discount,
    amount_paid: record.amountPaid,
    balance: balanceOf(record.amountDue, record.amountPaid, record.discount),
    status: record.status as FeeStatus,
    payment_method: record.paymentMethod,
    paid_at: record.paidAt ? record.paidAt.toISOString() : null,
    issued_at: new Date().toISOString(),
  };
}

export async function getReceiptByNo(db: Db, schoolId: string, receiptNo: string): Promise<ReceiptData> {
  const school = await getSchoolOr404(db, schoolId);
  const record: any = await db.feeRecord.findFirst({ where: { schoolId, receiptNo } });
  if (!record) throw ApiError.notFound('Receipt not found');
  const student: any = await db.student.findUnique({ where: { id: record.studentId } });
  if (!student) throw ApiError.notFound('Receipt not found');
  const klass: any = await db.class.findUnique({ where: { id: student.classId } });
  return toReceiptData(school, student, klass, record);
}

// ---------------------------------------------------------------------------
// Monthly report
// ---------------------------------------------------------------------------

export async function monthlyFeeReport(db: Db, schoolId: string, month: string): Promise<MonthlyFeeReport> {
  if (!isValidMonthKey(month)) throw ApiError.validation('month must be YYYY-MM');
  const [classes, students, records]: [any[], any[], any[]] = await Promise.all([
    db.class.findMany({ where: { schoolId }, orderBy: [{ name: 'asc' }, { section: 'asc' }] }),
    db.student.findMany({ where: { schoolId, status: 'active' } }),
    db.feeRecord.findMany({ where: { schoolId, month } }),
  ]);
  const classById = new Map(classes.map((c) => [c.id, c]));
  const studentById = new Map(students.map((s) => [s.id, s]));
  const recordedStudentIds = new Set(records.map((r) => r.studentId));

  const byClass = new Map<
    string,
    { collected: number; pending: number; total_due: number; paid: number; partial: number; unpaid: number; missing: number }
  >();
  for (const c of classes) {
    byClass.set(c.id, { collected: 0, pending: 0, total_due: 0, paid: 0, partial: 0, unpaid: 0, missing: 0 });
  }
  let collected = 0;
  let pending = 0;
  let totalDue = 0;
  let paidCount = 0;
  let partialCount = 0;
  let unpaidCount = 0;

  for (const r of records) {
    const s = studentById.get(r.studentId);
    if (!s) continue;
    const bucket = byClass.get(s.classId);
    if (!bucket) continue;
    const bal = balanceOf(r.amountDue, r.amountPaid, r.discount);
    bucket.collected += r.amountPaid;
    bucket.pending += bal;
    bucket.total_due += r.amountDue;
    collected += r.amountPaid;
    pending += bal;
    totalDue += r.amountDue;
    if (r.status === 'paid') { bucket.paid += 1; paidCount += 1; }
    else if (r.status === 'partial') { bucket.partial += 1; partialCount += 1; }
    else { bucket.unpaid += 1; unpaidCount += 1; }
  }

  let missingRecords = 0;
  for (const s of students) {
    if (!recordedStudentIds.has(s.id)) {
      missingRecords += 1;
      const bucket = byClass.get(s.classId);
      if (bucket) bucket.missing += 1;
    }
  }

  return {
    month,
    collected,
    pending,
    total_due: totalDue,
    paid_count: paidCount,
    partial_count: partialCount,
    unpaid_count: unpaidCount,
    missing_records: missingRecords,
    by_class: classes.map((c) => {
      const b = byClass.get(c.id)!;
      return {
        class_id: c.id,
        class_name: classDisplayName(c.name, c.section),
        collected: b.collected,
        pending: b.pending,
        total_due: b.total_due,
        paid_count: b.paid,
        partial_count: b.partial,
        unpaid_count: b.unpaid,
        missing_records: b.missing,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Month rollover (also used by the 1st-of-month job)
// ---------------------------------------------------------------------------

export async function rolloverMonth(db: Db, schoolId: string, month: string): Promise<RolloverResult> {
  if (!isValidMonthKey(month)) throw ApiError.validation('month must be YYYY-MM');
  const structures = await latestStructuresByClass(db, schoolId, month);
  const classes: any[] = await db.class.findMany({ where: { schoolId } });
  const classesWithoutStructure: string[] = [];
  const toCreate: Array<{ schoolId: string; studentId: string; month: string; amountDue: number; amountPaid: number; discount: number }> = [];

  for (const klass of classes) {
    const structure = structures.get(klass.id);
    if (!structure) {
      classesWithoutStructure.push(klass.id);
      continue;
    }
    const students: any[] = await db.student.findMany({
      where: { schoolId, classId: klass.id, status: 'active' },
      select: { id: true },
    });
    for (const s of students) {
      toCreate.push({
        schoolId,
        studentId: s.id,
        month,
        amountDue: structure.monthlyAmount,
        amountPaid: 0,
        discount: 0,
        // NOTE: `status` is GENERATED — never written.
      });
    }
  }

  let created = 0;
  if (toCreate.length > 0) {
    // skipDuplicates makes the rollover idempotent: already-paid (or any
    // existing) records are NEVER re-created. Run in chunks to stay under
    // parameter limits on very large schools.
    const CHUNK = 500;
    for (let i = 0; i < toCreate.length; i += CHUNK) {
      const res = await db.feeRecord.createMany({
        data: toCreate.slice(i, i + CHUNK),
        skipDuplicates: true,
      });
      created += res.count;
    }
  }

  await db.auditLog.create({
    data: {
      schoolId,
      actorType: 'system',
      action: 'fee.rollover',
      entity: 'fee_record',
      entityId: null,
      details: { month, created, skipped: toCreate.length - created, classes_without_structure: classesWithoutStructure },
    },
  });

  return { month, created, already_existed: toCreate.length - created, classes_without_structure: classesWithoutStructure };
}
