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
import { writeChangeLogs } from '../hardening/helpers';
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
    db.class.findMany({ where: { schoolId, deletedAt: null } }),
  ]);
  const classById = new Map(classes.map((c) => [c.id, c]));
  return structures.map((s) => {
    const c = classById.get(s.classId);
    return {
      id: s.id,
      class_id: s.classId,
      class_name: c ? classDisplayName(c.name, c.section) : '(deleted class)',
      monthly_amount: s.monthlyAmount,
      admission_fee: s.admissionFee ?? 0,
      sibling_discount_pct: s.siblingDiscountPct ?? 0,
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
  const admissionFee = input.admission_fee !== undefined ? assertNonNegativeInt(input.admission_fee, 'admission_fee') : 0;
  const siblingPct = input.sibling_discount_pct !== undefined ? assertNonNegativeInt(input.sibling_discount_pct, 'sibling_discount_pct') : 0;
  if (siblingPct > 100) throw ApiError.validation('sibling_discount_pct must be 0–100');
  if (!isValidDateString(input.effective_from)) {
    throw ApiError.validation('effective_from must be a valid YYYY-MM-DD date');
  }
  const klass: any = await db.class.findUnique({ where: { id: input.class_id } });
  if (!klass || klass.schoolId !== schoolId || klass.deletedAt) throw ApiError.notFound('Class not found');
  const created: any = await db.feeStructure.create({
    data: {
      schoolId,
      classId: input.class_id,
      monthlyAmount: amount,
      admissionFee,
      siblingDiscountPct: siblingPct,
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
      details: { class_id: input.class_id, monthly_amount: amount, effective_from: input.effective_from, admission_fee: admissionFee, sibling_discount_pct: siblingPct },
    },
  });
  return {
    id: created.id,
    class_id: created.classId,
    class_name: classDisplayName(klass.name, klass.section),
    monthly_amount: created.monthlyAmount,
    admission_fee: created.admissionFee ?? 0,
    sibling_discount_pct: created.siblingDiscountPct ?? 0,
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
  const data: { monthlyAmount?: number; effectiveFrom?: Date; admissionFee?: number; siblingDiscountPct?: number } = {};
  if (patch.monthly_amount !== undefined) data.monthlyAmount = assertPositiveInt(patch.monthly_amount, 'monthly_amount');
  if (patch.admission_fee !== undefined) data.admissionFee = assertNonNegativeInt(patch.admission_fee, 'admission_fee');
  if (patch.sibling_discount_pct !== undefined) {
    data.siblingDiscountPct = assertNonNegativeInt(patch.sibling_discount_pct, 'sibling_discount_pct');
    if (data.siblingDiscountPct > 100) throw ApiError.validation('sibling_discount_pct must be 0–100');
  }
  if (patch.effective_from !== undefined) {
    if (!isValidDateString(patch.effective_from)) throw ApiError.validation('effective_from must be a valid YYYY-MM-DD date');
    data.effectiveFrom = new Date(`${patch.effective_from}T00:00:00Z`);
  }
  // Snapshot before-values BEFORE the update (in-place mutation would erase them).
  const beforeStructure = {
    monthly_amount: existing.monthlyAmount,
    admission_fee: existing.admissionFee ?? 0,
    sibling_discount_pct: existing.siblingDiscountPct ?? 0,
    effective_from: toISODate(existing.effectiveFrom),
  };
  const updated: any = await db.feeStructure.update({ where: { id: structureId }, data });
  await writeChangeLogs(db, {
    schoolId,
    entity: 'fee_structure',
    entityId: structureId,
    before: beforeStructure,
    after: {
      monthly_amount: updated.monthlyAmount,
      admission_fee: updated.admissionFee ?? 0,
      sibling_discount_pct: updated.siblingDiscountPct ?? 0,
      effective_from: toISODate(updated.effectiveFrom),
    },
  });
  const klass: any = await db.class.findFirst({ where: { id: updated.classId, schoolId } });
  return {
    id: updated.id,
    class_id: updated.classId,
    class_name: klass ? classDisplayName(klass.name, klass.section) : '(deleted class)',
    monthly_amount: updated.monthlyAmount,
    admission_fee: updated.admissionFee ?? 0,
    sibling_discount_pct: updated.siblingDiscountPct ?? 0,
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
    where: { schoolId, classId: existing.classId, deletedAt: null },
    select: { id: true },
  });
  const ids = students.map((s) => s.id);
  if (ids.length > 0) {
    const blocking: any = await db.feeRecord.findFirst({
      where: { schoolId, studentId: { in: ids }, month: { gte: fromMonth }, deletedAt: null },
      select: { id: true },
    });
    if (blocking) {
      throw ApiError.conflict('Cannot delete: fee records already exist for this class from this structure');
    }
  }
  await db.feeStructure.delete({ where: { id: structureId } });
}

/** Latest structure per class effective on or before the given month start. */
export interface StructureForCalc {
  id: string;
  monthlyAmount: number;
  effectiveFrom: Date;
  admissionFee: number;
  siblingDiscountPct: number;
}

async function latestStructuresByClass(
  db: Db,
  schoolId: string,
  monthKey: string,
): Promise<Map<string, StructureForCalc>> {
  const from = new Date(`${monthStartDate(monthKey)}T00:00:00Z`);
  const all: any[] = await db.feeStructure.findMany({
    where: { schoolId, effectiveFrom: { lte: from } },
    orderBy: { effectiveFrom: 'desc' },
  });
  const byClass = new Map<string, StructureForCalc>();
  for (const s of all) {
    if (!byClass.has(s.classId)) {
      byClass.set(s.classId, {
        id: s.id,
        monthlyAmount: s.monthlyAmount,
        effectiveFrom: s.effectiveFrom,
        admissionFee: s.admissionFee ?? 0,
        siblingDiscountPct: s.siblingDiscountPct ?? 0,
      });
    }
  }
  return byClass;
}

// ---------------------------------------------------------------------------
// 6C-2 fee extensions — fee math rules (see FEATURES-6C2.md)
//   amount_due = monthly_amount + arrears + admission_fee (first record only)
//              - sibling_discount - scholarship_discount
// * sibling_discount = floor(monthly_amount * sibling_discount_pct / 100),
//   applied only when another ACTIVE student in the same school shares the
//   student's parent_phone_hash (same parent, different student).
// * admission_fee is one-time: added only when the student has NO prior
//   fee_record in any month.
// * arrears = sum of the still-unpaid balances of the student's fee_records
//   from months BEFORE the current month (unpaid/partial balances carry
//   forward; a paid month contributes 0). Stored on the record's `arrears`
//   column; `scholarship_discount` is a per-payment input (no per-student
//   scholarship column exists) and is folded in at record creation.
// * The DB GENERATED status column only sees amount_paid + discount vs
//   amount_due, so all of the above MUST be folded into amount_due — the
//   status then follows automatically. Partial payment = payFee with
//   amount_paid < balance; the record stays 'partial' until balance hits 0.
// ---------------------------------------------------------------------------

export interface FeeBreakdown {
  monthly_amount: number;
  arrears: number;
  admission_fee: number;
  sibling_discount: number;
  scholarship_discount: number;
  amount_due: number;
}

/** True when another active student in this school shares the parent phone hash. */
export async function isSiblingStudent(db: Db, schoolId: string, student: any): Promise<boolean> {
  const hash = student?.parentPhoneHash;
  if (!hash) return false;
  const others: any[] = await db.student.findMany({
    where: { schoolId, parentPhoneHash: hash, status: 'active', deletedAt: null },
    select: { id: true },
  });
  return others.some((o) => o.id !== student.id);
}

/** Sum of unpaid balances of this student's fee_records from months before `month`. */
export async function priorArrears(db: Db, schoolId: string, studentId: string, month: string): Promise<number> {
  const prior: any[] = await db.feeRecord.findMany({
    where: { schoolId, studentId, month: { lt: month }, deletedAt: null },
  });
  let sum = 0;
  for (const r of prior) sum += Math.max(0, (r.amountDue ?? 0) - (r.amountPaid ?? 0) - (r.discount ?? 0));
  return sum;
}

export async function hasPriorFeeRecord(db: Db, schoolId: string, studentId: string): Promise<boolean> {
  const existing: any = await db.feeRecord.findFirst({
    where: { schoolId, studentId, deletedAt: null },
    select: { id: true },
  });
  return !!existing;
}

export function computeFeeBreakdown(input: {
  monthlyAmount: number;
  admissionFee: number;
  siblingDiscountPct: number;
  isSibling: boolean;
  isFirstRecord: boolean;
  arrears: number;
  scholarshipDiscount: number;
}): FeeBreakdown {
  // Defensive coercion: real Prisma rows always carry the v2 defaults
  // (0), but callers/tests may pass rows without the fields set.
  const monthlyAmount = Number(input.monthlyAmount) || 0;
  const admissionFeeIn = Number(input.admissionFee) || 0;
  const siblingPct = Number(input.siblingDiscountPct) || 0;
  const arrearsIn = Number(input.arrears) || 0;
  const scholarshipIn = Number(input.scholarshipDiscount) || 0;
  const siblingDiscount = input.isSibling
    ? Math.floor((monthlyAmount * Math.min(100, Math.max(0, siblingPct))) / 100)
    : 0;
  const admissionFee = input.isFirstRecord ? Math.max(0, admissionFeeIn) : 0;
  const amountDue = Math.max(
    0,
    monthlyAmount + Math.max(0, arrearsIn) + admissionFee - siblingDiscount - Math.max(0, scholarshipIn),
  );
  return {
    monthly_amount: monthlyAmount,
    arrears: Math.max(0, arrearsIn),
    admission_fee: admissionFee,
    sibling_discount: siblingDiscount,
    scholarship_discount: Math.max(0, scholarshipIn),
    amount_due: amountDue,
  };
}

/** Full breakdown for one student/month (used by listFees, payFee, rollover). */
export async function feeBreakdownForStudent(
  db: Db,
  schoolId: string,
  student: any,
  structure: StructureForCalc,
  month: string,
  scholarshipDiscount = 0,
): Promise<FeeBreakdown> {
  const [isSibling, arrears, hasPrior] = await Promise.all([
    isSiblingStudent(db, schoolId, student),
    priorArrears(db, schoolId, student.id, month),
    hasPriorFeeRecord(db, schoolId, student.id),
  ]);
  return computeFeeBreakdown({
    monthlyAmount: structure.monthlyAmount,
    admissionFee: structure.admissionFee,
    siblingDiscountPct: structure.siblingDiscountPct,
    isSibling,
    isFirstRecord: !hasPrior,
    arrears,
    scholarshipDiscount,
  });
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
    where: query.class_id ? { schoolId, id: query.class_id, deletedAt: null } : { schoolId, deletedAt: null },
    orderBy: [{ name: 'asc' }, { section: 'asc' }],
  });
  if (query.class_id && classes.length === 0) throw ApiError.notFound('Class not found');
  const classById = new Map(classes.map((c) => [c.id, c]));
  const classIds = classes.map((c) => c.id);

  const studentWhere: Record<string, unknown> = { schoolId, classId: { in: classIds }, status: 'active', deletedAt: null };
  if (query.search) studentWhere.name = { contains: query.search, mode: 'insensitive' };
  const students: any[] = await db.student.findMany({
    where: studentWhere,
    orderBy: [{ classId: 'asc' }, { rollNo: 'asc' }, { name: 'asc' }],
  });

  const studentIds = students.map((s) => s.id);
  const records: any[] = studentIds.length
    ? await db.feeRecord.findMany({ where: { schoolId, month, studentId: { in: studentIds }, deletedAt: null } })
    : [];
  const recordByStudent = new Map(records.map((r) => [r.studentId, r]));
  const structures = await latestStructuresByClass(db, schoolId, month);

  // 6C-2: rows without a record yet show the PROSPECTIVE breakdown
  // (arrears / admission fee / sibling discount folded into amount_due).
  // Rows with a record show the stored arrears / scholarship_discount;
  // sibling + admission amounts are already inside their stored amount_due.
  let items: FeeListItem[] = [];
  for (const s of students) {
    const klass = classById.get(s.classId);
    const rec = recordByStudent.get(s.id);
    const structure = structures.get(s.classId);
    let amountDue: number;
    let amountPaid: number;
    let discount: number;
    let arrears = 0;
    let scholarshipDiscount = 0;
    let breakdown: FeeBreakdown | null = null;
    if (rec) {
      amountDue = rec.amountDue;
      amountPaid = rec.amountPaid;
      discount = rec.discount;
      arrears = rec.arrears ?? 0;
      scholarshipDiscount = rec.scholarshipDiscount ?? 0;
    } else if (structure) {
      breakdown = await feeBreakdownForStudent(db, schoolId, s, structure, month);
      amountDue = breakdown.amount_due;
      amountPaid = 0;
      discount = 0;
      arrears = breakdown.arrears;
      scholarshipDiscount = breakdown.scholarship_discount;
    } else {
      amountDue = 0;
      amountPaid = 0;
      discount = 0;
    }
    items.push({
      student_id: s.id,
      student_name: s.name,
      roll_no: s.rollNo,
      class_id: s.classId,
      class_name: klass ? classDisplayName(klass.name, klass.section) : '(unknown)',
      month,
      amount_due: amountDue,
      amount_paid: amountPaid,
      discount,
      arrears,
      scholarship_discount: scholarshipDiscount,
      breakdown,
      balance: balanceOf(amountDue, amountPaid, discount),
      status: rec ? (rec.status as FeeStatus) : computeFeeStatus(amountDue, 0, 0),
      receipt_no: rec?.receiptNo ?? null,
      paid_at: rec?.paidAt ? rec.paidAt.toISOString() : null,
      payment_method: rec?.paymentMethod ?? null,
      record_exists: !!rec,
      record_id: rec?.id ?? null,
      no_structure: !structure && !rec,
    });
  }

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
    if (!student || student.schoolId !== schoolId || student.deletedAt) throw ApiError.notFound('Student not found');
    if (student.status !== 'active') throw ApiError.conflict('Cannot accept payment for a non-active student');

    let record: any = await tx.feeRecord.findUnique({
      where: { studentId_month: { studentId, month: input.month } },
    });
    if (record?.deletedAt) throw ApiError.conflict('This fee record was deleted (see recycle bin)');

    if (!record) {
      // No rollover record yet (e.g. payment before the 1st-run job):
      // create it on the fly from the class's current structure.
      // 6C-2: arrears / admission fee / sibling discount / scholarship are
      // folded into amount_due at creation (they do NOT feed the GENERATED
      // status column — see computeFeeBreakdown).
      const structures = await latestStructuresByClass(tx, schoolId, input.month);
      const structure = structures.get(student.classId);
      if (!structure) throw ApiError.conflict('No fee structure exists for this class/month yet');
      const scholarship = input.scholarship_discount !== undefined ? assertNonNegativeInt(input.scholarship_discount, 'scholarship_discount') : 0;
      const breakdown = await feeBreakdownForStudent(tx, schoolId, student, structure, input.month, scholarship);
      // A caller-supplied `arrears` overrides the computed carry-forward
      // (e.g. the admin is correcting a migrated balance); otherwise use
      // the computed value.
      const arrears = input.arrears !== undefined ? assertNonNegativeInt(input.arrears, 'arrears') : breakdown.arrears;
      const amountDue =
        arrears === breakdown.arrears
          ? breakdown.amount_due
          : computeFeeBreakdown({
              monthlyAmount: structure.monthlyAmount,
              admissionFee: structure.admissionFee,
              siblingDiscountPct: structure.siblingDiscountPct,
              isSibling: breakdown.sibling_discount > 0,
              isFirstRecord: breakdown.admission_fee > 0 || !(await hasPriorFeeRecord(tx, schoolId, student.id)),
              arrears,
              scholarshipDiscount: scholarship,
            }).amount_due;
      record = await tx.feeRecord.create({
        data: {
          schoolId,
          studentId,
          month: input.month,
          amountDue,
          amountPaid: 0,
          discount: 0,
          arrears,
          scholarshipDiscount: scholarship,
          // NOTE: `status` is a GENERATED column — never written, only read.
        },
      });
    } else if (
      (input.arrears !== undefined || input.scholarship_discount !== undefined) &&
      record.amountPaid === 0 &&
      record.discount === 0
    ) {
      // 6C-2: an untouched existing record may still have its arrears /
      // scholarship restated (folded into amount_due). Once any payment or
      // discount exists the due is locked — restating it would rewrite
      // history, so that is rejected instead.
      const arrears = input.arrears !== undefined ? assertNonNegativeInt(input.arrears, 'arrears') : record.arrears ?? 0;
      const scholarship =
        input.scholarship_discount !== undefined
          ? assertNonNegativeInt(input.scholarship_discount, 'scholarship_discount')
          : record.scholarshipDiscount ?? 0;
      const restatedDue = Math.max(0, record.amountDue - (record.arrears ?? 0) + arrears + (record.scholarshipDiscount ?? 0) - scholarship);
      record = await tx.feeRecord.update({
        where: { id: record.id },
        data: { amountDue: restatedDue, arrears, scholarshipDiscount: scholarship },
      });
    } else if (input.arrears !== undefined || input.scholarship_discount !== undefined) {
      throw ApiError.validation('Cannot change arrears/scholarship_discount after a payment or discount has been recorded for this month');
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
    // Snapshot before-values BEFORE the update (in-place mutation would erase them).
    const beforeFee = {
      amount_paid: record.amountPaid,
      discount: record.discount,
      payment_method: record.paymentMethod ?? null,
      receipt_no: record.receiptNo ?? null,
      status: record.status,
    };

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

    // 6C-2: keep any vouchers for this record in step with the payment.
    try {
      await (tx as any).feeVoucher.updateMany({
        where: { schoolId, feeRecordId: updated.id },
        data: { status: updated.status, amountDue: balanceOf(updated.amountDue, updated.amountPaid, updated.discount) },
      });
    } catch {
      /* vouchers are best-effort here; the payment itself must not fail */
    }

    // 6A change history: one row per changed field on the fee record.
    await writeChangeLogs(tx, {
      schoolId,
      actorId,
      entity: 'fee_record',
      entityId: updated.id,
      before: beforeFee,
      after: {
        amount_paid: updated.amountPaid,
        discount: updated.discount,
        payment_method: updated.paymentMethod ?? null,
        receipt_no: updated.receiptNo ?? null,
        status: updated.status,
      },
    });

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

    const klass: any = await tx.class.findFirst({ where: { id: student.classId, schoolId } });
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
    arrears?: number;
    scholarshipDiscount?: number;
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
    arrears: record.arrears ?? 0,
    scholarship_discount: record.scholarshipDiscount ?? 0,
  };
}

export async function getReceiptByNo(db: Db, schoolId: string, receiptNo: string): Promise<ReceiptData> {
  const school = await getSchoolOr404(db, schoolId);
  const record: any = await db.feeRecord.findFirst({ where: { schoolId, receiptNo } });
  if (!record) throw ApiError.notFound('Receipt not found');
  const student: any = await db.student.findUnique({ where: { id: record.studentId } });
  if (!student || student.schoolId !== schoolId) throw ApiError.notFound('Receipt not found');
  const klass: any = await db.class.findFirst({ where: { id: student.classId, schoolId } });
  return toReceiptData(school, student, klass, record);
}

// ---------------------------------------------------------------------------
// Monthly report
// ---------------------------------------------------------------------------

export async function monthlyFeeReport(db: Db, schoolId: string, month: string): Promise<MonthlyFeeReport> {
  if (!isValidMonthKey(month)) throw ApiError.validation('month must be YYYY-MM');
  const [classes, students, records]: [any[], any[], any[]] = await Promise.all([
    db.class.findMany({ where: { schoolId, deletedAt: null }, orderBy: [{ name: 'asc' }, { section: 'asc' }] }),
    db.student.findMany({ where: { schoolId, status: 'active', deletedAt: null } }),
    db.feeRecord.findMany({ where: { schoolId, month, deletedAt: null } }),
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
  const classes: any[] = await db.class.findMany({ where: { schoolId, deletedAt: null } });
  const classesWithoutStructure: string[] = [];
  const toCreate: Array<{ schoolId: string; studentId: string; month: string; amountDue: number; amountPaid: number; discount: number; arrears: number; scholarshipDiscount: number }> = [];

  for (const klass of classes) {
    const structure = structures.get(klass.id);
    if (!structure) {
      classesWithoutStructure.push(klass.id);
      continue;
    }
    const students: any[] = await db.student.findMany({
      where: { schoolId, classId: klass.id, status: 'active', deletedAt: null },
      select: { id: true, parentPhoneHash: true },
    });
    for (const s of students) {
      // 6C-2: fold arrears + one-time admission fee − sibling discount
      // into amount_due (see computeFeeBreakdown); the GENERATED status
      // column then follows automatically.
      const breakdown = await feeBreakdownForStudent(db, schoolId, s, structure, month);
      toCreate.push({
        schoolId,
        studentId: s.id,
        month,
        amountDue: breakdown.amount_due,
        amountPaid: 0,
        discount: 0,
        arrears: breakdown.arrears,
        scholarshipDiscount: 0,
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
