// Exams, datesheets & grading scales (6C-1) tests.
import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../../../lib/db';
import { FakeDb, seed6C1, OTHER_SCHOOL_ID } from '../../sessions/__tests__/fake-db';
import * as svc from '../service';
import * as sessionsSvc from '../../sessions/service';

function fresh(): { db: Db; schoolId: string; classAId: string; classBId: string } {
  const fake = new FakeDb();
  const seed = seed6C1(fake);
  return { db: fake as unknown as Db, schoolId: seed.schoolId, classAId: seed.classAId, classBId: seed.classBId };
}

async function makeSession(db: Db, schoolId: string) {
  return sessionsSvc.createSession(db, schoolId, { name: '2026-27', start_date: '2026-04-01', end_date: '2027-03-31' }, 'admin-1');
}

describe('exams CRUD', () => {
  let db: Db;
  const schoolId = 'school-6c1';
  beforeEach(() => {
    ({ db } = fresh());
  });

  it('creates an exam with and without a session; rejects bad dates and foreign sessions', async () => {
    const s = await makeSession(db, schoolId);
    const withSession = await svc.createExam(db, schoolId, { name: 'Midterm', session_id: s.id as string, start_date: '2026-09-01', end_date: '2026-09-10' }, 'admin-1');
    expect(withSession.session_id).toBe(s.id);
    const monthly = await svc.createExam(db, schoolId, { name: 'Monthly Test — Sep' }, 'admin-1');
    expect(monthly.session_id).toBeNull();
    await expect(svc.createExam(db, schoolId, { name: 'Bad', start_date: '2026-09-10', end_date: '2026-09-01' }, 'admin-1')).rejects.toThrow('start_date must be on or before end_date');
    await expect(svc.createExam(db, schoolId, { name: 'Foreign', session_id: 'no-such-session' }, 'admin-1')).rejects.toThrow('Session not found');
  });

  it('update writes change logs; delete soft-deletes (hidden from lists)', async () => {
    const e = await svc.createExam(db, schoolId, { name: 'Midterm' }, 'admin-1');
    const updated = await svc.updateExam(db, schoolId, e.id as string, { name: 'Midterm Exams' }, 'admin-1');
    expect(updated.name).toBe('Midterm Exams');
    const logs = (db as any).changeLog.findMany({ where: { entity: 'exam', entityId: e.id } });
    expect(logs.some((l: any) => l.field === 'name' && l.oldValue === 'Midterm')).toBe(true);
    await svc.deleteExam(db, schoolId, e.id as string, 'admin-1');
    const list = await svc.listExams(db, schoolId, {});
    expect(list.items.map((x: any) => x.id)).not.toContain(e.id);
    const bin = (db as any).deletedRecord.findMany({ where: { entity: 'exam', entityId: e.id } });
    expect(bin).toHaveLength(1);
    await expect(svc.getExam(db, schoolId, e.id as string)).rejects.toThrow('Exam not found');
  });

  it('exams of an archived session are excluded from the default list but visible by session_id', async () => {
    const s = await makeSession(db, schoolId);
    const e = await svc.createExam(db, schoolId, { name: 'Midterm', session_id: s.id as string }, 'admin-1');
    await sessionsSvc.archiveSession(db, schoolId, s.id as string, 'admin-1');
    const def = await svc.listExams(db, schoolId, {});
    expect(def.items.map((x: any) => x.id)).not.toContain(e.id);
    const bySession = await svc.listExams(db, schoolId, { session_id: s.id });
    expect(bySession.items.map((x: any) => x.id)).toContain(e.id);
    // And no new exam can be created in the archived session.
    await expect(svc.createExam(db, schoolId, { name: 'Final', session_id: s.id as string }, 'admin-1')).rejects.toThrow('archived');
  });
});

describe('datesheets', () => {
  let db: Db;
  let schoolId: string;
  let classAId: string;
  let examId: string;
  beforeEach(async () => {
    ({ db, schoolId, classAId } = fresh());
    const e = await svc.createExam(db, schoolId, { name: 'Midterm' }, 'admin-1');
    examId = e.id as string;
  });

  it('creates a paper and rejects duplicate subject/date and overlapping times', async () => {
    const first = await svc.createDatesheet(db, schoolId, examId, { class_id: classAId, subject: 'Math', date: '2026-09-01', start_time: '09:00', end_time: '10:30' }, 'admin-1');
    expect(first.subject).toBe('Math');
    await expect(svc.createDatesheet(db, schoolId, examId, { class_id: classAId, subject: 'math', date: '2026-09-01', start_time: '11:00', end_time: '12:00' }, 'admin-1')).rejects.toThrow('already scheduled');
    await expect(svc.createDatesheet(db, schoolId, examId, { class_id: classAId, subject: 'English', date: '2026-09-01', start_time: '10:00', end_time: '11:00' }, 'admin-1')).rejects.toThrow('overlaps');
    const ok = await svc.createDatesheet(db, schoolId, examId, { class_id: classAId, subject: 'English', date: '2026-09-01', start_time: '11:00', end_time: '12:00' }, 'admin-1');
    expect(ok.subject).toBe('English');
    await expect(svc.createDatesheet(db, schoolId, examId, { class_id: classAId, subject: 'Urdu', date: '2026-09-02', start_time: '12:00', end_time: '11:00' }, 'admin-1')).rejects.toThrow('start_time must be before end_time');
    const list = await svc.listDatesheet(db, schoolId, examId, {});
    expect(list.total).toBe(2);
  });

  it('update re-checks overlaps and delete removes the entry', async () => {
    const m = await svc.createDatesheet(db, schoolId, examId, { class_id: classAId, subject: 'Math', date: '2026-09-01', start_time: '09:00', end_time: '10:00' }, 'admin-1');
    await svc.createDatesheet(db, schoolId, examId, { class_id: classAId, subject: 'English', date: '2026-09-01', start_time: '11:00', end_time: '12:00' }, 'admin-1');
    await expect(svc.updateDatesheet(db, schoolId, m.id as string, { start_time: '10:30', end_time: '11:30' }, 'admin-1')).rejects.toThrow('overlaps');
    const moved = await svc.updateDatesheet(db, schoolId, m.id as string, { date: '2026-09-02' }, 'admin-1');
    expect(moved.date).toBe('2026-09-02');
    await svc.deleteDatesheet(db, schoolId, m.id as string, 'admin-1');
    const list = await svc.listDatesheet(db, schoolId, examId, {});
    expect(list.total).toBe(1);
  });
});

describe('grading scales + passing marks', () => {
  let db: Db;
  let schoolId: string;
  let classAId: string;
  beforeEach(() => {
    ({ db, schoolId, classAId } = fresh());
  });

  it('seed-defaults creates A+..F and passing marks is 50', async () => {
    const bands = await svc.seedDefaultGradingScales(db, schoolId, 'admin-1');
    expect(bands).toHaveLength(6);
    expect(bands.map((b: any) => b.grade)).toEqual(['A+', 'A', 'B', 'C', 'D', 'F']);
    const passing = await svc.getPassingMarks(db, schoolId, null);
    expect(passing).toEqual({ passing_marks: 50, grade: 'D', source: 'school-default' });
    await expect(svc.seedDefaultGradingScales(db, schoolId, 'admin-1')).rejects.toThrow('already exists');
  });

  it('overlapping bands are rejected in the same scope', async () => {
    await svc.createGradingScale(db, schoolId, { class_id: null, min_marks: 80, max_marks: 100, grade: 'A', gpa_points: 4 }, 'admin-1');
    await expect(svc.createGradingScale(db, schoolId, { class_id: null, min_marks: 90, max_marks: 95, grade: 'A+', gpa_points: 4 }, 'admin-1')).rejects.toThrow('overlaps');
    await expect(svc.createGradingScale(db, schoolId, { class_id: null, min_marks: 50, max_marks: 50, grade: 'X', gpa_points: 1 }, 'admin-1')).rejects.toThrow('greater than min_marks');
    // Same range in a different (class) scope is fine.
    const classBand = await svc.createGradingScale(db, schoolId, { class_id: classAId, min_marks: 80, max_marks: 100, grade: 'A', gpa_points: 4 }, 'admin-1');
    expect(classBand.class_id).toBe(classAId);
  });

  it('class override wins for passing marks; no bands means null', async () => {
    const none = await svc.getPassingMarks(db, schoolId, classAId);
    expect(none.passing_marks).toBeNull();
    await svc.seedDefaultGradingScales(db, schoolId, 'admin-1');
    await svc.createGradingScale(db, schoolId, { class_id: classAId, min_marks: 40, max_marks: 59, grade: 'D', gpa_points: 1, is_passing: true }, 'admin-1');
    await svc.createGradingScale(db, schoolId, { class_id: classAId, min_marks: 0, max_marks: 39, grade: 'F', gpa_points: 0, is_passing: false }, 'admin-1');
    const passing = await svc.getPassingMarks(db, schoolId, classAId);
    expect(passing).toEqual({ passing_marks: 40, grade: 'D', source: 'class' });
    // The school default still applies to other classes.
    const other = await svc.getPassingMarks(db, schoolId, null);
    expect(other.passing_marks).toBe(50);
  });

  it('update re-checks overlap and delete removes the band', async () => {
    const a = await svc.createGradingScale(db, schoolId, { class_id: null, min_marks: 80, max_marks: 100, grade: 'A', gpa_points: 4 }, 'admin-1');
    const b = await svc.createGradingScale(db, schoolId, { class_id: null, min_marks: 0, max_marks: 49, grade: 'F', gpa_points: 0, is_passing: false }, 'admin-1');
    await expect(svc.updateGradingScale(db, schoolId, b.id as string, { max_marks: 85 }, 'admin-1')).rejects.toThrow('overlaps');
    const updated = await svc.updateGradingScale(db, schoolId, b.id as string, { grade: 'Fail' }, 'admin-1');
    expect(updated.grade).toBe('Fail');
    await svc.deleteGradingScale(db, schoolId, a.id as string, 'admin-1');
    expect(await svc.listGradingScales(db, schoolId, {})).toHaveLength(1);
  });
});

describe('exams cross-tenant isolation', () => {
  let db: Db;
  const schoolId = 'school-6c1';
  beforeEach(() => {
    ({ db } = fresh());
  });

  it('another school cannot read/update/delete our exam, datesheet, or grading scale (404)', async () => {
    const e = await svc.createExam(db, schoolId, { name: 'Midterm' }, 'admin-1');
    const d = await svc.createDatesheet(db, schoolId, e.id as string, { class_id: 'class-5a', subject: 'Math', date: '2026-09-01', start_time: '09:00', end_time: '10:00' }, 'admin-1');
    const g = await svc.createGradingScale(db, schoolId, { class_id: null, min_marks: 80, max_marks: 100, grade: 'A', gpa_points: 4 }, 'admin-1');
    await expect(svc.getExam(db, OTHER_SCHOOL_ID, e.id as string)).rejects.toThrow('Exam not found');
    await expect(svc.updateExam(db, OTHER_SCHOOL_ID, e.id as string, { name: 'Hijack' }, 'admin-2')).rejects.toThrow('Exam not found');
    await expect(svc.deleteExam(db, OTHER_SCHOOL_ID, e.id as string, 'admin-2')).rejects.toThrow('Exam not found');
    await expect(svc.createDatesheet(db, OTHER_SCHOOL_ID, e.id as string, { class_id: 'class-5a', subject: 'X', date: '2026-09-02', start_time: '09:00', end_time: '10:00' }, 'admin-2')).rejects.toThrow('Exam not found');
    await expect(svc.updateDatesheet(db, OTHER_SCHOOL_ID, d.id as string, { subject: 'Hijack' }, 'admin-2')).rejects.toThrow('Datesheet entry not found');
    await expect(svc.updateGradingScale(db, OTHER_SCHOOL_ID, g.id as string, { grade: 'Hijack' }, 'admin-2')).rejects.toThrow('Grading scale not found');
    await expect(svc.deleteGradingScale(db, OTHER_SCHOOL_ID, g.id as string, 'admin-2')).rejects.toThrow('Grading scale not found');
    // Nothing was touched.
    expect((await svc.getExam(db, schoolId, e.id as string)).name).toBe('Midterm');
    expect((await svc.listExams(db, OTHER_SCHOOL_ID, {})).total).toBe(0);
  });
});
