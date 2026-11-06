// Timetable (6C-1) tests — conflict detection, class/teacher views,
// cross-tenant 404s.
import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../../../lib/db';
import { FakeDb, seed6C1, OTHER_SCHOOL_ID } from '../../sessions/__tests__/fake-db';
import * as svc from '../service';
import * as staffSvc from '../../staff/service';

function fresh(): { db: Db; schoolId: string; classAId: string; classBId: string } {
  const fake = new FakeDb();
  const seed = seed6C1(fake);
  return { db: fake as unknown as Db, schoolId: seed.schoolId, classAId: seed.classAId, classBId: seed.classBId };
}

async function makeTeacher(db: Db, schoolId: string, name: string) {
  return staffSvc.createStaff(db, schoolId, { name, role: 'teacher', subjects: ['Math'] }, 'admin-1');
}

describe('timetable conflicts', () => {
  let db: Db;
  let schoolId: string;
  let classAId: string;
  let classBId: string;
  let teacherId: string;
  beforeEach(async () => {
    ({ db, schoolId, classAId, classBId } = fresh());
    const t = await makeTeacher(db, schoolId, 'Ayesha Khan');
    teacherId = t.id as string;
  });

  it('creates an entry and rejects a double-booked class slot (same day + period)', async () => {
    const e = await svc.createTimetableEntry(db, schoolId, { class_id: classAId, teacher_id: teacherId, day_of_week: 1, period_no: 1, subject: 'Math', start_time: '08:00', end_time: '08:45' }, 'admin-1');
    expect(e.day_name).toBe('Monday');
    expect(e.class_name).toBe('5-A');
    await expect(svc.createTimetableEntry(db, schoolId, { class_id: classAId, teacher_id: null, day_of_week: 1, period_no: 1, subject: 'English', start_time: '09:00', end_time: '09:45' }, 'admin-1')).rejects.toThrow('already has a lesson in period 1');
  });

  it('rejects the same teacher in two places at once (same period, other class)', async () => {
    await svc.createTimetableEntry(db, schoolId, { class_id: classAId, teacher_id: teacherId, day_of_week: 2, period_no: 2, subject: 'Math', start_time: '09:00', end_time: '09:45' }, 'admin-1');
    await expect(svc.createTimetableEntry(db, schoolId, { class_id: classBId, teacher_id: teacherId, day_of_week: 2, period_no: 2, subject: 'Science', start_time: '09:00', end_time: '09:45' }, 'admin-1')).rejects.toThrow('already teaching');
  });

  it('rejects the same teacher with overlapping times under a different period number', async () => {
    await svc.createTimetableEntry(db, schoolId, { class_id: classAId, teacher_id: teacherId, day_of_week: 3, period_no: 1, subject: 'Math', start_time: '08:00', end_time: '09:00' }, 'admin-1');
    await expect(svc.createTimetableEntry(db, schoolId, { class_id: classBId, teacher_id: teacherId, day_of_week: 3, period_no: 2, subject: 'Science', start_time: '08:30', end_time: '09:15' }, 'admin-1')).rejects.toThrow('already teaching');
    // Adjacent (non-overlapping) time in another class is fine.
    const ok = await svc.createTimetableEntry(db, schoolId, { class_id: classBId, teacher_id: teacherId, day_of_week: 3, period_no: 2, subject: 'Science', start_time: '09:00', end_time: '09:45' }, 'admin-1');
    expect(ok.subject).toBe('Science');
  });

  it('rejects overlapping times for the same class and invalid times/days', async () => {
    await svc.createTimetableEntry(db, schoolId, { class_id: classAId, teacher_id: null, day_of_week: 4, period_no: 1, subject: 'Math', start_time: '08:00', end_time: '08:45' }, 'admin-1');
    await expect(svc.createTimetableEntry(db, schoolId, { class_id: classAId, teacher_id: null, day_of_week: 4, period_no: 2, subject: 'English', start_time: '08:30', end_time: '09:15' }, 'admin-1')).rejects.toThrow('overlapping');
    await expect(svc.createTimetableEntry(db, schoolId, { class_id: classAId, teacher_id: null, day_of_week: 7, period_no: 1, subject: 'X', start_time: '08:00', end_time: '08:45' }, 'admin-1')).rejects.toThrow('day_of_week must be 0–6');
    await expect(svc.createTimetableEntry(db, schoolId, { class_id: classAId, teacher_id: null, day_of_week: 4, period_no: 3, subject: 'X', start_time: '10:00', end_time: '09:00' }, 'admin-1')).rejects.toThrow('start_time must be before end_time');
  });

  it('update re-checks conflicts (excluding itself) and delete removes the entry', async () => {
    const a = await svc.createTimetableEntry(db, schoolId, { class_id: classAId, teacher_id: teacherId, day_of_week: 1, period_no: 1, subject: 'Math', start_time: '08:00', end_time: '08:45' }, 'admin-1');
    const b = await svc.createTimetableEntry(db, schoolId, { class_id: classAId, teacher_id: null, day_of_week: 1, period_no: 2, subject: 'English', start_time: '09:00', end_time: '09:45' }, 'admin-1');
    await expect(svc.updateTimetableEntry(db, schoolId, b.id as string, { period_no: 1 }, 'admin-1')).rejects.toThrow('already has a lesson');
    // Teacher conflict on update: an entry in the OTHER class overlapping
    // the teacher's Math lesson must 409 as "already teaching".
    const c = await svc.createTimetableEntry(db, schoolId, { class_id: classBId, teacher_id: null, day_of_week: 1, period_no: 3, subject: 'Science', start_time: '10:00', end_time: '10:45' }, 'admin-1');
    await expect(svc.updateTimetableEntry(db, schoolId, c.id as string, { teacher_id: teacherId, start_time: '08:30', end_time: '09:15' }, 'admin-1')).rejects.toThrow('already teaching');
    const moved = await svc.updateTimetableEntry(db, schoolId, b.id as string, { subject: 'Urdu' }, 'admin-1');
    expect(moved.subject).toBe('Urdu');
    await svc.deleteTimetableEntry(db, schoolId, a.id as string, 'admin-1');
    const list = await svc.listTimetable(db, schoolId, { class_id: classAId });
    expect(list.total).toBe(1);
  });

  it('non-teacher staff cannot be put on the timetable', async () => {
    const clerk = await staffSvc.createStaff(db, schoolId, { name: 'Office Clerk', role: 'staff' }, 'admin-1');
    await expect(svc.createTimetableEntry(db, schoolId, { class_id: classAId, teacher_id: clerk.id as string, day_of_week: 1, period_no: 1, subject: 'Math', start_time: '08:00', end_time: '08:45' }, 'admin-1')).rejects.toThrow('Only staff with role "teacher"');
  });
});

describe('timetable views', () => {
  let db: Db;
  let schoolId: string;
  let classAId: string;
  let teacherId: string;
  beforeEach(async () => {
    ({ db, schoolId, classAId } = fresh());
    const t = await makeTeacher(db, schoolId, 'Ayesha Khan');
    teacherId = t.id as string;
    await svc.createTimetableEntry(db, schoolId, { class_id: classAId, teacher_id: teacherId, day_of_week: 1, period_no: 1, subject: 'Math', start_time: '08:00', end_time: '08:45' }, 'admin-1');
    await svc.createTimetableEntry(db, schoolId, { class_id: classAId, teacher_id: teacherId, day_of_week: 1, period_no: 2, subject: 'English', start_time: '09:00', end_time: '09:45' }, 'admin-1');
    await svc.createTimetableEntry(db, schoolId, { class_id: classAId, teacher_id: null, day_of_week: 3, period_no: 1, subject: 'Science', start_time: '08:00', end_time: '08:45' }, 'admin-1');
  });

  it('class-wise view groups by day with periods ascending', async () => {
    const view = await svc.getClassTimetable(db, schoolId, classAId);
    expect(view.class_name).toBe('5-A');
    expect((view.by_day as any)['1']).toHaveLength(2);
    expect(((view.by_day as any)['1'] as any[])[0].subject).toBe('Math');
    expect((view.by_day as any)['3']).toHaveLength(1);
    expect((view.by_day as any)['0']).toHaveLength(0);
  });

  it('teacher-wise view shows only that teacher’s lessons', async () => {
    const view = await svc.getTeacherTimetable(db, schoolId, teacherId);
    expect(view.teacher_name).toBe('Ayesha Khan');
    expect((view.entries as any[])).toHaveLength(2);
    expect((view.by_day as any)['3']).toHaveLength(0);
  });

  it('list filters by class, teacher, and day', async () => {
    expect((await svc.listTimetable(db, schoolId, { teacher_id: teacherId })).total).toBe(2);
    expect((await svc.listTimetable(db, schoolId, { day: '3' })).total).toBe(1);
    expect((await svc.listTimetable(db, schoolId, { day: '5' })).total).toBe(0);
  });
});

describe('timetable cross-tenant isolation', () => {
  let db: Db;
  let schoolId: string;
  let classAId: string;
  beforeEach(() => {
    ({ db, schoolId, classAId } = fresh());
  });

  it('another school cannot create, read, update, or delete our entries (404)', async () => {
    const e = await svc.createTimetableEntry(db, schoolId, { class_id: classAId, teacher_id: null, day_of_week: 1, period_no: 1, subject: 'Math', start_time: '08:00', end_time: '08:45' }, 'admin-1');
    await expect(svc.createTimetableEntry(db, OTHER_SCHOOL_ID, { class_id: classAId, teacher_id: null, day_of_week: 2, period_no: 1, subject: 'X', start_time: '08:00', end_time: '08:45' }, 'admin-2')).rejects.toThrow('Class not found');
    await expect(svc.updateTimetableEntry(db, OTHER_SCHOOL_ID, e.id as string, { subject: 'Hijack' }, 'admin-2')).rejects.toThrow('Timetable entry not found');
    await expect(svc.deleteTimetableEntry(db, OTHER_SCHOOL_ID, e.id as string, 'admin-2')).rejects.toThrow('Timetable entry not found');
    await expect(svc.getClassTimetable(db, OTHER_SCHOOL_ID, classAId)).rejects.toThrow('Class not found');
    expect((await svc.listTimetable(db, OTHER_SCHOOL_ID, {})).total).toBe(0);
  });
});
