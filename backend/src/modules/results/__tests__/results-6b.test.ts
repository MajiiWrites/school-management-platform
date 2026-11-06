/**
 * 6B tests — students/classes/results. Service-level with an in-memory
 * fake DB (same matcher semantics as hardening/__tests__/fake-db);
 * no live DB. Covers: section independence, teacher assign/change,
 * student move, admission_no uniqueness, CSV import validation/preview,
 * result-sheet OCR parsing + review flags, results save/link-confirmation,
 * toppers/positions/summary, soft delete/restore, cross-tenant 404s,
 * publish-SMS drafts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { ApiError } from '../../../lib/errors';
import * as studentsSvc from '../../students/service';
import * as classesSvc from '../../classes/service';
import * as resultsSvc from '../service';
import { parseResultSheet, rowConfidence } from '../../ocr/resultSheets';
import { restoreDeletedRecord, listRecycleBin } from '../../hardening/recycleBin';

process.env.PHONE_ENC_KEY = process.env.PHONE_ENC_KEY ?? crypto.randomBytes(32).toString('base64');

type Row = Record<string, any>;

function isOperatorObject(cond: any): boolean {
  if (cond === null || typeof cond !== 'object' || cond instanceof Date || Array.isArray(cond)) return false;
  return Object.keys(cond).some((k) =>
    ['equals', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'endsWith', 'mode', 'not'].includes(k),
  );
}

function matches(row: Row, where: any): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === 'OR' && Array.isArray(cond)) {
      if (!cond.some((c) => matches(row, c))) return false;
      continue;
    }
    if (key === 'AND' && Array.isArray(cond)) {
      if (!cond.every((c) => matches(row, c))) return false;
      continue;
    }
    const val = row[key];
    if (isOperatorObject(cond)) {
      const c = cond as any;
      if ('equals' in c && val !== c.equals) return false;
      if ('in' in c && !c.in.includes(val)) return false;
      if ('notIn' in c && c.notIn.includes(val)) return false;
      if ('lt' in c && !(val < c.lt)) return false;
      if ('lte' in c && !(val <= c.lte)) return false;
      if ('gt' in c && !(val > c.gt)) return false;
      if ('gte' in c && !(val >= c.gte)) return false;
      if ('not' in c) {
        if (c.not === null) {
          if (val === null || val === undefined) return false;
        } else if (val === c.not) return false;
      }
      if ('contains' in c) {
        const hay = String(val ?? '');
        const needle = String(c.contains);
        const ok = c.mode === 'insensitive' ? hay.toLowerCase().includes(needle.toLowerCase()) : hay.includes(needle);
        if (!ok) return false;
      }
      if ('startsWith' in c && !String(val ?? '').startsWith(String(c.startsWith))) return false;
      if ('endsWith' in c && !String(val ?? '').endsWith(String(c.endsWith))) return false;
    } else if (cond === null) {
      if (val !== null && val !== undefined) return false;
    } else if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      if (!matches(row, cond)) return false;
    } else if (cond instanceof Date) {
      if (!(val instanceof Date) || val.getTime() !== cond.getTime()) return false;
    } else {
      if (val !== cond) return false;
    }
  }
  return true;
}

function applyOrderBy(rows: Row[], orderBy: any): Row[] {
  if (!orderBy) return rows;
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  const out = [...rows];
  out.sort((a, b) => {
    for (const spec of specs) {
      for (const [field, dir] of Object.entries(spec)) {
        const av = a[field];
        const bv = b[field];
        if (av === bv) continue;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        const cmp = av < bv ? -1 : 1;
        return dir === 'desc' ? -cmp : cmp;
      }
    }
    return 0;
  });
  return out;
}

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `fake-uuid-${String(idSeq).padStart(4, '0')}`;
}

class FakeCollection {
  rows: Row[] = [];

  findUnique(args: { where: any }): Row | null {
    return this.rows.find((r) => matches(r, args.where)) ?? null;
  }

  findFirst(args: { where: any }): Row | null {
    return this.rows.find((r) => matches(r, args.where)) ?? null;
  }

  findMany(args: { where?: any; orderBy?: any; skip?: number; take?: number }): Row[] {
    let out = this.rows.filter((r) => matches(r, args.where ?? null));
    out = applyOrderBy(out, args.orderBy);
    if (args.skip) out = out.slice(args.skip);
    if (args.take !== undefined) out = out.slice(0, args.take);
    return out;
  }

  create(args: { data: any }): Row {
    const row: Row = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...args.data };
    this.rows.push(row);
    return row;
  }

  createMany(args: { data: any[] }): { count: number } {
    for (const d of args.data) this.create({ data: d });
    return { count: args.data.length };
  }

  update(args: { where: any; data: any }): Row {
    const row = this.rows.find((r) => matches(r, args.where));
    if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
    Object.assign(row, args.data, { updatedAt: new Date() });
    return row;
  }

  updateMany(args: { where: any; data: any }): { count: number } {
    const found = this.rows.filter((r) => matches(r, args.where));
    for (const r of found) Object.assign(r, args.data);
    return { count: found.length };
  }

  delete(args: { where: any }): Row {
    const idx = this.rows.findIndex((r) => matches(r, args.where));
    if (idx === -1) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
    return this.rows.splice(idx, 1)[0]!;
  }

  deleteMany(args: { where?: any }): { count: number } {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, args.where ?? null));
    return { count: before - this.rows.length };
  }

  count(args?: { where?: any }): number {
    return this.rows.filter((r) => matches(r, args?.where ?? null)).length;
  }

  groupBy(args: { by: string[]; where?: any; _count?: any }): Row[] {
    const groups = new Map<string, Row>();
    for (const r of this.rows.filter((x) => matches(x, args.where ?? null))) {
      const key = args.by.map((b) => String(r[b])).join('|');
      if (!groups.has(key)) {
        const g: Row = { _count: { _all: 0 } };
        for (const b of args.by) g[b] = r[b];
        groups.set(key, g);
      }
      groups.get(key)!._count._all += 1;
    }
    return [...groups.values()];
  }

  aggregate(): Record<string, unknown> {
    return {};
  }
}

function makeDb(): any {
  const collections: Record<string, FakeCollection> = {};
  const names = [
    'school', 'user', 'class', 'student', 'attendanceDay', 'attendanceRecord',
    'teacherAttendance', 'feeStructure', 'feeRecord', 'messageTemplate',
    'messageQueue', 'messageDelivery', 'smsDevice', 'holiday', 'academicSession',
    'promotion', 'leaveApplication', 'ocrUpload', 'auditLog', 'notification',
    'rolePermission', 'approvalRequest', 'deletedRecord', 'changeLog', 'exam',
    'gradingScale', 'resultSheet', 'result', 'timetableEntry', 'staff',
    'staffClassAssignment', 'salaryRecord', 'expense', 'announcement', 'event',
    'certificate', 'examDatesheet', 'feeVoucher', 'accountDeletionRequest',
    'schoolBackup', 'messageDraft',
  ];
  for (const n of names) collections[n] = new FakeCollection();
  return collections;
}

const SCHOOL_A = '11111111-1111-1111-1111-111111111111';
const SCHOOL_B = '22222222-2222-2222-2222-222222222222';
const ADMIN = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

let db: any;
let classA: any;
let classB: any;

beforeEach(() => {
  db = makeDb();
  db.school.create({ data: { id: SCHOOL_A, name: 'Demo Public School', slug: 'demo' } });
  db.school.create({ data: { id: SCHOOL_B, name: 'Other School', slug: 'other' } });
  classA = null;
  classB = null;
});

async function seedClasses(): Promise<void> {
  classA = await classesSvc.createClass(db, SCHOOL_A, { name: '5', section: 'A', teacher_name: 'Ms. Shazia', teacher_phone: '03001234567' }, ADMIN);
  classB = await classesSvc.createClass(db, SCHOOL_A, { name: '5', section: 'B', teacher_name: 'Mr. Bilal', teacher_phone: '03007654321' }, ADMIN);
}

async function seedStudent(overrides: Record<string, any> = {}): Promise<any> {
  return studentsSvc.createStudent(db, SCHOOL_A, classA.id, {
    name: 'Ahmed Raza',
    roll_no: 1,
    parent_name: 'Muhammad Raza',
    parent_phone: '03001112222',
    father_name: 'Muhammad Raza',
    admission_no: 'ADM-001',
    ...overrides,
  }, ADMIN);
}

function isApiError(err: unknown, code: string): boolean {
  return err instanceof ApiError && (err as any).code === code;
}

/* ------------------------------------------------------------------ */

describe('6B classes/sections', () => {
  it('sections are independent: own teacher + own attendance link', async () => {
    await seedClasses();
    // Different teachers per section.
    expect(classA.teacherName).toBe('Ms. Shazia');
    expect(classB.teacherName).toBe('Mr. Bilal');
    // Each section gets its own token; resolving one never yields the other.
    const linkA = await classesSvc.regenerateLink(db, SCHOOL_A, classA.id, ADMIN);
    const linkB = await classesSvc.regenerateLink(db, SCHOOL_A, classB.id, ADMIN);
    expect(linkA.token).not.toBe(linkB.token);
    const resolvedA = await classesSvc.resolveLinkToken(db, linkA.token);
    const resolvedB = await classesSvc.resolveLinkToken(db, linkB.token);
    expect(resolvedA.id).toBe(classA.id);
    expect(resolvedB.id).toBe(classB.id);
    // Revoking A's link leaves B's link working.
    await classesSvc.revokeLink(db, SCHOOL_A, classA.id, ADMIN);
    expect(await classesSvc.resolveLinkToken(db, linkA.token)).toBeNull();
    expect((await classesSvc.resolveLinkToken(db, linkB.token))?.id).toBe(classB.id);
  });

  it('teacher assign/change per section writes change history, other section untouched', async () => {
    await seedClasses();
    const updated = await classesSvc.updateClass(db, SCHOOL_A, classA.id, { teacher_name: 'Ms. Ayesha', teacher_phone: '03009998888' }, ADMIN);
    expect(updated.teacherName).toBe('Ms. Ayesha');
    const other = await classesSvc.getClass(db, SCHOOL_A, classB.id);
    expect((other as any).teacher_name).toBe('Mr. Bilal');
    const logs = db.changeLog.findMany({ where: { schoolId: SCHOOL_A, entity: 'class', entityId: classA.id } });
    expect(logs.some((l: any) => l.field === 'teacher_name' && l.oldValue === 'Ms. Shazia' && l.newValue === 'Ms. Ayesha')).toBe(true);
  });

  it('no caps: many classes/sections/students can be created', async () => {
    for (let s = 0; s < 12; s++) {
      await classesSvc.createClass(db, SCHOOL_A, { name: '6', section: String.fromCharCode(65 + s), teacher_name: `Teacher ${s}` }, ADMIN);
    }
    const classes = await classesSvc.listClasses(db, SCHOOL_A);
    expect(classes.length).toBe(12);
  });
});

describe('6B students: extended profile, move, admission_no', () => {
  it('admission_no is unique per school but reusable in another school', async () => {
    await seedClasses();
    await seedStudent();
    await expect(
      studentsSvc.createStudent(db, SCHOOL_A, classA.id, { name: 'Sara Ahmed', admission_no: 'ADM-001' }, ADMIN),
    ).rejects.toThrow(/Admission number ADM-001 is already used/);
    // Same admission_no in school B is fine (need a class there first).
    const classOther = await classesSvc.createClass(db, SCHOOL_B, { name: '5', section: 'A', teacher_name: 'T', teacher_phone: null }, ADMIN);
    const ok = await studentsSvc.createStudent(db, SCHOOL_B, classOther.id, { name: 'Sara Ahmed', admission_no: 'ADM-001' }, ADMIN);
    expect(ok.admissionNo).toBe('ADM-001');
    // Update to a taken admission_no conflicts.
    const second = await seedStudent({ name: 'Bilal Khan', roll_no: 2, admission_no: 'ADM-002' });
    await expect(
      studentsSvc.updateStudent(db, SCHOOL_A, second.id, { admission_no: 'ADM-001' }, ADMIN),
    ).rejects.toThrow(/already used/);
  });

  it('move between sections: class changes, change log written, roll clash blocks', async () => {
    await seedClasses();
    const student = await seedStudent();
    const moved = await studentsSvc.moveStudent(db, SCHOOL_A, student.id, classB.id, ADMIN);
    expect(moved.classId).toBe(classB.id);
    const logs = db.changeLog.findMany({ where: { schoolId: SCHOOL_A, entity: 'student', entityId: student.id } });
    expect(logs.some((l: any) => l.field === 'class_id')).toBe(true);
    // Roll clash in the target section blocks the move.
    const other = await seedStudent({ name: 'Zara Khan', roll_no: 5, admission_no: 'ADM-005' });
    await studentsSvc.createStudent(db, SCHOOL_A, classB.id, { name: 'Hassan Ali', roll_no: 5, admission_no: 'ADM-009' }, ADMIN);
    await expect(studentsSvc.moveStudent(db, SCHOOL_A, other.id, classB.id, ADMIN)).rejects.toThrow(/Roll number 5/);
    // Moving into another school's class is a 404.
    const foreign = await classesSvc.createClass(db, SCHOOL_B, { name: '5', section: 'A', teacher_name: 'T', teacher_phone: null }, ADMIN);
    await expect(studentsSvc.moveStudent(db, SCHOOL_A, student.id, foreign.id, ADMIN)).rejects.toThrow(/Class not found/);
  });

  it('status changes incl. struck_off are accepted and logged', async () => {
    await seedClasses();
    const student = await seedStudent();
    const updated = await studentsSvc.updateStudent(db, SCHOOL_A, student.id, { status: 'struck_off' }, ADMIN);
    expect(updated.status).toBe('struck_off');
    await expect(
      studentsSvc.updateStudent(db, SCHOOL_A, student.id, { status: 'bogus' }, ADMIN),
    ).rejects.toThrow(/Invalid status/);
  });

  it('school-wide search finds by admission_no and status', async () => {
    await seedClasses();
    await seedStudent();
    const byAdm = await studentsSvc.listStudentsSchoolWide(db, SCHOOL_A, { admission_no: 'ADM-001' });
    expect(byAdm.total).toBe(1);
    expect(byAdm.items[0].name).toBe('Ahmed Raza');
    const byStatus = await studentsSvc.listStudentsSchoolWide(db, SCHOOL_A, { status: 'struck_off' });
    expect(byStatus.total).toBe(0);
    const none = await studentsSvc.listStudentsSchoolWide(db, SCHOOL_B, { admission_no: 'ADM-001' });
    expect(none.total).toBe(0);
  });
});

describe('6B CSV/Excel import: preview validation', () => {
  it('preview flags duplicates, invalid phones, admission clashes; import saves only ok rows', async () => {
    await seedClasses();
    await seedStudent(); // Ahmed Raza, roll 1, ADM-001
    const rows = [
      { name: 'Fatima Khan', roll_no: 2, parent_phone: '03003334444', father_name: 'Ali Khan', admission_no: 'ADM-002' },
      { name: 'Ahmed Raza', roll_no: 3, parent_phone: '03005556666' }, // duplicate name
      { name: 'Bilal Ahmed', roll_no: 1, parent_phone: '03007778888' }, // duplicate roll
      { name: 'Bad Phone', roll_no: 4, parent_phone: '12345' }, // invalid phone
      { name: 'Dup Adm', roll_no: 5, admission_no: 'ADM-001' }, // admission clash
      { name: 'Wrong Gender', roll_no: 6, gender: 'alien' }, // invalid gender
      { name: 'Sara Ahmed', roll_no: 7, parent_phone: '03001112222' }, // same phone, DIFFERENT name = sibling, ok
    ];
    const preview = await studentsSvc.previewImport(db, SCHOOL_A, classA.id, rows);
    expect(preview.total).toBe(7);
    expect(preview.valid).toBe(2); // Fatima + Sara (sibling phone is fine)
    expect(preview.duplicates_flagged).toBe(1);
    expect(preview.invalid_rows.length).toBe(4);
    const result = await studentsSvc.importStudents(db, SCHOOL_A, classA.id, rows, ADMIN);
    expect(result.imported).toBe(2);
    expect(result.saved_ids.length).toBe(2);
    const saved = await studentsSvc.getStudent(db, SCHOOL_A, result.saved_ids[0]!);
    expect(saved.fatherName).toBe('Ali Khan');
    expect(saved.admissionNo).toBe('ADM-002');
  });

  it('CSV parsing reads extended columns', () => {
    const grid = studentsSvc.parseCsvText(
      'name,roll_no,father_name,admission_no,date_of_birth,gender,parent_phone\nAhmed Raza,1,Muhammad Raza,ADM-001,2018-05-01,male,03001112222\n',
    );
    const rows = studentsSvc.rowsToImportRows(grid);
    expect(rows[0]!.father_name).toBe('Muhammad Raza');
    expect(rows[0]!.admission_no).toBe('ADM-001');
    expect(rows[0]!.date_of_birth).toBe('2018-05-01');
    expect(rows[0]!.gender).toBe('male');
  });
});

describe('6B result-sheet OCR parser', () => {
  const EN_SHEET = [
    'Roll No | Student Name | Father Name | English | Math | Science | Obtained | Total | % | Grade',
    '1 | Ahmed Raza | Muhammad Raza | 85 | 90 | 78 | 253 | 300 | 84.33 | A',
    '2 | Fatima Khan | Ali Khan | 92 | 88 | 95 | 275 | 300 | 91.67 | A',
    '3 | Bilal Ahmed | Usman Ahmed | 40 | 35 | 30 | 105 | 300 | 35 | D',
  ].join('\n');

  it('reads the sheet headings: subjects become subject_marks, totals derived', () => {
    const parsed = parseResultSheet(EN_SHEET);
    expect(parsed.headings.length).toBeGreaterThan(5);
    expect(parsed.rows.length).toBe(3);
    const first = parsed.rows[0]!;
    expect(first.roll_no).toBe(1);
    expect(first.student_name).toBe('Ahmed Raza');
    expect(first.father_name).toBe('Muhammad Raza');
    expect(first.subject_marks).toEqual({ English: 85, Math: 90, Science: 78 });
    expect(first.obtained_marks).toBe(253);
    expect(first.total_marks).toBe(300);
    expect(first.percentage).toBe(84.33);
    expect(first.grade).toBe('A');
    expect(first.flags).toEqual([]);
  });

  it('flags obtained > total and duplicate rolls', () => {
    const text = [
      'Roll No  Student Name  Obtained  Total',
      '1  Ahmed Raza  320  300',
      '1  Fatima Khan  200  300',
    ].join('\n');
    const parsed = parseResultSheet(text);
    expect(parsed.rows[0]!.flags).toContain('obtained_gt_total');
    expect(parsed.rows[1]!.flags).toContain('duplicate_roll');
  });

  it('reads Urdu headings', () => {
    const text = [
      'رول نمبر  نام  والد کا نام  حاصل کردہ  کل',
      '1  احمد رضا  محمد رضا  240  300',
    ].join('\n');
    const parsed = parseResultSheet(text);
    expect(parsed.rows.length).toBe(1);
    expect(parsed.rows[0]!.roll_no).toBe(1);
    expect(parsed.rows[0]!.obtained_marks).toBe(240);
    expect(parsed.rows[0]!.total_marks).toBe(300);
  });

  it('free-form fallback: bare roll number, last two numbers are obtained/total', () => {
    const text = [
      '1 Ahmed Raza 85 90 175 200',
      '2 Fatima Khan 92 95 187 200',
      '3 Bilal Ahmed 40 30 70 200',
    ].join('\n');
    const parsed = parseResultSheet(text);
    expect(parsed.headings).toEqual([]);
    expect(parsed.rows.length).toBe(3);
    expect(parsed.rows[0]!.roll_no).toBe(1);
    expect(parsed.rows[0]!.student_name).toBe('Ahmed Raza');
    expect(parsed.rows[0]!.obtained_marks).toBe(175);
    expect(parsed.rows[0]!.total_marks).toBe(200);
    expect(parsed.rows[1]!.roll_no).toBe(2);
    expect(parsed.rows[2]!.obtained_marks).toBe(70);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it('low-confidence cells: OCR garbage digits score below 0.7', () => {
    const text = [
      'Roll No  Student Name  English  Obtained  Total',
      '1  Ahmed Raza  8S  253  300',
    ].join('\n');
    const parsed = parseResultSheet(text);
    expect(parsed.rows.length).toBe(1);
    expect(rowConfidence(parsed.rows[0]!)).toBeLessThan(0.7);
    expect(parsed.rows[0]!.subject_marks.English).toBe(8);
  });
});

describe('6B results: save, link, toppers, summary', () => {
  async function seedResultsClass(): Promise<{ exam: any }> {
    await seedClasses();
    await seedStudent(); // roll 1 Ahmed Raza
    await studentsSvc.createStudent(db, SCHOOL_A, classA.id, { name: 'Fatima Khan', roll_no: 2, parent_phone: '03003334444', admission_no: 'ADM-002' }, ADMIN);
    await studentsSvc.createStudent(db, SCHOOL_A, classA.id, { name: 'Bilal Ahmed', roll_no: 3, parent_phone: '03005556666', admission_no: 'ADM-003' }, ADMIN);
    const exam = await resultsSvc.upsertExam(db, SCHOOL_A, { name: 'Midterm' });
    return { exam };
  }

  const threeRows = [
    { roll_no: 1, student_name: 'Ahmed Raza', subject_marks: { English: 85, Math: 90 }, obtained_marks: 175, total_marks: 200 },
    { roll_no: 2, student_name: 'Fatima Khan', subject_marks: { English: 92, Math: 95 }, obtained_marks: 187, total_marks: 200 },
    { roll_no: 3, student_name: 'Bilal Ahmed', subject_marks: { English: 40, Math: 30 }, obtained_marks: 70, total_marks: 200 },
  ];

  it('save links by roll, computes positions (dense rank) and grades', async () => {
    const { exam } = await seedResultsClass();
    const out = await resultsSvc.saveResultRows(db, SCHOOL_A, { exam_id: exam.id, class_id: classA.id, rows: threeRows }, ADMIN);
    expect(out.saved).toBe(3);
    expect(out.linked).toBe(3);
    expect(out.unlinked).toBe(0);
    const toppers = await resultsSvc.getToppers(db, SCHOOL_A, { exam_id: exam.id, class_id: classA.id });
    expect(toppers[0]!.student_name).toBe('Fatima Khan'); // 93.5%
    expect(toppers[0]!.position).toBe(1);
    expect(toppers[1]!.student_name).toBe('Ahmed Raza'); // 87.5%
    expect(toppers[1]!.position).toBe(2);
    expect(toppers[2]!.grade).toBe('F'); // 35% -> default band F? 35 < 40 -> F
    expect(toppers[1]!.grade).toBe('A');
  });

  it('ties share a position (dense rank)', async () => {
    const { exam } = await seedResultsClass();
    const rows = [
      { roll_no: 1, student_name: 'Ahmed Raza', obtained_marks: 180, total_marks: 200 },
      { roll_no: 2, student_name: 'Fatima Khan', obtained_marks: 180, total_marks: 200 },
      { roll_no: 3, student_name: 'Bilal Ahmed', obtained_marks: 100, total_marks: 200 },
    ];
    await resultsSvc.saveResultRows(db, SCHOOL_A, { exam_id: exam.id, class_id: classA.id, rows }, ADMIN);
    const toppers = await resultsSvc.getToppers(db, SCHOOL_A, { exam_id: exam.id, class_id: classA.id });
    expect(toppers[0]!.position).toBe(1);
    expect(toppers[1]!.position).toBe(1);
    expect(toppers[2]!.position).toBe(2);
  });

  it('roll/name mismatch stays unlinked with link_mismatch flag; name-only match links', async () => {
    const { exam } = await seedResultsClass();
    const out = await resultsSvc.saveResultRows(db, SCHOOL_A, {
      exam_id: exam.id,
      class_id: classA.id,
      rows: [
        { roll_no: 1, student_name: 'Fatima Khan', obtained_marks: 150, total_marks: 200 }, // roll->Ahmed, name->Fatima
        { roll_no: 9, student_name: 'Bilal Ahmed', obtained_marks: 120, total_marks: 200 }, // no roll 9; name matches
        { roll_no: 10, student_name: 'Nobody Here', obtained_marks: 100, total_marks: 200 }, // no match at all
      ],
    }, ADMIN);
    expect(out.saved).toBe(3);
    expect(out.linked).toBe(1); // Bilal by name
    expect(out.unlinked).toBe(2);
    expect(out.flagged.some((f) => f.roll_no === 1 && f.flags.includes('link_mismatch'))).toBe(true);
    const list = await resultsSvc.listResults(db, SCHOOL_A, { exam_id: exam.id, class_id: classA.id });
    const mismatch = list.items.find((r: any) => r.roll_no === 1);
    expect(mismatch.linked).toBe(false);
    // Explicit link (admin-confirmed) resolves the mismatch.
    const ahmed = await studentsSvc.listStudentsSchoolWide(db, SCHOOL_A, { admission_no: 'ADM-001' });
    const linked = await resultsSvc.linkResult(db, SCHOOL_A, mismatch.id, ahmed.items[0].id, ADMIN);
    expect(linked.studentId).toBe(ahmed.items[0].id);
    // Linking to a student in another class is rejected.
    const foreignClassStudent = await studentsSvc.createStudent(db, SCHOOL_A, classB.id, { name: 'Other Kid', roll_no: 1, admission_no: 'ADM-090' }, ADMIN);
    const unlinkedRow = list.items.find((r: any) => r.roll_no === 10);
    await expect(resultsSvc.linkResult(db, SCHOOL_A, unlinkedRow.id, foreignClassStudent.id, ADMIN)).rejects.toThrow(/same class/);
  });

  it('summary uses the 33% default pass mark; manual entry creates the exam', async () => {
    const { exam } = await seedResultsClass();
    await resultsSvc.saveResultRows(db, SCHOOL_A, { exam_id: exam.id, class_id: classA.id, rows: threeRows }, ADMIN);
    const summary = await resultsSvc.getSummary(db, SCHOOL_A, { exam_id: exam.id, class_id: classA.id });
    expect(summary.total).toBe(3);
    expect(summary.passed).toBe(3); // 93.5, 87.5 and 35% all clear the 33% default bar
    expect(summary.failed).toBe(0);
    // Manual entry with a new exam name creates the exam row.
    const manual = await resultsSvc.saveManualResults(db, SCHOOL_A, {
      exam_name: 'Monthly Test',
      class_id: classA.id,
      rows: [{ roll_no: 1, student_name: 'Ahmed Raza', obtained_marks: 90, total_marks: 100 }],
    }, ADMIN);
    expect(manual.saved).toBe(1);
    const exams = db.exam.findMany({ where: { schoolId: SCHOOL_A, deletedAt: null } });
    expect(exams.some((e: any) => e.name === 'Monthly Test')).toBe(true);
  });

  it('grading scales override the default bands and pass mark', async () => {
    const { exam } = await seedResultsClass();
    db.gradingScale.create({ data: { schoolId: SCHOOL_A, classId: classA.id, minMarks: 90, maxMarks: 100, grade: 'A+', gpaPoints: 4, isPassing: true } });
    db.gradingScale.create({ data: { schoolId: SCHOOL_A, classId: classA.id, minMarks: 0, maxMarks: 32, grade: 'F', gpaPoints: 0, isPassing: false } });
    const threshold = await resultsSvc.passingThreshold(db, SCHOOL_A, classA.id);
    expect(threshold).toBe(90); // lowest passing band min
    const { grade } = await resultsSvc.gradeForPercentage(db, SCHOOL_A, classA.id, 95);
    expect(grade).toBe('A+');
  });

  it('update recomputes percentage/grade and writes change logs', async () => {
    const { exam } = await seedResultsClass();
    await resultsSvc.saveResultRows(db, SCHOOL_A, { exam_id: exam.id, class_id: classA.id, rows: threeRows }, ADMIN);
    const list = await resultsSvc.listResults(db, SCHOOL_A, { exam_id: exam.id, class_id: classA.id });
    const bilal = list.items.find((r: any) => r.roll_no === 3)!;
    const updated = await resultsSvc.updateResult(db, SCHOOL_A, bilal.id, { obtained_marks: 170 }, ADMIN);
    expect(updated.percentage).toBe(85);
    expect(updated.grade).toBe('A');
    const logs = db.changeLog.findMany({ where: { schoolId: SCHOOL_A, entity: 'result', entityId: bilal.id } });
    expect(logs.some((l: any) => l.field === 'obtained_marks')).toBe(true);
  });

  it('upload + review flow with stubbed OCR', async () => {
    await seedClasses();
    await seedStudent();
    const stubOcr = async () => ({
      raw_text: 'Roll No  Student Name  Obtained  Total\n1  Ahmed Raza  175  200\n',
      engine: 'tesseract',
      warnings: [],
    });
    const up = await resultsSvc.uploadResultSheet(db, SCHOOL_A, classA.id, { exam_name: 'Final', file_path: '/tmp/sheet.png' }, ADMIN, { runOcr: stubOcr });
    expect(up.rows.length).toBe(1);
    expect(up.rows[0]!.student_name).toBe('Ahmed Raza');
    const review = await resultsSvc.getSheetForReview(db, SCHOOL_A, up.result_sheet_id);
    const row = (review.rows as any[])[0];
    expect(row.link_preview.studentId).toBeTruthy();
    expect(row.link_preview.method).toBe('roll');
    const saved = await resultsSvc.saveResultRows(db, SCHOOL_A, {
      exam_id: up.exam_id,
      class_id: classA.id,
      result_sheet_id: up.result_sheet_id,
      rows: [{ roll_no: 1, student_name: 'Ahmed Raza', obtained_marks: 175, total_marks: 200 }],
    }, ADMIN);
    expect(saved.saved).toBe(1);
    expect(saved.linked).toBe(1);
    const sheet = db.resultSheet.findFirst({ where: { id: up.result_sheet_id } });
    expect(sheet.status).toBe('saved');
  });

  it('publish creates message drafts for linked parents, skips opted-out and unlinked', async () => {
    const { exam } = await seedResultsClass();
    // Make Bilal's parent opted out.
    const bilal = await studentsSvc.listStudentsSchoolWide(db, SCHOOL_A, { admission_no: 'ADM-003' });
    await studentsSvc.updateStudent(db, SCHOOL_A, bilal.items[0].id, { parent_opt_out: true }, ADMIN);
    const up = await resultsSvc.uploadResultSheet(db, SCHOOL_A, classA.id, { exam_name: 'Midterm', file_path: '/tmp/s.png' }, ADMIN, {
      runOcr: async () => ({ raw_text: '', engine: 'tesseract', warnings: [] }),
    });
    await resultsSvc.saveResultRows(db, SCHOOL_A, {
      exam_id: exam.id,
      class_id: classA.id,
      result_sheet_id: up.result_sheet_id,
      rows: [
        ...threeRows,
        { roll_no: 9, student_name: 'Ghost Kid', obtained_marks: 50, total_marks: 200 }, // unlinked
      ],
    }, ADMIN);
    const pub = await resultsSvc.publishSheetSms(db, SCHOOL_A, up.result_sheet_id, ADMIN);
    expect(pub.drafts_created).toBe(2); // Ahmed + Fatima; Bilal opted out, Ghost unlinked
    expect(pub.skipped.length).toBe(2);
    expect(db.messageDraft.findMany({ where: { schoolId: SCHOOL_A } }).length).toBe(2);
    expect(db.messageDraft.findMany({ where: { schoolId: SCHOOL_A } })[0].status).toBe('draft');
    const sheet = db.resultSheet.findFirst({ where: { id: up.result_sheet_id } });
    expect(sheet.status).toBe('published');
  });
});

describe('6B soft delete / recycle bin + cross-tenant', () => {
  it('delete result + sheet soft-deletes; recycle bin restores them', async () => {
    await seedClasses();
    await seedStudent();
    const exam = await resultsSvc.upsertExam(db, SCHOOL_A, { name: 'Midterm' });
    await resultsSvc.saveResultRows(db, SCHOOL_A, {
      exam_id: exam.id,
      class_id: classA.id,
      rows: [{ roll_no: 1, student_name: 'Ahmed Raza', obtained_marks: 150, total_marks: 200 }],
    }, ADMIN);
    const list = await resultsSvc.listResults(db, SCHOOL_A, { exam_id: exam.id, class_id: classA.id });
    const row = list.items[0]!;
    await resultsSvc.deleteResult(db, SCHOOL_A, row.id, ADMIN);
    await expect(resultsSvc.getResult(db, SCHOOL_A, row.id)).rejects.toThrow(/not found/i);
    const bin = await listRecycleBin(db, SCHOOL_A, { entity: 'result' });
    expect(bin.total).toBe(1);
    await restoreDeletedRecord(db, SCHOOL_A, bin.items[0].id, ADMIN);
    const back = await resultsSvc.getResult(db, SCHOOL_A, row.id);
    expect(back.studentName).toBe('Ahmed Raza');
    // Sheet soft delete also lands in the bin.
    const sheet = await resultsSvc.uploadResultSheet(db, SCHOOL_A, classA.id, { exam_name: 'Final', file_path: '/tmp/x.png' }, ADMIN, {
      runOcr: async () => ({ raw_text: '', engine: 'tesseract', warnings: [] }),
    });
    await resultsSvc.deleteResultSheet(db, SCHOOL_A, sheet.result_sheet_id, ADMIN);
    const bin2 = await listRecycleBin(db, SCHOOL_A, { entity: 'result_sheet' });
    expect(bin2.total).toBe(1);
  });

  it('cross-tenant: school B sees nothing of school A results', async () => {
    await seedClasses();
    await seedStudent();
    const exam = await resultsSvc.upsertExam(db, SCHOOL_A, { name: 'Midterm' });
    await resultsSvc.saveResultRows(db, SCHOOL_A, {
      exam_id: exam.id,
      class_id: classA.id,
      rows: [{ roll_no: 1, student_name: 'Ahmed Raza', obtained_marks: 150, total_marks: 200 }],
    }, ADMIN);
    const list = await resultsSvc.listResults(db, SCHOOL_A, { exam_id: exam.id, class_id: classA.id });
    const rowId = list.items[0]!.id;
    await expect(resultsSvc.getResult(db, SCHOOL_B, rowId)).rejects.toThrow(/not found/i);
    const bList = await resultsSvc.listResults(db, SCHOOL_B, { exam_id: exam.id, class_id: classA.id });
    expect(bList.total).toBe(0);
    await expect(resultsSvc.getToppers(db, SCHOOL_B, { exam_id: exam.id, class_id: classA.id })).rejects.toThrow(/not found/i);
    await expect(resultsSvc.getSummary(db, SCHOOL_B, { exam_id: exam.id, class_id: classA.id })).rejects.toThrow(/not found/i);
    await expect(resultsSvc.deleteResult(db, SCHOOL_B, rowId, ADMIN)).rejects.toThrow(/not found/i);
    await expect(resultsSvc.linkResult(db, SCHOOL_B, rowId, 'whatever', ADMIN)).rejects.toThrow(/not found/i);
  });

  it('export + report card build from saved results', async () => {
    await seedClasses();
    await seedStudent();
    const exam = await resultsSvc.upsertExam(db, SCHOOL_A, { name: 'Midterm' });
    await resultsSvc.saveResultRows(db, SCHOOL_A, {
      exam_id: exam.id,
      class_id: classA.id,
      rows: [{ roll_no: 1, student_name: 'Ahmed Raza', subject_marks: { English: 85, Math: 90 }, obtained_marks: 175, total_marks: 200 }],
    }, ADMIN);
    const xlsx = await resultsSvc.exportResults(db, SCHOOL_A, { format: 'xlsx', exam_id: exam.id, class_id: classA.id });
    expect(xlsx.buffer.length).toBeGreaterThan(100);
    expect(xlsx.contentType).toContain('spreadsheet');
    const pdf = await resultsSvc.exportResults(db, SCHOOL_A, { format: 'pdf', exam_id: exam.id, class_id: classA.id });
    expect(pdf.buffer.length).toBeGreaterThan(100);
    const student = await studentsSvc.listStudentsSchoolWide(db, SCHOOL_A, { admission_no: 'ADM-001' });
    const card = await resultsSvc.getReportCard(db, SCHOOL_A, student.items[0].id, exam.id);
    expect(card.student.name).toBe('Ahmed Raza');
    expect(card.percentage).toBe(87.5);
    expect(card.grade).toBe('A');
    expect(card.position).toBe(1);
    expect(card.school_name).toBe('Demo Public School');
    const html = resultsSvc.renderReportCardHtml(card);
    expect(html).toContain('Demo Public School');
    expect(html).toContain('Ahmed Raza');
    const cardPdf = await resultsSvc.renderReportCardPdf(card);
    expect(cardPdf.length).toBeGreaterThan(100);
  });
});

describe('Fix E (Phase 9): manual entry fields, exam id on save, class-only export, report-card father/remarks', () => {
  it('manual entry auto-creates the exam, returns its id, and stores father_name + remarks', async () => {
    await seedClasses();
    await seedStudent();
    const out = await resultsSvc.saveManualResults(db, SCHOOL_A, {
      exam_name: 'Midterm',
      class_id: classA.id,
      rows: [{ roll_no: 1, student_name: 'Ahmed Raza', father_name: 'Muhammad Raza', obtained_marks: 85, total_marks: 100, remarks: 'Good effort' }],
    }, ADMIN);
    expect(out.saved).toBe(1);
    expect(out.linked).toBe(1);
    // The frontend needs this id to refresh + select the exam in the filter.
    expect(out.exam_id).toBeTruthy();
    expect(out.exam_name).toBe('Midterm');
    const list = await resultsSvc.listResults(db, SCHOOL_A, { exam_id: out.exam_id, class_id: classA.id });
    expect(list.total).toBe(1);
    const row = list.items[0] as any;
    expect(row.father_name).toBe('Muhammad Raza');
    expect(row.remarks).toBe('Good effort');
    expect(row.percentage).toBe(85);
    expect(row.grade).toBe('A');
    expect(row.position).toBe(1);
    // Toppers / summary still work for the auto-created exam.
    const toppers = await resultsSvc.getToppers(db, SCHOOL_A, { exam_id: out.exam_id, class_id: classA.id });
    expect(toppers[0].student_name).toBe('Ahmed Raza');
    const summary = await resultsSvc.getSummary(db, SCHOOL_A, { exam_id: out.exam_id, class_id: classA.id });
    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
  });

  it('export works with no exam_id (All exams) and still works per-exam', async () => {
    await seedClasses();
    await seedStudent();
    const out = await resultsSvc.saveManualResults(db, SCHOOL_A, {
      exam_name: 'Midterm',
      class_id: classA.id,
      rows: [{ roll_no: 1, student_name: 'Ahmed Raza', father_name: 'Muhammad Raza', obtained_marks: 85, total_marks: 100, remarks: 'Good effort' }],
    }, ADMIN);
    const xlsxAll = await resultsSvc.exportResults(db, SCHOOL_A, { format: 'xlsx', class_id: classA.id });
    expect(xlsxAll.buffer.length).toBeGreaterThan(100);
    expect(xlsxAll.contentType).toContain('spreadsheet');
    const pdfAll = await resultsSvc.exportResults(db, SCHOOL_A, { format: 'pdf', class_id: classA.id });
    expect(pdfAll.buffer.length).toBeGreaterThan(100);
    const xlsxOne = await resultsSvc.exportResults(db, SCHOOL_A, { format: 'xlsx', exam_id: out.exam_id, class_id: classA.id });
    expect(xlsxOne.buffer.length).toBeGreaterThan(100);
    await expect(resultsSvc.exportResults(db, SCHOOL_A, { format: 'xlsx' })).rejects.toThrow(/class_id/i);
  });

  it('report card falls back to the result father_name and shows remarks', async () => {
    await seedClasses();
    // Student with NO father on the profile.
    await studentsSvc.createStudent(db, SCHOOL_A, classA.id, { name: 'Noor Fatima', roll_no: 5, parent_phone: '03001112222', admission_no: 'ADM-005' }, ADMIN);
    const out = await resultsSvc.saveManualResults(db, SCHOOL_A, {
      exam_name: 'Midterm',
      class_id: classA.id,
      rows: [{ roll_no: 5, student_name: 'Noor Fatima', father_name: 'Abdul Kareem', obtained_marks: 90, total_marks: 100, remarks: 'Excellent work' }],
    }, ADMIN);
    expect(out.linked).toBe(1);
    const students = await studentsSvc.listStudentsSchoolWide(db, SCHOOL_A, { admission_no: 'ADM-005' });
    const card = await resultsSvc.getReportCard(db, SCHOOL_A, students.items[0].id, out.exam_id);
    expect(card.student.father_name).toBe('Abdul Kareem');
    expect(card.remarks).toContain('Excellent work');
    const html = resultsSvc.renderReportCardHtml(card);
    expect(html).toContain('Abdul Kareem');
    expect(html).toContain('Excellent work');
    const pdf = await resultsSvc.renderReportCardPdf(card);
    expect(pdf.length).toBeGreaterThan(100);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
