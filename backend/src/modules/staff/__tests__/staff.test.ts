// Staff & payroll (6C-1) tests — CRUD + phone masking, assignments,
// payroll calc, paid/unpaid, cross-tenant 404s.
import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../../../lib/db';
import { FakeDb, seed6C1, OTHER_SCHOOL_ID } from '../../sessions/__tests__/fake-db';
import * as svc from '../service';
import { decryptPhone } from '../../../lib/crypto';

function fresh(): { db: Db; schoolId: string; classAId: string; classBId: string } {
  const fake = new FakeDb();
  const seed = seed6C1(fake);
  return { db: fake as unknown as Db, schoolId: seed.schoolId, classAId: seed.classAId, classBId: seed.classBId };
}

describe('staff CRUD', () => {
  let db: Db;
  const schoolId = 'school-6c1';
  beforeEach(() => {
    ({ db } = fresh());
  });

  it('creates a teacher, encrypts the phone, and never returns it (masked only)', async () => {
    const s = await svc.createStaff(db, schoolId, { name: 'Ayesha Khan', role: 'teacher', phone: '03001234567', email: 'ayesha@example.com', joining_date: '2026-01-15', subjects: ['Math', 'Science'], salary_monthly: 60000 }, 'admin-1');
    expect(s.phone_masked).toBe('+92 3XX XXXX567');
    expect(s).not.toHaveProperty('phone_enc');
    expect(s).not.toHaveProperty('phone_hash');
    const row = await (db as any).staff.findFirst({ where: { id: s.id } });
    expect(row.phoneEnc).not.toBe('03001234567');
    expect(decryptPhone(row.phoneEnc)).toBe('+923001234567');
    expect(row.phoneHash).toBeTruthy();
    expect(s.subjects).toEqual(['Math', 'Science']);
    expect(s.salary_monthly).toBe(60000);
  });

  it('rejects invalid phones, roles, and salaries', async () => {
    await expect(svc.createStaff(db, schoolId, { name: 'Bad Phone', role: 'teacher', phone: '12345' }, 'admin-1')).rejects.toThrow('not a valid Pakistani mobile');
    await expect(svc.createStaff(db, schoolId, { name: 'Bad Role', role: 'principal' }, 'admin-1')).rejects.toThrow('role must be teacher or staff');
    await expect(svc.createStaff(db, schoolId, { name: 'Bad Salary', role: 'staff', salary_monthly: -5 }, 'admin-1')).rejects.toThrow('salary_monthly must be an integer >= 0');
  });

  it('update masks the phone in change logs and list filters by role', async () => {
    const s = await svc.createStaff(db, schoolId, { name: 'Ayesha Khan', role: 'teacher', phone: '03001234567' }, 'admin-1');
    await svc.createStaff(db, schoolId, { name: 'Office Clerk', role: 'staff' }, 'admin-1');
    const updated = await svc.updateStaff(db, schoolId, s.id as string, { phone: '03219876543', salary_monthly: 65000 }, 'admin-1');
    expect(updated.phone_masked).toBe('+92 3XX XXXX543');
    const logs = (db as any).changeLog.findMany({ where: { entity: 'staff', entityId: s.id } });
    const phoneLog = logs.find((l: any) => l.field === 'phone');
    expect(phoneLog.oldValue).toBe('+92 3XX XXXX567');
    expect(phoneLog.newValue).toBe('+92 3XX XXXX543');
    expect((await svc.listStaff(db, schoolId, { role: 'teacher' })).total).toBe(1);
    expect((await svc.listStaff(db, schoolId, { role: 'staff' })).total).toBe(1);
  });

  it('delete is blocked while on the timetable or with salary history', async () => {
    const s = await svc.createStaff(db, schoolId, { name: 'Ayesha Khan', role: 'teacher', salary_monthly: 60000 }, 'admin-1');
    await svc.createSalaryRecord(db, schoolId, { staff_id: s.id as string, month: '2026-11' }, 'admin-1');
    await expect(svc.deleteStaff(db, schoolId, s.id as string, 'admin-1')).rejects.toThrow('salary records');
    const plain = await svc.createStaff(db, schoolId, { name: 'Temp Teacher', role: 'teacher' }, 'admin-1');
    await svc.deleteStaff(db, schoolId, plain.id as string, 'admin-1');
    expect((await svc.listStaff(db, schoolId, {})).total).toBe(1);
  });
});

describe('staff assignments', () => {
  let db: Db;
  let schoolId: string;
  let classAId: string;
  let staffId: string;
  beforeEach(async () => {
    ({ db, schoolId, classAId } = fresh());
    const s = await svc.createStaff(db, schoolId, { name: 'Ayesha Khan', role: 'teacher', subjects: ['Math'] }, 'admin-1');
    staffId = s.id as string;
  });

  it('assigns, rejects duplicates, lists, and removes', async () => {
    const a = await svc.assignStaff(db, schoolId, staffId, { class_id: classAId, subject: 'Math' }, 'admin-1');
    expect(a.class_name).toBe('5-A');
    expect(a.staff_name).toBe('Ayesha Khan');
    await expect(svc.assignStaff(db, schoolId, staffId, { class_id: classAId, subject: 'Math' }, 'admin-1')).rejects.toThrow('already assigned');
    // Same teacher, same class, different subject is fine.
    await svc.assignStaff(db, schoolId, staffId, { class_id: classAId, subject: 'Science' }, 'admin-1');
    const list = await svc.listAssignments(db, schoolId, { staff_id: staffId });
    expect(list).toHaveLength(2);
    await svc.removeAssignment(db, schoolId, staffId, a.id as string, 'admin-1');
    expect((await svc.listAssignments(db, schoolId, { staff_id: staffId }))).toHaveLength(1);
    await expect(svc.removeAssignment(db, schoolId, staffId, a.id as string, 'admin-1')).rejects.toThrow('Assignment not found');
  });
});

describe('payroll', () => {
  let db: Db;
  let schoolId: string;
  let staffId: string;
  beforeEach(async () => {
    ({ db, schoolId } = fresh());
    const s = await svc.createStaff(db, schoolId, { name: 'Ayesha Khan', role: 'teacher', salary_monthly: 60000 }, 'admin-1');
    staffId = s.id as string;
  });

  it('net pay = base − deductions; defaults base from the staff profile', async () => {
    const r = await svc.createSalaryRecord(db, schoolId, { staff_id: staffId, month: '2026-11', deductions: 5000 }, 'admin-1');
    expect(r.base_salary).toBe(60000);
    expect(r.net_pay).toBe(55000);
    expect(r.paid).toBe(false);
    expect(r.payslip_no).toBe('PS-202611-001');
  });

  it('deductions above base clamp net pay at 0; duplicate month is rejected', async () => {
    const r = await svc.createSalaryRecord(db, schoolId, { staff_id: staffId, month: '2026-11', base_salary: 40000, deductions: 50000 }, 'admin-1');
    expect(r.net_pay).toBe(0);
    await expect(svc.createSalaryRecord(db, schoolId, { staff_id: staffId, month: '2026-11', base_salary: 40000 }, 'admin-1')).rejects.toThrow('already exists');
    await expect(svc.createSalaryRecord(db, schoolId, { staff_id: staffId, month: '2026-13' }, 'admin-1')).rejects.toThrow('month must be YYYY-MM');
  });

  it('mark paid sets paid_at; unmark clears it; paid records cannot be deleted', async () => {
    const r = await svc.createSalaryRecord(db, schoolId, { staff_id: staffId, month: '2026-11' }, 'admin-1');
    const paid = await svc.updateSalaryRecord(db, schoolId, r.id as string, { paid: true }, 'admin-1');
    expect(paid.paid).toBe(true);
    expect(paid.paid_at).not.toBeNull();
    await expect(svc.deleteSalaryRecord(db, schoolId, r.id as string, 'admin-1')).rejects.toThrow('paid salary record cannot be deleted');
    const unpaid = await svc.updateSalaryRecord(db, schoolId, r.id as string, { paid: false, deductions: 2000 }, 'admin-1');
    expect(unpaid.paid).toBe(false);
    expect(unpaid.paid_at).toBeNull();
    expect(unpaid.net_pay).toBe(58000);
    await svc.deleteSalaryRecord(db, schoolId, r.id as string, 'admin-1');
    expect((await svc.listPayroll(db, schoolId, {})).total).toBe(0);
  });

  it('payslip data + HTML render with school, staff, month, and net pay', async () => {
    const r = await svc.createSalaryRecord(db, schoolId, { staff_id: staffId, month: '2026-11', deductions: 5000 }, 'admin-1');
    await svc.updateSalaryRecord(db, schoolId, r.id as string, { paid: true }, 'admin-1');
    const data = await svc.getPayslipData(db, schoolId, r.id as string);
    expect(data.school_name).toBe('Demo Public School');
    expect(data.staff_name).toBe('Ayesha Khan');
    expect(data.net_pay).toBe(55000);
    const html = svc.renderPayslipHtml(data as any);
    expect(html).toContain('Ayesha Khan');
    expect(html).toContain('November 2026');
    expect(html).toContain('55,000');
    expect(html).toContain('PAID');
  });

  it('computeNetPay is pure and clamps at zero', () => {
    expect(svc.computeNetPay(50000, 0)).toBe(50000);
    expect(svc.computeNetPay(50000, 60000)).toBe(0);
  });
});

describe('staff/payroll cross-tenant isolation', () => {
  let db: Db;
  const schoolId = 'school-6c1';
  beforeEach(() => {
    ({ db } = fresh());
  });

  it('another school cannot read/update/delete our staff or salary records (404)', async () => {
    const s = await svc.createStaff(db, schoolId, { name: 'Ayesha Khan', role: 'teacher', phone: '03001234567' }, 'admin-1');
    const r = await svc.createSalaryRecord(db, schoolId, { staff_id: s.id as string, month: '2026-11', base_salary: 60000 }, 'admin-1');
    await expect(svc.getStaff(db, OTHER_SCHOOL_ID, s.id as string)).rejects.toThrow('Staff member not found');
    await expect(svc.updateStaff(db, OTHER_SCHOOL_ID, s.id as string, { name: 'Hijack' }, 'admin-2')).rejects.toThrow('Staff member not found');
    await expect(svc.deleteStaff(db, OTHER_SCHOOL_ID, s.id as string, 'admin-2')).rejects.toThrow('Staff member not found');
    await expect(svc.getSalaryRecord(db, OTHER_SCHOOL_ID, r.id as string)).rejects.toThrow('Salary record not found');
    await expect(svc.updateSalaryRecord(db, OTHER_SCHOOL_ID, r.id as string, { deductions: 99999 }, 'admin-2')).rejects.toThrow('Salary record not found');
    await expect(svc.assignStaff(db, OTHER_SCHOOL_ID, s.id as string, { class_id: 'class-5a', subject: 'Math' }, 'admin-2')).rejects.toThrow('Staff member not found');
    expect((await svc.listStaff(db, OTHER_SCHOOL_ID, {})).total).toBe(0);
    expect((await svc.listPayroll(db, OTHER_SCHOOL_ID, {})).total).toBe(0);
    // Nothing was touched.
    expect((await svc.getStaff(db, schoolId, s.id as string)).name).toBe('Ayesha Khan');
    expect((await svc.getSalaryRecord(db, schoolId, r.id as string)).net_pay).toBe(60000);
  });
});
