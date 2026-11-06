// Scripted demo of the fee + scheduler flow, end to end, through the real
// service/job functions against the in-memory fake DB (no Postgres needed).
// Run: npx vitest run src/jobs/__tests__/demo-flow.test.ts
// It prints a readable trace and asserts every step.
import { describe, expect, it } from 'vitest';
import type { Db } from '../../lib/db';
import { FakeDb, seedDemo, demoSchoolRow } from '../../modules/fees/__tests__/fake-db';
import { listFees, monthlyFeeReport, payFee, rolloverMonth } from '../../modules/fees/service';
import { runMonthlyFeeReminders, runFeeFollowup } from '../fee-reminders';
import { runTeacherReminders } from '../teacher-reminders';
import { runDailyPendingAttendance } from '../pending-attendance';

function log(...args: unknown[]): void {
  console.log(...args);
}

describe('demo: November fee cycle at Demo Public School', () => {
  it('rolls over, collects, reminds, and follows up — paid students are never reminded', async () => {
    const fake = new FakeDb();
    seedDemo(fake);
    const db = fake as unknown as Db;
    const school = demoSchoolRow(fake);

    log('\n=== Demo Public School — November 2026 fee cycle ===');
    log('Timezone: Asia/Karachi. 1 Nov 2026 is a SUNDAY, so the 1st-of-month job shifts to Mon 2 Nov.');

    // --- 1. Month rollover (Mon 2 Nov, 08:00 PKT) ---
    const rollover = await rolloverMonth(db, school.id, '2026-11');
    log(`\n[rollover] created=${rollover.created} already_existed=${rollover.already_existed}`);
    expect(rollover.created).toBe(5);

    // --- 2. Parents pay: Ahmed full, Zainab partial, Sara nothing yet ---
    const rAhmed = await payFee(db, school.id, 'stu-1', { month: '2026-11', amount_paid: 2500, payment_method: 'cash' }, 'admin-1');
    log(`[pay] Ahmed Raza paid 2500 -> ${rAhmed.status}, receipt ${rAhmed.receipt_no}`);
    const rZainab = await payFee(db, school.id, 'stu-5', { month: '2026-11', amount_paid: 1000, payment_method: 'jazzcash' }, 'clerk-1');
    log(`[pay] Zainab Noor paid 1000 -> ${rZainab.status}, balance ${rZainab.balance}, receipt ${rZainab.receipt_no}`);
    expect(rAhmed.receipt_no).toBe('demo-public-202611-001');
    expect(rZainab.receipt_no).toBe('demo-public-202611-002');

    // --- 3. Monthly reminder job (Mon 2 Nov, 08:00 PKT) ---
    const reminders = await runMonthlyFeeReminders(db, school, new Date('2026-11-02T03:00:00Z'));
    log(`\n[monthly reminder] ran=${reminders.ran} created=${reminders.created} skipped_paid=${reminders.skipped_paid} skipped_no_phone=${reminders.skipped_no_phone} skipped_opt_out=${reminders.skipped_opt_out}`);
    expect(reminders.created).toBe(2); // Sara (unpaid) + Zainab (partial, 1500 left)
    const queued = fake.messageQueue.rows.filter((r) => r.type === 'fee_reminder' && !String(r.dedupeKey).includes('followup'));
    for (const q of queued) log(`  queued -> ${q.dedupeKey}: "${q.body}"`);
    expect(queued.every((q) => q.approvedAt === null)).toBe(true); // fee_auto_send=false -> held for approval
    expect(queued.some((q) => String(q.body).includes('Ahmed'))).toBe(false); // PAID: never reminded

    // --- 4. Report after the 2nd ---
    const report = await monthlyFeeReport(db, school.id, '2026-11');
    log(`\n[report] collected=${report.collected} pending=${report.pending} paid=${report.paid_count} partial=${report.partial_count} unpaid=${report.unpaid_count}`);
    expect(report.collected).toBe(3500);
    expect(report.pending).toBe(9000);

    // --- 5. Sara pays on the 5th; follow-up on the 10th only chases Zainab ---
    await payFee(db, school.id, 'stu-2', { month: '2026-11', amount_paid: 2500 }, 'admin-1');
    const followup = await runFeeFollowup(db, school, new Date('2026-11-10T03:00:00Z'));
    log(`\n[follow-up 10 Nov] ran=${followup.ran} created=${followup.created} skipped_paid=${followup.skipped_paid}`);
    expect(followup.created).toBe(1); // only Zainab still owes 1500
    const fu = fake.messageQueue.rows.filter((r) => String(r.dedupeKey).includes('followup'));
    expect(fu).toHaveLength(1);
    expect(fu[0].dedupeKey).toBe('fee:stu-5:2026-11:followup');

    // --- 6. Teacher reminders + pending check (Fri 6 Nov) ---
    fake.attendanceDay.create({
      data: { schoolId: school.id, classId: 'class-5a', date: new Date('2026-11-06T00:00:00Z'), submittedBy: 'teacher_link', submittedAt: new Date() },
    });
    const teacher = await runTeacherReminders(db, school, new Date('2026-11-06T10:00:00Z')); // 15:00 PKT
    log(`\n[teacher reminders] ran=${teacher.ran} queued=${teacher.queued} skipped_no_phone=${teacher.skipped_no_phone}`);
    expect(teacher.queued).toBe(1); // 6-B only (5-A submitted, 1-A has no teacher phone)
    const pending = await runDailyPendingAttendance(db, school, new Date('2026-11-06T11:30:00Z')); // 16:30 PKT
    log(`[pending check] pending=${pending.pending_classes.map((c) => c.class_name).join(', ')} notifications=${pending.notifications_created}`);
    expect(pending.pending_classes.map((c) => c.class_name).sort()).toEqual(['1-A', '6-B']);

    // --- 7. Final fee list ---
    const list = await listFees(db, school.id, { month: '2026-11' }, 'Asia/Karachi');
    log('\n[fee list 2026-11]');
    for (const item of list.items) {
      log(`  ${item.student_name} (${item.class_name}): due ${item.amount_due}, paid ${item.amount_paid}, status ${item.status}`);
    }
    expect(list.items.find((i) => i.student_id === 'stu-1')!.status).toBe('paid');
    expect(list.items.find((i) => i.student_id === 'stu-2')!.status).toBe('paid');
    expect(list.items.find((i) => i.student_id === 'stu-5')!.status).toBe('partial');
    log('\n=== demo complete: paid students were never reminded; every send is a queue row with a dedupe key ===\n');
  });
});
