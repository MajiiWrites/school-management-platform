// In-memory fake PrismaClient for unit tests. Implements ONLY the subset of
// the Prisma API this module uses (findUnique/findFirst/findMany/create/
// createMany/update/updateMany/delete/count/$transaction), with the same
// where-operator semantics the service relies on (equality, in, gte/lte,
// contains, startsWith, OR, nested compound keys). It is NOT a Prisma
// replacement — the service is verified against the real generated client
// types via tsc (see jobs/README.md), and QA adds end-to-end tests.

type Row = Record<string, any>;

function isOperatorObject(cond: any): boolean {
  if (cond === null || typeof cond !== 'object' || cond instanceof Date || Array.isArray(cond)) return false;
  return Object.keys(cond).some((k) =>
    ['equals', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'endsWith', 'mode'].includes(k),
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
      if ('contains' in c) {
        const hay = String(val ?? '');
        const needle = String(c.contains);
        const ok = c.mode === 'insensitive'
          ? hay.toLowerCase().includes(needle.toLowerCase())
          : hay.includes(needle);
        if (!ok) return false;
      }
      if ('startsWith' in c && !String(val ?? '').startsWith(String(c.startsWith))) return false;
      if ('endsWith' in c && !String(val ?? '').endsWith(String(c.endsWith))) return false;
    } else if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      // Nested object: compound unique key (e.g. { studentId_month: {...} }) — flatten.
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

function applySelect(rows: Row[], select: any): Row[] {
  if (!select) return rows;
  return rows.map((r) => {
    const out: Row = {};
    for (const key of Object.keys(select)) if (select[key]) out[key] = r[key];
    return out;
  });
}

let idSeq = 0;
function nextId(): string {
  idSeq += 1;
  return `fake-${Date.now().toString(36)}-${idSeq}`;
}

export class FakeCollection {
  rows: Row[] = [];
  /** Unique key extractor for createMany skipDuplicates (per collection). */
  uniqueKey?: (row: Row) => string;
  /**
   * Post-write hook. The feeRecord collection uses it to mirror the DB's
   * GENERATED status column (Postgres computes status from the amounts;
   * see prisma/migrations/.../migration.sql) so tests see the same values
   * the real database would return.
   */
  derive?: (row: Row) => void;

  findUnique(args: { where: any; select?: any }): Row | null {
    const found = this.rows.find((r) => matches(r, args.where)) ?? null;
    return found ? applySelect([found], args.select)[0] : null;
  }

  findFirst(args: { where?: any; orderBy?: any; select?: any }): Row | null {
    const list = applyOrderBy(this.rows.filter((r) => matches(r, args.where)), args.orderBy);
    const found = list[0] ?? null;
    return found ? applySelect([found], args.select)[0] : null;
  }

  findMany(args: { where?: any; orderBy?: any; select?: any; take?: number; skip?: number } = {}): Row[] {
    let list = applyOrderBy(this.rows.filter((r) => matches(r, args.where)), args.orderBy);
    if (args.skip) list = list.slice(args.skip);
    if (args.take !== undefined) list = list.slice(0, args.take);
    return applySelect(list, args.select);
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

  createMany(args: { data: Row[]; skipDuplicates?: boolean }): { count: number } {
    let count = 0;
    for (const data of args.data) {
      if (args.skipDuplicates && this.uniqueKey) {
        const key = this.uniqueKey({ ...data });
        if (this.rows.some((r) => this.uniqueKey!(r) === key)) continue;
      }
      const now = new Date();
      const row: Row = { id: nextId(), createdAt: now, updatedAt: now, ...data };
      this.derive?.(row);
      this.rows.push(row);
      count += 1;
    }
    return { count };
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
}

export class FakeDb {
  school = new FakeCollection();
  class = new FakeCollection();
  student = new FakeCollection();
  attendanceDay = new FakeCollection();
  teacherAttendance = new FakeCollection();
  feeStructure = new FakeCollection();
  feeRecord = new FakeCollection();
  messageTemplate = new FakeCollection();
  messageQueue = new FakeCollection();
  holiday = new FakeCollection();
  notification = new FakeCollection();
  auditLog = new FakeCollection();

  constructor() {
    this.feeRecord.uniqueKey = (r) => `${r.studentId}|${r.month}`;
    this.messageQueue.uniqueKey = (r) => r.dedupeKey;
    // Mirror the DB GENERATED column: status from amounts.
    this.feeRecord.derive = (r) => {
      const balance = (r.amountDue ?? 0) - (r.amountPaid ?? 0) - (r.discount ?? 0);
      r.status = balance <= 0 ? 'paid' : (r.amountPaid ?? 0) > 0 || (r.discount ?? 0) > 0 ? 'partial' : 'unpaid';
    };
  }

  async $transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

/** Seed one demo school with classes/students/structures/templates. */
export function seedDemo(db: FakeDb): {
  school: Row;
  classes: Row[];
  students: Row[];
} {
  const school = db.school.create({
    data: {
      id: 'school-demo',
      name: 'Demo Public School',
      slug: 'demo-public',
      timezone: 'Asia/Karachi',
      country: 'PK',
      settings: { teacher_reminder_time: '15:00', fee_auto_send: false, fee_followup_day: 10, pending_check_time: '16:00' },
    },
  });
  const classA = db.class.create({
    data: { id: 'class-5a', schoolId: school.id, name: '5', section: 'A', teacherName: 'Ayesha Khan', teacherPhoneEnc: 'enc-teacher-5a' },
  });
  const classB = db.class.create({
    data: { id: 'class-6b', schoolId: school.id, name: '6', section: 'B', teacherName: 'Bilal Ahmed', teacherPhoneEnc: 'enc-teacher-6b' },
  });
  const classC = db.class.create({
    data: { id: 'class-1a', schoolId: school.id, name: '1', section: 'A', teacherName: 'Fatima Noor', teacherPhoneEnc: null },
  });

  const students: Row[] = [];
  const mk = (id: string, classId: string, rollNo: number, name: string, phone: string | null, optOut = false, status = 'active') =>
    students.push(
      db.student.create({
        data: {
          id,
          schoolId: school.id,
          classId,
          rollNo,
          name,
          parentName: `Parent of ${name}`,
          parentPhoneEnc: phone,
          parentPhoneHash: phone ? `hash-${phone}` : null,
          parentOptOut: optOut,
          status,
        },
      }),
    );
  mk('stu-1', classA.id, 1, 'Ahmed Raza', 'enc-parent-1');
  mk('stu-2', classA.id, 2, 'Sara Khan', 'enc-parent-2');
  mk('stu-3', classA.id, 3, 'Usman Ali', null); // no phone
  mk('stu-4', classB.id, 1, 'Hina Malik', 'enc-parent-4', true); // opted out
  mk('stu-5', classB.id, 2, 'Zainab Noor', 'enc-parent-5');
  mk('stu-6', classC.id, 1, 'Ali Hassan', 'enc-parent-6', false, 'left'); // inactive

  for (const c of [classA, classB, classC]) {
    db.feeStructure.create({
      data: { schoolId: school.id, classId: c.id, monthlyAmount: 2500, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
    });
  }

  db.messageTemplate.create({
    data: {
      schoolId: school.id,
      type: 'fee_reminder',
      language: 'en',
      body: 'Dear Parent, the fee of {student_name} (Class {class}) for {month} is due. Amount: {amount}. Please pay at the earliest. – {school_name}',
      isActive: true,
    },
  });
  db.messageTemplate.create({
    data: {
      schoolId: school.id,
      type: 'teacher_reminder',
      language: 'en',
      body: 'Reminder: attendance for Class {class} on {date} has not been submitted yet. Please submit it today. – {school_name}',
      isActive: true,
    },
  });

  return { school, classes: [classA, classB, classC], students };
}

/** The demo school row as a jobs SchoolRow. */
export function demoSchoolRow(db: FakeDb): { id: string; name: string; slug: string; timezone: string; settings: any } {
  const s = db.school.findUnique({ where: { id: 'school-demo' } });
  if (!s) throw new Error('seedDemo was not called before demoSchoolRow');
  return { id: s.id, name: s.name, slug: s.slug, timezone: s.timezone, settings: s.settings };
}
