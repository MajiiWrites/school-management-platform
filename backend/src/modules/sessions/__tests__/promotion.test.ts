// Promotion rebuild (Module D) — tests for the fixed promotion engine.
// Covers the five required behaviours (promote, undo, edit, partial
// promotion, highest class) plus preview, double-promotion guards, the
// admin delegate, undo blocking, and cross-tenant isolation. Fake in-memory
// DB only; the migration + real-Postgres behaviour (partial unique index,
// UNIQUE (class_id, roll_no)) is verified on scratch in PROMOTION-REBUILD.md.
import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../../../lib/db';
import { FakeDb } from './fake-db';
import * as svc from '../service';
import * as adminSvc from '../../admin/service';

const SCHOOL = 'school-promo';
const OTHER = 'school-other';

function seed(db: FakeDb) {
  db.school.create({ data: { id: SCHOOL, name: 'Promo School', slug: 'promo', timezone: 'Asia/Karachi', country: 'PK', settings: {} } });
  db.school.create({ data: { id: OTHER, name: 'Other School', slug: 'other', timezone: 'Asia/Karachi', country: 'PK', settings: {} } });
  const c5 = db.class.create({ data: { id: 'c5', schoolId: SCHOOL, name: '5', section: 'A', teacherName: 'T1', deletedAt: null } });
  const c6 = db.class.create({ data: { id: 'c6', schoolId: SCHOOL, name: '6', section: 'A', teacherName: 'T2', deletedAt: null } });
  const c7 = db.class.create({ data: { id: 'c7', schoolId: SCHOOL, name: '7', section: 'A', teacherName: 'T3', deletedAt: null } });
  const c10 = db.class.create({ data: { id: 'c10', schoolId: SCHOOL, name: '10', section: 'A', teacherName: 'T4', deletedAt: null } });
  const mk = (id: string, classId: string, rollNo: number | null, name: string, status = 'active') =>
    db.student.create({ data: { id, schoolId: SCHOOL, classId, rollNo, name, status, deletedAt: null } });
  const existing6A = mk('stu-6a-1', c6.id, 1, 'Existing Sixer');
  const ali = mk('stu-ali', c5.id, 1, 'Ali');
  const bina = mk('stu-bina', c5.id, 2, 'Bina');
  const noRoll = mk('stu-noroll', c5.id, null, 'Noor');
  const left = mk('stu-left', c5.id, 3, 'Left Kid', 'left');
  const struck = mk('stu-struck', c5.id, 4, 'Struck Kid', 'struck_off');
  const topper = mk('stu-top', c10.id, 1, 'Topper');
  // Old-session history that a promotion must NEVER rewrite: an attendance
  // day + record for 5-A, and a fee record for Ali, both pre-promotion.
  db.attendanceDay.create({ data: { id: 'day-1', schoolId: SCHOOL, classId: c5.id, date: new Date('2026-05-01'), submittedBy: 't', submittedAt: new Date() } });
  db.attendanceRecord.create({ data: { id: 'rec-1', attendanceDayId: 'day-1', studentId: ali.id, status: 'present', markedAt: new Date(), updatedBy: 't' } });
  db.feeRecord.create({ data: { id: 'fee-1', schoolId: SCHOOL, studentId: ali.id, month: '2026-05', amountDue: 1000, amountPaid: 1000, discount: 0, deletedAt: null } });
  return { c5, c6, c7, c10, existing6A, ali, bina, noRoll, left, struck, topper };
}

async function makeSession(db: Db, name = '2026-27') {
  return svc.createSession(db, SCHOOL, { name, start_date: '2026-04-01', end_date: '2027-03-31' }, 'admin-1');
}

async function student(db: Db, id: string) {
  return (db as any).student.findFirst({ where: { id } });
}

async function rollsIn(db: Db, classId: string): Promise<Array<number | null>> {
  const rows = await (db as any).student.findMany({ where: { classId, deletedAt: null } });
  return rows.map((r: any) => r.rollNo);
}

describe('promotion rebuild', () => {
  let db: Db;
  let s: ReturnType<typeof seed>;
  beforeEach(() => {
    const fake = new FakeDb();
    s = seed(fake);
    db = fake as unknown as Db;
  });

  it('promote: whole class moves with collision-free roll numbers and old-session history is preserved', async () => {
    const session = await makeSession(db);
    const res = await svc.promoteClassSection(db, SCHOOL, session.id as string, { from_class_id: s.c5.id, to_class_id: s.c6.id }, 'admin-1');
    expect(res.promoted).toBe(3); // Ali, Bina, Noor — left/struck-off never move
    expect(res.batch_id).toBeTruthy();
    expect((await student(db, s.ali.id)).classId).toBe(s.c6.id);
    expect((await student(db, s.ali.id)).rollNo).toBe(2); // 6-A already held roll 1
    expect((await student(db, s.bina.id)).rollNo).toBe(3);
    expect((await student(db, s.noRoll.id)).rollNo).toBe(4);
    const rolls = await rollsIn(db, s.c6.id);
    expect(new Set(rolls).size).toBe(rolls.length); // no duplicate rolls
    expect((await student(db, s.left.id)).classId).toBe(s.c5.id);
    expect((await student(db, s.struck.id)).classId).toBe(s.c5.id);
    // History untouched: old attendance day/record + fee record still there,
    // and the promotion row says Ali WAS 5-A in this session.
    expect((db as any).attendanceDay.count({})).toBe(1);
    expect((db as any).attendanceRecord.count({})).toBe(1);
    expect((db as any).feeRecord.count({})).toBe(1);
    expect((await (db as any).feeRecord.findFirst({ where: { id: 'fee-1' } })).amountPaid).toBe(1000);
    expect(await svc.getStudentClassInSession(db, SCHOOL, s.ali.id, session.id as string)).toEqual({ class_id: s.c5.id, source: 'promotion' });
    // Promotion rows carry batch / status / outcome / roll snapshot + logs.
    const rows = await (db as any).promotion.findMany({ where: { sessionId: session.id } });
    expect(rows).toHaveLength(3);
    expect(rows.every((r: any) => r.batchId === res.batch_id && r.status === 'applied' && r.outcome === 'promoted')).toBe(true);
    const aliRow = rows.find((r: any) => r.studentId === s.ali.id);
    expect(aliRow.rollNoFrom).toBe(1);
    expect(aliRow.rollNoTo).toBe(2);
    const logs = (db as any).changeLog.findMany({ where: { entity: 'student', entityId: s.ali.id } });
    expect(logs.some((l: any) => l.field === 'class_id')).toBe(true);
  });

  it('undo: a promotion batch reverses exactly, restoring class and roll numbers', async () => {
    const session = await makeSession(db);
    const res = await svc.promoteClassSection(db, SCHOOL, session.id as string, { from_class_id: s.c5.id, to_class_id: s.c6.id }, 'admin-1');
    const undone = await svc.undoPromotion(db, SCHOOL, res.batch_id, 'admin-1');
    expect(undone.reversed).toBe(3);
    expect(undone.roll_no_reassigned).toEqual([]);
    expect((await student(db, s.ali.id)).classId).toBe(s.c5.id);
    expect((await student(db, s.ali.id)).rollNo).toBe(1);
    expect((await student(db, s.bina.id)).rollNo).toBe(2);
    expect((await student(db, s.noRoll.id)).rollNo).toBeNull();
    expect((await rollsIn(db, s.c6.id))).toEqual([1]); // only the pre-existing student left
    const rows = await (db as any).promotion.findMany({ where: { sessionId: session.id } });
    expect(rows.every((r: any) => r.status === 'reversed')).toBe(true);
    await expect(svc.undoPromotion(db, SCHOOL, res.batch_id, 'admin-1')).rejects.toThrow('already reversed');
  });

  it('edit: a single promoted student moves to a different class without touching the rest', async () => {
    const session = await makeSession(db);
    const res = await svc.promoteClassSection(db, SCHOOL, session.id as string, { from_class_id: s.c5.id, to_class_id: s.c6.id }, 'admin-1');
    const rows = await (db as any).promotion.findMany({ where: { sessionId: session.id, studentId: s.ali.id } });
    const edited = await svc.editPromotion(db, SCHOOL, rows[0].id, { to_class_id: s.c7.id }, 'admin-1');
    expect(edited.to_class_id).toBe(s.c7.id);
    expect(edited.outcome).toBe('promoted');
    expect(edited.batch_id).toBe(res.batch_id);
    expect((await student(db, s.ali.id)).classId).toBe(s.c7.id);
    expect((await student(db, s.ali.id)).rollNo).toBe(1); // 7-A was empty
    expect((await student(db, s.bina.id)).classId).toBe(s.c6.id); // untouched
    expect((await student(db, s.noRoll.id)).classId).toBe(s.c6.id);
    const all = await (db as any).promotion.findMany({ where: { studentId: s.ali.id } });
    expect(all.find((r: any) => r.id === rows[0].id).status).toBe('superseded');
    expect(all.find((r: any) => r.id === edited.id).status).toBe('applied');
    await expect(svc.editPromotion(db, SCHOOL, rows[0].id, { to_class_id: s.c7.id }, 'admin-1')).rejects.toThrow('already reversed or superseded');
    // Undo AFTER an edit restores the PRE-BATCH state (5-A), never the
    // intermediate 6-A the edit superseded. (Regression: the first undo
    // implementation only inverted the latest row and left Ali in 6-A —
    // caught on real Postgres, not by the fake DB.)
    const undone = await svc.undoPromotion(db, SCHOOL, res.batch_id, 'admin-1');
    expect(undone.reversed).toBe(3);
    expect((await student(db, s.ali.id)).classId).toBe(s.c5.id);
    expect((await student(db, s.ali.id)).rollNo).toBe(1);
    expect((await student(db, s.bina.id)).classId).toBe(s.c5.id);
  });

  it('partial promotion: selected students move, one is held, and left/struck-off students are skipped with reasons', async () => {
    const session = await makeSession(db);
    const res = await svc.applyPromotion(db, SCHOOL, session.id as string, {
      mappings: [
        { student_id: s.ali.id, to_class_id: s.c6.id },
        { student_id: s.bina.id, outcome: 'held' },
        { student_id: s.left.id, to_class_id: s.c6.id },
        { student_id: s.struck.id, to_class_id: s.c6.id },
      ],
    }, 'admin-1');
    expect(res.promoted).toBe(1);
    expect(res.graduated).toBe(0);
    expect(res.held).toBe(1);
    expect(res.skipped).toHaveLength(2);
    expect(res.skipped.map((x) => x.reason).join(' ')).toMatch(/left/);
    expect(res.skipped.map((x) => x.reason).join(' ')).toMatch(/struck_off/);
    expect((await student(db, s.ali.id)).classId).toBe(s.c6.id);
    expect((await student(db, s.bina.id)).classId).toBe(s.c5.id); // held: stays put
    expect((await student(db, s.bina.id)).status).toBe('active');
    expect((await student(db, s.left.id)).classId).toBe(s.c5.id);
    expect((await student(db, s.left.id)).status).toBe('left');
    expect((await student(db, s.struck.id)).classId).toBe(s.c5.id);
    const heldRow = await (db as any).promotion.findFirst({ where: { studentId: s.bina.id } });
    expect(heldRow.outcome).toBe('held');
    expect(heldRow.status).toBe('applied');
    // Whole-class call with an explicit selection behaves the same way.
    // (Session 2 is new, so Bina has no live promotion there — she moves;
    // the left student is skipped again, with a reason.)
    const session2 = await makeSession(db, '2027-28');
    const res2 = await svc.promoteClassSection(db, SCHOOL, session2.id as string, {
      from_class_id: s.c5.id, to_class_id: s.c6.id, student_ids: [s.bina.id, s.left.id],
    }, 'admin-1');
    expect(res2.promoted).toBe(1);
    expect(res2.skipped).toHaveLength(1);
    expect(res2.skipped[0].reason).toMatch(/left/);
    expect((await student(db, s.bina.id)).classId).toBe(s.c6.id);
  });

  it('highest class: graduating the top class sets graduated status and never invents a target class', async () => {
    const session = await makeSession(db);
    const preview = await svc.previewPromotion(db, SCHOOL, session.id as string, {
      mappings: [{ student_id: s.topper.id, outcome: 'graduated' }],
    });
    expect(preview.rows[0].outcome).toBe('graduated');
    expect(preview.rows[0].to_class_id).toBe(s.c10.id);
    const res = await svc.promoteClassSection(db, SCHOOL, session.id as string, { from_class_id: s.c10.id, outcome: 'graduated' }, 'admin-1');
    expect(res.graduated).toBe(1);
    expect(res.promoted).toBe(0);
    const top = await student(db, s.topper.id);
    expect(top.status).toBe('graduated');
    expect(top.classId).toBe(s.c10.id); // still 10-A; no invented target
    // Graduated students are never promoted again.
    const again = await svc.previewPromotion(db, SCHOOL, session.id as string, {
      mappings: [{ student_id: s.topper.id, to_class_id: s.c6.id }],
    });
    expect(again.rows[0].status).toBe('skipped');
    expect(again.rows[0].skip_reason).toMatch(/graduated/);
    // …but graduating can be undone: status returns to active.
    const undone = await svc.undoPromotion(db, SCHOOL, res.batch_id, 'admin-1');
    expect(undone.reversed).toBe(1);
    expect((await student(db, s.topper.id)).status).toBe('active');
  });

  it('preview: shows target rolls and skip reasons without changing anything', async () => {
    const session = await makeSession(db);
    const preview = await svc.previewPromotion(db, SCHOOL, session.id as string, {
      mappings: [
        { student_id: s.ali.id, to_class_id: s.c6.id },
        { student_id: s.bina.id, to_class_id: s.c6.id },
        { student_id: s.left.id, to_class_id: s.c6.id },
      ],
    });
    expect(preview.ready).toBe(2);
    expect(preview.skipped).toBe(1);
    expect(preview.rows.find((r) => r.student_id === s.ali.id)?.roll_no_to).toBe(2);
    expect(preview.rows.find((r) => r.student_id === s.bina.id)?.roll_no_to).toBe(3);
    expect(preview.rows.find((r) => r.student_id === s.left.id)?.skip_reason).toMatch(/left/);
    expect((await student(db, s.ali.id)).classId).toBe(s.c5.id); // nothing moved
    expect((db as any).promotion.count({})).toBe(0);
  });

  it('double promotion in one session is refused and duplicate mappings are rejected', async () => {
    const session = await makeSession(db);
    await svc.applyPromotion(db, SCHOOL, session.id as string, { mappings: [{ student_id: s.ali.id, to_class_id: s.c6.id }] }, 'admin-1');
    const second = await svc.previewPromotion(db, SCHOOL, session.id as string, {
      mappings: [{ student_id: s.ali.id, to_class_id: s.c7.id }],
    });
    expect(second.rows[0].status).toBe('skipped');
    expect(second.rows[0].skip_reason).toMatch(/already has an applied promotion/);
    await expect(svc.applyPromotion(db, SCHOOL, session.id as string, {
      mappings: [{ student_id: s.ali.id, to_class_id: s.c7.id }],
    }, 'admin-1')).rejects.toThrow('Nothing to promote');
    await expect(svc.applyPromotion(db, SCHOOL, session.id as string, {
      mappings: [
        { student_id: s.bina.id, to_class_id: s.c6.id },
        { student_id: s.bina.id, to_class_id: s.c7.id },
      ],
    }, 'admin-1')).rejects.toThrow('Duplicate student');
  });

  it('admin.promoteStudents delegate enforces the same rules (left students are never moved)', async () => {
    const session = await makeSession(db);
    await expect(adminSvc.promoteStudents(db, SCHOOL, {
      session_id: session.id as string,
      mappings: [{ student_id: s.left.id, to_class_id: s.c6.id }],
    }, 'admin-1')).rejects.toThrow('Nothing to promote');
    expect((await student(db, s.left.id)).classId).toBe(s.c5.id);
    const res = await adminSvc.promoteStudents(db, SCHOOL, {
      session_id: session.id as string,
      mappings: [{ student_id: s.ali.id, to_class_id: s.c6.id }],
    }, 'admin-1');
    expect(res.promoted).toBe(1);
    expect((await student(db, s.ali.id)).rollNo).toBe(2); // collision-free via delegate too
  });

  it('undo is blocked when a student has moved on since — and then nothing is reversed', async () => {
    const session = await makeSession(db);
    const res = await svc.promoteClassSection(db, SCHOOL, session.id as string, { from_class_id: s.c5.id, to_class_id: s.c6.id }, 'admin-1');
    // Out-of-band move (e.g. direct student edit) after the promotion.
    await (db as any).student.update({ where: { id: s.ali.id }, data: { classId: s.c7.id } });
    await expect(svc.undoPromotion(db, SCHOOL, res.batch_id, 'admin-1')).rejects.toThrow('has moved to a different class');
    // Atomic: Bina was NOT reversed either.
    expect((await student(db, s.bina.id)).classId).toBe(s.c6.id);
    const rows = await (db as any).promotion.findMany({ where: { batchId: res.batch_id } });
    expect(rows.every((r: any) => r.status === 'applied')).toBe(true);
  });

  it('cross-tenant: another school cannot preview, apply, or undo our promotion', async () => {
    const session = await makeSession(db);
    await expect(svc.previewPromotion(db, OTHER, session.id as string, {
      mappings: [{ student_id: s.ali.id, to_class_id: s.c6.id }],
    })).rejects.toThrow('Session not found');
    await expect(svc.applyPromotion(db, OTHER, session.id as string, {
      mappings: [{ student_id: s.ali.id, to_class_id: s.c6.id }],
    }, 'admin-2')).rejects.toThrow('Session not found');
    const res = await svc.promoteClassSection(db, SCHOOL, session.id as string, { from_class_id: s.c5.id, to_class_id: s.c6.id }, 'admin-1');
    await expect(svc.undoPromotion(db, OTHER, res.batch_id, 'admin-2')).rejects.toThrow('not found');
    expect((await student(db, s.ali.id)).classId).toBe(s.c6.id); // untouched
  });

  it('promotion batches list groups one decision with its undo state', async () => {
    const session = await makeSession(db);
    const res = await svc.promoteClassSection(db, SCHOOL, session.id as string, { from_class_id: s.c5.id, to_class_id: s.c6.id }, 'admin-1');
    const batches = await svc.listPromotionBatches(db, SCHOOL, session.id as string);
    expect(batches).toHaveLength(1);
    expect(batches[0].batch_id).toBe(res.batch_id);
    expect(batches[0].students).toBe(3);
    expect(batches[0].status).toBe('applied');
    await svc.undoPromotion(db, SCHOOL, res.batch_id, 'admin-1');
    const after = await svc.listPromotionBatches(db, SCHOOL, session.id as string);
    expect(after[0].status).toBe('reversed');
  });
});
