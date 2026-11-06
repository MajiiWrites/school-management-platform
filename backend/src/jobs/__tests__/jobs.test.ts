// Unit tests for the scheduler jobs (run with vitest).
// Calendar facts used: 2026-11-01 is a Sunday, 2026-11-02 a Monday,
// 2026-11-10 a Tuesday. School timezone is Asia/Karachi (UTC+5).
import { describe, expect, it, beforeEach } from 'vitest';
import type { Db } from '../../lib/db';
import { FakeDb, seedDemo, demoSchoolRow } from '../../modules/fees/__tests__/fake-db';
import { localDateString, isSunday, localMonthKey, weekdayOf } from '../date-utils';
import { renderTemplate } from '../templates';
import { runMonthlyFeeReminders, runFeeFollowup } from '../fee-reminders';
import { runDailyPendingAttendance } from '../pending-attendance';
import { runTeacherReminders } from '../teacher-reminders';
import { payFee, rolloverMonth } from '../../modules/fees/service';

function freshDb(): { db: Db; school: ReturnType<typeof demoSchoolRow> } {
  const fake = new FakeDb();
  seedDemo(fake);
  return { db: fake as unknown as Db, school: demoSchoolRow(fake) };
}

describe('date-utils', () => {
  it('computes school-local dates in Asia/Karachi', () => {
    // 03:00 UTC == 08:00 PKT.
    expect(localDateString(new Date('2026-11-02T03:00:00Z'), 'Asia/Karachi')).toBe('2026-11-02');
    expect(localMonthKey(new Date('2026-11-02T03:00:00Z'), 'Asia/Karachi')).toBe('2026-11');
    // 22:00 UTC on the 1st is already the 2nd in Karachi.
    expect(localDateString(new Date('2026-11-01T22:00:00Z'), 'Asia/Karachi')).toBe('2026-11-02');
  });

  it('detects Sundays', () => {
    expect(isSunday(new Date('2026-11-01T03:00:00Z'), 'Asia/Karachi')).toBe(true);
    expect(isSunday(new Date('2026-11-02T03:00:00Z'), 'Asia/Karachi')).toBe(false);
    expect(weekdayOf('2026-11-01', 'Asia/Karachi')).toBe('Sunday');
  });
});

describe('renderTemplate', () => {
  it('replaces known variables and reports missing ones', () => {
    const r = renderTemplate('Fee of {student_name} for {month} is {amount}.', {
      student_name: 'Ahmed',
      month: '2026-11',
      amount: 2500,
    });
    expect(r.body).toBe('Fee of Ahmed for 2026-11 is 2500.');
    expect(r.missing).toEqual([]);
    const r2 = renderTemplate('Hello {student_name}, {unknown} here.', { student_name: 'Ahmed' });
    expect(r2.body).toBe('Hello Ahmed, {unknown} here.');
    expect(r2.missing).toEqual(['unknown']);
  });
});

describe('runMonthlyFeeReminders', () => {
  it('runs on the first school day of the month (1st was a Sunday -> 2nd)', async () => {
    const { db, school } = freshDb();
    // 1 Nov 2026 is a Sunday: job must skip.
    const sunday = await runMonthlyFeeReminders(db, school, new Date('2026-11-01T03:00:00Z'));
    expect(sunday.ran).toBe(false);
    expect(sunday.reason).toBe('sunday');

    // 2 Nov 2026 (Monday, 08:00 PKT): runs.
    const monday = await runMonthlyFeeReminders(db, school, new Date('2026-11-02T03:00:00Z'));
    expect(monday.ran).toBe(true);
    expect(monday.created).toBe(3); // stu-1, stu-2, stu-5 (see counts below)
    expect(monday.skipped_no_phone).toBe(1); // stu-3
    expect(monday.skipped_opt_out).toBe(1); // stu-4
    expect(monday.skipped_paid).toBe(0);
    expect(monday.skipped_inactive).toBe(0); // stu-6 never got a record (left)
  });

  it('never reminds paid students, and a second run in the same month is a no-op', async () => {
    const { db, school } = freshDb();
    await rolloverMonth(db, 'school-demo', '2026-11');
    await payFee(db, 'school-demo', 'stu-1', { month: '2026-11', amount_paid: 2500 }, 'admin-1');
    await payFee(db, 'school-demo', 'stu-5', { month: '2026-11', amount_paid: 1000 }, 'admin-1'); // partial, still owes

    const first = await runMonthlyFeeReminders(db, school, new Date('2026-11-02T03:00:00Z'));
    expect(first.ran).toBe(true);
    expect(first.created).toBe(2); // stu-2 (unpaid) + stu-5 (partial, balance left)
    expect(first.skipped_paid).toBe(1); // stu-1
    expect(first.skipped_no_phone).toBe(1); // stu-3
    expect(first.skipped_opt_out).toBe(1); // stu-4

    const second = await runMonthlyFeeReminders(db, school, new Date('2026-11-02T10:00:00Z'));
    expect(second.ran).toBe(false);
    expect(second.reason).toBe('already-ran-this-month');

    // Queue rows carry the right dedupe keys and are held for approval (fee_auto_send=false).
    const fake = db as unknown as FakeDb;
    const rows = fake.messageQueue.rows.filter((r) => r.type === 'fee_reminder');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual(['fee:stu-2:2026-11', 'fee:stu-5:2026-11']);
    expect(rows.every((r) => r.approvedAt === null)).toBe(true);
    expect(rows.some((r) => r.body.includes('Sara Khan'))).toBe(true);
    expect(rows.some((r) => r.body.includes('2500'))).toBe(true); // stu-2 full balance
    expect(rows.some((r) => r.body.includes('1500'))).toBe(true); // stu-5 remaining balance
  });

  it('skips holidays and does nothing after the 3rd', async () => {
    const { db, school } = freshDb();
    const fake = db as unknown as FakeDb;
    fake.holiday.create({ data: { schoolId: school.id, date: new Date('2026-11-02T00:00:00Z'), name: 'Test Holiday' } });
    const res = await runMonthlyFeeReminders(db, school, new Date('2026-11-02T03:00:00Z'));
    expect(res.ran).toBe(false);
    expect(res.reason).toContain('holiday');

    const late = await runMonthlyFeeReminders(db, school, new Date('2026-11-04T03:00:00Z'));
    expect(late.ran).toBe(false);
    expect(late.reason).toBe('not-first-days-of-month');
  });
});

describe('runFeeFollowup', () => {
  it('reminds only students still unpaid on the follow-up day', async () => {
    const { db, school } = freshDb();
    await runMonthlyFeeReminders(db, school, new Date('2026-11-02T03:00:00Z'));
    // stu-2 pays in full before the 10th; stu-5 stays partial.
    await payFee(db, 'school-demo', 'stu-2', { month: '2026-11', amount_paid: 2500 }, 'admin-1');

    const followup = await runFeeFollowup(db, school, new Date('2026-11-10T03:00:00Z'));
    expect(followup.ran).toBe(true);
    expect(followup.created).toBe(2); // stu-1 (never paid) + stu-5 (partial)
    expect(followup.skipped_paid).toBe(1); // stu-2 paid in the meantime

    const fake = db as unknown as FakeDb;
    const fuRows = fake.messageQueue.rows.filter((r) => String(r.dedupeKey).endsWith(':followup'));
    expect(fuRows).toHaveLength(2);
    expect(fuRows.map((r) => r.dedupeKey).sort()).toEqual(['fee:stu-1:2026-11:followup', 'fee:stu-5:2026-11:followup']);

    const again = await runFeeFollowup(db, school, new Date('2026-11-10T06:00:00Z'));
    expect(again.ran).toBe(false);
    expect(again.reason).toBe('already-ran-this-month');
  });

  it('does nothing before the follow-up day or when disabled', async () => {
    const { db, school } = freshDb();
    const early = await runFeeFollowup(db, school, new Date('2026-11-05T03:00:00Z'));
    expect(early.ran).toBe(false);
    expect(early.reason).toBe('outside-followup-window');

    const fake = db as unknown as FakeDb;
    const schoolRow = fake.school.rows[0];
    schoolRow.settings = { ...schoolRow.settings, fee_followup_day: null };
    const disabled = await runFeeFollowup(db, { ...school, settings: schoolRow.settings }, new Date('2026-11-10T03:00:00Z'));
    expect(disabled.ran).toBe(false);
    expect(disabled.reason).toBe('followup-disabled');
  });
});

describe('runDailyPendingAttendance', () => {
  it('notifies only about classes with no submission, and only after check time', async () => {
    const { db, school } = freshDb();
    const fake = db as unknown as FakeDb;
    // Class 5-A submitted today; 6-B and 1-A did not.
    fake.attendanceDay.create({
      data: { schoolId: school.id, classId: 'class-5a', date: new Date('2026-11-06T00:00:00Z'), submittedBy: 'teacher_link', submittedAt: new Date() },
    });

    const tooEarly = await runDailyPendingAttendance(db, school, new Date('2026-11-06T09:00:00Z')); // 14:00 PKT
    expect(tooEarly.ran).toBe(false);
    expect(tooEarly.reason).toBe('too-early');

    const res = await runDailyPendingAttendance(db, school, new Date('2026-11-06T11:30:00Z')); // 16:30 PKT
    expect(res.ran).toBe(true);
    expect(res.pending_classes.map((c) => c.class_name).sort()).toEqual(['1-A', '6-B']);
    expect(res.notifications_created).toBe(2);

    // Second run same day: no duplicate notifications.
    const again = await runDailyPendingAttendance(db, school, new Date('2026-11-06T12:00:00Z'));
    expect(again.notifications_created).toBe(0);
  });

  it('skips Sundays', async () => {
    const { db, school } = freshDb();
    const res = await runDailyPendingAttendance(db, school, new Date('2026-11-01T11:30:00Z'));
    expect(res.ran).toBe(false);
    expect(res.reason).toBe('sunday');
  });
});

describe('runTeacherReminders', () => {
  it('queues reminders only for unsubmitted classes with a teacher phone', async () => {
    const { db, school } = freshDb();
    const fake = db as unknown as FakeDb;
    fake.attendanceDay.create({
      data: { schoolId: school.id, classId: 'class-5a', date: new Date('2026-11-06T00:00:00Z'), submittedBy: 'teacher_link', submittedAt: new Date() },
    });

    // 15:00 PKT == 10:00 UTC.
    const res = await runTeacherReminders(db, school, new Date('2026-11-06T10:00:00Z'));
    expect(res.ran).toBe(true);
    expect(res.queued).toBe(1); // only 6-B (1-A's teacher has no phone)
    expect(res.skipped_no_phone).toBe(1);

    const rows = fake.messageQueue.rows.filter((r) => r.type === 'teacher_reminder');
    expect(rows).toHaveLength(1);
    expect(rows[0].dedupeKey).toBe('teacher:class-6b:2026-11-06');
    expect(rows[0].approvedAt).not.toBeNull(); // auto-approved by design
    expect(rows[0].body).toContain('6-B');

    const again = await runTeacherReminders(db, school, new Date('2026-11-06T10:02:00Z'));
    expect(again.queued).toBe(0);
    expect(again.skipped_already_queued).toBe(1);
  });

  it('does nothing outside the reminder window or on Sundays', async () => {
    const { db, school } = freshDb();
    const early = await runTeacherReminders(db, school, new Date('2026-11-06T08:00:00Z')); // 13:00 PKT
    expect(early.ran).toBe(false);
    expect(early.reason).toBe('outside-reminder-window');
    const sunday = await runTeacherReminders(db, school, new Date('2026-11-01T10:00:00Z'));
    expect(sunday.ran).toBe(false);
    expect(sunday.reason).toBe('sunday');
  });
});
