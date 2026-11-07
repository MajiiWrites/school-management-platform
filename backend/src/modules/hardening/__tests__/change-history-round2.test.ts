/**
 * Round 2 (R2-A) Change History tests.
 *
 * Regression coverage for the live re-test findings (7 Nov 2026):
 *  (1) WHO showed generic "user —" — listChangeHistory must resolve the
 *      actor id to the admin's email, and every mutation must actually
 *      carry the actor id (fee structures previously logged actor NULL).
 *  (2) Only ONE change was logged for a whole session of edits — creates,
 *      deletes and restores previously wrote audit_logs only, never
 *      change_logs. Every create/delete/restore must now log.
 *
 * Uses the shared sessions fake-db (FakeDb/FakeCollection), extended with
 * the collections the exercised services touch.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FakeDb, FakeCollection } from '../../sessions/__tests__/fake-db';
import * as classesSvc from '../../classes/service';
import * as studentsSvc from '../../students/service';
import * as sessionsSvc from '../../sessions/service';
import * as staffSvc from '../../staff/service';
import * as feesSvc from '../../fees/service';
import * as adminSvc from '../../admin/service';
import * as recycleBin from '../recycleBin';
import * as hardeningSvc from '../service';
import { writeChangeLogs } from '../helpers';

const SCHOOL = 'school-r2a';
const ADMIN_ID = 'admin-r2a';
const ADMIN_EMAIL = 'admin@r2a.school.pk';
const CLASS_ID = 'class-r2a';

function freshDb(): any {
  const db = new FakeDb() as any;
  // Collections the sessions fake-db does not carry but these services use.
  for (const name of ['feeStructure', 'event', 'announcement', 'expense', 'certificate', 'result', 'resultSheet', 'attendanceDay', 'attendanceRecord', 'messageTemplate', 'messageQueue', 'feeVoucher', 'schoolBackup', 'deletedRecord']) {
    if (!db[name]) db[name] = new FakeCollection();
  }
  db.school.create({ data: { id: SCHOOL, name: 'R2A Test School', slug: 'r2a-test-school', timezone: 'Asia/Karachi', country: 'PK', settings: {} } });
  db.user.create({ data: { id: ADMIN_ID, schoolId: SCHOOL, email: ADMIN_EMAIL, passwordHash: 'x', role: 'admin', emailVerified: true } });
  db.class.create({ data: { id: CLASS_ID, schoolId: SCHOOL, name: '5', section: 'A', teacherName: 'Ayesha Khan', teacherPhoneEnc: null, teacherPhoneHash: null, deletedAt: null } });
  return db;
}

describe('change history round 2 — actor', () => {
  let db: any;
  beforeEach(() => { db = freshDb(); });

  it('an edit logs with the correct actor email (not a bare id)', async () => {
    const klass = await classesSvc.createClass(db, SCHOOL, { name: '6', section: 'B', teacher_name: 'Bilal', teacher_phone: '03001112233' }, ADMIN_ID);
    await classesSvc.updateClass(db, SCHOOL, klass.id, { section: 'C' }, ADMIN_ID);
    const logs = await hardeningSvc.listChangeHistory(db, SCHOOL, { entity: 'class', entity_id: klass.id });
    expect(logs.total).toBeGreaterThan(0);
    for (const row of logs.items) {
      expect(row.actor_id).toBe(ADMIN_ID);
      expect(row.actor_email).toBe(ADMIN_EMAIL);
    }
    const section = logs.items.find((r: any) => r.field === 'section' && r.old_value === 'B');
    expect(section).toMatchObject({ old_value: 'B', new_value: 'C' });
  });

  it('a row whose actor no longer exists resolves to a null email, not a crash', async () => {
    await writeChangeLogs(db, {
      schoolId: SCHOOL,
      actorId: 'deleted-user-id',
      entity: 'class',
      entityId: CLASS_ID,
      before: { section: 'A' },
      after: { section: 'B' },
    });
    const logs = await hardeningSvc.listChangeHistory(db, SCHOOL, { entity: 'class' });
    expect(logs.total).toBe(1);
    expect(logs.items[0].actor_email).toBeNull();
    expect(logs.items[0].actor_id).toBe('deleted-user-id');
  });
});

describe('change history round 2 — creates log', () => {
  let db: any;
  beforeEach(() => { db = freshDb(); });

  it('class / student / session / staff creates each log with the actor', async () => {
    const klass = await classesSvc.createClass(db, SCHOOL, { name: '7', section: 'A', teacher_name: 'T', teacher_phone: '03001112233' }, ADMIN_ID);
    expect(db.changeLog.rows.filter((r: any) => r.entity === 'class' && r.entityId === klass.id).length).toBeGreaterThan(0);
    const student = await studentsSvc.createStudent(db, SCHOOL, CLASS_ID, { name: 'Ahmed', roll_no: 1 }, ADMIN_ID);
    expect(db.changeLog.rows.filter((r: any) => r.entity === 'student' && r.entityId === student.id && r.field === 'name').map((r: any) => r.newValue)).toEqual(['Ahmed']);
    const session = await sessionsSvc.createSession(db, SCHOOL, { name: '2026-27', start_date: '2026-04-01', end_date: '2027-03-31' }, ADMIN_ID);
    expect(db.changeLog.rows.filter((r: any) => r.entity === 'academic_session' && r.entityId === session.id).length).toBeGreaterThan(0);
    const member = await staffSvc.createStaff(db, SCHOOL, { name: 'Sara', role: 'teacher' }, ADMIN_ID);
    expect(db.changeLog.rows.filter((r: any) => r.entity === 'staff' && r.entityId === member.id && r.field === 'name').map((r: any) => r.newValue)).toEqual(['Sara']);
    // Every row from these creates carries the acting admin.
    for (const r of db.changeLog.rows) expect(r.actorId).toBe(ADMIN_ID);
  });

  it('student import logs one create per imported student', async () => {
    const result = await studentsSvc.importStudents(db, SCHOOL, CLASS_ID, [
      { name: 'Imp One', roll_no: 11 },
      { name: 'Imp Two', roll_no: 12 },
    ] as any, ADMIN_ID);
    expect(result.imported).toBe(2);
    const names = db.changeLog.rows.filter((r: any) => r.entity === 'student' && r.field === 'name').map((r: any) => r.newValue);
    expect(names).toContain('Imp One');
    expect(names).toContain('Imp Two');
  });

  it('fee structure create/update/delete log with the actor (was NULL before)', async () => {
    const created = await feesSvc.createFeeStructure(db, SCHOOL, { class_id: CLASS_ID, monthly_amount: 3000, effective_from: '2027-01-01' }, undefined, ADMIN_ID);
    const createdRows = db.changeLog.rows.filter((r: any) => r.entity === 'fee_structure' && r.entityId === created.id);
    expect(createdRows.length).toBeGreaterThan(0);
    expect(createdRows.every((r: any) => r.actorId === ADMIN_ID)).toBe(true);
    await feesSvc.updateFeeStructure(db, SCHOOL, created.id, { monthly_amount: 3500 }, ADMIN_ID);
    const upd = db.changeLog.rows.find((r: any) => r.entity === 'fee_structure' && r.field === 'monthly_amount' && r.newValue === '3500');
    expect(upd).toBeTruthy();
    expect(upd.actorId).toBe(ADMIN_ID);
    await feesSvc.deleteFeeStructure(db, SCHOOL, created.id, ADMIN_ID);
    const del = db.changeLog.rows.find((r: any) => r.entity === 'fee_structure' && r.entityId === created.id && r.field === 'monthly_amount' && r.newValue === null);
    expect(del).toBeTruthy();
    expect(del.actorId).toBe(ADMIN_ID);
  });
});

describe('change history round 2 — delete / restore / multi-edit', () => {
  let db: any;
  beforeEach(() => { db = freshDb(); });

  it('delete logs deleted_at and restore logs it back to null', async () => {
    const student = await studentsSvc.createStudent(db, SCHOOL, CLASS_ID, { name: 'Hina', roll_no: 5 }, ADMIN_ID);
    await studentsSvc.deleteStudent(db, SCHOOL, student.id, ADMIN_ID);
    const del = db.changeLog.rows.find((r: any) => r.entity === 'student' && r.entityId === student.id && r.field === 'deleted_at');
    expect(del).toBeTruthy();
    expect(del.oldValue).toBeNull();
    expect(del.newValue).toBeTruthy();
    expect(del.actorId).toBe(ADMIN_ID);
    const bin = await recycleBin.listRecycleBin(db, SCHOOL, {});
    expect(bin.total).toBe(1);
    await recycleBin.restoreDeletedRecord(db, SCHOOL, bin.items[0].id, ADMIN_ID);
    const res = db.changeLog.rows.find((r: any) => r.entity === 'student' && r.entityId === student.id && r.field === 'deleted_at' && r.newValue === null);
    expect(res).toBeTruthy();
    expect(res.actorId).toBe(ADMIN_ID);
  });

  it('multiple edits in one session produce multiple entries', async () => {
    const student = await studentsSvc.createStudent(db, SCHOOL, CLASS_ID, { name: 'First', roll_no: 1 }, ADMIN_ID);
    const before = db.changeLog.rows.length;
    await studentsSvc.updateStudent(db, SCHOOL, student.id, { name: 'Second' }, ADMIN_ID);
    await studentsSvc.updateStudent(db, SCHOOL, student.id, { name: 'Third', status: 'left' }, ADMIN_ID);
    const otherClass = await classesSvc.createClass(db, SCHOOL, { name: '6', section: 'A', teacher_name: 'T', teacher_phone: '03001112233' }, ADMIN_ID);
    await studentsSvc.moveStudent(db, SCHOOL, student.id, otherClass.id, ADMIN_ID);
    const after = db.changeLog.rows.filter((r: any) => r.entity === 'student' && r.entityId === student.id);
    // create rows + name Second + name Third + status left (+ move only logs when class changes)
    expect(after.length - before).toBeGreaterThanOrEqual(3);
    const names = after.filter((r: any) => r.field === 'name').map((r: any) => r.newValue);
    expect(names).toContain('Second');
    expect(names).toContain('Third');
    expect(after.every((r: any) => r.actorId === ADMIN_ID)).toBe(true);
  });

  it('a holiday create/delete round trip logs both', async () => {
    const h = await adminSvc.createHoliday(db, SCHOOL, { date: '2026-12-25', name: 'Winter Break' }, ADMIN_ID);
    await adminSvc.deleteHoliday(db, SCHOOL, h.id, ADMIN_ID);
    const rows = db.changeLog.rows.filter((r: any) => r.entity === 'holiday' && r.entityId === h.id);
    expect(rows.some((r: any) => r.field === 'name' && r.newValue === 'Winter Break')).toBe(true);
    expect(rows.some((r: any) => r.field === 'name' && r.newValue === null)).toBe(true);
  });
});
