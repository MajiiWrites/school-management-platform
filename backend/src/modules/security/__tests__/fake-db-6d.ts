/**
 * Minimal in-memory fake Prisma DB for the 6D tests (same matcher semantics
 * as fees/__tests__/fake-db.ts, extended to every delegate the 6A export +
 * auth + backup job touch). No live DB needed.
 */
import { encryptPhone } from '../../../lib/crypto';

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
  return `fake-6d-${Date.now().toString(36)}-${idSeq}`;
}

export class FakeCollection {
  rows: Row[] = [];

  findUnique(args: { where: any }): Row | null {
    return this.rows.find((r) => matches(r, args.where)) ?? null;
  }

  findFirst(args: { where?: any; orderBy?: any } = {}): Row | null {
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
    this.rows.push(row);
    return row;
  }

  createMany(args: { data: Row[]; skipDuplicates?: boolean }): { count: number } {
    let count = 0;
    for (const data of args.data) {
      const now = new Date();
      this.rows.push({ id: nextId(), createdAt: now, updatedAt: now, ...data });
      count += 1;
    }
    return { count };
  }

  update(args: { where: any; data: Row }): Row {
    const row = this.rows.find((r) => matches(r, args.where));
    if (!row) throw new Error('FakeCollection.update: record not found');
    Object.assign(row, args.data, { updatedAt: new Date() });
    return row;
  }

  updateMany(args: { where: any; data: Row }): { count: number } {
    let count = 0;
    for (const row of this.rows.filter((r) => matches(r, args.where))) {
      Object.assign(row, args.data, { updatedAt: new Date() });
      count += 1;
    }
    return { count };
  }

  delete(args: { where: any }): Row {
    const idx = this.rows.findIndex((r) => matches(r, args.where));
    if (idx === -1) throw new Error('FakeCollection.delete: record not found');
    return this.rows.splice(idx, 1)[0];
  }
}

const DELEGATES = [
  'school', 'user', 'class', 'student', 'attendanceDay', 'attendanceRecord',
  'teacherAttendance', 'feeStructure', 'feeRecord', 'messageTemplate',
  'messageQueue', 'messageDelivery', 'smsDevice', 'holiday', 'academicSession',
  'promotion', 'leaveApplication', 'ocrUpload', 'auditLog', 'notification',
  'rolePermission', 'approvalRequest', 'deletedRecord', 'changeLog', 'exam',
  'gradingScale', 'resultSheet', 'result', 'timetableEntry', 'staff',
  'staffClassAssignment', 'salaryRecord', 'expense', 'announcement', 'event',
  'certificate', 'examDatesheet', 'feeVoucher', 'accountDeletionRequest',
  'schoolBackup', 'messageDraft',
] as const;

export class FakeDb6D {
  [key: string]: any;

  constructor() {
    for (const key of DELEGATES) this[key] = new FakeCollection();
  }

  async $transaction<T>(fn: (tx: FakeDb6D) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async $disconnect(): Promise<void> {
    /* no-op */
  }
}

export interface TwoSchoolSeed {
  schoolA: Row;
  schoolB: Row;
  adminA: Row;
  adminB: Row;
  studentA1: Row;
  studentA2: Row;
  studentB1: Row;
}

/**
 * Two schools with distinct data. Student A1's parent phone is REALLY
 * encrypted (encryptPhone with the process key) so the backup test can prove
 * the export decrypts it; student B1's name/ids must never appear in A's
 * backup (cross-tenant check).
 */
export async function seedTwoSchools(db: FakeDb6D, passwordHash: string): Promise<TwoSchoolSeed> {
  const schoolA = db.school.create({
    data: { id: 'school-a', name: 'Alpha School', slug: 'alpha-school', timezone: 'Asia/Karachi', country: 'PK', settings: {} },
  });
  const schoolB = db.school.create({
    data: { id: 'school-b', name: 'Beta School', slug: 'beta-school', timezone: 'Asia/Karachi', country: 'PK', settings: {} },
  });
  const adminA = db.user.create({
    data: { id: 'admin-a', schoolId: schoolA.id, email: 'admin@alpha.test', passwordHash, role: 'admin', emailVerified: true, totpEnabled: false, loginAlerts: true, lastLoginIp: null },
  });
  const adminB = db.user.create({
    data: { id: 'admin-b', schoolId: schoolB.id, email: 'admin@beta.test', passwordHash, role: 'admin', emailVerified: true, totpEnabled: false, loginAlerts: true, lastLoginIp: null },
  });
  const classA = db.class.create({ data: { id: 'class-a1', schoolId: schoolA.id, name: '5', section: 'A', teacherName: 'Ayesha', teacherPhoneEnc: encryptPhone('+923001111111') } });
  const classB = db.class.create({ data: { id: 'class-b1', schoolId: schoolB.id, name: '5', section: 'A', teacherName: 'Bilal', teacherPhoneEnc: encryptPhone('+923002222222') } });
  const studentA1 = db.student.create({
    data: { id: 'stu-a1', schoolId: schoolA.id, classId: classA.id, rollNo: 1, name: 'Ahmed Raza Alpha', parentName: 'Raza', parentPhoneEnc: encryptPhone('+923001234567'), parentPhoneHash: 'hash-a1', parentOptOut: false, status: 'active' },
  });
  const studentA2 = db.student.create({
    data: { id: 'stu-a2', schoolId: schoolA.id, classId: classA.id, rollNo: 2, name: 'Sara Khan Alpha', parentName: 'Khan', parentPhoneEnc: null, parentPhoneHash: null, parentOptOut: false, status: 'active' },
  });
  const studentB1 = db.student.create({
    data: { id: 'stu-b1', schoolId: schoolB.id, classId: classB.id, rollNo: 1, name: 'Zainab Noor Beta', parentName: 'Noor', parentPhoneEnc: encryptPhone('+923009876543'), parentPhoneHash: 'hash-b1', parentOptOut: false, status: 'active' },
  });
  db.feeStructure.create({ data: { schoolId: schoolA.id, classId: classA.id, monthlyAmount: 2500, effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
  db.feeRecord.create({ data: { schoolId: schoolA.id, studentId: studentA1.id, month: '2026-11', amountDue: 2500, amountPaid: 0, discount: 0 } });
  return { schoolA, schoolB, adminA, adminB, studentA1, studentA2, studentB1 };
}

/** SchoolRow shape the jobs registry passes around. */
export function schoolRowOf(school: Row): { id: string; name: string; slug: string; timezone: string; settings: any } {
  return { id: school.id, name: school.name, slug: school.slug, timezone: school.timezone, settings: school.settings ?? {} };
}
