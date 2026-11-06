// Staff & payroll (6C-1).
// Staff profiles (phone stored AES-256-GCM + SHA-256 hash, same pattern as
// parents/teachers — never returned, only masked), class assignments, and
// monthly salary records with a printable payslip.
// net_pay = max(0, base_salary - deductions). One salary record per
// (staff, month). Staff delete is blocked while timetable entries or salary
// records exist (payroll history must not vanish silently); assignments are
// removed with the staff row.
import { ApiError } from '../../lib/errors';
import { isValidDateString, dateOnly } from '../../lib/dates';
import { normalizePhone, encryptPhone, decryptPhone, sha256Hex, maskPhone } from '../../lib/crypto';
import { writeAudit } from '../../lib/audit';
import { writeChangeLogs } from '../hardening/helpers';
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

export function toPublicSalaryRecord(r: any, staffName?: string | null): Record<string, unknown> {
  return {
    id: r.id, school_id: r.schoolId, staff_id: r.staffId, staff_name: staffName ?? null,
    month: r.month, base_salary: r.baseSalary, deductions: r.deductions, net_pay: r.netPay,
    paid: Boolean(r.paidAt), paid_at: r.paidAt ?? null, payslip_no: r.payslipNo ?? null, created_at: r.createdAt,
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
  if (salaryRows > 0) throw ApiError.conflict('This staff member has salary records. Salary history is kept — staff with payroll cannot be deleted.');
  const snapshot = JSON.parse(JSON.stringify(s, (_k, v) => (v instanceof Date ? v.toISOString() : v)));
  // Assignments go with the staff row; salary/timetable are blocked above.
  await db.staffClassAssignment.deleteMany({ where: { schoolId, staffId: id } });
  await db.staff.delete({ where: { id } });
  await (db as any).deletedRecord.create({
    data: { schoolId, entity: 'staff', entityId: id, snapshot, deletedBy: actorId, deletedAt: new Date(), restoreBy: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
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
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'staff.assign', entity: 'staff_class_assignment', entityId: created.id, details: { staff_id: staffId, class_id: input.class_id, subject } });
  return toPublicAssignment(created, staff.name, `${cls.name}-${cls.section}`);
}

export async function removeAssignment(db: Db, schoolId: string, staffId: string, assignmentId: string, actorId: string): Promise<void> {
  const row = await db.staffClassAssignment.findFirst({ where: { id: assignmentId, schoolId, staffId } });
  if (!row) throw ApiError.notFound('Assignment not found');
  await db.staffClassAssignment.delete({ where: { id: assignmentId } });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'staff.unassign', entity: 'staff_class_assignment', entityId: assignmentId, details: { staff_id: staffId, subject: row.subject } });
}

// --- Payroll -------------------------------------------------------------------
export function computeNetPay(baseSalary: number, deductions: number): number {
  return Math.max(0, baseSalary - deductions);
}

export async function listPayroll(
  db: Db, schoolId: string, query: Record<string, any>,
): Promise<{ items: any[]; total: number; page: number; pages: number }> {
  const { page, limit, skip } = parsePagination(query);
  const where: Record<string, unknown> = { schoolId };
  if (query.month) {
    if (!MONTH_RE.test(String(query.month))) throw ApiError.validation('month must be YYYY-MM');
    where.month = String(query.month);
  }
  if (query.staff_id) where.staffId = String(query.staff_id);
  if (query.paid === 'true') where.paidAt = { not: null };
  if (query.paid === 'false') where.paidAt = null;
  const [rows, total] = await Promise.all([
    db.salaryRecord.findMany({ where, orderBy: [{ month: 'desc' }, { createdAt: 'asc' }], skip, take: limit }),
    db.salaryRecord.count({ where }),
  ]);
  const staffIds = [...new Set(rows.map((r: any) => r.staffId))];
  const staff = staffIds.length ? await db.staff.findMany({ where: { schoolId, id: { in: staffIds } } }) : [];
  const byId = new Map<string, string>(staff.map((s: any) => [s.id, s.name] as [string, string]));
  return paginatedResponse(rows.map((r: any) => toPublicSalaryRecord(r, byId.get(r.staffId) ?? null)), total, { page, limit, skip });
}

export async function createSalaryRecord(
  db: Db, schoolId: string,
  input: { staff_id: string; month: string; base_salary?: number | null; deductions?: number; payslip_no?: string | null },
  actorId: string,
): Promise<any> {
  const staff = await getStaffRow(db, schoolId, input.staff_id);
  if (!MONTH_RE.test(input.month)) throw ApiError.validation('month must be YYYY-MM');
  const baseSalary = input.base_salary ?? staff.salaryMonthly;
  if (baseSalary === null || baseSalary === undefined || !Number.isInteger(baseSalary) || baseSalary < 0) {
    throw ApiError.validation('base_salary is required (or set a monthly salary on the staff profile)');
  }
  const deductions = input.deductions ?? 0;
  if (!Number.isInteger(deductions) || deductions < 0) throw ApiError.validation('deductions must be an integer >= 0');
  const dup = await db.salaryRecord.findFirst({ where: { staffId: input.staff_id, month: input.month } });
  if (dup) throw ApiError.conflict(`A salary record already exists for ${staff.name} for ${input.month}`);
  const seq = (await db.salaryRecord.count({ where: { schoolId, month: input.month } })) + 1;
  const payslipNo = input.payslip_no?.trim() || `PS-${input.month.replace('-', '')}-${String(seq).padStart(3, '0')}`;
  const created = await db.salaryRecord.create({
    data: { schoolId, staffId: input.staff_id, month: input.month, baseSalary, deductions, netPay: computeNetPay(baseSalary, deductions), paidAt: null, payslipNo },
  });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'payroll.create', entity: 'salary_record', entityId: created.id, details: { staff_id: input.staff_id, month: input.month, net_pay: created.netPay } });
  return toPublicSalaryRecord(created, staff.name);
}

export async function getSalaryRecord(db: Db, schoolId: string, id: string): Promise<any> {
  const r = await db.salaryRecord.findFirst({ where: { id, schoolId } });
  if (!r) throw ApiError.notFound('Salary record not found');
  const staff = await db.staff.findFirst({ where: { id: r.staffId, schoolId } });
  return toPublicSalaryRecord(r, staff?.name ?? null);
}

export async function updateSalaryRecord(
  db: Db, schoolId: string, id: string,
  patch: { base_salary?: number; deductions?: number; paid?: boolean },
  actorId: string,
): Promise<any> {
  const r = await db.salaryRecord.findFirst({ where: { id, schoolId } });
  if (!r) throw ApiError.notFound('Salary record not found');
  const before = { base_salary: r.baseSalary, deductions: r.deductions, net_pay: r.netPay, paid: Boolean(r.paidAt) };
  const baseSalary = patch.base_salary ?? r.baseSalary;
  const deductions = patch.deductions ?? r.deductions;
  if (!Number.isInteger(baseSalary) || baseSalary < 0) throw ApiError.validation('base_salary must be an integer >= 0');
  if (!Number.isInteger(deductions) || deductions < 0) throw ApiError.validation('deductions must be an integer >= 0');
  const data: Record<string, unknown> = { baseSalary, deductions, netPay: computeNetPay(baseSalary, deductions) };
  if (patch.paid !== undefined) data.paidAt = patch.paid ? (r.paidAt ?? new Date()) : null;
  const updated = await db.salaryRecord.update({ where: { id }, data });
  await writeChangeLogs(db, { schoolId, actorId, entity: 'salary_record', entityId: id, before, after: { base_salary: updated.baseSalary, deductions: updated.deductions, net_pay: updated.netPay, paid: Boolean(updated.paidAt) } });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'payroll.update', entity: 'salary_record', entityId: id, details: { month: updated.month, net_pay: updated.netPay } });
  const staff = await db.staff.findFirst({ where: { id: updated.staffId, schoolId } });
  return toPublicSalaryRecord(updated, staff?.name ?? null);
}

export async function deleteSalaryRecord(db: Db, schoolId: string, id: string, actorId: string): Promise<void> {
  const r = await db.salaryRecord.findFirst({ where: { id, schoolId } });
  if (!r) throw ApiError.notFound('Salary record not found');
  if (r.paidAt) throw ApiError.conflict('A paid salary record cannot be deleted. Unmark it as paid first.');
  await db.salaryRecord.delete({ where: { id } });
  await writeAudit(db, { schoolId, actorId, actorType: 'user', action: 'payroll.delete', entity: 'salary_record', entityId: id, details: { month: r.month } });
}

// --- Payslip (printable HTML) ---------------------------------------------------
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderPayslipHtml(p: { school_name: string; staff_name: string; role: string; month: string; base_salary: number; deductions: number; net_pay: number; paid: boolean; paid_at: string | null; payslip_no: string | null }): string {
  const fmt = (n: number) => `Rs. ${n.toLocaleString('en-PK')}`;
  const [y, m] = p.month.split('-').map(Number);
  const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Payslip ${esc(p.payslip_no ?? '')}</title>
<style>*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0;padding:24px}.slip{max-width:640px;margin:0 auto;border:2px solid #14532d;border-radius:8px;padding:24px}h1{margin:0;font-size:20px;color:#14532d}.sub{color:#555;font-size:13px}.badge{display:inline-block;padding:4px 10px;border-radius:999px;color:#fff;background:${p.paid ? '#14532d' : '#991b1b'};font-weight:bold;font-size:12px}table{width:100%;border-collapse:collapse;margin-top:16px;font-size:14px}td,th{padding:8px 4px;border-bottom:1px solid #ddd;text-align:left}td.num,th.num{text-align:right}tr.total td{font-weight:bold;border-top:2px solid #14532d}.row{display:flex;justify-content:space-between;margin-top:6px;font-size:14px}.sig{margin-top:36px;display:flex;justify-content:space-between;font-size:13px}.sig span{border-top:1px solid #333;padding-top:4px}.print-btn{margin:16px auto;display:block;padding:10px 18px;font-size:14px;background:#14532d;color:#fff;border:0;border-radius:6px;cursor:pointer}@media print{.print-btn{display:none}body{padding:0}.slip{border-width:1px}}</style>
</head><body>
<button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
<div class="slip">
<div class="row"><div><h1>${esc(p.school_name)}</h1><div class="sub">Monthly Payslip</div></div><div><span class="badge">${p.paid ? 'PAID' : 'UNPAID'}</span></div></div>
<div class="row"><span>Payslip No: <strong>${esc(p.payslip_no ?? '—')}</strong></span><span>Month: <strong>${esc(monthLabel)}</strong></span></div>
<div class="row"><span>Staff: <strong>${esc(p.staff_name)}</strong> (${esc(p.role)})</span><span>Paid on: ${p.paid_at ? esc(new Date(p.paid_at).toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi' })) : '—'}</span></div>
<table><tr><th>Description</th><th class="num">Amount</th></tr>
<tr><td>Base salary</td><td class="num">${fmt(p.base_salary)}</td></tr>
<tr><td>Deductions</td><td class="num">&minus; ${fmt(p.deductions)}</td></tr>
<tr class="total"><td>Net pay</td><td class="num">${fmt(p.net_pay)}</td></tr></table>
<div class="sig"><span>Received by</span><span>Authorised by</span></div>
<p style="margin-top:20px;font-size:12px;color:#666">This is a computer-generated payslip from ${esc(p.school_name)}.</p>
</div></body></html>`;
}

export async function getPayslipData(db: Db, schoolId: string, id: string): Promise<Record<string, unknown>> {
  const r = await db.salaryRecord.findFirst({ where: { id, schoolId } });
  if (!r) throw ApiError.notFound('Salary record not found');
  const staff = await db.staff.findFirst({ where: { id: r.staffId, schoolId } });
  const school = await db.school.findUnique({ where: { id: schoolId } });
  return {
    school_name: school?.name ?? '', staff_name: staff?.name ?? '', role: staff?.role ?? '',
    month: r.month, base_salary: r.baseSalary, deductions: r.deductions, net_pay: r.netPay,
    paid: Boolean(r.paidAt), paid_at: r.paidAt ? new Date(r.paidAt).toISOString() : null,
    payslip_no: r.payslipNo ?? null,
  };
}
