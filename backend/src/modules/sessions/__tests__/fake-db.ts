// Shared in-memory fake Prisma DB for the 6C-1 modules (sessions, exams,
// timetable, staff/payroll). Same matcher semantics as
// backend/src/modules/fees/__tests__/fake-db.ts (equality, in, gte/lte,
// contains, startsWith, OR/AND, null = IS NULL, compound-key flattening).
// NOT a Prisma replacement — services are verified against the real
// generated client types via tsc, and the fake only backs vitest.
import crypto from 'node:crypto';

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
  return `fake-${Date.now().toString(36)}-${idSeq}`;
}

export class FakeCollection {
  rows: Row[] = [];
  derive?: (row: Row) => void;

  findUnique(args: { where: any }): Row | null {
    return this.rows.find((r) => matches(r, args.where)) ?? null;
  }
  findFirst(args: { where?: any; orderBy?: any }): Row | null {
    return applyOrderBy(this.rows.filter((r) => matches(r, args.where)), args.orderBy)[0] ?? null;
  }
  findMany(args: { where?: any; orderBy?: any; take?: number; skip?: number } = {}): Row[] {
    let list = applyOrderBy(this.rows.filter((r) => matches(r, args.where)), args.orderBy);
    if (args.skip) list = list.slice(args.skip);
    if (args.take !== undefined) list = list.slice(0, args.take);
    return list;
  }
  count(args: { where?: any } = {}): number {
    return this.rows.filter((r) => matches(r, args.where)).length;
  }
  create(args: { data: Row }): Row {
    const now = new Date();
    const row: Row = { id: nextId(), createdAt: now, updatedAt: now, ...args.data };
    this.derive?.(row);
    this.rows.push(row);
    return row;
  }
  update(args: { where: any; data: Row }): Row {
    const row = this.rows.find((r) => matches(r, args.where));
    if (!row) throw new Error('FakeCollection.update: record not found');
    Object.assign(row, args.data, { updatedAt: new Date() });
    this.derive?.(row);
    return row;
  }
  updateMany(args: { where: any; data: Row }): { count: number } {
    let count = 0;
    for (const row of this.rows.filter((r) => matches(r, args.where))) {
      Object.assign(row, args.data, { updatedAt: new Date() });
      this.derive?.(row);
      count += 1;
    }
    return { count };
  }
  delete(args: { where: any }): Row {
    const idx = this.rows.findIndex((r) => matches(r, args.where));
    if (idx === -1) throw new Error('FakeCollection.delete: record not found');
    return this.rows.splice(idx, 1)[0];
  }
  deleteMany(args: { where?: any } = {}): { count: number } {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, args.where));
    return { count: before - this.rows.length };
  }
}

export class FakeDb {
  school = new FakeCollection();
  user = new FakeCollection();
  class = new FakeCollection();
  student = new FakeCollection();
  academicSession = new FakeCollection();
  promotion = new FakeCollection();
  exam = new FakeCollection();
  gradingScale = new FakeCollection();
  examDatesheet = new FakeCollection();
  timetableEntry = new FakeCollection();
  staff = new FakeCollection();
  staffClassAssignment = new FakeCollection();
  salaryRecord = new FakeCollection();
  auditLog = new FakeCollection();
  changeLog = new FakeCollection();
  deletedRecord = new FakeCollection();
  approvalRequest = new FakeCollection();
  notification = new FakeCollection();
  feeRecord = new FakeCollection();
  attendanceDay = new FakeCollection();
  attendanceRecord = new FakeCollection();
  resultSheet = new FakeCollection();
  result = new FakeCollection();
  holiday = new FakeCollection();
  rolePermission = new FakeCollection();

  async $transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

/** Seed one school with two classes and students in class 5-A. */
export function seed6C1(db: FakeDb): { schoolId: string; classAId: string; classBId: string; studentIds: string[] } {
  const schoolId = 'school-6c1';
  db.school.create({
    data: { id: schoolId, name: 'Demo Public School', slug: 'demo-public', timezone: 'Asia/Karachi', country: 'PK', settings: {} },
  });
  const classA = db.class.create({
    data: { id: 'class-5a', schoolId, name: '5', section: 'A', teacherName: 'Ayesha Khan', deletedAt: null },
  });
  const classB = db.class.create({
    data: { id: 'class-6a', schoolId, name: '6', section: 'A', teacherName: 'Bilal Ahmed', deletedAt: null },
  });
  const studentIds: string[] = [];
  for (const [i, name] of ['Ahmed Raza', 'Sara Khan', 'Usman Ali'].entries()) {
    const s = db.student.create({
      data: { id: `stu-6c1-${i + 1}`, schoolId, classId: classA.id, rollNo: i + 1, name, status: 'active', deletedAt: null },
    });
    studentIds.push(s.id);
  }
  // One student in the other school — every cross-tenant test uses this id.
  db.school.create({
    data: { id: 'school-other', name: 'Other School', slug: 'other-school', timezone: 'Asia/Karachi', country: 'PK', settings: {} },
  });
  db.class.create({
    data: { id: 'class-other', schoolId: 'school-other', name: '5', section: 'A', teacherName: 'Other Teacher', deletedAt: null },
  });
  return { schoolId, classAId: classA.id, classBId: classB.id, studentIds };
}

export const OTHER_SCHOOL_ID = 'school-other';
