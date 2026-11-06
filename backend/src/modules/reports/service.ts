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
  const records = await db.feeRecord.findMany({ where: { schoolId: schoolId, month } });
  const studentIds = [...new Set(records.map((r: any) => r.studentId))];
  const students = studentIds.length > 0 ? await db.student.findMany({ where: { id: { in: studentIds } } }) : [];
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
  return {
    title: `Attendance report — ${report.date ?? report.week_start ?? report.month}`,
    headers: ['Class', 'Days submitted', 'Present', 'Absent', 'Late', 'Leave', 'Rate %'],
    rows: ((report.by_class as any[]) ?? []).map((c) => [c.display_name, c.days_submitted, c.present, c.absent, c.late, c.leave, c.attendance_rate ?? '—']),
  };
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
