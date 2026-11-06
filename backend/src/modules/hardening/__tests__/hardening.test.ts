/**
 * Hardening tests (6A) — approval queue, recycle bin, change history,
 * roles/permissions, 2FA, export. Service-level with an in-memory fake DB
 * (same matcher semantics as fees/__tests__/fake-db.ts); no live DB.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { ApiError } from '../../../lib/errors';
import { encryptPhone } from '../../../lib/crypto';
import * as approvals from '../approvals';
import * as recycleBin from '../recycleBin';
import * as hardeningSvc from '../service';
import * as twofa from '../twofa';
import { exportSchoolData, verifyAdminPassword } from '../export';
import { isAllowed, getEffectivePermissions } from '../permissions';
import { requirePermission, requireQueueable } from '../../../middleware/permissions';
import { writeChangeLogs, softDeleteEntity } from '../helpers';
import { login } from '../../auth/service';
import * as studentsSvc from '../../students/service';
import * as classesSvc from '../../classes/service';
import * as adminSvc from '../../admin/service';

process.env.PHONE_ENC_KEY = process.env.PHONE_ENC_KEY ?? crypto.randomBytes(32).toString('base64');

/* ------------------------------------------------------------------ */
/* Fake Prisma DB                                                      */
/* ------------------------------------------------------------------ */

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
      if (!matches(row, cond)) return false; // compound unique key — flatten
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

class FakeCollection {
  rows: Row[] = [];
  derive?: (row: Row) => void;

  findUnique(args: { where: any; select?: any }): Row | null {
    return this.rows.find((r) => matches(r, args.where)) ?? null;
  }
  findFirst(args: { where?: any; orderBy?: any; select?: any }): Row | null {
    const list = applyOrderBy(this.rows.filter((r) => matches(r, args.where)), args.orderBy);
    return list[0] ?? null;
  }
  findMany(args: { where?: any; orderBy?: any; select?: any; take?: number; skip?: number } = {}): Row[] {
    let list = applyOrderBy(this.rows.filter((r) => matches(r, args.where)), args.orderBy);
    if (args.skip) list = list.slice(args.skip);
    if (args.take !== undefined) list = list.slice(0, args.take);
    return list;
  }
  count(args: { where?: any } = {}): number {
    return this.rows.filter((r) => matches(r, args.where)).length;
  }
  groupBy(args: { by: string[]; where?: any; _count?: any }): Row[] {
    const groups = new Map<string, Row>();
    for (const r of this.rows.filter((x) => matches(x, args.where))) {
      const key = args.by.map((b) => String(r[b])).join('|');
      const g = groups.get(key) ?? { ...Object.fromEntries(args.by.map((b) => [b, r[b]])), _count: { _all: 0 } };
      g._count._all += 1;
      groups.set(key, g);
    }
    return [...groups.values()];
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
      const row: Row = { id: nextId(), createdAt: new Date(), updatedAt: new Date(), ...data };
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
  upsert(args: { where: any; update: Row; create: Row }): Row {
    const row = this.rows.find((r) => matches(r, args.where));
    if (row) return this.update({ where: args.where, data: args.update });
    return this.create({ data: args.create });
  }
  delete(args: { where: any }): Row {
    const idx = this.rows.findIndex((r) => matches(r, args.where));
    if (idx === -1) throw new Error('FakeCollection.delete: record not found');
    return this.rows.splice(idx, 1)[0];
  }
  deleteMany(args: { where: any }): { count: number } {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !matches(r, args.where));
    return { count: before - this.rows.length };
  }
}

const COLLECTIONS = [
  'school', 'user', 'class', 'student', 'attendanceDay', 'attendanceRecord', 'teacherAttendance',
  'feeStructure', 'feeRecord', 'messageTemplate', 'messageQueue', 'messageDelivery', 'smsDevice',
  'holiday', 'academicSession', 'promotion', 'leaveApplication', 'ocrUpload', 'auditLog',
  'notification', 'rolePermission', 'approvalRequest', 'deletedRecord', 'changeLog', 'exam',
  'gradingScale', 'resultSheet', 'result', 'timetableEntry', 'staff', 'staffClassAssignment',
  'salaryRecord', 'expense', 'announcement', 'event', 'certificate', 'examDatesheet',
  'feeVoucher', 'accountDeletionRequest', 'schoolBackup', 'messageDraft',
] as const;

class FakeDb {
  constructor() {
    for (const name of COLLECTIONS) (this as any)[name] = new FakeCollection();
    // Mirror the DB GENERATED fee status column.
    (this as any).feeRecord.derive = (r: Row) => {
      const balance = (r.amountDue ?? 0) - (r.amountPaid ?? 0) - (r.discount ?? 0);
      r.status = balance <= 0 ? 'paid' : (r.amountPaid ?? 0) > 0 || (r.discount ?? 0) > 0 ? 'partial' : 'unpaid';
    };
  }
  async $transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

const SCHOOL = 'school-1';

async function seedSchool(db: any) {
  const school = db.school.create({ data: { id: SCHOOL, name: 'Test School', slug: 'test-school', timezone: 'Asia/Karachi', country: 'PK', settings: { fee_auto_send: false } } });
  const adminPw = await bcrypt.hash('Admin1234', 4);
  const clerkPw = await bcrypt.hash('Clerk1234', 4);
  const admin = db.user.create({ data: { id: 'admin-1', schoolId: SCHOOL, email: 'admin@school.pk', passwordHash: adminPw, role: 'admin', emailVerified: true, totpEnabled: false, loginAlerts: true, lastLoginIp: null } });
  const clerk = db.user.create({ data: { id: 'clerk-1', schoolId: SCHOOL, email: 'clerk@school.pk', passwordHash: clerkPw, role: 'clerk', emailVerified: true, totpEnabled: false, loginAlerts: true, lastLoginIp: null } });
  const klass = db.class.create({ data: { id: 'class-1', schoolId: SCHOOL, name: '5', section: 'A', teacherName: 'Ayesha Khan', teacherPhoneEnc: null, teacherPhoneHash: null } });
  return { school, admin, clerk, klass };
}

describe('approval queue', () => {
  let db: any;
  let admin: any;
  let clerk: any;
  let klass: any;

  beforeEach(async () => {
    db = new FakeDb();
    ({ admin, clerk, klass } = await seedSchool(db));
  });

  it('clerk add goes to queue (nothing applied) and admin approve applies it', async () => {
    const req = await approvals.createApprovalRequest(db, {
      schoolId: SCHOOL,
      requestedBy: clerk.id,
      actionType: 'create',
      entity: 'student',
      payload: { class_id: klass.id, name: 'Ahmed Raza', roll_no: 1, parent_name: 'Raza', parent_phone: '03001112233' },
    });
    expect(req.status).toBe('pending');
    // Nothing applied yet: no student row exists.
    expect(db.student.count({ where: { schoolId: SCHOOL } })).toBe(0);
    // Admin approves -> student created from the payload.
    const approved = await approvals.approveApprovalRequest(db, SCHOOL, req.id, admin.id);
    expect(approved.status).toBe('approved');
    expect(approved.applied.student_id).toBeTruthy();
    expect(db.student.count({ where: { schoolId: SCHOOL } })).toBe(1);
    const student = db.student.findFirst({ where: { schoolId: SCHOOL } });
    expect(student.name).toBe('Ahmed Raza');
    // Approval + notification audit trail exists.
    expect(db.auditLog.rows.some((a: any) => a.action === 'approval.approved')).toBe(true);
    expect(db.notification.rows.some((n: any) => n.type === 'approval_requested')).toBe(true);
  });

  it('clerk delete is queued, not applied — until admin approves', async () => {
    const student = await studentsSvc.createStudent(db, SCHOOL, klass.id, { name: 'Sara Khan', roll_no: 2 }, admin.id);
    const req = await approvals.createApprovalRequest(db, {
      schoolId: SCHOOL,
      requestedBy: clerk.id,
      actionType: 'delete',
      entity: 'student',
      entityId: student.id,
      payload: { id: student.id },
    });
    // Still listed (not soft-deleted) while pending.
    const listed = await studentsSvc.listStudents(db, SCHOOL, klass.id, {});
    expect(listed.items).toHaveLength(1);
    await approvals.approveApprovalRequest(db, SCHOOL, req.id, admin.id);
    const after = await studentsSvc.listStudents(db, SCHOOL, klass.id, {});
    expect(after.items).toHaveLength(0);
    expect(db.deletedRecord.count({ where: { schoolId: SCHOOL, entity: 'student' } })).toBe(1);
  });

  it('reject leaves nothing applied and a second decision is a 409', async () => {
    const req = await approvals.createApprovalRequest(db, {
      schoolId: SCHOOL,
      requestedBy: clerk.id,
      actionType: 'create',
      entity: 'student',
      payload: { class_id: klass.id, name: 'No One', roll_no: 9 },
    });
    const rejected = await approvals.rejectApprovalRequest(db, SCHOOL, req.id, admin.id, 'Duplicate name');
    expect(rejected.status).toBe('rejected');
    expect(db.student.count({ where: { schoolId: SCHOOL } })).toBe(0);
    await expect(approvals.approveApprovalRequest(db, SCHOOL, req.id, admin.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('list is scoped: clerks see only their own requests', async () => {
    await approvals.createApprovalRequest(db, { schoolId: SCHOOL, requestedBy: clerk.id, actionType: 'create', entity: 'student', payload: { class_id: klass.id, name: 'A' } });
    await approvals.createApprovalRequest(db, { schoolId: SCHOOL, requestedBy: admin.id, actionType: 'create', entity: 'student', payload: { class_id: klass.id, name: 'B' } });
    const mine = await approvals.listApprovalRequests(db, SCHOOL, {}, clerk.id);
    expect(mine.total).toBe(1);
    const all = await approvals.listApprovalRequests(db, SCHOOL, {}, null);
    expect(all.total).toBe(2);
  });

  it('clerk fee pay goes through the queue and approve pays it', async () => {
    const student = await studentsSvc.createStudent(db, SCHOOL, klass.id, { name: 'Bilal', roll_no: 3 }, admin.id);
    db.feeStructure.create({ data: { schoolId: SCHOOL, classId: klass.id, monthlyAmount: 2500, effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
    const req = await approvals.createApprovalRequest(db, {
      schoolId: SCHOOL,
      requestedBy: clerk.id,
      actionType: 'update',
      entity: 'fee_record',
      payload: { student_id: student.id, month: '2026-11', amount_paid: 2500, payment_method: 'cash' },
    });
    expect(db.feeRecord.count({ where: { schoolId: SCHOOL } })).toBe(0);
    const approved = await approvals.approveApprovalRequest(db, SCHOOL, req.id, admin.id);
    expect(approved.applied.receipt_no).toMatch(/^test-school-202611-/);
    const record = db.feeRecord.findFirst({ where: { schoolId: SCHOOL } });
    expect(record.status).toBe('paid');
  });
});

describe('recycle bin', () => {
  let db: any;
  let admin: any;
  let klass: any;

  beforeEach(async () => {
    db = new FakeDb();
    ({ admin, klass } = await seedSchool(db));
  });

  it('soft delete hides the row + writes a snapshot; restore brings it back', async () => {
    const student = await studentsSvc.createStudent(db, SCHOOL, klass.id, { name: 'Hina', roll_no: 1 }, admin.id);
    await studentsSvc.deleteStudent(db, SCHOOL, student.id, admin.id);
    expect((await studentsSvc.listStudents(db, SCHOOL, klass.id, {})).items).toHaveLength(0);
    const bin = await recycleBin.listRecycleBin(db, SCHOOL, {});
    expect(bin.total).toBe(1);
    expect(bin.items[0].entity).toBe('student');
    expect((bin.items[0].snapshot as any).name).toBe('Hina');
    expect(new Date(bin.items[0].restore_by).getTime()).toBeGreaterThan(Date.now());
    const restored = await recycleBin.restoreDeletedRecord(db, SCHOOL, bin.items[0].id, admin.id);
    expect(restored.restored).toBe(true);
    expect((await studentsSvc.listStudents(db, SCHOOL, klass.id, {})).items).toHaveLength(1);
    expect((await recycleBin.listRecycleBin(db, SCHOOL, {})).total).toBe(0);
  });

  it('permanent delete needs a second confirmation and removes row + snapshot', async () => {
    const student = await studentsSvc.createStudent(db, SCHOOL, klass.id, { name: 'Usman', roll_no: 1 }, admin.id);
    await studentsSvc.deleteStudent(db, SCHOOL, student.id, admin.id);
    const bin = await recycleBin.listRecycleBin(db, SCHOOL, {});
    const binId = bin.items[0].id;
    await expect(recycleBin.permanentDeleteRecord(db, SCHOOL, binId, false, admin.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(recycleBin.permanentDeleteRecord(db, SCHOOL, binId, undefined, admin.id)).rejects.toMatchObject({ code: 'VALIDATION' });
    // Still in the bin after the refused attempts.
    expect((await recycleBin.listRecycleBin(db, SCHOOL, {})).total).toBe(1);
    const done = await recycleBin.permanentDeleteRecord(db, SCHOOL, binId, true, admin.id);
    expect(done.permanently_deleted).toBe(true);
    expect((await recycleBin.listRecycleBin(db, SCHOOL, {})).total).toBe(0);
    expect(db.student.count({ where: { schoolId: SCHOOL } })).toBe(0);
  });

  it('restore after the 30-day window is refused', async () => {
    const student = await studentsSvc.createStudent(db, SCHOOL, klass.id, { name: 'Late', roll_no: 1 }, admin.id);
    await studentsSvc.deleteStudent(db, SCHOOL, student.id, admin.id);
    const bin = await recycleBin.listRecycleBin(db, SCHOOL, {});
    // Age the snapshot past its restore deadline.
    db.deletedRecord.update({ where: { id: bin.items[0].id }, data: { restoreBy: new Date(Date.now() - 1000) } });
    await expect(recycleBin.restoreDeletedRecord(db, SCHOOL, bin.items[0].id, admin.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('class delete is soft too, and still blocked while students exist', async () => {
    await studentsSvc.createStudent(db, SCHOOL, klass.id, { name: 'Kid', roll_no: 1 }, admin.id);
    await expect(classesSvc.deleteClass(db, SCHOOL, klass.id, admin.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    const empty = db.class.create({ data: { schoolId: SCHOOL, name: '6', section: 'B', teacherName: 'T' } });
    await classesSvc.deleteClass(db, SCHOOL, empty.id, admin.id);
    expect(await classesSvc.listClasses(db, SCHOOL)).toHaveLength(1); // only 5-A remains
    expect(db.deletedRecord.count({ where: { entity: 'class' } })).toBe(1);
  });
});

describe('change history', () => {
  let db: any;
  let admin: any;
  let klass: any;

  beforeEach(async () => {
    db = new FakeDb();
    ({ admin, klass } = await seedSchool(db));
  });

  it('records old/new per changed field on student update', async () => {
    const student = await studentsSvc.createStudent(db, SCHOOL, klass.id, { name: 'Old Name', roll_no: 1 }, admin.id);
    await studentsSvc.updateStudent(db, SCHOOL, student.id, { name: 'New Name', status: 'left' }, admin.id);
    const logs = await hardeningSvc.listChangeHistory(db, SCHOOL, { entity: 'student', entity_id: student.id });
    expect(logs.total).toBe(2);
    const byField = new Map(logs.items.map((l: any) => [l.field, l]));
    expect(byField.get('name')).toMatchObject({ old_value: 'Old Name', new_value: 'New Name' });
    expect(byField.get('status')).toMatchObject({ old_value: 'active', new_value: 'left' });
    // Unchanged fields produce no rows.
    expect(byField.has('roll_no')).toBe(false);
  });

  it('records settings changes per key', async () => {
    await adminSvc.updateSettings(db, SCHOOL, { fee_auto_send: true }, admin.id);
    const logs = await hardeningSvc.listChangeHistory(db, SCHOOL, { entity: 'school_settings' });
    expect(logs.total).toBe(1);
    expect(logs.items[0]).toMatchObject({ field: 'fee_auto_send', old_value: 'false', new_value: 'true' });
  });

  it('writeChangeLogs writes one row per changed field and skips unchanged', async () => {
    const n = await writeChangeLogs(db, {
      schoolId: SCHOOL,
      actorId: admin.id,
      entity: 'class',
      entityId: 'c1',
      before: { name: '5', section: 'A', teacher_name: 'X' },
      after: { name: '5', section: 'B', teacher_name: 'X' },
    });
    expect(n).toBe(1);
    expect(db.changeLog.rows[0]).toMatchObject({ field: 'section', oldValue: 'A', newValue: 'B' });
  });
});

describe('roles & permissions', () => {
  let db: any;
  let admin: any;

  beforeEach(async () => {
    db = new FakeDb();
    ({ admin } = await seedSchool(db));
  });

  it('principal is view-only: mutations 403, admin bypasses', async () => {
    const mw = requirePermission('students', 'update');
    const run = (role: string) =>
      new Promise<ApiError | null>((resolve) => {
        const req: any = { user: { role, sub: 'u1', school_id: SCHOOL }, schoolId: SCHOOL };
        mw(req, {} as any, (err?: any) => resolve(err ?? null));
      });
    const principalErr = await run('principal');
    expect(principalErr).toBeInstanceOf(ApiError);
    expect((principalErr as ApiError).code).toBe('FORBIDDEN');
    // Admin bypasses without any DB lookup.
    expect(await run('admin')).toBeNull();
  });

  it('requireQueueable lets clerks submit queue-gated actions, principals never', async () => {
    const run = (mw: any, role: string) =>
      new Promise<ApiError | null>((resolve) => {
        const req: any = { user: { role, sub: 'u1', school_id: SCHOOL }, schoolId: SCHOOL };
        mw(req, {} as any, (err?: any) => resolve(err ?? null));
      });
    // Clerk has NO students.delete cell in the matrix, but the queue is
    // their path: submission applies nothing until an admin approves.
    expect(await run(requireQueueable('students', 'delete'), 'clerk')).toBeNull();
    expect(await run(requireQueueable('students', 'delete'), 'admin')).toBeNull();
    const principalErr = await run(requireQueueable('students', 'delete'), 'principal');
    expect(principalErr).toBeInstanceOf(ApiError);
    expect((principalErr as ApiError).code).toBe('FORBIDDEN');
    // Non-queueable actions stay matrix-gated for clerks.
    const settingsErr = await run(requireQueueable('settings', 'update'), 'clerk');
    expect(settingsErr).toBeInstanceOf(ApiError);
  });

  it('principal may view; clerk matrix allows students.create but not classes.delete', async () => {
    expect(await isAllowed(db, SCHOOL, 'principal', 'students', 'view')).toBe(true);
    expect(await isAllowed(db, SCHOOL, 'principal', 'students', 'create')).toBe(false);
    expect(await isAllowed(db, SCHOOL, 'clerk', 'students', 'create')).toBe(true);
    expect(await isAllowed(db, SCHOOL, 'clerk', 'classes', 'delete')).toBe(false);
    expect(await isAllowed(db, SCHOOL, 'clerk', 'fees', 'update')).toBe(true);
  });

  it('PATCH /roles/permissions customises a cell and it takes effect', async () => {
    // Clerk cannot delete classes by default; grant it, then it is allowed.
    expect(await isAllowed(db, SCHOOL, 'clerk', 'classes', 'delete')).toBe(false);
    await hardeningSvc.updateRolePermission(db, SCHOOL, { role: 'clerk', resource: 'classes', action: 'delete', allowed: true }, admin.id);
    expect(await isAllowed(db, SCHOOL, 'clerk', 'classes', 'delete')).toBe(true);
    // Revoke again.
    await hardeningSvc.updateRolePermission(db, SCHOOL, { role: 'clerk', resource: 'classes', action: 'delete', allowed: false }, admin.id);
    expect(await isAllowed(db, SCHOOL, 'clerk', 'classes', 'delete')).toBe(false);
    // Admin permissions cannot be revoked.
    await expect(
      hardeningSvc.updateRolePermission(db, SCHOOL, { role: 'admin', resource: 'students', action: 'delete', allowed: false }, admin.id),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('effective permissions fall back to the seeded defaults when no rows exist', async () => {
    const perms = await getEffectivePermissions(db, SCHOOL, 'clerk');
    expect(perms.some((p) => p.resource === 'students' && p.action === 'create' && p.allowed)).toBe(true);
    expect(perms.some((p) => p.resource === 'students' && p.action === 'delete')).toBe(false);
  });

  it('createPrincipal creates a view-only principal login', async () => {
    const principal = await hardeningSvc.createPrincipal(db, SCHOOL, { email: 'principal@school.pk', password: 'Principal1' }, admin.id);
    expect(principal.role).toBe('principal');
    const logged = await login(db, { email: 'principal@school.pk', password: 'Principal1' });
    expect('user' in logged && logged.user.role).toBe('principal');
  });
});

describe('2FA', () => {
  let db: any;
  let admin: any;

  beforeEach(async () => {
    db = new FakeDb();
    ({ admin } = await seedSchool(db));
  });

  it('setup -> verify -> login needs 2FA -> second step issues JWTs', async () => {
    const setup = await twofa.setupTwofa(db, admin);
    expect(setup.otpauth_url).toMatch(/^otpauth:\/\/totp\//);
    expect(setup.secret).toBeTruthy();
    // Secret is NOT stored before verify.
    expect(db.user.findUnique({ where: { id: admin.id } }).totpSecretEnc).toBeFalsy();
    const code = twofa.generateTotpCodeForTest(setup.secret);
    const verified = await twofa.verifyTwofaSetup(db, admin, code);
    expect(verified.enabled).toBe(true);
    const stored = db.user.findUnique({ where: { id: admin.id } });
    expect(stored.totpEnabled).toBe(true);
    expect(stored.totpSecretEnc).toBeTruthy();
    expect(stored.totpSecretEnc).not.toContain(setup.secret);
    // Wrong code is rejected at verify time.
    await expect(twofa.verifyTwofaSetup(db, admin, '000000', setup.secret)).rejects.toMatchObject({ code: 'VALIDATION' });

    // Password step now returns needs_2fa + temp token instead of JWTs.
    const step1 = await login(db, { email: 'admin@school.pk', password: 'Admin1234' });
    expect(step1).toMatchObject({ needs_2fa: true });
    expect((step1 as any).temp_token).toBeTruthy();
    // Inline code completes the login directly.
    const inline = await login(db, { email: 'admin@school.pk', password: 'Admin1234' }, { totpCode: twofa.generateTotpCodeForTest(setup.secret) });
    expect('access' in inline && inline.access).toBeTruthy();
    // Second-step login with the temp token.
    const step2 = await twofa.completeTwofaLogin(db, (step1 as any).temp_token, twofa.generateTotpCodeForTest(setup.secret));
    expect(step2.access).toBeTruthy();
    // Wrong code on the second step fails.
    await expect(twofa.completeTwofaLogin(db, (step1 as any).temp_token, '000000')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('disable requires the password and clears 2FA', async () => {
    const setup = await twofa.setupTwofa(db, admin);
    await twofa.verifyTwofaSetup(db, admin, twofa.generateTotpCodeForTest(setup.secret));
    await expect(twofa.disableTwofa(db, admin, 'WrongPass')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const disabled = await twofa.disableTwofa(db, admin, 'Admin1234');
    expect(disabled.enabled).toBe(false);
    const stored = db.user.findUnique({ where: { id: admin.id } });
    expect(stored.totpEnabled).toBe(false);
    expect(stored.totpSecretEnc).toBeNull();
    // Login works without 2FA again.
    const logged = await login(db, { email: 'admin@school.pk', password: 'Admin1234' });
    expect('access' in logged && logged.access).toBeTruthy();
  });

  it('login from a new IP creates a "New login" notification and updates last_login_ip', async () => {
    await login(db, { email: 'admin@school.pk', password: 'Admin1234' }, { ip: '1.2.3.4' });
    expect(db.notification.rows).toHaveLength(0); // first login: no previous IP to compare
    expect(db.user.findUnique({ where: { id: admin.id } }).lastLoginIp).toBe('1.2.3.4');
    await login(db, { email: 'admin@school.pk', password: 'Admin1234' }, { ip: '5.6.7.8' });
    expect(db.notification.rows).toHaveLength(1);
    expect(db.notification.rows[0].title).toBe('New login from 5.6.7.8');
    expect(db.user.findUnique({ where: { id: admin.id } }).lastLoginIp).toBe('5.6.7.8');
  });
});

describe('data ownership', () => {
  let db: any;
  let admin: any;
  let klass: any;

  beforeEach(async () => {
    db = new FakeDb();
    ({ admin, klass } = await seedSchool(db));
  });

  it('export requires the correct admin password', async () => {
    await expect(verifyAdminPassword(db, admin.id, '')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(verifyAdminPassword(db, admin.id, 'WrongPass')).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await verifyAdminPassword(db, admin.id, 'Admin1234');
  });

  it('export includes all tables with full decrypted phones + audit log', async () => {
    const phone = '03001112233';
    await studentsSvc.createStudent(db, SCHOOL, klass.id, { name: 'Export Kid', roll_no: 1, parent_phone: phone }, admin.id);
    const out = await exportSchoolData(db, SCHOOL, admin.id);
    expect(out.school_id).toBe(SCHOOL);
    const tables = out.tables as Record<string, any[]>;
    expect(tables.students).toHaveLength(1);
    expect(tables.students[0].parent_phone).toBe('+923001112233');
    expect(tables.classes).toHaveLength(1);
    expect(tables.users).toHaveLength(2);
    // No credential material leaks into the export.
    expect(tables.users[0].passwordHash).toBeUndefined();
    expect(tables.users[0].totpSecretEnc).toBeUndefined();
    expect(db.auditLog.rows.some((a: any) => a.action === 'data.export')).toBe(true);
  });

  it('account deletion request is created pending; execution stays manual', async () => {
    const created = await hardeningSvc.createAccountDeletionRequest(db, SCHOOL, admin.id);
    expect(created.status).toBe('pending');
    // A second pending request is refused.
    await expect(hardeningSvc.createAccountDeletionRequest(db, SCHOOL, admin.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    // No data was deleted by the request itself.
    expect(db.school.count({ where: { id: SCHOOL } })).toBe(1);
    const decided = await hardeningSvc.decideAccountDeletionRequest(db, SCHOOL, created.id, 'approved', admin.id);
    expect(decided.status).toBe('approved');
    expect(db.school.count({ where: { id: SCHOOL } })).toBe(1); // still there — manual step
  });

  it('backups list reads the school_backups log', async () => {
    db.schoolBackup.create({ data: { schoolId: SCHOOL, fileRef: 's3://backups/2026-11-06.dump', sizeBytes: 12345 } });
    const items = await hardeningSvc.listBackups(db, SCHOOL);
    expect(items).toHaveLength(1);
    expect(items[0].fileRef).toContain('2026-11-06');
  });
});

describe('soft-delete helpers', () => {
  it('softDeleteEntity rejects unknown entities and double deletes', async () => {
    const db: any = new FakeDb();
    const { admin, klass } = await seedSchool(db);
    await expect(softDeleteEntity(db, { schoolId: SCHOOL, entity: 'holiday', entityId: 'x' })).rejects.toMatchObject({ code: 'VALIDATION' });
    const student = await studentsSvc.createStudent(db, SCHOOL, klass.id, { name: 'Dup', roll_no: 1 }, admin.id);
    await softDeleteEntity(db, { schoolId: SCHOOL, entity: 'student', entityId: student.id, deletedBy: admin.id });
    // Already soft-deleted: the row is found but flagged, so this is a 409, not a 404.
    await expect(softDeleteEntity(db, { schoolId: SCHOOL, entity: 'student', entityId: student.id, deletedBy: admin.id })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});
