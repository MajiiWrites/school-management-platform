// Minimal in-memory fake PrismaClient for the certificates module tests.
// Same matcher semantics as the fees module fake (equality, in, gte/lte,
// contains, OR/AND, NULL-as-undefined) but only the delegates the
// certificates service touches: school, class, student, certificate,
// changeLog, auditLog. No live DB.

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
    const row: Row = { id: nextId(), createdAt: now, updatedAt: now, issuedAt: now, ...args.data };
    this.rows.push(row);
    return row;
  }
}

export class FakeDb {
  school = new FakeCollection();
  class = new FakeCollection();
  student = new FakeCollection();
  certificate = new FakeCollection();
  changeLog = new FakeCollection();
  auditLog = new FakeCollection();

  async $transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

/** Seed one school, one class, one fully-profiled student. */
export function seedCertDemo(db: FakeDb): { school: Row; klass: Row; student: Row } {
  const school = db.school.create({
    data: {
      id: 'school-cert',
      name: 'Cert Test School',
      slug: 'cert-test',
      timezone: 'Asia/Karachi',
      settings: { school_address: '1 Test Road', logo_url: null },
    },
  });
  const klass = db.class.create({
    data: { id: 'class-5a', schoolId: school.id, name: '5', section: 'A' },
  });
  const student = db.student.create({
    data: {
      id: 'stu-cert-1',
      schoolId: school.id,
      classId: klass.id,
      rollNo: 12,
      name: 'Ahmed Raza',
      fatherName: 'Raza Hussain',
      admissionNo: 'ADM-2024-011',
      dateOfBirth: new Date('2015-03-04T00:00:00Z'),
      admissionDate: new Date('2024-04-01T00:00:00Z'),
      status: 'active',
    },
  });
  return { school, klass, student };
}
