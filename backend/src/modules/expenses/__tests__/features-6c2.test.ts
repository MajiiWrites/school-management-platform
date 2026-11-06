// 6C-2 feature tests (fees extensions, vouchers, expenses, announcements,
// events, certificates + ID cards, leave/late, reports exports,
// notification center, settings, cross-tenant 404s).
// Uses the fees module's in-memory fake DB, extended with the v2
// collections these services need. No live DB, no schema changes.

import { describe, it, expect, beforeEach } from 'vitest';
import { FakeDb, FakeCollection, seedDemo } from '../../fees/__tests__/fake-db';
import {
  payFee,
  listFees,
  rolloverMonth,
  feeBreakdownForStudent,
  computeFeeBreakdown,
} from '../../fees/service';
import { generateVoucher, listVouchers, getVoucherByNo, renderVoucherHtml, renderVoucherPdf } from '../../fees/vouchers';
import { createExpense, updateExpense, deleteExpense, listExpenses, incomeVsExpense } from '../../expenses/service';
import { createAnnouncement, approveAnnouncement, listAnnouncements } from '../../announcements/service';
import { createEvent, monthCalendar } from '../../events/service';
import { issueCertificate, listCertificatesForStudent, renderCertificateHtml, renderCertificatePdf, issueIdCard } from '../../certificates/service';
import { createLeave, decideLeave, listLateArrivals } from '../../admin/service';
import { getSettings, updateSettings } from '../../admin/service';
import { feeDefaulters, classStrength, messageHistory, resultsSummary } from '../../reports/service';
import { buildExportRows, exportCsv, exportPdf, exportXlsx } from '../../reports/service';
import { getNotificationCenter } from '../../notifications/service';
import { ApiError } from '../../../lib/errors';

const SCHOOL = 'school-demo';
const OTHER_SCHOOL = 'school-other';

function makeDb(): FakeDb {
  const db = new FakeDb();
  // Attach the v2 collections the 6C-2 services read/write (not in the
  // fees fake, which predates them).
  const extra = [
    'expense', 'announcement', 'event', 'certificate', 'feeVoucher',
    'ocrUpload', 'resultSheet', 'result', 'exam', 'attendanceDay',
    'attendanceRecord', 'messageQueue', 'user', 'leaveApplication',
  ] as const;
  for (const key of extra) (db as any)[key] = new FakeCollection();
  (db as any).feeVoucher.uniqueKey = (r: any) => `${r.schoolId}|${r.voucherNo}`;
  seedDemo(db);
  return db;
}

function expectNotFound(p: Promise<unknown>): Promise<void> {
  return p.then(
    () => { throw new Error('expected NOT_FOUND'); },
    (e) => {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).code).toBe('NOT_FOUND');
    },
  );
}

describe('6C-2 fee math: partial payment, arrears, sibling + admission', () => {
  let db: FakeDb;
  beforeEach(() => { db = makeDb(); });

  it('carries an unpaid prior month forward as arrears and keeps a partial payment partial', async () => {
    // Prior month (2026-09) unpaid in full: PKR 2,500.
    db.feeRecord.create({ data: { schoolId: SCHOOL, studentId: 'stu-1', month: '2026-09', amountDue: 2500, amountPaid: 0, discount: 0, arrears: 0, scholarshipDiscount: 0 } });
    const receipt = await payFee(db as any, SCHOOL, 'stu-1', { month: '2026-10', amount_paid: 1000 }, 'actor-1');
    // Due = 2,500 (Oct) + 2,500 (arrears) = 5,000; paid 1,000 → partial, balance 4,000.
    expect(receipt.amount_due).toBe(5000);
    expect(receipt.amount_paid).toBe(1000);
    expect(receipt.balance).toBe(4000);
    expect(receipt.status).toBe('partial');
    expect(receipt.arrears).toBe(2500);
    // A second partial payment finishes it.
    const receipt2 = await payFee(db as any, SCHOOL, 'stu-1', { month: '2026-10', amount_paid: 4000 }, 'actor-1');
    expect(receipt2.status).toBe('paid');
    expect(receipt2.balance).toBe(0);
  });

  it('applies sibling discount only when a sibling shares the parent phone hash', async () => {
    // stu-1 and stu-2 share no hash in the seed; give stu-2 stu-1's hash.
    const s1: any = db.student.findUnique({ where: { id: 'stu-1' } });
    const s2: any = db.student.findUnique({ where: { id: 'stu-2' } });
    await db.student.update({ where: { id: 'stu-2' }, data: { parentPhoneHash: s1.parentPhoneHash } });
    const structure: any = db.feeStructure.findFirst({ where: { classId: 'class-5a' } });
    await db.feeStructure.update({ where: { id: structure.id }, data: { siblingDiscountPct: 10 } });
    const fresh: any = await db.feeStructure.findFirst({ where: { classId: 'class-5a' } });
    const bd = await feeBreakdownForStudent(db as any, SCHOOL, s2, fresh, '2026-10');
    expect(bd.sibling_discount).toBe(250); // 10% of 2,500
    expect(bd.amount_due).toBe(2250);
    // A student with no sibling gets no discount.
    const s5: any = db.student.findUnique({ where: { id: 'stu-5' } });
    const bd5 = await feeBreakdownForStudent(db as any, SCHOOL, s5, fresh, '2026-10');
    expect(bd5.sibling_discount).toBe(0);
  });

  it('adds the admission fee only to the first fee record', async () => {
    const structure: any = db.feeStructure.findFirst({ where: { classId: 'class-5a' } });
    await db.feeStructure.update({ where: { id: structure.id }, data: { admissionFee: 1000 } });
    const r1 = await payFee(db as any, SCHOOL, 'stu-1', { month: '2026-10', amount_paid: 3500 }, 'actor-1');
    expect(r1.amount_due).toBe(3500); // 2,500 + 1,000 admission
    const r2 = await payFee(db as any, SCHOOL, 'stu-1', { month: '2026-11', amount_paid: 2500 }, 'actor-1');
    expect(r2.amount_due).toBe(2500); // no admission fee the second month
  });

  it('folds a scholarship discount into amount_due at creation', async () => {
    const r = await payFee(db as any, SCHOOL, 'stu-1', { month: '2026-10', amount_paid: 1500, scholarship_discount: 1000 }, 'actor-1');
    expect(r.amount_due).toBe(1500); // 2,500 − 1,000 scholarship
    expect(r.scholarship_discount).toBe(1000);
    expect(r.status).toBe('paid');
  });

  it('pure fee math: computeFeeBreakdown', () => {
    expect(computeFeeBreakdown({ monthlyAmount: 2500, admissionFee: 500, siblingDiscountPct: 20, isSibling: true, isFirstRecord: true, arrears: 300, scholarshipDiscount: 200 }).amount_due).toBe(2600);
    expect(computeFeeBreakdown({ monthlyAmount: 2500, admissionFee: 500, siblingDiscountPct: 20, isSibling: false, isFirstRecord: false, arrears: 0, scholarshipDiscount: 0 }).amount_due).toBe(2500);
  });

  it('rollover folds arrears + admission − sibling into the new records', async () => {
    db.feeRecord.create({ data: { schoolId: SCHOOL, studentId: 'stu-1', month: '2026-09', amountDue: 2500, amountPaid: 0, discount: 0, arrears: 0, scholarshipDiscount: 0 } });
    const structure: any = db.feeStructure.findFirst({ where: { classId: 'class-5a' } });
    await db.feeStructure.update({ where: { id: structure.id }, data: { admissionFee: 0, siblingDiscountPct: 0 } });
    const res = await rolloverMonth(db as any, SCHOOL, '2026-10');
    expect(res.created).toBeGreaterThan(0);
    const rec: any = db.feeRecord.findFirst({ where: { studentId: 'stu-1', month: '2026-10' } });
    expect(rec.amountDue).toBe(5000);
    expect(rec.arrears).toBe(2500);
  });

  it('listFees shows the prospective breakdown for students with no record yet', async () => {
    const structure: any = db.feeStructure.findFirst({ where: { classId: 'class-5a' } });
    await db.feeStructure.update({ where: { id: structure.id }, data: { admissionFee: 200 } });
    const list = await listFees(db as any, SCHOOL, { month: '2026-10' }, 'Asia/Karachi');
    const row = list.items.find((i) => i.student_id === 'stu-1')!;
    expect(row.record_exists).toBe(false);
    expect(row.breakdown).not.toBeNull();
    expect(row.breakdown!.admission_fee).toBe(200);
    expect(row.amount_due).toBe(2700);
  });
});

describe('6C-2 fee vouchers', () => {
  let db: FakeDb;
  beforeEach(() => { db = makeDb(); });

  async function paidRecord(): Promise<any> {
    db.feeRecord.create({ data: { schoolId: SCHOOL, studentId: 'stu-1', month: '2026-10', amountDue: 2500, amountPaid: 1000, discount: 0, arrears: 0, scholarshipDiscount: 0 } });
    return db.feeRecord.findFirst({ where: { studentId: 'stu-1', month: '2026-10' } });
  }

  it('generates a numbered voucher with the remaining balance and due date', async () => {
    const rec = await paidRecord();
    const v = await generateVoucher(db as any, SCHOOL, { fee_record_id: rec.id, month: '2026-10', due_date: '2026-10-15' }, 'actor-1');
    expect(v.voucher_no).toMatch(/^demo-public-202610-V\d{3}$/);
    expect(v.student_name).toBe('Ahmed Raza');
    expect(v.class_name).toBe('5-A');
    expect(v.amount_due).toBe(1500); // remaining balance
    expect(v.balance).toBe(1500);
    expect(v.due_date).toBe('2026-10-15');
    expect(v.status).toBe('partial');
    // Re-generating returns the same voucher, not a duplicate.
    const v2 = await generateVoucher(db as any, SCHOOL, { fee_record_id: rec.id, month: '2026-10' }, 'actor-1');
    expect(v2.voucher_no).toBe(v.voucher_no);
    const list = await listVouchers(db as any, SCHOOL, { month: '2026-10' });
    expect(list.total).toBe(1);
  });

  it('voucher HTML contains the student, number and amount; PDF is a real PDF', async () => {
    const rec = await paidRecord();
    const v = await generateVoucher(db as any, SCHOOL, { fee_record_id: rec.id, month: '2026-10' }, 'actor-1');
    const html = renderVoucherHtml(v);
    expect(html).toContain('Ahmed Raza');
    expect(html).toContain(v.voucher_no);
    expect(html).toContain('Rs. 1,500');
    const pdf = await renderVoucherPdf(v);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(500);
  });

  it('paying in full flips the voucher to paid', async () => {
    const rec = await paidRecord();
    await generateVoucher(db as any, SCHOOL, { fee_record_id: rec.id, month: '2026-10' }, 'actor-1');
    await payFee(db as any, SCHOOL, 'stu-1', { month: '2026-10', amount_paid: 1500 }, 'actor-1');
    const again = await getVoucherByNo(db as any, SCHOOL, (await listVouchers(db as any, SCHOOL, {})).items[0].voucher_no);
    expect(again.status).toBe('paid');
    expect(again.balance).toBe(0);
  });

  it('by-student generation finds the record; 409 when no record exists yet', async () => {
    const rec = await paidRecord();
    const { generateVoucherForStudent } = await import('../../fees/vouchers');
    const v = await generateVoucherForStudent(db as any, SCHOOL, 'stu-1', '2026-10', undefined, 'actor-1');
    expect(v.fee_record_id).toBe(rec.id);
    await expect(generateVoucherForStudent(db as any, SCHOOL, 'stu-2', '2026-10', undefined, 'a')).rejects.toThrow('No fee record exists');
  });

  it('cross-tenant: another school cannot read or mint vouchers', async () => {
    const rec = await paidRecord();
    const v = await generateVoucher(db as any, SCHOOL, { fee_record_id: rec.id, month: '2026-10' }, 'actor-1');
    await expectNotFound(getVoucherByNo(db as any, OTHER_SCHOOL, v.voucher_no));
    await expectNotFound(generateVoucher(db as any, OTHER_SCHOOL, { fee_record_id: rec.id, month: '2026-10' }, 'actor-1'));
  });
});

describe('6C-2 expenses + income-vs-expense', () => {
  let db: FakeDb;
  beforeEach(() => { db = makeDb(); });

  it('CRUD with paid_by round-trip and change logs on update', async () => {
    const created = await createExpense(db as any, SCHOOL, { date: '2026-11-02', category: 'Utilities', description: 'Electricity bill', amount: 5000, paid_by: 'Admin' }, 'actor-1');
    expect(created.paid_by).toBe('Admin');
    expect(created.description).toBe('Electricity bill');
    expect(created.amount).toBe(5000);
    const updated = await updateExpense(db as any, SCHOOL, created.id, { amount: 5500 }, 'actor-1');
    expect(updated.amount).toBe(5500);
    expect(db.changeLog.findMany({ where: { entity: 'expense', entityId: created.id } }).length).toBeGreaterThan(0);
    const list = await listExpenses(db as any, SCHOOL, { month: '2026-11' });
    expect(list.total).toBe(1);
    await deleteExpense(db as any, SCHOOL, created.id, 'actor-1');
    expect((await listExpenses(db as any, SCHOOL, {})).total).toBe(0);
  });

  it('rejects bad amounts and dates', async () => {
    await expect(createExpense(db as any, SCHOOL, { date: '2026-11-02', category: 'X', amount: 0 }, 'a')).rejects.toThrow();
    await expect(createExpense(db as any, SCHOOL, { date: 'not-a-date', category: 'X', amount: 100 }, 'a')).rejects.toThrow();
  });

  it('income-vs-expense: income is fees collected, expense is the expenses table', async () => {
    db.feeRecord.create({ data: { schoolId: SCHOOL, studentId: 'stu-1', month: '2026-10', amountDue: 2500, amountPaid: 2000, discount: 0, arrears: 0, scholarshipDiscount: 0 } });
    db.feeRecord.create({ data: { schoolId: SCHOOL, studentId: 'stu-2', month: '2026-10', amountDue: 2500, amountPaid: 2500, discount: 0, arrears: 0, scholarshipDiscount: 0 } });
    await createExpense(db as any, SCHOOL, { date: '2026-10-05', category: 'Utilities', amount: 500 }, 'a');
    await createExpense(db as any, SCHOOL, { date: '2026-10-06', category: 'Stationery', amount: 300 }, 'a');
    const r = await incomeVsExpense(db as any, SCHOOL, '2026-10');
    expect(r.income).toBe(4500);
    expect(r.expense).toBe(800);
    expect(r.balance).toBe(3700);
    expect(r.by_category).toEqual([
      { category: 'Utilities', total: 500, count: 1 },
      { category: 'Stationery', total: 300, count: 1 },
    ]);
  });

  it('cross-tenant: another school sees no expenses and cannot delete them', async () => {
    const created = await createExpense(db as any, SCHOOL, { date: '2026-11-02', category: 'Utilities', amount: 500 }, 'a');
    expect((await listExpenses(db as any, OTHER_SCHOOL, {})).total).toBe(0);
    await expectNotFound(deleteExpense(db as any, OTHER_SCHOOL, created.id, 'a'));
  });
});

describe('6C-2 announcements, events, certificates', () => {
  let db: FakeDb;
  beforeEach(() => { db = makeDb(); });

  it('announcement: draft → approved (notice board only, no SMS rows)', async () => {
    const a = await createAnnouncement(db as any, SCHOOL, { title: 'PTM on Friday', body: 'Parent-teacher meeting at 10am.', target_type: 'all', sms_send: true }, 'actor-1');
    expect(a.status).toBe('draft');
    const approved = await approveAnnouncement(db as any, SCHOOL, a.id, 'actor-1');
    expect(approved.status).toBe('approved');
    // No message_queue rows were ever created by the announcement flow.
    expect(db.messageQueue.findMany({}).length).toBe(0);
    const list = await listAnnouncements(db as any, SCHOOL, { status: 'approved' });
    expect(list.total).toBe(1);
  });

  it('announcement: class targeting requires a real in-school class', async () => {
    await expect(createAnnouncement(db as any, SCHOOL, { title: 'Class notice', body: 'Y', target_type: 'class' }, 'a')).rejects.toThrow();
    await expect(createAnnouncement(db as any, SCHOOL, { title: 'Class notice', body: 'Y', target_type: 'class', target_class_id: 'nope' }, 'a')).rejects.toThrow();
    const ok = await createAnnouncement(db as any, SCHOOL, { title: 'Class notice', body: 'Y', target_type: 'class', target_class_id: 'class-5a' }, 'a');
    expect(ok.target_class_name).toBe('5-A');
  });

  it('events: calendar merges holidays + events in date order', async () => {
    db.holiday.create({ data: { schoolId: SCHOOL, date: new Date('2026-11-09T00:00:00Z'), name: 'Iqbal Day' } });
    await createEvent(db as any, SCHOOL, { date: '2026-11-06', title: 'Sports Day', description: 'Annual sports' }, 'a');
    await createEvent(db as any, SCHOOL, { date: '2026-11-09', title: 'Assembly', description: 'Special assembly' }, 'a');
    const cal = await monthCalendar(db as any, SCHOOL, '2026-11');
    expect(cal.days.map((d) => `${d.date}:${d.kind}:${d.title}`)).toEqual([
      '2026-11-06:event:Sports Day',
      '2026-11-09:event:Assembly',
      '2026-11-09:holiday:Iqbal Day',
    ]);
  });

  it('certificate: issue → derived number, HTML + PDF content', async () => {
    const cert = await issueCertificate(db as any, SCHOOL, 'stu-1', 'leaving', 'actor-1');
    expect(cert.certificate_no).toMatch(/^DEMO-PUBLIC-LEA-[0-9A-Z]{8}$/);
    expect(cert.type_label).toBe('School Leaving Certificate');
    expect(cert.student_name).toBe('Ahmed Raza');
    expect(cert.class_name).toBe('5-A');
    const html = renderCertificateHtml(cert);
    expect(html).toContain('Ahmed Raza');
    expect(html).toContain(cert.certificate_no);
    expect(html).toContain('School Leaving Certificate');
    const pdf = await renderCertificatePdf(cert);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(500);
    const list = await listCertificatesForStudent(db as any, SCHOOL, 'stu-1');
    expect(list.length).toBe(1);
    await expect(issueCertificate(db as any, SCHOOL, 'stu-1', 'bogus', 'a')).rejects.toThrow();
  });

  it('ID card: issue sets id_card_issued_at and writes a change log', async () => {
    const card = await issueIdCard(db as any, SCHOOL, 'stu-1', 'actor-1');
    expect(card.student_name).toBe('Ahmed Raza');
    expect(card.id_card_issued_at).not.toBeNull();
    const student: any = db.student.findUnique({ where: { id: 'stu-1' } });
    expect(student.idCardIssuedAt).not.toBeNull();
    expect(db.changeLog.findMany({ where: { entity: 'student', entityId: 'stu-1' } }).length).toBeGreaterThan(0);
  });

  it('cross-tenant: another school cannot issue certificates or read events', async () => {
    await expectNotFound(issueCertificate(db as any, OTHER_SCHOOL, 'stu-1', 'bonafide', 'a'));
    await createEvent(db as any, SCHOOL, { date: '2026-11-06', title: 'Sports Day' }, 'a');
    expect((await monthCalendar(db as any, OTHER_SCHOOL, '2026-11')).days).toEqual([]);
  });
});

describe('6C-2 leave approve/reject + late arrivals', () => {
  let db: FakeDb;
  beforeEach(() => { db = makeDb(); });

  it('decideLeave writes change history for approve and reject', async () => {
    const l1: any = await createLeave(db as any, SCHOOL, { student_id: 'stu-1', from_date: '2026-11-10', to_date: '2026-11-11', reason: 'Family wedding' }, 'actor-1');
    const approved = await decideLeave(db as any, SCHOOL, l1.id, 'approved', 'actor-1');
    expect(approved.status).toBe('approved');
    const l2: any = await createLeave(db as any, SCHOOL, { student_id: 'stu-2', from_date: '2026-11-10', to_date: '2026-11-10', reason: 'Sick' }, 'actor-1');
    const rejected = await decideLeave(db as any, SCHOOL, l2.id, 'rejected', 'actor-1');
    expect(rejected.status).toBe('rejected');
    const logs = db.changeLog.findMany({ where: { entity: 'leave_application' } });
    expect(logs.some((l: any) => l.newValue === 'approved')).toBe(true);
    expect(logs.some((l: any) => l.newValue === 'rejected')).toBe(true);
    await expectNotFound(decideLeave(db as any, OTHER_SCHOOL, l1.id, 'approved', 'a'));
  });

  it('late arrivals come from attendance records with status late', async () => {
    const day: any = db.attendanceDay.create({ data: { schoolId: SCHOOL, classId: 'class-5a', date: new Date('2026-11-06T00:00:00Z'), submittedBy: 'admin', submittedAt: new Date() } });
    (db as any).attendanceRecord.create({ data: { attendanceDayId: day.id, studentId: 'stu-1', status: 'late', markedAt: new Date(), updatedBy: 'admin' } });
    (db as any).attendanceRecord.create({ data: { attendanceDayId: day.id, studentId: 'stu-2', status: 'present', markedAt: new Date(), updatedBy: 'admin' } });
    const late = await listLateArrivals(db as any, SCHOOL, { date: '2026-11-06' });
    expect(late).toHaveLength(1);
    expect(late[0].student_name).toBe('Ahmed Raza');
    expect(late[0].class_name).toBe('5-A');
    expect(await listLateArrivals(db as any, OTHER_SCHOOL, { date: '2026-11-06' })).toEqual([]);
  });
});

describe('6C-2 reports + exports', () => {
  let db: FakeDb;
  beforeEach(() => { db = makeDb(); });

  it('fee defaulters lists only balances > 0, worst first', async () => {
    db.feeRecord.create({ data: { schoolId: SCHOOL, studentId: 'stu-1', month: '2026-10', amountDue: 2500, amountPaid: 0, discount: 0, arrears: 0, scholarshipDiscount: 0 } });
    db.feeRecord.create({ data: { schoolId: SCHOOL, studentId: 'stu-2', month: '2026-10', amountDue: 2500, amountPaid: 2500, discount: 0, arrears: 0, scholarshipDiscount: 0 } });
    db.feeRecord.create({ data: { schoolId: SCHOOL, studentId: 'stu-5', month: '2026-10', amountDue: 2500, amountPaid: 500, discount: 0, arrears: 0, scholarshipDiscount: 0 } });
    const r: any = await feeDefaulters(db as any, SCHOOL, { month: '2026-10' });
    expect(r.defaulters).toBe(2);
    expect(r.total_pending).toBe(4500);
    expect(r.by_student[0].student_name).toBe('Ahmed Raza');
    expect(r.by_student[0].balance).toBe(2500);
    const csv = exportCsv('x', ['Student', 'Balance'], r.by_student.map((s: any) => [s.student_name, s.balance]));
    expect(csv.toString('utf-8')).toContain('Ahmed Raza');
  });

  it('class strength counts by status', async () => {
    const r: any = await classStrength(db as any, SCHOOL);
    expect(r.classes).toBe(3);
    expect(r.total_active).toBe(5); // stu-6 is 'left'
    const c5a = r.by_class.find((c: any) => c.display_name === '5-A');
    expect(c5a.active).toBe(3);
    const c1a = r.by_class.find((c: any) => c.display_name === '1-A');
    expect(c1a.left).toBe(1);
  });

  it('message history is scoped and exportable as CSV/PDF/XLSX', async () => {
    db.messageQueue.create({ data: { schoolId: SCHOOL, type: 'absent', studentId: 'stu-1', body: 'Absent today', status: 'failed', dedupeKey: 'absent:stu-1:2026-11-06', scheduledFor: new Date(), attempts: 1, error: 'No signal' } });
    db.messageQueue.create({ data: { schoolId: OTHER_SCHOOL, type: 'absent', studentId: 'stu-1', body: 'Other school', status: 'failed', dedupeKey: 'other-1', scheduledFor: new Date(), attempts: 1 } });
    const r: any = await messageHistory(db as any, SCHOOL, {});
    expect(r.total).toBe(1);
    expect(r.items[0].student_name).toBe('Ahmed Raza');
    const exp = buildExportRows(r, 'message-history');
    expect(exp.headers[0]).toBe('Type');
    expect(exp.rows[0][0]).toBe('absent');
    const pdf = await exportPdf(exp.title, exp.headers, exp.rows);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    const xlsx = await exportXlsx(exp.title, exp.headers, exp.rows);
    expect(xlsx.subarray(0, 2).toString()).toBe('PK');
    const csv = exportCsv(exp.title, exp.headers, exp.rows);
    expect(csv.toString('utf-8')).toContain('Absent today');
  });

  it('results summary aggregates per exam', async () => {
    (db as any).exam.create({ data: { id: 'exam-mid', schoolId: SCHOOL, name: 'Midterm' } });
    (db as any).result.create({ data: { schoolId: SCHOOL, examId: 'exam-mid', classId: 'class-5a', rollNo: 1, studentName: 'Ahmed Raza', obtainedMarks: 80, totalMarks: 100, percentage: 80, grade: 'A' } });
    (db as any).result.create({ data: { schoolId: SCHOOL, examId: 'exam-mid', classId: 'class-5a', rollNo: 2, studentName: 'Sara Khan', obtainedMarks: 40, totalMarks: 100, percentage: 40, grade: 'F' } });
    const r: any = await resultsSummary(db as any, SCHOOL, { exam_id: 'exam-mid' });
    expect(r.students).toBe(2);
    expect(r.by_exam[0].average_percentage).toBe(60);
    expect(r.by_exam[0].passed).toBe(1);
    const exp = buildExportRows(r, 'results-summary');
    expect(exp.rows).toHaveLength(2);
  });
});

describe('6C-2 notification center + settings', () => {
  let db: FakeDb;
  beforeEach(() => { db = makeDb(); });

  it('aggregates pending approvals, failed messages, OCR review, fee dues', async () => {
    db.approvalRequest.create({ data: { schoolId: SCHOOL, requestedBy: 'clerk-1', actionType: 'create', entity: 'expense', payload: {}, status: 'pending' } });
    db.approvalRequest.create({ data: { schoolId: OTHER_SCHOOL, requestedBy: 'clerk-1', actionType: 'create', entity: 'expense', payload: {}, status: 'pending' } });
    db.messageQueue.create({ data: { schoolId: SCHOOL, type: 'absent', studentId: 'stu-1', body: 'x', status: 'failed', dedupeKey: 'f1', scheduledFor: new Date(), attempts: 2, error: 'SIM offline' } });
    (db as any).ocrUpload.create({ data: { schoolId: SCHOOL, classId: 'class-5a', filePath: '/tmp/x.jpg', status: 'review', rawText: 'Ahmed' } });
    db.feeRecord.create({ data: { schoolId: SCHOOL, studentId: 'stu-1', month: new Date().toISOString().slice(0, 7), amountDue: 2500, amountPaid: 0, discount: 0, arrears: 0, scholarshipDiscount: 0 } });
    const center = await getNotificationCenter(db as any, SCHOOL);
    expect(center.counts.pending_approvals).toBe(1);
    expect(center.counts.failed_messages).toBe(1);
    expect(center.counts.ocr_needing_review).toBe(1);
    expect(center.counts.fee_dues).toBe(1);
    expect(center.counts.fee_dues_amount).toBe(2500);
    expect(center.items.pending_approvals[0].entity).toBe('expense');
    expect(center.items.failed_messages[0].error).toBe('SIM offline');
    expect(center.items.fee_dues[0].student_name).toBe('Ahmed Raza');
  });

  it('settings: school name/timezone land on the row, language + address in settings JSON', async () => {
    const before = await getSettings(db as any, SCHOOL);
    expect(before.school_name).toBe('Demo Public School');
    expect(before.timezone).toBe('Asia/Karachi');
    const updated = await updateSettings(db as any, SCHOOL, { school_name: 'New School', timezone: 'Asia/Dubai', language: 'ur', school_address: 'Main Bazaar', school_phone: '03001234567' }, 'actor-1');
    expect(updated.school_name).toBe('New School');
    expect(updated.timezone).toBe('Asia/Dubai');
    expect(updated.language).toBe('ur');
    expect(updated.school_address).toBe('Main Bazaar');
    const school: any = db.school.findUnique({ where: { id: SCHOOL } });
    expect(school.name).toBe('New School');
    expect(school.timezone).toBe('Asia/Dubai');
    // The row-backed keys were NOT duplicated into settings JSON.
    expect((school.settings as any).school_name).toBeUndefined();
    expect((school.settings as any).timezone).toBeUndefined();
    expect((school.settings as any).language).toBe('ur');
    await expect(updateSettings(db as any, SCHOOL, { language: 'fr' }, 'a')).rejects.toThrow();
    await expect(updateSettings(db as any, SCHOOL, { timezone: 'Mars/Olympus' }, 'a')).rejects.toThrow();
  });
});
