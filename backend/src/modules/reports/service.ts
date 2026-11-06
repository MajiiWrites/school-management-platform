import PDFDocument from 'pdfkit';
import ExcelJS from 'exceljs';
import { ApiError } from '../../lib/errors';
import { isValidDateString, monthRange, addDays, weekStartOf, dateOnly } from '../../lib/dates';
import type { Db } from '../../lib/db';

export interface ClassAttendanceSummary {
  class_id: string;
  display_name: string;
  days_submitted: number;
  present: number;
  absent: number;
  late: number;
  leave: number;
  attendance_rate: number | null; // present / (present+absent), null when no data
}

export interface StudentAttendanceSummary {
  student_id: string;
  name: string;
  roll_no: number | null;
  class_id: string;
  display_name: string;
  present: number;
  absent: number;
  late: number;
  leave: number;
  attendance_rate: number | null;
}

interface RangeData {
  days: any[];
  records: any[];
  students: any[];
  classes: any[];
}

async function loadRange(db: Db, schoolId: string, start: string, end: string, classId?: string): Promise<RangeData> {
  const dayWhere: Record<string, unknown> = { schoolId: schoolId, date: { gte: dateOnly(start), lte: dateOnly(end) } };
  if (classId) dayWhere.classId = classId;
  const days = await db.attendanceDay.findMany({ where: dayWhere, orderBy: [{ date: 'asc' }] });
  const dayIds = days.map((d: any) => d.id);
  const records = dayIds.length > 0 ? await db.attendanceRecord.findMany({ where: { attendanceDayId: { in: dayIds } } }) : [];
  const classIds = [...new Set(days.map((d: any) => d.classId))];
  const classWhere: Record<string, unknown> = { schoolId: schoolId };
  if (classId) classWhere.id = classId;
  else if (classIds.length > 0) classWhere.id = { in: classIds };
  const classes = await db.class.findMany({ where: classWhere });
  const students = await db.student.findMany({
    where: { schoolId: schoolId, ...(classId ? { classId: classId } : classIds.length > 0 ? { classId: { in: classIds } } : {}) },
  });
  return { days, records, students, classes };
}

function summarize(days: any[], records: any[], students: any[], classes: any[]): { by_class: ClassAttendanceSummary[]; by_student: StudentAttendanceSummary[] } {
  const classById = new Map<string, any>(classes.map((c: any) => [c.id, c]));
  const dayById = new Map<string, any>(days.map((d: any) => [d.id, d]));
  const perClass = new Map<string, { present: number; absent: number; late: number; leave: number; days: Set<string> }>();
  const perStudent = new Map<string, { present: number; absent: number; late: number; leave: number }>();
  for (const s of students) perStudent.set(s.id, { present: 0, absent: 0, late: 0, leave: 0 });
  for (const r of records) {
    const day = dayById.get(r.attendanceDayId);
    if (!day) continue;
    const cc = perClass.get(day.classId) ?? { present: 0, absent: 0, late: 0, leave: 0, days: new Set<string>() };
    cc[r.status as 'present' | 'absent' | 'late' | 'leave'] += 1;
    cc.days.add(day.date as string);
    perClass.set(day.classId, cc);
    const ps = perStudent.get(r.studentId);
    if (ps) ps[r.status as 'present' | 'absent' | 'late' | 'leave'] += 1;
  }
  const rate = (p: number, a: number): number | null => (p + a === 0 ? null : Math.round((p / (p + a)) * 1000) / 10);
  const byClass: ClassAttendanceSummary[] = [...perClass.entries()].map(([classId, c]) => {
    const cls = classById.get(classId);
    return {
      class_id: classId,
      display_name: cls ? `${cls.name}-${cls.section}` : classId,
      days_submitted: c.days.size,
      present: c.present,
      absent: c.absent,
      late: c.late,
      leave: c.leave,
      attendance_rate: rate(c.present, c.absent),
    };
  });
  const byStudent: StudentAttendanceSummary[] = students.map((s: any) => {
    const ps = perStudent.get(s.id) ?? { present: 0, absent: 0, late: 0, leave: 0 };
    const cls = classById.get(s.classId);
    return {
      student_id: s.id,
      name: s.name,
      roll_no: s.rollNo ?? null,
      class_id: s.classId,
      display_name: cls ? `${cls.name}-${cls.section}` : s.classId,
      ...ps,
      attendance_rate: rate(ps.present, ps.absent),
    };
  });
  return { by_class: byClass, by_student: byStudent };
}

export async function attendanceDaily(db: Db, schoolId: string, query: Record<string, any>): Promise<Record<string, unknown>> {
  const date = String(query.date ?? '');
  if (!isValidDateString(date)) throw ApiError.validation('date must be YYYY-MM-DD');
  const classId = query.class_id ? String(query.class_id) : undefined;
  const data = await loadRange(db, schoolId, date, date, classId);
  const summary = summarize(data.days, data.records, data.students, data.classes);
  const totals = summary.by_class.reduce(
    (acc, c) => ({ present: acc.present + c.present, absent: acc.absent + c.absent, late: acc.late + c.late, leave: acc.leave + c.leave }),
    { present: 0, absent: 0, late: 0, leave: 0 },
  );
  return { date, ...totals, classes_submitted: data.days.length, ...summary };
}

export async function attendanceWeekly(db: Db, schoolId: string, query: Record<string, any>): Promise<Record<string, unknown>> {
  const weekStart = String(query.week_start ?? '');
  if (!isValidDateString(weekStart)) throw ApiError.validation('week_start must be YYYY-MM-DD');
  const monday = weekStartOf(weekStart);
  const end = addDays(monday, 6);
  const classId = query.class_id ? String(query.class_id) : undefined;
  const data = await loadRange(db, schoolId, monday, end, classId);
  const summary = summarize(data.days, data.records, data.students, data.classes);
  return { week_start: monday, week_end: end, ...summary };
}

export async function attendanceMonthly(db: Db, schoolId: string, query: Record<string, any>): Promise<Record<string, unknown>> {
  const month = String(query.month ?? '');
  if (!/^\d{4}-\d{2}$/.test(month)) throw ApiError.validation('month must be YYYY-MM');
  const { start, end } = monthRange(month);
  const classId = query.class_id ? String(query.class_id) : undefined;
  const data = await loadRange(db, schoolId, start, end, classId);
  const summary = summarize(data.days, data.records, data.students, data.classes);
  return { month, ...summary };
}

export async function feesMonthly(db: Db, schoolId: string, query: Record<string, any>): Promise<Record<string, unknown>> {
  const month = String(query.month ?? '');
  if (!/^\d{4}-\d{2}$/.test(month)) throw ApiError.validation('month must be YYYY-MM');
  const records = await db.feeRecord.findMany({ where: { schoolId: schoolId, month, deletedAt: null } });
  const studentIds = [...new Set(records.map((r: any) => r.studentId))];
  const students = studentIds.length > 0 ? await db.student.findMany({ where: { schoolId: schoolId, id: { in: studentIds } } }) : [];
  const byStudent = new Map<string, any>(students.map((s: any) => [s.id, s]));
  const classes = await db.class.findMany({ where: { schoolId: schoolId } });
  const byClass = new Map<string, any>(classes.map((c: any) => [c.id, c]));
  let collected = 0;
  let pending = 0;
  const perClass = new Map<string, { collected: number; pending: number; students: number }>();
  for (const r of records) {
    collected += r.amountPaid ?? 0;
    const due = Math.max(0, (r.amountDue ?? 0) - (r.discount ?? 0) - (r.amountPaid ?? 0));
    pending += due;
    const s = byStudent.get(r.studentId);
    const cid = s?.classId as string | undefined;
    if (cid) {
      const agg = perClass.get(cid) ?? { collected: 0, pending: 0, students: 0 };
      agg.collected += r.amountPaid ?? 0;
      agg.pending += due;
      agg.students += 1;
      perClass.set(cid, agg);
    }
  }
  return {
    month,
    collected,
    pending,
    students: records.length,
    by_class: [...perClass.entries()].map(([classId, agg]) => {
      const cls = byClass.get(classId);
      return { class_id: classId, display_name: cls ? `${cls.name}-${cls.section}` : classId, ...agg };
    }),
  };
}

// ---------------------------------------------------------------------------
// 6C-2 reports: fee defaulters, results summary, class strength, message
// history. All scoped to the JWT school_id; all exportable via
// buildExportRows + exportPdf/exportXlsx/exportCsv in routes.ts.
// ---------------------------------------------------------------------------

/** Students who still owe money for the month (balance > 0), worst first. */
export async function feeDefaulters(db: Db, schoolId: string, query: Record<string, any>): Promise<Record<string, unknown>> {
  const month = String(query.month ?? '');
  if (!/^\d{4}-\d{2}$/.test(month)) throw ApiError.validation('month must be YYYY-MM');
  const records = await db.feeRecord.findMany({ where: { schoolId, month, deletedAt: null } });
  const studentIds = [...new Set(records.map((r: any) => r.studentId))];
  const students = studentIds.length > 0 ? await db.student.findMany({ where: { schoolId, id: { in: studentIds } } }) : [];
  const byStudent = new Map<string, any>(students.map((s: any) => [s.id, s]));
  const classes = await db.class.findMany({ where: { schoolId } });
  const byClass = new Map<string, any>(classes.map((c: any) => [c.id, c]));
  const classId = query.class_id ? String(query.class_id) : undefined;
  const rows = records
    .map((r: any) => {
      const s = byStudent.get(r.studentId);
      if (!s) return null;
      const balance = Math.max(0, (r.amountDue ?? 0) - (r.discount ?? 0) - (r.amountPaid ?? 0));
      if (balance <= 0) return null;
      const cls = byClass.get(s.classId);
      return {
        student_id: s.id,
        student_name: s.name,
        roll_no: s.rollNo ?? null,
        class_id: s.classId,
        display_name: cls ? `${cls.name}-${cls.section}` : s.classId,
        month,
        amount_due: r.amountDue ?? 0,
        amount_paid: r.amountPaid ?? 0,
        discount: r.discount ?? 0,
        arrears: r.arrears ?? 0,
        balance,
        status: r.status ?? 'unpaid',
      };
    })
    .filter((x: any): x is NonNullable<typeof x> => x !== null)
    .filter((x: any) => !classId || x.class_id === classId)
    .sort((a: any, b: any) => b.balance - a.balance);
  return {
    month,
    defaulters: rows.length,
    total_pending: rows.reduce((a: number, r: any) => a + r.balance, 0),
    by_student: rows,
  };
}

/**
 * Results summary per exam (and per class when class_id is given).
 * Pass = a grade other than 'F'/'Fail' (no grading-scale pass rule is
 * stored on results; the grade itself is the source of truth).
 */
export async function resultsSummary(db: Db, schoolId: string, query: Record<string, any>): Promise<Record<string, unknown>> {
  const examId = query.exam_id ? String(query.exam_id) : undefined;
  const classId = query.class_id ? String(query.class_id) : undefined;
  const where: Record<string, unknown> = { schoolId, deletedAt: null };
  if (examId) where.examId = examId;
  if (classId) where.classId = classId;
  const results = await db.result.findMany({ where });
  const exams = await db.exam.findMany({ where: { schoolId } });
  const examById = new Map<string, any>(exams.map((e: any) => [e.id, e] as [string, any]));
  const classes = await db.class.findMany({ where: { schoolId } });
  const classById = new Map<string, any>(classes.map((c: any) => [c.id, c] as [string, any]));
  const perExam = new Map<string, { students: number; total_percentage: number; counted: number; passed: number; top_percentage: number | null }>();
  for (const r of results) {
    const agg = perExam.get(r.examId) ?? { students: 0, total_percentage: 0, counted: 0, passed: 0, top_percentage: null };
    agg.students += 1;
    if (typeof r.percentage === 'number') {
      agg.total_percentage += r.percentage;
      agg.counted += 1;
      if (agg.top_percentage === null || r.percentage > agg.top_percentage) agg.top_percentage = r.percentage;
    }
    if (r.grade && r.grade !== 'F' && r.grade !== 'Fail') agg.passed += 1;
    perExam.set(r.examId, agg);
  }
  return {
    exam_id: examId ?? null,
    class_id: classId ?? null,
    students: results.length,
    by_exam: [...perExam.entries()].map(([id, a]) => {
      const e = examById.get(id);
      return {
        exam_id: id,
        exam_name: e?.name ?? id,
        students: a.students,
        average_percentage: a.counted > 0 ? Math.round((a.total_percentage / a.counted) * 10) / 10 : null,
        passed: a.passed,
        top_percentage: a.top_percentage,
      };
    }),
    by_student: results
      .map((r: any) => {
        const cls = classById.get(r.classId);
        return {
          student_name: r.studentName,
          roll_no: r.rollNo,
          class_id: r.classId,
          display_name: cls ? `${cls.name}-${cls.section}` : r.classId,
          exam_id: r.examId,
          exam_name: examById.get(r.examId)?.name ?? r.examId,
          obtained_marks: r.obtainedMarks ?? null,
          total_marks: r.totalMarks ?? null,
          percentage: r.percentage ?? null,
          grade: r.grade ?? null,
          position: r.position ?? null,
        };
      })
      .sort((a: any, b: any) => (b.percentage ?? -1) - (a.percentage ?? -1)),
  };
}

/** Headcount per class (active / left / struck_off / graduated). */
export async function classStrength(db: Db, schoolId: string): Promise<Record<string, unknown>> {
  const classes = await db.class.findMany({ where: { schoolId, deletedAt: null }, orderBy: [{ name: 'asc' }, { section: 'asc' }] });
  const students = await db.student.findMany({ where: { schoolId, deletedAt: null } });
  const perClass = new Map<string, { active: number; left: number; struck_off: number; graduated: number; total: number }>();
  for (const c of classes) perClass.set(c.id, { active: 0, left: 0, struck_off: 0, graduated: 0, total: 0 });
  for (const s of students) {
    const agg = perClass.get(s.classId);
    if (!agg) continue;
    agg.total += 1;
    if (s.status === 'active') agg.active += 1;
    else if (s.status === 'left') agg.left += 1;
    else if (s.status === 'struck_off') agg.struck_off += 1;
    else if (s.status === 'graduated') agg.graduated += 1;
  }
  const byClass = classes.map((c: any) => ({
    class_id: c.id,
    display_name: `${c.name}-${c.section}`,
    ...perClass.get(c.id)!,
  }));
  return {
    classes: byClass.length,
    total_students: byClass.reduce((a: number, c: any) => a + c.total, 0),
    total_active: byClass.reduce((a: number, c: any) => a + c.active, 0),
    by_class: byClass,
  };
}

/** Message history — every queued/sent/failed/cancelled message, scoped. */
export async function messageHistory(
  db: Db,
  schoolId: string,
  query: Record<string, any>,
): Promise<Record<string, unknown>> {
  const where: Record<string, unknown> = { schoolId };
  if (query.status) where.status = String(query.status);
  if (query.type) where.type = String(query.type);
  if (query.date) {
    const d = String(query.date);
    const start = new Date(`${d}T00:00:00Z`);
    const end = new Date(`${d}T23:59:59Z`);
    where.createdAt = { gte: start, lte: end };
  }
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const limit = Math.min(200, Math.max(1, Number(query.limit ?? 50) || 50));
  const [rows, total] = await Promise.all([
    db.messageQueue.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
    db.messageQueue.count({ where }),
  ]);
  const studentIds = [...new Set(rows.map((r: any) => r.studentId).filter(Boolean))];
  const students = studentIds.length > 0 ? await db.student.findMany({ where: { schoolId, id: { in: studentIds } } }) : [];
  const byStudent = new Map(students.map((s: any) => [s.id, s]));
  return {
    items: rows.map((r: any) => ({
      id: r.id,
      type: r.type,
      student_id: r.studentId ?? null,
      student_name: r.studentId ? (byStudent.get(r.studentId) as any)?.name ?? null : null,
      status: r.status,
      body: r.body,
      scheduled_for: r.scheduledFor ? new Date(r.scheduledFor).toISOString() : null,
      sent_at: r.sentAt ? new Date(r.sentAt).toISOString() : null,
      error: r.error ?? null,
      created_at: new Date(r.createdAt).toISOString(),
    })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export function buildExportRows(report: Record<string, unknown>, kind: string): { title: string; headers: string[]; rows: (string | number | null)[][] } {
  if (kind === 'fees') {
    return {
      title: `Fee report — ${report.month}`,
      headers: ['Class', 'Students', 'Collected (PKR)', 'Pending (PKR)'],
      rows: ((report.by_class as any[]) ?? []).map((c) => [c.display_name, c.students, c.collected, c.pending]),
    };
  }
  if (kind === 'defaulters') {
    return {
      title: `Fee defaulters — ${report.month}`,
      headers: ['Student', 'Roll', 'Class', 'Amount due (PKR)', 'Paid (PKR)', 'Discount (PKR)', 'Arrears (PKR)', 'Balance (PKR)', 'Status'],
      rows: ((report.by_student as any[]) ?? []).map((r) => [r.student_name, r.roll_no, r.display_name, r.amount_due, r.amount_paid, r.discount, r.arrears, r.balance, r.status]),
    };
  }
  if (kind === 'results-summary') {
    return {
      title: `Results summary`,
      headers: ['Student', 'Roll', 'Class', 'Exam', 'Obtained', 'Total', 'Percentage', 'Grade', 'Position'],
      rows: ((report.by_student as any[]) ?? []).map((r) => [r.student_name, r.roll_no, r.display_name, r.exam_name, r.obtained_marks, r.total_marks, r.percentage, r.grade, r.position]),
    };
  }
  if (kind === 'class-strength') {
    return {
      title: `Class strength`,
      headers: ['Class', 'Active', 'Left', 'Struck off', 'Graduated', 'Total'],
      rows: ((report.by_class as any[]) ?? []).map((c) => [c.display_name, c.active, c.left, c.struck_off, c.graduated, c.total]),
    };
  }
  if (kind === 'message-history') {
    return {
      title: `Message history`,
      headers: ['Type', 'Student', 'Status', 'Scheduled for', 'Sent at', 'Body', 'Error'],
      rows: ((report.items as any[]) ?? []).map((m) => [m.type, m.student_name ?? '—', m.status, m.scheduled_for ?? '', m.sent_at ?? '', m.body, m.error ?? '']),
    };
  }
  if (kind === 'income-expense') {
    return {
      title: `Income vs expense — ${report.month}`,
      headers: ['Category', 'Total (PKR)', 'Count'],
      rows: [
        ['Fees collected (income)', report.income, ''],
        ['Expenses', report.expense, ''],
        ['Balance', report.balance, ''],
        ...((report.by_category as any[]) ?? []).map((c) => [c.category, c.total, c.count]),
      ],
    };
  }
  return {
    title: `Attendance report — ${report.date ?? report.week_start ?? report.month}`,
    headers: ['Class', 'Days submitted', 'Present', 'Absent', 'Late', 'Leave', 'Rate %'],
    rows: ((report.by_class as any[]) ?? []).map((c) => [c.display_name, c.days_submitted, c.present, c.absent, c.late, c.leave, c.attendance_rate ?? '—']),
  };
}

/** CSV export (UTF-8, RFC 4180 quoting) — the third export format alongside PDF/XLSX. */
export function exportCsv(title: string, headers: string[], rows: (string | number | null)[][]): Buffer {
  const q = (v: string | number | null): string => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [q(title), headers.map(q).join(','), ...rows.map((r) => r.map(q).join(','))];
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf-8');
}

export async function exportPdf(title: string, headers: string[], rows: (string | number | null)[][]): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
  doc.fontSize(16).text(title, { underline: true });
  doc.moveDown();
  doc.fontSize(11).text(headers.join('  |  '));
  doc.moveDown(0.5);
  for (const row of rows) {
    doc.fontSize(10).text(row.map((v) => String(v ?? '')).join('  |  '));
  }
  doc.end();
  return done;
}

export async function exportXlsx(title: string, headers: string[], rows: (string | number | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Report');
  ws.addRow([title]);
  ws.addRow(headers);
  for (const row of rows) ws.addRow(row);
  ws.columns.forEach((col) => {
    col.width = 18;
  });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf as ArrayBuffer);
}
