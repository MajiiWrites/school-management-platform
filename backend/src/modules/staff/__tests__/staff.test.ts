// Staff & payroll (6C-1) tests — CRUD + phone masking, assignments,
// SIMPLIFIED payroll (Module E FINAL REBUILD): one payment row = month +
// staff + amount; status (Unpaid / Partially Paid / Paid) and remaining
// are derived from the payments; salary slip per (staff, month).
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
    // Round 2: the create also logs a phone row (old null) — pick the update row.
    const phoneLog = logs.filter((l: any) => l.field === 'phone').find((l: any) => l.oldValue === '+92 3XX XXXX567');
    expect(phoneLog.oldValue).toBe('+92 3XX XXXX567');
    expect(phoneLog.newValue).toBe('+92 3XX XXXX543');
    expect((await svc.listStaff(db, schoolId, { role: 'teacher' })).total).toBe(1);
    expect((await svc.listStaff(db, schoolId, { role: 'staff' })).total).toBe(1);
  });

  it('delete is blocked while on the timetable or with payment history', async () => {
    const s = await svc.createStaff(db, schoolId, { name: 'Ayesha Khan', role: 'teacher', salary_monthly: 60000 }, 'admin-1');
    await svc.createSalaryRecord(db, schoolId, { staff_id: s.id as string, month: '2026-11', amount: 20000 }, 'admin-1');
    await expect(svc.deleteStaff(db, schoolId, s.id as string, 'admin-1')).rejects.toThrow('payment records');
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

describe('simplified payroll', () => {
  let db: Db;
  let schoolId: string;
  let staffId: string;
  beforeEach(async () => {
    ({ db, schoolId } = fresh());
    const s = await svc.createStaff(db, schoolId, { name: 'Ayesha Khan', role: 'teacher', salary_monthly: 60000 }, 'admin-1');
    staffId = s.id as string;
  });

  async function summary(month = '2026-11'): Promise<any> {
    const list = await svc.listPayroll(db, schoolId, { month, staff_id: staffId });
    expect(list.total).toBe(1);
    return list.items[0];
  }

  it('a month with no payments is Unpaid with the full salary remaining', async () => {
    const s = await summary();
    expect(s.status).toBe('unpaid');
    expect(s.monthly_salary).toBe(60000);
    expect(s.amount_paid).toBe(0);
    expect(s.remaining).toBe(60000);
    expect(s.payments).toEqual([]);
  });

  it('partial payments add up; status goes Unpaid → Partially Paid → Paid', async () => {
    const p1 = await svc.createSalaryRecord(db, schoolId, { staff_id: staffId, month: '2026-11', amount: 20000 }, 'admin-1');
    expect(p1.amount).toBe(20000);
    expect(p1.paid_at).not.toBeNull();
    let s = await summary();
    expect(s.status).toBe('partial');
    expect(s.amount_paid).toBe(20000);
    expect(s.remaining).toBe(40000);
    expect(s.payments).toHaveLength(1);

    await svc.createSalaryRecord(db, schoolId, { staff_id: staffId, month: '2026-11', amount: 25000 }, 'admin-1');
    s = await summary();
    expect(s.status).toBe('partial');
    expect(s.amount_paid).toBe(45000);
    expect(s.remaining).toBe(15000);
    expect(s.payments).toHaveLength(2);

    await svc.createSalaryRecord(db, schoolId, { staff_id: staffId, month: '2026-11', amount: 15000 }, 'admin-1');
    s = await summary();
    expect(s.status).toBe('paid');
    expect(s.amount_paid).toBe(60000);
    expect(s.remaining).toBe(0);
    expect(s.payments).toHaveLength(3);
  });

  it('overpayment clamps remaining at 0 and still counts as Paid', async () => {
    await svc.createSalaryRecord(db, schoolId, { staff_id: staffId, month: '2026-11', amount: 70000 }, 'admin-1');
    const s = await summary();
    expect(s.status).toBe('paid');
    expect(s.amount_paid).toBe(70000);
    expect(s.remaining).toBe(0);
  });

  it('staff with no agreed salary: remaining is null, any payment is Partial', async () => {
    const s2 = await svc.createStaff(db, schoolId, { name: 'No Salary Clerk', role: 'staff' }, 'admin-1');
    let list = await svc.listPayroll(db, schoolId, { month: '2026-11', staff_id: s2.id as string });
    expect(list.items[0].status).toBe('unpaid');
    expect(list.items[0].monthly_salary).toBeNull();
    expect(list.items[0].remaining).toBeNull();
    await svc.createSalaryRecord(db, schoolId, { staff_id: s2.id as string, month: '2026-11', amount: 5000 }, 'admin-1');
    list = await svc.listPayroll(db, schoolId, { month: '2026-11', staff_id: s2.id as string });
    expect(list.items[0].status).toBe('partial');
    expect(list.items[0].amount_paid).toBe(5000);
    expect(list.items[0].remaining).toBeNull();
  });

  it('rejects non-positive amounts, bad months, and unknown staff', async () => {
    await expect(svc.createSalaryRecord(db, schoolId, { staff_id: staffId, month: '2026-11', amount: 0 }, 'admin-1')).rejects.toThrow('amount must be an integer > 0');
    await expect(svc.createSalaryRecord(db, schoolId, { staff_id: staffId, month: '2026-11', amount: -100 }, 'admin-1')).rejects.toThrow('amount must be an integer > 0');
    await expect(svc.createSalaryRecord(db, schoolId, { staff_id: staffId, month: '2026-13', amount: 1000 }, 'admin-1')).rejects.toThrow('month must be YYYY-MM');
    await expect(svc.createSalaryRecord(db, schoolId, { staff_id: 'no-such-staff', month: '2026-11', amount: 1000 }, 'admin-1')).rejects.toThrow('Staff member not found');
    await expect(svc.listPayroll(db, schoolId, { month: '2026-13' })).rejects.toThrow('month must be YYYY-MM');
    await expect(svc.listPayroll(db, schoolId, { month: '2026-11', status: 'bogus' })).rejects.toThrow('status must be unpaid, partial, or paid');
  });

  it('editing a payment amount re-derives the summary; deleting one flips the status back', async () => {
    const p1 = await svc.createSalaryRecord(db, schoolId, { staff_id: staffId, month: '2026-11', amount: 40000 }, 'admin-1');
    const p2 = await svc.createSalaryRecord(db, schoolId, { staff_id: staffId, month: '2026-11', amount: 20000 }, 'admin-1');
    expect((await summary()).status).toBe('paid');
    const edited = await svc.updateSalaryRecord(db, schoolId, p2.id as string, { amount: 10000 }, 'admin-1');
    expect(edited.amount).toBe(10000);
    let s = await summary();
    expect(s.status).toBe('partial');
    expect(s.amount_paid).toBe(50000);
    expect(s.remaining).toBe(10000);
    await expect(svc.updateSalaryRecord(db, schoolId, p2.id as string, { amount: 0 }, 'admin-1')).rejects.toThrow('amount must be an integer > 0');
    await svc.deleteSalaryRecord(db, schoolId, p1.id as string, 'admin-1');
    s = await summary();
    expect(s.status).toBe('partial');
    expect(s.amount_paid).toBe(10000);
    expect(s.remaining).toBe(50000);
    await svc.deleteSalaryRecord(db, schoolId, p2.id as string, 'admin-1');
    s = await summary();
    expect(s.status).toBe('unpaid');
    expect(s.amount_paid).toBe(0);
    await expect(svc.getSalaryRecord(db, schoolId, p2.id as string)).rejects.toThrow('Salary record not found');
  });

  it('list filters by month and status; payments in another month do not leak in', async () => {
    await svc.createSalaryRecord(db, schoolId, { staff_id: staffId, month: '2026-10', amount: 60000 }, 'admin-1');
    await svc.createSalaryRecord(db, schoolId, { staff_id: staffId, month: '2026-11', amount: 10000 }, 'admin-1');
    const oct = await svc.listPayroll(db, schoolId, { month: '2026-10' });
    expect(oct.items[0].status).toBe('paid');
    expect(oct.items[0].amount_paid).toBe(60000);
    const nov = await svc.listPayroll(db, schoolId, { month: '2026-11' });
    expect(nov.items[0].status).toBe('partial');
    expect(nov.items[0].amount_paid).toBe(10000);
    expect((await svc.listPayroll(db, schoolId, { month: '2026-11', status: 'paid' })).total).toBe(0);
    expect((await svc.listPayroll(db, schoolId, { month: '2026-11', status: 'partial' })).total).toBe(1);
    expect((await svc.listPayroll(db, schoolId, { month: '2026-12' })).items[0].status).toBe('unpaid');
  });

  it('salary slip data + HTML + PDF show school, staff, month, salary, paid, dates, remaining', async () => {
    (db as any).school.update({ where: { id: schoolId }, data: { settings: { logo_url: 'https://example.com/logo.png' } } });
    await svc.createSalaryRecord(db, schoolId, { staff_id: staffId, month: '2026-11', amount: 20000 }, 'admin-1');
    await svc.createSalaryRecord(db, schoolId, { staff_id: staffId, month: '2026-11', amount: 25000 }, 'admin-1');
    const slip = await svc.getPayslipData(db, schoolId, staffId, '2026-11');
    expect(slip.staff_id).toBe(staffId);
    expect(slip.school_name).toBe('Demo Public School');
    expect(slip.logo_url).toBe('https://example.com/logo.png');
    expect(slip.staff_name).toBe('Ayesha Khan');
    expect(slip.month).toBe('2026-11');
    expect(slip.monthly_salary).toBe(60000);
    expect(slip.amount_paid).toBe(45000);
    expect(slip.remaining).toBe(15000);
    expect(slip.status).toBe('partial');
    expect(slip.payments).toHaveLength(2);
    expect(slip.payments[0].paid_at).not.toBeNull();
    const html = svc.renderPayslipHtml(slip);
    expect(html).toContain('Demo Public School');
    expect(html).toContain('https://example.com/logo.png');
    expect(html).toContain('Ayesha Khan');
    expect(html).toContain('November 2026');
    expect(html).toContain('60,000');
    expect(html).toContain('45,000');
    expect(html).toContain('15,000');
    expect(html).toContain('PARTIALLY PAID');
    const pdf = await svc.renderPayslipPdf(slip);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 4).toString('ascii')).toBe('%PDF');
    expect(pdf.length).toBeGreaterThan(500);
  });

  it('slip for a month with no payments shows Unpaid and zero paid', async () => {
    const slip = await svc.getPayslipData(db, schoolId, staffId, '2026-11');
    expect(slip.status).toBe('unpaid');
    expect(slip.amount_paid).toBe(0);
    expect(slip.remaining).toBe(60000);
    expect(slip.payments).toEqual([]);
    const html = svc.renderPayslipHtml(slip);
    expect(html).toContain('UNPAID');
    expect(html).toContain('No payments recorded yet');
  });

  it('computePayrollStatus / computeRemaining are pure', () => {
    expect(svc.computePayrollStatus(60000, 0)).toBe('unpaid');
    expect(svc.computePayrollStatus(60000, 1)).toBe('partial');
    expect(svc.computePayrollStatus(60000, 59999)).toBe('partial');
    expect(svc.computePayrollStatus(60000, 60000)).toBe('paid');
    expect(svc.computePayrollStatus(60000, 90000)).toBe('paid');
    expect(svc.computePayrollStatus(null, 0)).toBe('unpaid');
    expect(svc.computePayrollStatus(null, 5000)).toBe('partial');
    expect(svc.computeRemaining(60000, 45000)).toBe(15000);
    expect(svc.computeRemaining(60000, 70000)).toBe(0);
    expect(svc.computeRemaining(null, 5000)).toBeNull();
  });
});

describe('staff/payroll cross-tenant isolation', () => {
  let db: Db;
  const schoolId = 'school-6c1';
  beforeEach(() => {
    ({ db } = fresh());
  });

  it('another school cannot read/update/delete our staff or payments, or see our slip (404)', async () => {
    const s = await svc.createStaff(db, schoolId, { name: 'Ayesha Khan', role: 'teacher', phone: '03001234567', salary_monthly: 60000 }, 'admin-1');
    const r = await svc.createSalaryRecord(db, schoolId, { staff_id: s.id as string, month: '2026-11', amount: 60000 }, 'admin-1');
    await expect(svc.getStaff(db, OTHER_SCHOOL_ID, s.id as string)).rejects.toThrow('Staff member not found');
    await expect(svc.updateStaff(db, OTHER_SCHOOL_ID, s.id as string, { name: 'Hijack' }, 'admin-2')).rejects.toThrow('Staff member not found');
    await expect(svc.deleteStaff(db, OTHER_SCHOOL_ID, s.id as string, 'admin-2')).rejects.toThrow('Staff member not found');
    await expect(svc.getSalaryRecord(db, OTHER_SCHOOL_ID, r.id as string)).rejects.toThrow('Salary record not found');
    await expect(svc.updateSalaryRecord(db, OTHER_SCHOOL_ID, r.id as string, { amount: 1 }, 'admin-2')).rejects.toThrow('Salary record not found');
    await expect(svc.deleteSalaryRecord(db, OTHER_SCHOOL_ID, r.id as string, 'admin-2')).rejects.toThrow('Salary record not found');
    await expect(svc.getPayslipData(db, OTHER_SCHOOL_ID, s.id as string, '2026-11')).rejects.toThrow('Staff member not found');
    await expect(svc.assignStaff(db, OTHER_SCHOOL_ID, s.id as string, { class_id: 'class-5a', subject: 'Math' }, 'admin-2')).rejects.toThrow('Staff member not found');
    expect((await svc.listStaff(db, OTHER_SCHOOL_ID, {})).total).toBe(0);
    expect((await svc.listPayroll(db, OTHER_SCHOOL_ID, { month: '2026-11' })).total).toBe(0);
    // Nothing was touched.
    expect((await svc.getStaff(db, schoolId, s.id as string)).name).toBe('Ayesha Khan');
    expect((await svc.getSalaryRecord(db, schoolId, r.id as string)).amount).toBe(60000);
  });
});
