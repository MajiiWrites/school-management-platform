/**
 * Round 5 (F1 + F3) — listFees: server-side pagination + whole-month
 * totals, and the batched breakdown (no per-student query fan-out).
 * Uses the module's FakeDb + seedDemo (in-memory, no DB, no network).
 */
import { describe, expect, it } from 'vitest';
import type { Db } from '../../../lib/db';
import { listFees } from '../service';
import { FakeDb, seedDemo } from './fake-db';

function freshDb(): { db: Db; fake: FakeDb } {
  const fake = new FakeDb();
  seedDemo(fake);
  return { db: fake as unknown as Db, fake };
}

describe('listFees (Round 5)', () => {
  it('paginates and reports whole-month totals over all matching rows', async () => {
    const { db } = freshDb();
    // seedDemo: 5 active students (stu-6 is 'left'), each with a 2500
    // structure and no fee record yet for 2026-11.
    const p1 = await listFees(db, 'school-demo', { month: '2026-11', page: 1, limit: 2 }, 'Asia/Karachi');
    expect(p1.total).toBe(5);
    expect(p1.pages).toBe(3);
    expect(p1.items).toHaveLength(2);
    // Totals cover ALL 5 rows, not just the loaded page.
    expect(p1.totals.collected).toBe(0);
    expect(p1.totals.pending).toBe(5 * 2500);
    expect(p1.totals.paid_count).toBe(0);
    expect(p1.totals.unpaid_count).toBe(5);
    const p3 = await listFees(db, 'school-demo', { month: '2026-11', page: 3, limit: 2 }, 'Asia/Karachi');
    expect(p3.items).toHaveLength(1);
    expect(p3.totals.pending).toBe(5 * 2500);
  });

  it('does not fan out queries per student (F3)', async () => {
    const { db, fake } = freshDb();
    let findManyCalls = 0;
    for (const table of [fake.class, fake.student, fake.feeRecord, fake.feeStructure]) {
      const orig = table.findMany.bind(table);
      (table as any).findMany = (...args: any[]) => {
        findManyCalls += 1;
        return orig(...args);
      };
    }
    await listFees(db, 'school-demo', { month: '2026-11', page: 1, limit: 50 }, 'Asia/Karachi');
    // Batched: classes + students + month records + structures +
    // all-records + sibling hashes = 6 findMany calls, whatever the
    // student count. The old code did 3 extra calls PER prospective
    // student (5 here → 15 more), ~3300 for the 1100-student class.
    expect(findManyCalls).toBeLessThanOrEqual(8);
  });

  it('a no-structure row is not a paid row (D3 phantom)', async () => {
    const { db, fake } = freshDb();
    // New class with no fee structure + one active student in it.
    fake.class.create({
      data: { id: 'class-9z', schoolId: 'school-demo', name: '9', section: 'Z', teacherName: 'Noor', teacherPhoneEnc: null },
    });
    fake.student.create({
      data: {
        id: 'stu-9z', schoolId: 'school-demo', classId: 'class-9z', rollNo: 1, name: 'No Structure Kid',
        parentName: null, parentPhoneEnc: null, parentPhoneHash: null, parentOptOut: false, status: 'active',
      },
    });
    const all = await listFees(db, 'school-demo', { month: '2026-11', class_id: 'class-9z' }, 'Asia/Karachi');
    expect(all.total).toBe(1);
    expect(all.items[0].no_structure).toBe(true);
    // The generated status is 'paid' (balance 0) but the row is not paid.
    expect(all.items[0].status).toBe('paid');
    const paid = await listFees(db, 'school-demo', { month: '2026-11', class_id: 'class-9z', status: 'paid' }, 'Asia/Karachi');
    expect(paid.total).toBe(0);
    expect(paid.totals.paid_count).toBe(0);
    expect(paid.totals.unpaid_count).toBe(0);
  });

  it('search filters server-side by student name', async () => {
    const { db } = freshDb();
    const found = await listFees(db, 'school-demo', { month: '2026-11', search: 'hina' }, 'Asia/Karachi');
    expect(found.total).toBe(1);
    expect(found.items[0].student_name).toBe('Hina Malik');
  });
});
