// Perf pass (2026-11-20): rolloverMonth / backfillMonthForClass must NOT
// run 3 queries per student. The old loop called feeBreakdownForStudent
// per student (isSiblingStudent + priorArrears + hasPriorFeeRecord) —
// 22 DB calls for the 6-student demo seed, ~3300 for an 1100-student
// school. The batched path fetches the same three inputs once for the
// whole set; these tests pin the call count AND prove the batched math
// matches the per-student math (arrears + sibling discount + first-record).
import { describe, expect, it } from 'vitest';
import type { Db } from '../../../lib/db';
import { backfillMonthForClass, rolloverMonth } from '../service';
import { FakeDb, seedDemo } from './fake-db';

/** Wrap every FakeCollection read/write with a counter; returns the count fn. */
function countDbCalls(fake: FakeDb): () => number {
  let calls = 0;
  const methods = ['findMany', 'findFirst', 'findUnique', 'create', 'createMany', 'count', 'update', 'updateMany', 'delete'] as const;
  for (const coll of Object.values(fake)) {
    if (!coll || typeof coll !== 'object' || !('findMany' in coll)) continue;
    for (const m of methods) {
      const fn = (coll as any)[m];
      if (typeof fn !== 'function') continue;
      const orig = fn.bind(coll);
      (coll as any)[m] = (...a: any[]) => {
        calls += 1;
        return orig(...a);
      };
    }
  }
  return () => calls;
}

describe('rolloverMonth (batched)', () => {
  it('issues a constant number of DB calls, independent of student count', async () => {
    const fake = new FakeDb();
    seedDemo(fake);
    const calls = countDbCalls(fake);
    const res = await rolloverMonth(fake as unknown as Db, 'school-demo', '2026-11');
    expect(res.created).toBe(5); // 5 active students (stu-6 left)
    // structures + classes + students + feeRecords + hash scan +
    // createMany + audit = 7. The old per-student loop needed 22 here
    // and ~3N for a real school; anything above 8 means the N+1 is back.
    expect(calls()).toBeLessThanOrEqual(8);
  });

  it('batched math matches the per-student math (arrears + sibling discount)', async () => {
    const fake = new FakeDb();
    seedDemo(fake);
    const db = fake as unknown as Db;
    // stu-1 and stu-2 share a parent phone -> siblings.
    (fake.student as any).update({ where: { id: 'stu-2' }, data: { parentPhoneHash: 'hash-enc-parent-1' } });
    // 10% sibling discount on the class-5a structure.
    const structs = (fake.feeStructure as any).findMany({ where: { schoolId: 'school-demo', classId: 'class-5a' } });
    (fake.feeStructure as any).update({ where: { id: structs[0].id }, data: { siblingDiscountPct: 10 } });
    // stu-1 carries 1500 unpaid from October.
    (fake.feeRecord as any).create({
      data: { schoolId: 'school-demo', studentId: 'stu-1', month: '2026-10', amountDue: 2500, amountPaid: 1000, discount: 0, arrears: 0, scholarshipDiscount: 0 },
    });
    const res = await rolloverMonth(db, 'school-demo', '2026-11');
    expect(res.created).toBe(5);
    const rows: any[] = (fake.feeRecord as any).findMany({ where: { schoolId: 'school-demo', month: '2026-11' } });
    const byStudent = new Map<string, any>(rows.map((r: any) => [r.studentId, r]));
    // stu-1: 2500 monthly + 1500 arrears - 250 sibling discount = 3750.
    expect(byStudent.get('stu-1').amountDue).toBe(3750);
    expect(byStudent.get('stu-1').arrears).toBe(1500);
    // stu-2: 2500 - 250 sibling discount = 2250.
    expect(byStudent.get('stu-2').amountDue).toBe(2250);
    // stu-3: no phone, no sibling, no arrears = 2500 flat.
    expect(byStudent.get('stu-3').amountDue).toBe(2500);
  });
});

describe('backfillMonthForClass (batched)', () => {
  it('issues a constant number of DB calls for one class', async () => {
    const fake = new FakeDb();
    seedDemo(fake);
    const calls = countDbCalls(fake);
    const created = await backfillMonthForClass(
      fake as unknown as Db,
      'school-demo',
      'class-5a',
      { id: 'struct-5a', monthlyAmount: 2500, effectiveFrom: new Date('2026-01-01T00:00:00Z'), admissionFee: 0, siblingDiscountPct: 0 },
      '2026-11',
    );
    expect(created).toBe(3); // stu-1, stu-2, stu-3 (all in 5a, all active)
    // students + feeRecords + hash scan + createMany = 4.
    expect(calls()).toBeLessThanOrEqual(5);
  });
});
