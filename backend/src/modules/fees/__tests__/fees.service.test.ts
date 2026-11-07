// Unit tests for the fee service (run with vitest).
// Covers: status math, partial payments, discounts, receipt sequencing,
// rollover idempotency, paid-record protection, listing/reporting.
import { describe, expect, it, beforeEach } from 'vitest';
import type { Db } from '../../../lib/db';
import {
  computeFeeStatus,
  createFeeStructure,
  deleteFeeStructure,
  getReceiptByNo,
  listFees,
  monthlyFeeReport,
  payFee,
  rolloverMonth,
} from '../service';
import { FakeDb, seedDemo } from './fake-db';

function freshDb(): { db: Db; schoolId: string } {
  const fake = new FakeDb();
  seedDemo(fake);
  return { db: fake as unknown as Db, schoolId: 'school-demo' };
}

describe('computeFeeStatus', () => {
  it('unpaid when nothing paid', () => {
    expect(computeFeeStatus(2500, 0, 0)).toBe('unpaid');
  });
  it('partial when some paid', () => {
    expect(computeFeeStatus(2500, 1000, 0)).toBe('partial');
  });
  it('partial when only a discount is given', () => {
    expect(computeFeeStatus(2500, 0, 500)).toBe('partial');
  });
  it('paid when paid + discount covers the due amount', () => {
    expect(computeFeeStatus(2500, 2000, 500)).toBe('paid');
    expect(computeFeeStatus(2500, 2500, 0)).toBe('paid');
  });
});

describe('payFee', () => {
  let db: Db;
  const schoolId = 'school-demo';
  beforeEach(() => {
    ({ db } = freshDb());
  });

  it('partial payment leaves status partial and mints receipt ...-001', async () => {
    await rolloverMonth(db, schoolId, '2026-11');
    const receipt = await payFee(db, schoolId, 'stu-1', { month: '2026-11', amount_paid: 1000, payment_method: 'cash' }, 'admin-1');
    expect(receipt.receipt_no).toBe('demo-public-202611-001');
    expect(receipt.status).toBe('partial');
    expect(receipt.balance).toBe(1500);
    expect(receipt.amount_paid).toBe(1000);
  });

  it('completing the balance flips status to paid, keeps the same receipt', async () => {
    await rolloverMonth(db, schoolId, '2026-11');
    const first = await payFee(db, schoolId, 'stu-1', { month: '2026-11', amount_paid: 1000 }, 'admin-1');
    const second = await payFee(db, schoolId, 'stu-1', { month: '2026-11', amount_paid: 1500 }, 'admin-1');
    expect(second.status).toBe('paid');
    expect(second.balance).toBe(0);
    expect(second.receipt_no).toBe(first.receipt_no);
    expect(second.paid_at).not.toBeNull();
  });

  it('discount counts toward the balance', async () => {
    await rolloverMonth(db, schoolId, '2026-11');
    const receipt = await payFee(db, schoolId, 'stu-2', { month: '2026-11', amount_paid: 2000, discount: 500 }, 'admin-1');
    expect(receipt.status).toBe('paid');
    expect(receipt.balance).toBe(0);
    expect(receipt.discount).toBe(500);
  });

  it('overpayment is rejected', async () => {
    await rolloverMonth(db, schoolId, '2026-11');
    await expect(
      payFee(db, schoolId, 'stu-1', { month: '2026-11', amount_paid: 3000 }, 'admin-1'),
    ).rejects.toThrow('exceeds the remaining balance');
  });

  it('paying again after full payment is rejected', async () => {
    await rolloverMonth(db, schoolId, '2026-11');
    await payFee(db, schoolId, 'stu-1', { month: '2026-11', amount_paid: 2500 }, 'admin-1');
    await expect(
      payFee(db, schoolId, 'stu-1', { month: '2026-11', amount_paid: 100 }, 'admin-1'),
    ).rejects.toThrow('exceeds the remaining balance');
  });

  it('receipt numbers sequence per school+month across students', async () => {
    await rolloverMonth(db, schoolId, '2026-11');
    const r1 = await payFee(db, schoolId, 'stu-1', { month: '2026-11', amount_paid: 2500 }, 'admin-1');
    const r2 = await payFee(db, schoolId, 'stu-2', { month: '2026-11', amount_paid: 2500 }, 'admin-1');
    expect(r1.receipt_no).toBe('demo-public-202611-001');
    expect(r2.receipt_no).toBe('demo-public-202611-002');
    // A new month restarts the sequence.
    await rolloverMonth(db, schoolId, '2026-12');
    const r3 = await payFee(db, schoolId, 'stu-1', { month: '2026-12', amount_paid: 2500 }, 'admin-1');
    expect(r3.receipt_no).toBe('demo-public-202612-001');
  });

  it('creates the record on the fly when rollover has not run', async () => {
    const receipt = await payFee(db, schoolId, 'stu-5', { month: '2026-11', amount_paid: 2500 }, 'clerk-1');
    expect(receipt.status).toBe('paid');
    expect(receipt.amount_due).toBe(2500);
  });

  it('receipt can be fetched by number', async () => {
    await rolloverMonth(db, schoolId, '2026-11');
    const paid = await payFee(db, schoolId, 'stu-1', { month: '2026-11', amount_paid: 2500 }, 'admin-1');
    const fetched = await getReceiptByNo(db, schoolId, paid.receipt_no);
    expect(fetched.student_name).toBe('Ahmed Raza');
    expect(fetched.class_name).toBe('5-A');
    expect(fetched.amount_paid).toBe(2500);
  });

  it('unknown receipt number throws', async () => {
    await expect(getReceiptByNo(db, schoolId, 'demo-public-202611-999')).rejects.toThrow('Receipt not found');
  });
});

describe('rolloverMonth', () => {
  it('creates one record per active student and is idempotent', async () => {
    const { db } = freshDb();
    const first = await rolloverMonth(db, 'school-demo', '2026-11');
    // 5 active students (stu-6 left the school) across 3 classes.
    expect(first.created).toBe(5);
    expect(first.already_existed).toBe(0);
    const second = await rolloverMonth(db, 'school-demo', '2026-11');
    expect(second.created).toBe(0);
    expect(second.already_existed).toBe(5);
  });

  it('never re-creates or resets an already-paid record', async () => {
    const { db } = freshDb();
    await rolloverMonth(db, 'school-demo', '2026-11');
    await payFee(db, 'school-demo', 'stu-1', { month: '2026-11', amount_paid: 2500 }, 'admin-1');
    const again = await rolloverMonth(db, 'school-demo', '2026-11');
    expect(again.created).toBe(0);
    const list = await listFees(db, 'school-demo', { month: '2026-11' }, 'Asia/Karachi');
    const stu1 = list.items.find((i) => i.student_id === 'stu-1')!;
    expect(stu1.status).toBe('paid');
    expect(stu1.amount_paid).toBe(2500);
  });
});

describe('listFees', () => {
  it('projects amounts from the structure when no record exists yet', async () => {
    const { db } = freshDb();
    const list = await listFees(db, 'school-demo', { month: '2026-11' }, 'Asia/Karachi');
    expect(list.total).toBe(5);
    const stu1 = list.items.find((i) => i.student_id === 'stu-1')!;
    expect(stu1.amount_due).toBe(2500);
    expect(stu1.status).toBe('unpaid');
    expect(stu1.record_exists).toBe(false);
  });

  it('filters by status and class', async () => {
    const { db } = freshDb();
    await rolloverMonth(db, 'school-demo', '2026-11');
    await payFee(db, 'school-demo', 'stu-1', { month: '2026-11', amount_paid: 2500 }, 'admin-1');
    const paid = await listFees(db, 'school-demo', { month: '2026-11', status: 'paid' }, 'Asia/Karachi');
    expect(paid.items.map((i) => i.student_id)).toEqual(['stu-1']);
    const classB = await listFees(db, 'school-demo', { month: '2026-11', class_id: 'class-6b' }, 'Asia/Karachi');
    expect(classB.total).toBe(2);
  });
});

describe('monthlyFeeReport', () => {
  it('reports collected vs pending by class, and flags missing records', async () => {
    const { db } = freshDb();
    await rolloverMonth(db, 'school-demo', '2026-11');
    await payFee(db, 'school-demo', 'stu-1', { month: '2026-11', amount_paid: 2500 }, 'admin-1');
    await payFee(db, 'school-demo', 'stu-2', { month: '2026-11', amount_paid: 1000 }, 'admin-1');
    const report = await monthlyFeeReport(db, 'school-demo', '2026-11');
    expect(report.collected).toBe(3500);
    expect(report.pending).toBe(2500 * 5 - 3500);
    expect(report.paid_count).toBe(1);
    expect(report.partial_count).toBe(1);
    expect(report.unpaid_count).toBe(3);
    expect(report.missing_records).toBe(0);
    const classA = report.by_class.find((c) => c.class_name === '5-A')!;
    expect(classA.collected).toBe(3500);
    expect(classA.paid_count).toBe(1);
  });

  it('counts students without records as missing', async () => {
    const { db } = freshDb();
    const report = await monthlyFeeReport(db, 'school-demo', '2026-11');
    expect(report.missing_records).toBe(5);
    expect(report.collected).toBe(0);
  });
});

describe('fee structures', () => {
  it('latest effective_from wins for the list projection', async () => {
    const { db } = freshDb();
    await createFeeStructure(db, 'school-demo', { class_id: 'class-5a', monthly_amount: 3000, effective_from: '2026-11-01' });
    const list = await listFees(db, 'school-demo', { month: '2026-11' }, 'Asia/Karachi');
    const stu1 = list.items.find((i) => i.student_id === 'stu-1')!;
    expect(stu1.amount_due).toBe(3000);
  });

  it('delete is blocked once records exist from that structure', async () => {
    const { db } = freshDb();
    await rolloverMonth(db, 'school-demo', '2026-11');
    const structures = await import('../service').then((m) => m.listFeeStructures(db, 'school-demo'));
    const s5a = structures.find((s) => s.class_id === 'class-5a')!;
    await expect(deleteFeeStructure(db, 'school-demo', s5a.id)).rejects.toThrow('Cannot delete');
  });
});

describe('mid-month fee structure backfill (R2-F)', () => {
  // 2026-11-07 10:00 PKT — mid-month in the school's timezone.
  const MID_NOV = new Date('2026-11-07T05:00:00Z');

  function addClass(db: Db, classId = 'class-7c', studentIds = ['stu-7a', 'stu-7b']) {
    (db as any).class.create({ data: { id: classId, schoolId: 'school-demo', name: '7', section: 'C' } });
    studentIds.forEach((id, i) =>
      (db as any).student.create({
        data: {
          id, schoolId: 'school-demo', classId, rollNo: i + 1, name: `Student ${id}`,
          parentName: `Parent of ${id}`, parentPhoneEnc: null, parentPhoneHash: null,
          parentOptOut: false, status: 'active',
        },
      }),
    );
    return { classId, studentIds };
  }

  function novRecords(db: Db, studentIds: string[]) {
    return (db as any).feeRecord.findMany({ where: { month: '2026-11', studentId: { in: studentIds } } });
  }

  it('structure created mid-month backfills current-month records; Collect works and a receipt is issued', async () => {
    const { db } = freshDb();
    const { studentIds } = addClass(db);
    const created = await createFeeStructure(
      db, 'school-demo',
      { class_id: 'class-7c', monthly_amount: 2000, admission_fee: 500, effective_from: '2026-11-07' },
      { now: MID_NOV },
    );
    expect(created.backfilled_records).toBe(2);

    const list = await listFees(db, 'school-demo', { month: '2026-11', class_id: 'class-7c' }, 'Asia/Karachi');
    expect(list.total).toBe(2);
    for (const item of list.items) {
      expect(item.record_exists).toBe(true);
      expect(item.record_id).not.toBeNull();
      // First record: monthly 2000 + one-time admission 500.
      expect(item.amount_due).toBe(2500);
      expect(item.status).toBe('unpaid');
    }

    const receipt = await payFee(db, 'school-demo', studentIds[0], { month: '2026-11', amount_paid: 2500, payment_method: 'cash' }, 'admin-1');
    expect(receipt.receipt_no).toBe('demo-public-202611-001');
    expect(receipt.status).toBe('paid');
    expect(receipt.amount_due).toBe(2500);
    expect(receipt.balance).toBe(0);
    const fetched = await getReceiptByNo(db, 'school-demo', receipt.receipt_no);
    expect(fetched.student_id).toBe(studentIds[0]);
  });

  it('re-running rollover after the backfill creates no duplicates and never resets a paid record', async () => {
    const { db } = freshDb();
    const { studentIds } = addClass(db);
    await createFeeStructure(
      db, 'school-demo',
      { class_id: 'class-7c', monthly_amount: 2000, admission_fee: 500, effective_from: '2026-11-07' },
      { now: MID_NOV },
    );
    await payFee(db, 'school-demo', studentIds[0], { month: '2026-11', amount_paid: 2500 }, 'admin-1');

    // First rollover creates only the 5 seeded students' records (the new
    // class was already backfilled); a second rollover creates nothing.
    const first = await rolloverMonth(db, 'school-demo', '2026-11');
    expect(first.created).toBe(5);
    expect(first.classes_without_structure).not.toContain('class-7c');
    const second = await rolloverMonth(db, 'school-demo', '2026-11');
    expect(second.created).toBe(0);
    expect(second.already_existed).toBe(7);

    expect(novRecords(db, studentIds)).toHaveLength(2);
    const list = await listFees(db, 'school-demo', { month: '2026-11', class_id: 'class-7c' }, 'Asia/Karachi');
    const paid = list.items.find((i) => i.student_id === studentIds[0])!;
    expect(paid.status).toBe('paid');
    expect(paid.amount_paid).toBe(2500);
  });

  it('a student admitted after the structure was created is still collectable (projection + on-the-fly payFee)', async () => {
    const { db } = freshDb();
    const { studentIds } = addClass(db, 'class-7c', ['stu-7a']);
    await createFeeStructure(
      db, 'school-demo',
      { class_id: 'class-7c', monthly_amount: 2000, admission_fee: 500, effective_from: '2026-11-07' },
      { now: MID_NOV },
    );
    // New admission after the backfill ran — no record yet.
    (db as any).student.create({
      data: {
        id: 'stu-7b', schoolId: 'school-demo', classId: 'class-7c', rollNo: 2, name: 'Student stu-7b',
        parentName: 'Parent of stu-7b', parentPhoneEnc: null, parentPhoneHash: null,
        parentOptOut: false, status: 'active',
      },
    });

    const list = await listFees(db, 'school-demo', { month: '2026-11', class_id: 'class-7c' }, 'Asia/Karachi');
    const late = list.items.find((i) => i.student_id === 'stu-7b')!;
    expect(late.record_exists).toBe(false);
    expect(late.no_structure).toBe(false);
    expect(late.amount_due).toBe(2500); // projected from the mid-month structure

    const receipt = await payFee(db, 'school-demo', 'stu-7b', { month: '2026-11', amount_paid: 2500 }, 'admin-1');
    expect(receipt.status).toBe('paid');
    expect(receipt.amount_due).toBe(2500);
    expect(novRecords(db, [...studentIds, 'stu-7b'])).toHaveLength(2);
  });

  it('creating a second structure for the same class mid-month creates no duplicate records', async () => {
    const { db } = freshDb();
    const { studentIds } = addClass(db);
    await createFeeStructure(
      db, 'school-demo',
      { class_id: 'class-7c', monthly_amount: 2000, admission_fee: 500, effective_from: '2026-11-07' },
      { now: MID_NOV },
    );
    const second = await createFeeStructure(
      db, 'school-demo',
      { class_id: 'class-7c', monthly_amount: 3000, effective_from: '2026-11-10' },
      { now: new Date('2026-11-10T05:00:00Z') },
    );
    expect(second.backfilled_records).toBe(0);
    expect(novRecords(db, studentIds)).toHaveLength(2);
    // Stored records keep the first structure's amounts (history is never rewritten).
    const list = await listFees(db, 'school-demo', { month: '2026-11', class_id: 'class-7c' }, 'Asia/Karachi');
    for (const item of list.items) expect(item.amount_due).toBe(2500);
  });

  it('a future-dated structure backfills nothing for the current month', async () => {
    const { db } = freshDb();
    const { studentIds } = addClass(db);
    const created = await createFeeStructure(
      db, 'school-demo',
      { class_id: 'class-7c', monthly_amount: 2000, effective_from: '2026-12-01' },
      { now: MID_NOV },
    );
    expect(created.backfilled_records).toBe(0);
    const nov = await listFees(db, 'school-demo', { month: '2026-11', class_id: 'class-7c' }, 'Asia/Karachi');
    expect(nov.items.every((i) => i.no_structure && i.amount_due === 0 && !i.record_exists)).toBe(true);
    // Its first month is created by that month's rollover.
    await rolloverMonth(db, 'school-demo', '2026-12');
    const dec = await listFees(db, 'school-demo', { month: '2026-12', class_id: 'class-7c' }, 'Asia/Karachi');
    expect(dec.items.every((i) => i.record_exists && i.amount_due === 2000)).toBe(true);
    expect(novRecords(db, studentIds)).toHaveLength(0);
  });

  it('rolloverMonth itself covers a mid-month structure (month-end cutoff)', async () => {
    const { db } = freshDb();
    const { studentIds } = addClass(db);
    // Seed the structure directly (bypassing createFeeStructure's backfill).
    (db as any).feeStructure.create({
      data: { schoolId: 'school-demo', classId: 'class-7c', monthlyAmount: 2000, effectiveFrom: new Date('2026-11-15T00:00:00Z') },
    });
    const res = await rolloverMonth(db, 'school-demo', '2026-11');
    expect(res.classes_without_structure).not.toContain('class-7c');
    expect(novRecords(db, studentIds)).toHaveLength(2);
    const again = await rolloverMonth(db, 'school-demo', '2026-11');
    expect(again.created).toBe(0);
  });
});
