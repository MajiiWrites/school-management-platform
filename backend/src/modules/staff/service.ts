// Staff & payroll (6C-1).
// Staff profiles (phone stored AES-256-GCM + SHA-256 hash, same pattern as
// parents/teachers — never returned, only masked), class assignments, and
// SIMPLIFIED payroll (Module E FINAL REBUILD): one SalaryRecord row = one
// payment (month + staff + amount). The agreed monthly salary lives only
// on Staff.salaryMonthly; month status (Paid / Partially Paid / Unpaid)
// and the remaining amount are derived from the payments. Staff delete is
// blocked while timetable entries or payment records exist (payroll history
// must not vanish silently); assignments are removed with the staff row.
import { ApiError } from '../../lib/errors';
import { isValidDateString, dateOnly } from '../../lib/dates';
import { normalizePhone, encryptPhone, decryptPhone, sha256Hex, maskPhone } from '../../lib/crypto';
import { writeAudit } from '../../lib/audit';
import { writeChangeLogs, logCreate, logDelete } from '../hardening/helpers';
import { paginatedResponse, parsePagination } from '../../lib/pagination';
import type { Db } from '../../lib/db';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function maskedPhone(enc: string | null | undefined): string | null {
  if (!enc) return null;
  try {
    return maskPhone(decryptPhone(enc));
  } catch {
    return null;
  }
}

export function toPublicStaff(s: any): Record<string, unknown> {
  return {
    id: s.id, school_id: s.schoolId, name: s.name, role: s.role,
    phone_masked: maskedPhone(s.phoneEnc), email: s.email ?? null,
    joining_date: s.joiningDate ? (s.joiningDate instanceof Date ? s.joiningDate.toISOString().slice(0, 10) : s.joiningDate) : null,
    subjects: (s.subjects as string[] | null) ?? [],
    salary_monthly: s.salaryMonthly ?? null,
    created_at: s.createdAt, updated_at: s.updatedAt,
  };
}

export function toPublicAssignment(a: any, staffName?: string | null, className?: string | null): Record<string, unknown> {
  return {
    id: a.id, school_id: a.schoolId, staff_id: a.staffId, staff_name: staffName ?? null,
    class_id: a.classId, class_name: className ?? null, subject: a.subject, created_at: a.createdAt,
  };
}

function phoneFields(phone: string | null | undefined): { enc: string | null; hash: string | null } {
  if (!phone) return { enc: null, hash: null };
  const normalized = normalizePhone(phone);
  if (!normalized) throw ApiError.validation('phone is not a valid Pakistani mobile number');
  return { enc: encryptPhone(normalized), hash: sha256Hex(normalized) };
}

function subjectsOf(input: unknown): string[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.some((x) => typeof x !== 'string')) throw ApiError.validation('subjects must be an array of strings');
  return input.map((x) => x.trim()).filter(Boolean);
}

// --- Staff -------------------------------------------------------------------
export async function listStaff(
  db: Db, schoolId: string, query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  const where: Record<string, unknown> = { schoolId };
  if (query.role) {
    if (query.role !== 'teacher' && query.role !== 'staff') throw ApiError.validation('role must be teacher or staff');
    where.role = String(query.role);
  }
  if (query.search) where.name = { contains: String(query.search), mode: 'insensitive' };
  const [rows, total] = await Promise.all([
    db.staff.findMany({ where, orderBy: [{ name: 'asc' }], skip, take: limit }),
    db.staff.count({ where }),
  ]);
  return paginatedResponse(rows.map(toPublicStaff), total, { page, limit, skip });
}

export async function createStaff(
  db: Db, schoolId: string,
  input: { name: string; role: string; phone?: string | null; email?: string | null; joining_date?: string | null; subjects?: string[]; salary_monthly?: number | null },
  actorId: string,
): Promise<any> {
  const name = input.name?.trim();
  if (!name) throw ApiError.validation('name is required');
  if (input.role !== 'teacher' && input.role !== 'staff') throw ApiError.validation('role must be teacher or staff');
  if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) throw ApiError.validation('email is not valid');
  if (input.joining_date && !isValidDateString(input.joining_date)) throw ApiError.validation('joining_date must be YYYY-MM-DD');
  if (input.salary_monthly !== undefined && input.salary_monthly !== null && (!Number.isInteger(input.salary_monthly) || input.salary_monthly < 0)) {
    throw ApiError.validation('salary_monthly must be an integer >= 0');
  }
  const phone = phoneFields(input.phone ?? null);
  const created = await db.staff.create({
    data: {
      schoolId, name, role: input.role, phoneEnc: phone.enc, phoneHash: phone.hash,
      email: input.email?.trim() || null,
      joiningDate: input.joining_date ? dateOnly(input.joining_date) : null,
      subjects: subjectsOf(input.subjects), salaryMonthly: input.salary_monthly ?? null,
    },
  });
  await logCreate(db, {
    schoolId,
    actorId,
    entity: 'staff',
    entityId: created.id,
    after: { name: created.name, role: created.role, phone: phone.enc ? maskedPhone(phone.enc) : null, email: created.email, joining_date: created.joiningDate, subjects: created.subjects, salary_monthly: created.salaryMonthly },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'staff.create', entity: 'staff', entityId: created.id, details: { name, role: input.role } });
  return toPublicStaff(created);
}

export async function getStaff(db: Db, schoolId: string, id: string): Promise<any> {
  const s = await db.staff.findFirst({ where: { id, schoolId } });
  if (!s) throw ApiError.notFound('Staff member not found');
  return toPublicStaff(s);
}

async function getStaffRow(db: Db, schoolId: string, id: string): Promise<any> {
  const s = await db.staff.findFirst({ where: { id, schoolId } });
  if (!s) throw ApiError.notFound('Staff member not found');
  return s;
}

export async function updateStaff(
  db: Db, schoolId: string, id: string,
  patch: { name?: string; role?: string; phone?: string | null; email?: string | null; joining_date?: string | null; subjects?: string[]; salary_monthly?: number | null },
  actorId: string,
): Promise<any> {
  const s = await getStaffRow(db, schoolId, id);
  const before = { name: s.name, role: s.role, phone: maskedPhone(s.phoneEnc), email: s.email, joining_date: s.joiningDate, subjects: s.subjects, salary_monthly: s.salaryMonthly };
  const data: Record<string, unknown> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw ApiError.validation('name is required');
    data.name = name;
  }
  if (patch.role !== undefined) {
    if (patch.role !== 'teacher' && patch.role !== 'staff') throw ApiError.validation('role must be teacher or staff');
    if (patch.role === 'staff') {
      const onTimetable = await db.timetableEntry.count({ where: { schoolId, teacherId: id } });
      if (onTimetable > 0) throw ApiError.conflict('This teacher is on the timetable. Remove their timetable entries before changing the role to staff.');
    }
    data.role = patch.role;
  }
  if (patch.phone !== undefined) {
    const phone = phoneFields(patch.phone);
    data.phoneEnc = phone.enc;
    data.phoneHash = phone.hash;
  }
  if (patch.email !== undefined) {
    if (patch.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) throw ApiError.validation('email is not valid');
    data.email = patch.email?.trim() || null;
  }
  if (patch.joining_date !== undefined) {
    if (patch.joining_date && !isValidDateString(patch.joining_date)) throw ApiError.validation('joining_date must be YYYY-MM-DD');
    data.joiningDate = patch.joining_date ? dateOnly(patch.joining_date) : null;
  }
  if (patch.subjects !== undefined) data.subjects = subjectsOf(patch.subjects);
  if (patch.salary_monthly !== undefined) {
    if (patch.salary_monthly !== null && (!Number.isInteger(patch.salary_monthly) || patch.salary_monthly < 0)) throw ApiError.validation('salary_monthly must be an integer >= 0');
    data.salaryMonthly = patch.salary_monthly;
  }
  if (Object.keys(data).length === 0) return toPublicStaff(s);
  const updated = await db.staff.update({ where: { id }, data });
  await writeChangeLogs(db, { schoolId, actorId, entity: 'staff', entityId: id, before, after: { name: updated.name, role: updated.role, phone: maskedPhone(updated.phoneEnc), email: updated.email, joining_date: updated.joiningDate, subjects: updated.subjects, salary_monthly: updated.salaryMonthly } });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'staff.update', entity: 'staff', entityId: id, details: { name: updated.name } });
  return toPublicStaff(updated);
}

export async function deleteStaff(db: Db, schoolId: string, id: string, actorId: string): Promise<void> {
  const s = await getStaffRow(db, schoolId, id);
  const onTimetable = await db.timetableEntry.count({ where: { schoolId, teacherId: id } });
  if (onTimetable > 0) throw ApiError.conflict('This staff member is on the timetable. Remove their timetable entries first.');
  const salaryRows = await db.salaryRecord.count({ where: { schoolId, staffId: id } });
  if (salaryRows > 0) throw ApiError.conflict('This staff member has payment records. Payment history is kept — staff with payroll cannot be deleted.');
  const snapshot = JSON.parse(JSON.stringify(s, (_k, v) => (v instanceof Date ? v.toISOString() : v)));
  // Assignments go with the staff row; payment history/timetable are blocked above.
  await db.staffClassAssignment.deleteMany({ where: { schoolId, staffId: id } });
  await db.staff.delete({ where: { id } });
  await (db as any).deletedRecord.create({
    data: { schoolId, entity: 'staff', entityId: id, snapshot, deletedBy: actorId, deletedAt: new Date(), restoreBy: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
  });
  await logDelete(db, {
    schoolId,
    actorId,
    entity: 'staff',
    entityId: id,
    before: { name: s.name, role: s.role },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'staff.delete', entity: 'staff', entityId: id, details: { name: s.name } });
}

// --- Assignments ---------------------------------------------------------------
export async function listAssignments(db: Db, schoolId: string, query: Record<string, any>): Promise<any[]> {
  const where: Record<string, unknown> = { schoolId };
  if (query.staff_id) where.staffId = String(query.staff_id);
  if (query.class_id) where.classId = String(query.class_id);
  const rows = await db.staffClassAssignment.findMany({ where, orderBy: [{ createdAt: 'asc' }] });
  const staffIds = [...new Set(rows.map((r: any) => r.staffId))];
  const classIds = [...new Set(rows.map((r: any) => r.classId))];
  const [staff, classes] = await Promise.all([
    staffIds.length ? db.staff.findMany({ where: { schoolId, id: { in: staffIds } } }) : Promise.resolve([]),
    classIds.length ? db.class.findMany({ where: { schoolId, id: { in: classIds } } }) : Promise.resolve([]),
  ]);
  const staffById = new Map<string, string>(staff.map((x: any) => [x.id, x.name] as [string, string]));
  const classById = new Map<string, string>(classes.map((c: any) => [c.id, `${c.name}-${c.section}`] as [string, string]));
  return rows.map((r: any) => toPublicAssignment(r, staffById.get(r.staffId) ?? null, classById.get(r.classId) ?? null));
}

export async function assignStaff(
  db: Db, schoolId: string, staffId: string,
  input: { class_id: string; subject: string },
  actorId: string,
): Promise<any> {
  const staff = await getStaffRow(db, schoolId, staffId);
  const cls = await db.class.findFirst({ where: { id: input.class_id, schoolId, deletedAt: null } });
  if (!cls) throw ApiError.notFound('Class not found');
  const subject = input.subject?.trim();
  if (!subject) throw ApiError.validation('subject is required');
  const dup = await db.staffClassAssignment.findFirst({ where: { staffId, classId: input.class_id, subject } });
  if (dup) throw ApiError.conflict(`${staff.name} is already assigned to teach ${subject} in Class ${cls.name}-${cls.section}`);
  const created = await db.staffClassAssignment.create({ data: { schoolId, staffId, classId: input.class_id, subject } });
  await logCreate(db, {
    schoolId,
    actorId,
    entity: 'staff_class_assignment',
    entityId: created.id,
    after: { staff_id: staffId, class_id: input.class_id, subject },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'staff.assign', entity: 'staff_class_assignment', entityId: created.id, details: { staff_id: staffId, class_id: input.class_id, subject } });
  return toPublicAssignment(created, staff.name, `${cls.name}-${cls.section}`);
}

export async function removeAssignment(db: Db, schoolId: string, staffId: string, assignmentId: string, actorId: string): Promise<void> {
  const row = await db.staffClassAssignment.findFirst({ where: { id: assignmentId, schoolId, staffId } });
  if (!row) throw ApiError.notFound('Assignment not found');
  await db.staffClassAssignment.delete({ where: { id: assignmentId } });
  await logDelete(db, {
    schoolId,
    actorId,
    entity: 'staff_class_assignment',
    entityId: assignmentId,
    before: { staff_id: staffId, class_id: row.classId, subject: row.subject },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'staff.unassign', entity: 'staff_class_assignment', entityId: assignmentId, details: { staff_id: staffId, subject: row.subject } });
}

// --- Payroll (SIMPLIFIED — Module E FINAL REBUILD) ---------------------------
// One SalaryRecord row = ONE payment: month + staff + amount (+ paidAt =
// the payment date). The agreed monthly salary lives ONLY on
// Staff.salaryMonthly. There are no deductions, allowances, bonuses, tax,
// net pay, or payslip numbers. A staff member's month status and the
// remaining amount are DERIVED from the payments, never stored:
//   paid = 0           -> 'unpaid'
//   0 < paid < salary  -> 'partial'
//   paid >= salary     -> 'paid'   (overpayment clamps remaining to 0)
// Staff with no salaryMonthly set: remaining is null; status is 'partial'
// only if something was paid, otherwise 'unpaid'.
export type PayrollStatus = 'unpaid' | 'partial' | 'paid';

export function computePayrollStatus(monthlySalary: number | null | undefined, amountPaid: number): PayrollStatus {
  if (amountPaid <= 0) return 'unpaid';
  if (monthlySalary === null || monthlySalary === undefined) return 'partial';
  return amountPaid >= monthlySalary ? 'paid' : 'partial';
}

export function computeRemaining(monthlySalary: number | null | undefined, amountPaid: number): number | null {
  if (monthlySalary === null || monthlySalary === undefined) return null;
  return Math.max(0, monthlySalary - amountPaid);
}

export function toPublicPayment(r: any, staffName?: string | null): Record<string, unknown> {
  return {
    id: r.id, school_id: r.schoolId, staff_id: r.staffId, staff_name: staffName ?? null,
    month: r.month, amount: r.amount, paid_at: r.paidAt ?? null, created_at: r.createdAt,
  };
}

export function toPublicPayrollSummary(staff: any, month: string, payments: any[]): Record<string, unknown> {
  const monthlySalary = staff.salaryMonthly ?? null;
  const amountPaid = payments.reduce((a: number, p: any) => a + (p.amount ?? 0), 0);
  return {
    staff_id: staff.id, staff_name: staff.name, month, monthly_salary: monthlySalary,
    amount_paid: amountPaid, remaining: computeRemaining(monthlySalary, amountPaid),
    status: computePayrollStatus(monthlySalary, amountPaid),
    payments: payments.map((p: any) => toPublicPayment(p, staff.name)),
  };
}

export async function listPayroll(
  db: Db, schoolId: string, query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  const month = query.month ? String(query.month) : new Date().toISOString().slice(0, 7);
  if (!MONTH_RE.test(month)) throw ApiError.validation('month must be YYYY-MM');
  if (query.status && !['unpaid', 'partial', 'paid'].includes(String(query.status))) {
    throw ApiError.validation('status must be unpaid, partial, or paid');
  }
  // Summaries are computed per staff member, so fetch all matching staff
  // (a school has at most a few hundred) and paginate the summaries.
  const staffWhere: Record<string, unknown> = { schoolId };
  if (query.staff_id) staffWhere.id = String(query.staff_id);
  const allStaff = await db.staff.findMany({ where: staffWhere, orderBy: [{ name: 'asc' }] });
  const staffIds = allStaff.map((s: any) => s.id);
  const payments = staffIds.length
    ? await db.salaryRecord.findMany({ where: { schoolId, month, staffId: { in: staffIds } }, orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }] })
    : [];
  const byStaff = new Map<string, any[]>();
  for (const p of payments) {
    const list = byStaff.get(p.staffId) ?? [];
    list.push(p);
    byStaff.set(p.staffId, list);
  }
  let summaries = allStaff.map((s: any) => toPublicPayrollSummary(s, month, byStaff.get(s.id) ?? []));
  if (query.status) summaries = summaries.filter((s: any) => s.status === String(query.status));
  const total = summaries.length;
  return paginatedResponse(summaries.slice(skip, skip + limit), total, { page, limit, skip });
}

/** Record ONE payment. Kept the historic name so the clerk approval queue
 * (modules/hardening/approvals.ts, entity 'salary_record') still dispatches
 * to it; the payload is now just { staff_id, month, amount }. */
export async function createSalaryRecord(
  db: Db, schoolId: string,
  input: { staff_id: string; month: string; amount: number },
  actorId: string,
): Promise<any> {
  const staff = await getStaffRow(db, schoolId, input.staff_id);
  if (!MONTH_RE.test(input.month)) throw ApiError.validation('month must be YYYY-MM');
  if (!Number.isInteger(input.amount) || input.amount <= 0) throw ApiError.validation('amount must be an integer > 0');
  const created = await db.salaryRecord.create({
    data: { schoolId, staffId: input.staff_id, month: input.month, amount: input.amount, paidAt: new Date() },
  });
  await logCreate(db, {
    schoolId,
    actorId,
    entity: 'salary_record',
    entityId: created.id,
    after: { staff_id: input.staff_id, month: input.month, amount: created.amount },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'payroll.create', entity: 'salary_record', entityId: created.id, details: { staff_id: input.staff_id, month: input.month, amount: created.amount } });
  return toPublicPayment(created, staff.name);
}

export async function getSalaryRecord(db: Db, schoolId: string, id: string): Promise<any> {
  const r = await db.salaryRecord.findFirst({ where: { id, schoolId } });
  if (!r) throw ApiError.notFound('Salary record not found');
  const staff = await db.staff.findFirst({ where: { id: r.staffId, schoolId } });
  return toPublicPayment(r, staff?.name ?? null);
}

/** Edit a payment's amount (the only editable field). Old queued patches
 * carrying base_salary/deductions/paid are ignored — those fields no
 * longer exist. */
export async function updateSalaryRecord(
  db: Db, schoolId: string, id: string,
  patch: { amount?: number },
  actorId: string,
): Promise<any> {
  const r = await db.salaryRecord.findFirst({ where: { id, schoolId } });
  if (!r) throw ApiError.notFound('Salary record not found');
  if (patch.amount === undefined) return toPublicPayment(r, (await db.staff.findFirst({ where: { id: r.staffId, schoolId } }))?.name ?? null);
  if (!Number.isInteger(patch.amount) || patch.amount <= 0) throw ApiError.validation('amount must be an integer > 0');
  const before = { amount: r.amount, month: r.month };
  const updated = await db.salaryRecord.update({ where: { id }, data: { amount: patch.amount } });
  await writeChangeLogs(db, { schoolId, actorId, entity: 'salary_record', entityId: id, before, after: { amount: updated.amount, month: updated.month } });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'payroll.update', entity: 'salary_record', entityId: id, details: { month: updated.month, amount: updated.amount } });
  const staff = await db.staff.findFirst({ where: { id: updated.staffId, schoolId } });
  return toPublicPayment(updated, staff?.name ?? null);
}

/** Delete ONE payment. Any payment can be deleted — deleting it just
 * reduces the month's paid total (and can flip the status back to
 * Partially Paid / Unpaid). Payment history is otherwise kept: staff with
 * payments cannot be deleted (see deleteStaff). */
export async function deleteSalaryRecord(db: Db, schoolId: string, id: string, actorId: string): Promise<void> {
  const r = await db.salaryRecord.findFirst({ where: { id, schoolId } });
  if (!r) throw ApiError.notFound('Salary record not found');
  await db.salaryRecord.delete({ where: { id } });
  await logDelete(db, {
    schoolId,
    actorId,
    entity: 'salary_record',
    entityId: id,
    before: { staff_id: r.staffId, month: r.month, amount: r.amount },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'payroll.delete', entity: 'salary_record', entityId: id, details: { month: r.month, amount: r.amount } });
}

// --- Salary slip (printable HTML + real PDF via pdfkit) ------------------------
// Same pattern as certificates / fee receipts: pdfkit is loaded dynamically
// and the route falls back to HTML when it is unavailable. The slip is per
// (staff, month) — not per payment — and lists every payment date.
export interface SalarySlipData {
  staff_id: string;
  school_name: string;
  logo_url: string | null;
  staff_name: string;
  role: string;
  month: string;
  monthly_salary: number | null;
  amount_paid: number;
  remaining: number | null;
  status: PayrollStatus;
  payments: { amount: number; paid_at: string | null }[];
  timezone: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export async function getPayslipData(db: Db, schoolId: string, staffId: string, month: string): Promise<SalarySlipData> {
  if (!MONTH_RE.test(month)) throw ApiError.validation('month must be YYYY-MM');
  const staff = await getStaffRow(db, schoolId, staffId);
  const school: any = await db.school.findUnique({ where: { id: schoolId } });
  if (!school) throw ApiError.notFound('School not found');
  const payments = await db.salaryRecord.findMany({ where: { schoolId, staffId, month }, orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }] });
  const monthlySalary = staff.salaryMonthly ?? null;
  const amountPaid = payments.reduce((a: number, p: any) => a + (p.amount ?? 0), 0);
  const settings = (school.settings as Record<string, unknown>) ?? {};
  return {
    staff_id: staff.id,
    school_name: school.name ?? '',
    logo_url: (settings.logo_url as string | null) ?? null,
    staff_name: staff.name,
    role: staff.role ?? '',
    month,
    monthly_salary: monthlySalary,
    amount_paid: amountPaid,
    remaining: computeRemaining(monthlySalary, amountPaid),
    status: computePayrollStatus(monthlySalary, amountPaid),
    payments: payments.map((p: any) => ({ amount: p.amount, paid_at: p.paidAt ? new Date(p.paidAt).toISOString() : null })),
    timezone: (school.timezone as string | undefined) ?? 'Asia/Karachi',
  };
}

export function renderPayslipHtml(p: SalarySlipData): string {
  const fmt = (n: number) => `Rs. ${n.toLocaleString('en-PK')}`;
  const statusLabel = p.status === 'paid' ? 'PAID' : p.status === 'partial' ? 'PARTIALLY PAID' : 'UNPAID';
  const badgeColor = p.status === 'paid' ? '#14532d' : p.status === 'partial' ? '#92400e' : '#991b1b';
  const dateFmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { timeZone: p.timezone }) : '—');
  const rows = p.payments.length
    ? p.payments.map((pay, i) => `<tr><td>Payment ${i + 1} — ${dateFmt(pay.paid_at)}</td><td class="num">${fmt(pay.amount)}</td></tr>`).join('')
    : '<tr><td>No payments recorded yet</td><td class="num">—</td></tr>';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Salary Slip — ${esc(p.staff_name)} — ${esc(monthLabel(p.month))}</title>
<style>*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0;padding:24px}.slip{max-width:640px;margin:0 auto;border:2px solid #14532d;border-radius:8px;padding:24px}h1{margin:0;font-size:20px;color:#14532d}.sub{color:#555;font-size:13px}.badge{display:inline-block;padding:4px 10px;border-radius:999px;color:#fff;background:${badgeColor};font-weight:bold;font-size:12px}table{width:100%;border-collapse:collapse;margin-top:16px;font-size:14px}td,th{padding:8px 4px;border-bottom:1px solid #ddd;text-align:left}td.num,th.num{text-align:right}tr.total td{font-weight:bold;border-top:2px solid #14532d}.row{display:flex;justify-content:space-between;margin-top:6px;font-size:14px}.sig{margin-top:36px;display:flex;justify-content:space-between;font-size:13px}.sig span{border-top:1px solid #333;padding-top:4px}.print-btn{margin:16px auto;display:block;padding:10px 18px;font-size:14px;background:#14532d;color:#fff;border:0;border-radius:6px;cursor:pointer}@media print{.print-btn{display:none}body{padding:0}.slip{border-width:1px}}</style>
</head><body>
<button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
<div class="slip">
${p.logo_url ? `<img src="${esc(p.logo_url)}" alt="School logo" style="max-height:64px;max-width:180px;">` : ''}
<div class="row"><div><h1>${esc(p.school_name)}</h1><div class="sub">Monthly Salary Slip</div></div><div><span class="badge">${statusLabel}</span></div></div>
<div class="row"><span>Staff: <strong>${esc(p.staff_name)}</strong> (${esc(p.role)})</span><span>Month: <strong>${esc(monthLabel(p.month))}</strong></span></div>
<table><tr><th>Description</th><th class="num">Amount</th></tr>
<tr><td>Monthly salary</td><td class="num">${p.monthly_salary !== null ? fmt(p.monthly_salary) : '—'}</td></tr>
${rows}
<tr class="total"><td>Amount paid</td><td class="num">${fmt(p.amount_paid)}</td></tr>
<tr class="total"><td>Amount remaining</td><td class="num">${p.remaining !== null ? fmt(p.remaining) : '—'}</td></tr></table>
<div class="sig"><span>Received by</span><span>Authorised by</span></div>
<p style="margin-top:20px;font-size:12px;color:#666">This is a computer-generated salary slip from ${esc(p.school_name)}.</p>
</div></body></html>`;
}

export async function renderPayslipPdf(p: SalarySlipData): Promise<Buffer> {
  let PDFDocument: any;
  try {
    const mod = await import('pdfkit');
    PDFDocument = mod.default ?? mod;
  } catch {
    const err = new Error('pdfkit is not installed — use the HTML salary slip instead') as Error & { code?: string };
    err.code = 'PDF_UNAVAILABLE';
    throw err;
  }
  const fmt = (n: number) => `Rs. ${n.toLocaleString('en-PK')}`;
  const statusLabel = p.status === 'paid' ? 'PAID' : p.status === 'partial' ? 'PARTIALLY PAID' : 'UNPAID';
  const dateFmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { timeZone: p.timezone }) : '—');
  const doc = new PDFDocument({ size: 'A4', margin: 64 });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  doc.fontSize(20).fillColor('#14532d').text(p.school_name, { align: 'center' });
  doc.fontSize(11).fillColor('#555').text('Monthly Salary Slip', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).fillColor('#111').text(`Staff: ${p.staff_name} (${p.role})`);
  doc.text(`Month: ${monthLabel(p.month)}`);
  doc.text(`Status: ${statusLabel}`);
  doc.moveDown();
  doc.fontSize(12).text(`Monthly salary: ${p.monthly_salary !== null ? fmt(p.monthly_salary) : '—'}`);
  if (p.payments.length === 0) {
    doc.text('Payments: none recorded yet');
  } else {
    p.payments.forEach((pay, i) => {
      doc.text(`Payment ${i + 1} — ${dateFmt(pay.paid_at)}: ${fmt(pay.amount)}`);
    });
  }
  doc.moveDown();
  doc.fontSize(13).fillColor('#111').text(`Amount paid: ${fmt(p.amount_paid)}`);
  doc.text(`Amount remaining: ${p.remaining !== null ? fmt(p.remaining) : '—'}`);
  doc.moveDown(3);
  doc.fontSize(11).fillColor('#333').text('Received by: ______________________        Authorised by: ______________________');
  doc.end();
  return done;
}
