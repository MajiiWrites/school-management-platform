/**
 * Cross-tenant isolation tests (ISOLATION-AUDIT 2026-11-06).
 *
 * Two fully-seeded schools (Alpha / Beta) share one fake DB. Every test
 * attempts to read / update / delete / approve / poll School A's data while
 * acting as School B's admin (or device), and asserts it fails with 404 /
 * 403 / 409 — never 200 with A's data — or returns empty.
 *
 * No live DB: the fake mirrors the Prisma where-operator semantics the
 * services rely on (equality, in, contains, startsWith, gte/lte, OR, `not`,
 * compound unique keys, Date equality). The live-DB twin of these probes is
 * backend/src/modules/isolation/live-cross-tenant.sh.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { ApiError } from '../../../lib/errors';
import { encryptPhone, sha256Hex } from '../../../lib/crypto';
import { requireSchool } from '../../../middleware/tenant';
import { getJobsStatus } from '../../../jobs/registry';
import * as classesSvc from '../../classes/service';
import * as studentsSvc from '../../students/service';
import * as feesSvc from '../../fees/service';
import * as adminSvc from '../../admin/service';
import * as attendanceSvc from '../../attendance/service';
import * as reportsSvc from '../../reports/service';
import { signup } from '../../auth/service';
import {
  approveMessages,
  buildAbsentDrafts,
  editQueueBody,
  getDeviceQueue,
  reportDelivery,
  retryFailed,
  type ServiceDeps,
} from '../../messaging/service';
import {
  createPrismaMessagingStore,
  type AuditLogInput,
  type DeviceRow,
  type DraftApproval,
  type DraftRow,
  type MessagingStore,
  type QueueRow,
  type TemplateRow,
} from '../../messaging/store';
import { DEFAULT_TEMPLATES } from '../../messaging/templates';
import { localDateString } from '../../../jobs/date-utils';
import { OcrService, type OcrDb, type UploadRecord } from '../../ocr/service';
import { prismaOcrDb } from '../../ocr/prisma-adapter';

process.env.PHONE_ENC_KEY =
  process.env.PHONE_ENC_KEY ?? crypto.randomBytes(32).toString('base64');

/* ------------------------------------------------------------------ */
/* Fake Prisma DB (same matcher semantics as fees/__tests__/fake-db.ts) */
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
          if (val === null) return false;
        } else if (val === c.not) return false;
      }
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
    } else if (cond === null) {
      // Prisma `field: null` means IS NULL; fake rows created without the
      // field carry `undefined`, which is NULL here (6A: deletedAt filters).
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
  return `fake-${idSeq}`;
}

class FakeCollection {
  rows: Row[] = [];
  uniqueKey?: (row: Row) => string;
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
  upsert(args: { where: any; update: Row; create: Row }): Row {
    const row = this.rows.find((r) => matches(r, args.where));
    if (row) {
      Object.assign(row, args.update, { updatedAt: new Date() });
      this.derive?.(row);
      return row;
    }
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

class FakeDb {
  school = new FakeCollection();
  user = new FakeCollection();
  class = new FakeCollection();
  student = new FakeCollection();
  attendanceDay = new FakeCollection();
  attendanceRecord = new FakeCollection();
  teacherAttendance = new FakeCollection();
  feeStructure = new FakeCollection();
  feeRecord = new FakeCollection();
  messageTemplate = new FakeCollection();
  messageQueue = new FakeCollection();
  messageDelivery = new FakeCollection();
  smsDevice = new FakeCollection();
  holiday = new FakeCollection();
  academicSession = new FakeCollection();
  promotion = new FakeCollection();
  ocrUpload = new FakeCollection();
  auditLog = new FakeCollection();
  notification = new FakeCollection();
  // v2 collections (6A hardening: soft delete writes deletedRecord rows,
  // edits write changeLog rows, approvals/permissions are read).
  rolePermission = new FakeCollection();
  approvalRequest = new FakeCollection();
  deletedRecord = new FakeCollection();
  changeLog = new FakeCollection();
  exam = new FakeCollection();
  gradingScale = new FakeCollection();
  resultSheet = new FakeCollection();
  result = new FakeCollection();
  timetableEntry = new FakeCollection();
  staff = new FakeCollection();
  staffClassAssignment = new FakeCollection();
  salaryRecord = new FakeCollection();
  expense = new FakeCollection();
  announcement = new FakeCollection();
  event = new FakeCollection();
  certificate = new FakeCollection();
  examDatesheet = new FakeCollection();
  feeVoucher = new FakeCollection();
  accountDeletionRequest = new FakeCollection();
  schoolBackup = new FakeCollection();
  messageDraft = new FakeCollection();

  constructor() {
    this.feeRecord.uniqueKey = (r) => `${r.studentId}|${r.month}`;
    this.messageQueue.uniqueKey = (r) => r.dedupeKey;
    this.feeRecord.derive = (r) => {
      const balance = (r.amountDue ?? 0) - (r.amountPaid ?? 0) - (r.discount ?? 0);
      r.status = balance <= 0 ? 'paid' : (r.amountPaid ?? 0) > 0 || (r.discount ?? 0) > 0 ? 'partial' : 'unpaid';
    };
  }

  async $transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

/* ------------------------------------------------------------------ */
/* Two-school fixture                                                  */
/* ------------------------------------------------------------------ */

const DAY = '2026-11-06'; // a Friday
const MONTH = '2026-11';

interface Fixture {
  db: FakeDb;
}

function seedTwoSchools(): Fixture {
  const db = new FakeDb();
  const mkSchool = (id: string, name: string, slug: string) =>
    db.school.create({ data: { id, name, slug, timezone: 'Asia/Karachi', country: 'PK', settings: {} } });
  const schoolA = mkSchool('school-a', 'Alpha Public School', 'alpha-public');
  const schoolB = mkSchool('school-b', 'Beta Public School', 'beta-public');

  const mkUser = (id: string, schoolId: string, email: string, role: string) =>
    db.user.create({ data: { id, schoolId, email, passwordHash: 'x', role, emailVerified: true, lastLoginAt: null } });
  mkUser('admin-a', 'school-a', 'admin@alpha.test', 'admin');
  mkUser('clerk-a', 'school-a', 'clerk@alpha.test', 'clerk');
  mkUser('admin-b', 'school-b', 'admin@beta.test', 'admin');
  mkUser('clerk-b', 'school-b', 'clerk@beta.test', 'clerk');

  const mkClass = (id: string, schoolId: string, name: string, section: string, teacher: string, phone: string | null) =>
    db.class.create({
      data: {
        id, schoolId, name, section, teacherName: teacher,
        teacherPhoneEnc: phone ? encryptPhone(phone) : null,
        teacherPhoneHash: phone ? sha256Hex(phone) : null,
        attendanceTokenHash: null, tokenExpiresAt: null, tokenRevoked: false,
      },
    });
  // Same display name (5-A) in both schools: uniqueness must be per-school.
  mkClass('class-a-5a', 'school-a', '5', 'A', 'Ayesha Khan', '+923001111111');
  mkClass('class-a-6b', 'school-a', '6', 'B', 'Bilal Ahmed', '+923001111112');
  mkClass('class-b-5a', 'school-b', '5', 'A', 'Bilal Ahmed', '+923002222221');
  mkClass('class-b-1a', 'school-b', '1', 'A', 'Fatima Noor', null);

  const mkStudent = (id: string, schoolId: string, classId: string, rollNo: number, name: string, phone: string | null) =>
    db.student.create({
      data: {
        id, schoolId, classId, rollNo, name, nameUr: null,
        parentName: `Parent of ${name}`,
        parentPhoneEnc: phone ? encryptPhone(phone) : null,
        parentPhoneHash: phone ? sha256Hex(phone) : null,
        parentOptOut: false, status: 'active',
      },
    });
  mkStudent('stu-a1', 'school-a', 'class-a-5a', 1, 'Ahmed Raza', '+923001111111');
  mkStudent('stu-a2', 'school-a', 'class-a-5a', 2, 'Sara Ahmed', '+923001111113');
  mkStudent('stu-b1', 'school-b', 'class-b-5a', 1, 'Bilal Ahmed', '+923002222222');
  mkStudent('stu-b2', 'school-b', 'class-b-5a', 2, 'Hina Bibi', '+923002222223');

  for (const schoolId of ['school-a', 'school-b']) {
    for (const type of ['absent', 'fee_reminder', 'teacher_reminder'] as const) {
      for (const language of ['en', 'ur'] as const) {
        db.messageTemplate.create({
          data: { id: `tpl-${schoolId}-${type}-${language}`, schoolId, type, language, body: (DEFAULT_TEMPLATES as any)[type][language], isActive: true },
        });
      }
    }
  }

  for (const [schoolId, classId] of [['school-a', 'class-a-5a'], ['school-a', 'class-a-6b'], ['school-b', 'class-b-5a'], ['school-b', 'class-b-1a']] as const) {
    db.feeStructure.create({ data: { id: `fs-${classId}`, schoolId, classId, monthlyAmount: 2500, effectiveFrom: new Date('2026-01-01T00:00:00Z') } });
  }
  // A already paid in full (receipt exists); B's student is unpaid.
  db.feeRecord.create({ data: { id: 'fr-a1', schoolId: 'school-a', studentId: 'stu-a1', month: MONTH, amountDue: 2500, amountPaid: 2500, discount: 0, receiptNo: 'alpha-202611-001', paymentMethod: 'cash', paidAt: new Date('2026-11-02T00:00:00Z'), markedBy: 'admin-a' } });
  db.feeRecord.create({ data: { id: 'fr-b1', schoolId: 'school-b', studentId: 'stu-b1', month: MONTH, amountDue: 2500, amountPaid: 0, discount: 0, receiptNo: null, paymentMethod: null, paidAt: null, markedBy: null } });

  db.messageQueue.create({
    data: { id: 'q-a1', schoolId: 'school-a', type: 'absent', studentId: 'stu-a1', classId: 'class-a-5a', parentPhoneEnc: encryptPhone('+923001111111'), body: 'Ahmed Raza absent', status: 'queued', attempts: 0, dedupeKey: `absent:stu-a1:${DAY}`, scheduledFor: new Date(`${DAY}T09:00:00Z`), sentAt: null, error: null, approvedBy: null, approvedAt: null },
  });
  db.messageQueue.create({
    data: { id: 'q-b1', schoolId: 'school-b', type: 'absent', studentId: 'stu-b1', classId: 'class-b-5a', parentPhoneEnc: encryptPhone('+923002222222'), body: 'Bilal Ahmed absent', status: 'queued', attempts: 0, dedupeKey: `absent:stu-b1:${DAY}`, scheduledFor: new Date(`${DAY}T09:00:00Z`), sentAt: null, error: null, approvedBy: null, approvedAt: null },
  });

  db.smsDevice.create({ data: { id: 'devrow-a1', schoolId: 'school-a', deviceId: 'dev-a1', name: 'Alpha phone', lastSeenAt: null, status: 'offline', pushToken: null } });
  db.smsDevice.create({ data: { id: 'devrow-b1', schoolId: 'school-b', deviceId: 'dev-b1', name: 'Beta phone', lastSeenAt: null, status: 'offline', pushToken: null } });

  db.attendanceDay.create({ data: { id: 'day-a1', schoolId: 'school-a', classId: 'class-a-5a', date: new Date(`${DAY}T00:00:00Z`), submittedBy: 'teacher_link', submittedAt: new Date(`${DAY}T09:00:00Z`), unlocked: false, unlockedBy: null } });
  db.attendanceRecord.create({ data: { id: 'ar-a1', attendanceDayId: 'day-a1', studentId: 'stu-a1', status: 'present', markedAt: new Date(), updatedBy: 'teacher_link' } });
  db.attendanceRecord.create({ data: { id: 'ar-a2', attendanceDayId: 'day-a1', studentId: 'stu-a2', status: 'absent', markedAt: new Date(), updatedBy: 'teacher_link' } });
  db.attendanceDay.create({ data: { id: 'day-b1', schoolId: 'school-b', classId: 'class-b-5a', date: new Date(`${DAY}T00:00:00Z`), submittedBy: 'teacher_link', submittedAt: new Date(`${DAY}T09:00:00Z`), unlocked: false, unlockedBy: null } });
  db.attendanceRecord.create({ data: { id: 'ar-b1', attendanceDayId: 'day-b1', studentId: 'stu-b1', status: 'present', markedAt: new Date(), updatedBy: 'teacher_link' } });

  db.teacherAttendance.create({ data: { id: 'ta-a1', schoolId: 'school-a', classId: 'class-a-5a', date: new Date(`${DAY}T00:00:00Z`), status: 'present', markedBy: 'admin-a', note: null } });
  db.teacherAttendance.create({ data: { id: 'ta-b1', schoolId: 'school-b', classId: 'class-b-5a', date: new Date(`${DAY}T00:00:00Z`), status: 'absent', markedBy: 'admin-b', note: null } });

  db.holiday.create({ data: { id: 'hol-a', schoolId: 'school-a', date: new Date('2026-11-09T00:00:00Z'), name: 'Iqbal Day' } });
  db.holiday.create({ data: { id: 'hol-b', schoolId: 'school-b', date: new Date('2026-11-10T00:00:00Z'), name: 'Beta Day' } });

  db.academicSession.create({ data: { id: 'sess-a1', schoolId: 'school-a', name: '2026-27', startDate: new Date('2026-04-01T00:00:00Z'), endDate: new Date('2027-03-31T00:00:00Z'), isCurrent: true } });
  db.academicSession.create({ data: { id: 'sess-b1', schoolId: 'school-b', name: '2026-27', startDate: new Date('2026-04-01T00:00:00Z'), endDate: new Date('2027-03-31T00:00:00Z'), isCurrent: true } });

  db.notification.create({ data: { id: 'n-a1', schoolId: 'school-a', type: 'absent_approval', title: 'Alpha notice', body: 'Alpha body', relatedType: null, relatedId: null, isRead: false } });
  db.notification.create({ data: { id: 'n-b1', schoolId: 'school-b', type: 'absent_approval', title: 'Beta notice', body: 'Beta body', relatedType: null, relatedId: null, isRead: false } });
  db.auditLog.create({ data: { id: 'al-a1', schoolId: 'school-a', actorId: 'admin-a', actorType: 'user', action: 'class.create', entity: 'class', entityId: 'class-a-5a', details: {} } });
  db.auditLog.create({ data: { id: 'al-b1', schoolId: 'school-b', actorId: 'admin-b', actorType: 'user', action: 'class.create', entity: 'class', entityId: 'class-b-5a', details: {} } });

  void schoolA;
  void schoolB;
  return { db };
}

const A = 'school-a';
const B = 'school-b';
const ADMIN_B = 'admin-b';

async function expectNotFound(p: Promise<unknown>): Promise<void> {
  await expect(p).rejects.toMatchObject({ code: 'NOT_FOUND' });
}

describe('cross-tenant isolation: School B vs School A', () => {
  let db: FakeDb;
  beforeEach(() => {
    db = seedTwoSchools().db;
  });

  it('sanity: each school sees only its own data in the fixture', async () => {
    expect(await classesSvc.listClasses(db as any, A)).toHaveLength(2);
    expect(await classesSvc.listClasses(db as any, B)).toHaveLength(2);
    expect((await studentsSvc.listStudents(db as any, A, 'class-a-5a', {})).total).toBe(2);
    expect((await studentsSvc.listStudents(db as any, B, 'class-b-5a', {})).total).toBe(2);
  });

  describe('tenant middleware: forged school_id', () => {
    it('rejects school_id in the request body', () => {
      const errors: unknown[] = [];
      const next = (e?: unknown) => {
        if (e) errors.push(e);
      };
      requireSchool(
        { user: { school_id: B }, body: { school_id: A, name: '9', section: 'C', teacher_name: 'X' }, query: {} } as any,
        {} as any,
        next,
      );
      expect(errors).toHaveLength(1);
      expect((errors[0] as ApiError).code).toBe('VALIDATION');
    });
    it('rejects school_id in the query string', () => {
      const errors: unknown[] = [];
      const next = (e?: unknown) => {
        if (e) errors.push(e);
      };
      requireSchool({ user: { school_id: B }, body: {}, query: { school_id: A } } as any, {} as any, next);
      expect(errors).toHaveLength(1);
      expect((errors[0] as ApiError).code).toBe('VALIDATION');
    });
    it('resolves schoolId from the JWT when no forgery is present', () => {
      let schoolId: string | undefined;
      const req = { user: { school_id: B }, body: {}, query: {} } as any;
      requireSchool(req, {} as any, () => {
        schoolId = req.schoolId;
      });
      expect(schoolId).toBe(B);
    });
    it('a forged school_id in a create-class body can never land in another school', async () => {
      const created = await classesSvc.createClass(db as any, B, {
        name: '9', section: 'C', teacher_name: 'Forged Teacher',
        // a client-supplied school_id is not even a field of ClassInput;
        // the service only ever writes the JWT schoolId.
        school_id: A,
      } as any);
      expect(created.schoolId).toBe(B);
      expect(db.class.findMany({ where: { schoolId: A } })).toHaveLength(2);
    });
  });

  describe('classes', () => {
    it("B cannot read / update / delete / re-link A's class", async () => {
      await expectNotFound(classesSvc.getClass(db as any, B, 'class-a-5a'));
      await expectNotFound(classesSvc.updateClass(db as any, B, 'class-a-5a', { teacher_name: 'Hijacked' }));
      await expectNotFound(classesSvc.deleteClass(db as any, B, 'class-a-5a'));
      await expectNotFound(classesSvc.regenerateLink(db as any, B, 'class-a-5a', ADMIN_B));
      await expectNotFound(classesSvc.revokeLink(db as any, B, 'class-a-5a', ADMIN_B));
      expect(db.class.findUnique({ where: { id: 'class-a-5a' } })?.teacherName).toBe('Ayesha Khan');
    });
    it('same class name/section may exist in both schools independently', async () => {
      // A already has 6-B; B does not. Creating 6-B in B must succeed
      // (uniqueness is per-school), while re-creating B's own 5-A conflicts.
      const created = await classesSvc.createClass(db as any, B, { name: '6', section: 'B', teacher_name: 'Someone Else' });
      expect(created.schoolId).toBe(B);
      await expect(
        classesSvc.createClass(db as any, B, { name: '5', section: 'A', teacher_name: 'Dup' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });
  });

  describe('students + parents', () => {
    it("B cannot read / update / delete / re-parent A's student", async () => {
      await expectNotFound(studentsSvc.getStudent(db as any, B, 'stu-a1'));
      await expectNotFound(studentsSvc.updateStudent(db as any, B, 'stu-a1', { name: 'Hijacked' }));
      await expectNotFound(studentsSvc.deleteStudent(db as any, B, 'stu-a1'));
      await expectNotFound(studentsSvc.updateParent(db as any, B, 'stu-a1', { parent_name: 'Hijacked' }));
      expect(db.student.findUnique({ where: { id: 'stu-a1' } })?.name).toBe('Ahmed Raza');
    });
    it("B cannot create a student in A's class, or list A's class", async () => {
      await expectNotFound(studentsSvc.createStudent(db as any, B, 'class-a-5a', { name: 'Intruder' }));
      await expectNotFound(studentsSvc.listStudents(db as any, B, 'class-a-5a', {}));
    });
    it("B searching for A's student name finds nothing", async () => {
      const res = await studentsSvc.listStudents(db as any, B, 'class-b-5a', { search: 'Ahmed Raza' });
      expect(res.total).toBe(0);
      expect(res.items).toHaveLength(0);
      const res2 = await studentsSvc.listStudents(db as any, B, 'class-b-5a', { search: 'Sara Ahmed' });
      expect(res2.total).toBe(0);
    });
    it("B's parents list contains no A student", async () => {
      const res = await studentsSvc.listParents(db as any, B, {});
      expect(res.items.every((s: any) => s.school_id === B)).toBe(true);
      expect(res.items.map((s: any) => s.name)).not.toContain('Ahmed Raza');
    });
    it("B cannot move A's student into B's class via class_id", async () => {
      await expectNotFound(
        studentsSvc.updateStudent(db as any, B, 'stu-a1', { class_id: 'class-b-5a' }),
      );
      // And B cannot move its OWN student into A's class either.
      await expect(
        studentsSvc.updateStudent(db as any, B, 'stu-b1', { class_id: 'class-a-5a' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(db.student.findUnique({ where: { id: 'stu-b1' } })?.classId).toBe('class-b-5a');
    });
  });

  describe('fees + receipts', () => {
    it("B cannot pay A's student, or fetch A's receipt", async () => {
      await expectNotFound(feesSvc.payFee(db as any, B, 'stu-a1', { month: MONTH, amount_paid: 100 }, ADMIN_B));
      await expectNotFound(feesSvc.getReceiptByNo(db as any, B, 'alpha-202611-001'));
      expect(db.feeRecord.findUnique({ where: { id: 'fr-a1' } })?.amountPaid).toBe(2500);
    });
    it("B cannot create / update / delete a fee structure on A's class", async () => {
      await expectNotFound(
        feesSvc.createFeeStructure(db as any, B, { class_id: 'class-a-5a', monthly_amount: 1, effective_from: '2026-01-01' }),
      );
      await expectNotFound(feesSvc.updateFeeStructure(db as any, B, 'fs-class-a-5a', { monthly_amount: 1 }));
      await expectNotFound(feesSvc.deleteFeeStructure(db as any, B, 'fs-class-a-5a'));
    });
    it("B's fee list and monthly report contain no A data", async () => {
      const list = await feesSvc.listFees(db as any, B, { month: MONTH }, 'Asia/Karachi');
      expect(list.items.every((i) => i.student_name !== 'Ahmed Raza')).toBe(true);
      const report = await feesSvc.monthlyFeeReport(db as any, B, MONTH);
      expect(report.collected).toBe(0); // B has no payments; A's 2500 must not appear
      expect(report.by_class.every((c: any) => c.class_id.startsWith('class-b'))).toBe(true);
    });
    it('B can pay its own student and gets its own receipt sequence', async () => {
      const receipt = await feesSvc.payFee(db as any, B, 'stu-b1', { month: MONTH, amount_paid: 2500, payment_method: 'cash' }, ADMIN_B);
      expect(receipt.receipt_no).toBe('beta-public-202611-001');
      expect(receipt.student_name).toBe('Bilal Ahmed');
    });
  });

  describe('dashboard / reports', () => {
    it("B's dashboard counts only B", async () => {
      const dash = await adminSvc.getDashboard(db as any, B);
      expect(dash.classes_total).toBe(2);
      // Fixture attendance is dated DAY; only count it when today is DAY.
      // getDashboard uses the SCHOOL-LOCAL day (Asia/Karachi), so the
      // test must too — UTC today (toISOString) is a different calendar
      // day for the 19:00–24:00 UTC window and flipped this test after
      // midnight PKT.
      const today = localDateString(new Date(), 'Asia/Karachi');
      const expectedPresent = today === DAY ? 1 : 0; // only stu-b1 present; A's present must not count
      expect(dash.present).toBe(expectedPresent);
      expect(dash.absent).toBe(0);
      expect(dash.fee_collected_this_month).toBe(0);
    });
    it("B's attendance reports with A's class_id are empty", async () => {
      const daily = await reportsSvc.attendanceDaily(db as any, B, { date: DAY, class_id: 'class-a-5a' });
      expect((daily as any).by_class).toHaveLength(0);
      expect((daily as any).by_student).toHaveLength(0);
      expect((daily as any).present).toBe(0);
      const weekly = await reportsSvc.attendanceWeekly(db as any, B, { week_start: '2026-11-02', class_id: 'class-a-5a' });
      expect((weekly as any).by_class).toHaveLength(0);
      const fees = await reportsSvc.feesMonthly(db as any, B, { month: MONTH });
      expect((fees as any).collected).toBe(0);
      expect((fees as any).by_class.every((c: any) => !c.display_name.includes('Ahmed'))).toBe(true);
    });
    it("B's teacher-attendance list filtered by A's class is empty", async () => {
      const rows = await attendanceSvc.listTeacherAttendance(db as any, B, { class_id: 'class-a-5a' });
      expect(rows).toHaveLength(0);
    });
  });

  describe('attendance (admin) + teacher link', () => {
    it("B cannot read / unlock / edit A's attendance day", async () => {
      await expectNotFound(attendanceSvc.getClassAttendance(db as any, B, 'class-a-5a', DAY));
      await expectNotFound(attendanceSvc.unlockAttendance(db as any, B, 'class-a-5a', DAY, ADMIN_B));
      await expectNotFound(
        attendanceSvc.editAttendance(db as any, B, 'day-a1', [{ student_id: 'stu-a1', status: 'present' }], ADMIN_B),
      );
    });
    it("B cannot mark teacher attendance for A's class", async () => {
      await expectNotFound(
        attendanceSvc.markTeacherAttendance(db as any, B, { class_id: 'class-a-5a', date: DAY, status: 'present' }, ADMIN_B),
      );
    });
    it("B using A's teacher token with a school context gets 404 (token is hash-only, no cross-school use)", async () => {
      const { token } = await classesSvc.regenerateLink(db as any, A, 'class-a-5a', 'admin-a');
      expect(await classesSvc.resolveLinkToken(db as any, token, B)).toBeNull();
      expect(await classesSvc.resolveLinkToken(db as any, token, A)).not.toBeNull();
      expect(await classesSvc.resolveLinkToken(db as any, token)).not.toBeNull(); // public bearer flow still works
      await expectNotFound(attendanceSvc.getLinkPage(db as any, token, B));
      await expectNotFound(
        attendanceSvc.submitAttendance(db as any, { token, records: [{ student_id: 'stu-a1', status: 'present' }], expectedSchoolId: B }),
      );
    });
    it('the token holder only ever sees their own class students on submit', async () => {
      const { token } = await classesSvc.regenerateLink(db as any, A, 'class-a-6b', 'admin-a');
      // stu-a1 belongs to 5-A, not 6-B: smuggling another class's student is rejected.
      await expect(
        attendanceSvc.submitAttendance(db as any, { token, records: [{ student_id: 'stu-a1', status: 'absent' }], dateOverride: DAY }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      // And B's student id is rejected the same way.
      await expect(
        attendanceSvc.submitAttendance(db as any, { token, records: [{ student_id: 'stu-b1', status: 'absent' }], dateOverride: DAY }),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
    });
  });

  describe('admin: users / settings / holidays / sessions / promotions / logs', () => {
    it("B cannot delete A's user; B's user list has no A users", async () => {
      const users = await adminSvc.listUsers(db as any, B);
      expect(users.every((u: any) => u.email.endsWith('@beta.test'))).toBe(true);
      await expectNotFound(adminSvc.deleteUser(db as any, B, 'clerk-a', ADMIN_B));
      expect(db.user.findUnique({ where: { id: 'clerk-a' } })).not.toBeNull();
    });
    it('an email that exists in A cannot be re-created as a clerk in B', async () => {
      await expect(
        adminSvc.createClerk(db as any, B, { email: 'admin@alpha.test', password: 'Secret123!' }, ADMIN_B),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });
    it("B changing settings changes only B's school row", async () => {
      await adminSvc.updateSettings(db as any, B, { sms_provider: 'gateway' }, ADMIN_B);
      expect((db.school.findUnique({ where: { id: B } })?.settings as any).sms_provider).toBe('gateway');
      expect((db.school.findUnique({ where: { id: A } })?.settings as any).sms_provider).toBeUndefined();
    });
    it("B cannot delete A's holiday; same date may exist per-school", async () => {
      await expectNotFound(adminSvc.deleteHoliday(db as any, B, 'hol-a', ADMIN_B));
      const created = await adminSvc.createHoliday(db as any, B, { date: '2026-11-09', name: 'Beta Iqbal Day' }, ADMIN_B);
      expect(created.schoolId).toBe(B);
    });
    it("B cannot make A's session current, or promote A's student", async () => {
      await expectNotFound(adminSvc.makeSessionCurrent(db as any, B, 'sess-a1', ADMIN_B));
      await expect(
        adminSvc.promoteStudents(db as any, B, { session_id: 'sess-b1', mappings: [{ student_id: 'stu-a1', to_class_id: 'class-b-1a' }] }, ADMIN_B),
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      await expectNotFound(
        adminSvc.promoteStudents(db as any, B, { session_id: 'sess-a1', mappings: [{ student_id: 'stu-b1', to_class_id: 'class-b-1a' }] }, ADMIN_B),
      );
      expect(db.student.findUnique({ where: { id: 'stu-a1' } })?.classId).toBe('class-a-5a');
    });
    it("B's audit logs / notifications contain no A rows; B cannot mark A's notification read", async () => {
      const logs = await adminSvc.listAuditLogs(db as any, B, {});
      expect(logs.items.every((l: any) => l.school_id === B)).toBe(true);
      const notes = await adminSvc.listNotifications(db as any, B, {});
      expect(notes.items.every((n: any) => n.school_id === B)).toBe(true);
      await expectNotFound(adminSvc.markNotificationRead(db as any, B, 'n-a1'));
    });
  });

  describe('jobs status', () => {
    it('getJobsStatus scoped to B returns only B', async () => {
      const scoped = await getJobsStatus(db as any, B);
      expect(scoped.jobs.length).toBeGreaterThan(0);
      for (const job of scoped.jobs) {
        expect(job.schools).toHaveLength(1);
        expect(job.schools[0].school_id).toBe(B);
        expect(job.schools[0].school_slug).toBe('beta-public');
      }
      const all = await getJobsStatus(db as any); // server-side, no user context
      expect(all.jobs[0].schools).toHaveLength(2);
    });
  });

  describe('signup seeds per-school templates (no shared templates)', () => {
    it('two signups each get exactly their own 6 templates', async () => {
      const fresh = new FakeDb();
      const a = await signup(fresh as any, { school_name: 'Gamma School', email: 'g@gamma.test', password: 'Secret123!' });
      const b = await signup(fresh as any, { school_name: 'Delta School', email: 'd@delta.test', password: 'Secret123!' });
      expect(a.school.id).not.toBe(b.school.id);
      const tplA = fresh.messageTemplate.findMany({ where: { schoolId: a.school.id } });
      const tplB = fresh.messageTemplate.findMany({ where: { schoolId: b.school.id } });
      expect(tplA).toHaveLength(6);
      expect(tplB).toHaveLength(6);
      expect(new Set(tplA.map((t) => `${t.type}:${t.language}`)).size).toBe(6);
      expect(tplA.every((t) => t.schoolId === a.school.id)).toBe(true);
      expect(tplB.every((t) => t.schoolId === b.school.id)).toBe(true);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Messaging: school-aware fake store + real Prisma adapter on FakeDb  */
/* ------------------------------------------------------------------ */

const TEST_KEY = crypto.randomBytes(32);
const testCrypto = {
  encrypt: (e164: string) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', TEST_KEY, iv);
    const ct = Buffer.concat([cipher.update(e164, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  },
  decrypt: (enc: string) => {
    const buf = Buffer.from(enc, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', TEST_KEY, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return decipher.update(buf.subarray(28), undefined, 'utf8') + decipher.final('utf8');
  },
};

const SCHOOL_A = { id: A, name: 'Alpha Public School', timezone: 'Asia/Karachi', smsProvider: 'sim' as const };
const SCHOOL_B = { id: B, name: 'Beta Public School', timezone: 'Asia/Karachi', smsProvider: 'sim' as const };

/** MessagingStore fake that enforces the FIXED store semantics (school-scoped lookups). */
class TwoSchoolStore implements MessagingStore {
  queue: QueueRow[] = [];
  templates: TemplateRow[] = [];
  devices = new Map<string, DeviceRow>();
  students = new Map<string, { id: string; name: string; schoolId: string }>();
  audits: AuditLogInput[] = [];
  private seq = 0;

  constructor() {
    this.students.set('stu-a1', { id: 'stu-a1', name: 'Ahmed Raza', schoolId: A });
    this.students.set('stu-b1', { id: 'stu-b1', name: 'Bilal Ahmed', schoolId: B });
    for (const schoolId of [A, B]) {
      for (const type of ['absent', 'fee_reminder', 'teacher_reminder'] as const) {
        for (const language of ['en', 'ur'] as const) {
          this.templates.push({ id: `tpl-${schoolId}-${type}-${language}`, schoolId, type, language, body: (DEFAULT_TEMPLATES as any)[type][language], isActive: true, name: `${type} (${language.toUpperCase()})`, isCustom: false });
        }
      }
    }
  }

  seedQueue(row: Partial<QueueRow> & { id: string; schoolId: string; dedupeKey: string }): QueueRow {
    const full: QueueRow = {
      type: 'absent', studentId: null, classId: null, parentPhoneEnc: testCrypto.encrypt('+923001111111'),
      body: 'body', status: 'queued', attempts: 0, scheduledFor: new Date(`${DAY}T09:00:00Z`),
      sentAt: null, error: null, approvedBy: null, approvedAt: null, createdAt: new Date(`${DAY}T09:00:00Z`),
      ...row,
    } as QueueRow;
    this.queue.push(full);
    return full;
  }

  async getSchool(schoolId: string) {
    return schoolId === A ? SCHOOL_A : SCHOOL_B;
  }
  async getStudentsByIds(ids: string[], schoolId: string) {
    return ids
      .map((id) => this.students.get(id))
      .filter((s): s is { id: string; name: string; schoolId: string } => !!s && s.schoolId === schoolId)
      .map((s) => ({ id: s.id, name: s.name }));
  }
  async isHoliday() {
    return false;
  }
  async getActiveTemplate(schoolId: string, type: any, language: any) {
    return this.templates.find((t) => t.schoolId === schoolId && t.type === type && t.language === language) ?? null;
  }
  async listTemplates(schoolId: string) {
    return this.templates.filter((t) => t.schoolId === schoolId);
  }
  async getTemplateById(id: string, schoolId?: string) {
    return this.templates.find((t) => t.id === id && (!schoolId || t.schoolId === schoolId)) ?? null;
  }
  async updateTemplate(id: string, patch: { body?: string; isActive?: boolean; name?: string | null; type?: any; language?: any }, schoolId?: string) {
    const t = this.templates.find((x) => x.id === id && (!schoolId || x.schoolId === schoolId));
    if (!t) throw Object.assign(new Error('Template not found'), { code: 'NOT_FOUND' });
    if (patch.body !== undefined) t.body = patch.body;
    if (patch.isActive !== undefined) t.isActive = patch.isActive;
    if (patch.name !== undefined) t.name = patch.name;
    if (patch.type !== undefined) t.type = patch.type;
    if (patch.language !== undefined) t.language = patch.language;
    return t;
  }
  // --- Section 11 (Custom Messages): in-memory template/draft/recipient
  // methods mirroring the fixed Prisma store's school-scoping. ---
  drafts: DraftRow[] = [];
  approvals: Array<DraftApproval & { schoolId: string; entityId: string }> = [];
  async createTemplate(input: { schoolId: string; name: string; type: any; language: any; body: string; isCustom?: boolean }) {
    if (this.templates.some((t) => t.schoolId === input.schoolId && t.type === input.type && t.language === input.language)) {
      throw Object.assign(new Error('A template already exists for this type and language'), { code: 'CONFLICT' });
    }
    const row: TemplateRow = { id: `tpl-${++this.seq}`, schoolId: input.schoolId, type: input.type, language: input.language, body: input.body, isActive: true, name: input.name, isCustom: input.isCustom ?? true };
    this.templates.push(row);
    return row;
  }
  async deleteTemplate(id: string, schoolId: string) {
    const idx = this.templates.findIndex((t) => t.id === id && t.schoolId === schoolId);
    if (idx === -1) throw Object.assign(new Error('Template not found'), { code: 'NOT_FOUND' });
    this.templates.splice(idx, 1);
  }
  async createDraft(draft: any) {
    const row: DraftRow = { id: `d-${++this.seq}`, schoolId: draft.schoolId, createdBy: draft.createdBy ?? null, recipientType: draft.recipientType, targetClassId: draft.targetClassId ?? null, targetStudentIds: draft.targetStudentIds ?? [], body: draft.body, status: 'draft', scheduledFor: draft.scheduledFor ?? null, createdAt: new Date(), updatedAt: new Date() };
    this.drafts.push(row);
    return row;
  }
  async getDraftById(id: string, schoolId: string) {
    return this.drafts.find((d) => d.id === id && d.schoolId === schoolId) ?? null;
  }
  async listDrafts(schoolId: string, filters: { status?: string; page: number; limit: number }) {
    const items = this.drafts.filter((d) => d.schoolId === schoolId && (!filters.status || d.status === filters.status));
    return { items, total: items.length };
  }
  async updateDraft(id: string, patch: any, schoolId: string) {
    const d = this.drafts.find((x) => x.id === id && x.schoolId === schoolId);
    if (!d) throw Object.assign(new Error('Draft not found'), { code: 'NOT_FOUND' });
    Object.assign(d, patch, { updatedAt: new Date() });
    return d;
  }
  async deleteDraft(id: string, schoolId: string) {
    const idx = this.drafts.findIndex((d) => d.id === id && d.schoolId === schoolId);
    if (idx === -1) throw Object.assign(new Error('Draft not found'), { code: 'NOT_FOUND' });
    this.drafts.splice(idx, 1);
  }
  async listRecipients(schoolId: string, query: any) {
    // Fake has only id/name/schoolId students — enough for scoping tests.
    const ids = query.targetStudentIds as string[] | undefined;
    return [...this.students.values()]
      .filter((s) => s.schoolId === schoolId && (!ids || ids.includes(s.id)))
      .map((s) => ({ id: s.id, name: s.name, fatherName: null, classId: 'class-a-5a', className: '5', section: 'A', parentPhoneEnc: testCrypto.encrypt('+923001111111'), parentOptOut: false }));
  }
  async listDeliveriesForQueueIds() {
    return [];
  }
  async getDraftApproval(draftId: string, schoolId: string) {
    const rows = this.approvals.filter((a) => a.entityId === draftId && a.schoolId === schoolId);
    return rows[rows.length - 1] ?? null;
  }
  async hasApprovedDraftApproval(draftId: string, schoolId: string) {
    return this.approvals.some((a) => a.entityId === draftId && a.schoolId === schoolId && a.status === 'approved');
  }
  async recordDraftApproval(input: { schoolId: string; draftId: string; adminId: string; payload: Record<string, unknown> }) {
    const row: DraftApproval & { schoolId: string; entityId: string } = { id: `ap-${++this.seq}`, status: 'approved', requestedBy: input.adminId, decidedBy: input.adminId, decidedAt: new Date(), createdAt: new Date(), schoolId: input.schoolId, entityId: input.draftId };
    this.approvals.push(row);
    return row;
  }
  async findQueueByDedupeKey(dedupeKey: string, schoolId?: string) {
    return this.queue.find((q) => q.dedupeKey === dedupeKey && (!schoolId || q.schoolId === schoolId)) ?? null;
  }
  async createQueue(row: Parameters<MessagingStore['createQueue']>[0]) {
    const existing = await this.findQueueByDedupeKey(row.dedupeKey, row.schoolId);
    if (existing) return { row: existing, created: false };
    const created: QueueRow = {
      id: `q-${++this.seq}`, schoolId: row.schoolId, type: row.type, studentId: row.studentId ?? null,
      classId: row.classId ?? null, parentPhoneEnc: row.parentPhoneEnc, body: row.body, status: 'queued',
      attempts: 0, dedupeKey: row.dedupeKey, scheduledFor: row.scheduledFor ?? new Date(),
      sentAt: null, error: null, approvedBy: null, approvedAt: null, createdAt: new Date(),
    };
    this.queue.push(created);
    return { row: created, created: true };
  }
  async listPendingApproval(schoolId: string) {
    return this.queue.filter((q) => q.schoolId === schoolId && q.status === 'queued' && q.approvedAt === null);
  }
  async listDueApproved(schoolId: string, limit: number) {
    const now = Date.now();
    return this.queue
      .filter((q) => q.schoolId === schoolId && q.status === 'queued' && q.approvedAt !== null && q.scheduledFor.getTime() <= now)
      .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime())
      .slice(0, limit);
  }
  async listQueue(schoolId: string, filters: { status?: QueueRow['status']; type?: QueueRow['type']; date?: string; page: number; limit: number }) {
    const items = this.queue.filter(
      (q) => q.schoolId === schoolId && (!filters.status || q.status === filters.status) && (!filters.type || q.type === filters.type),
    );
    return { items, total: items.length };
  }
  async getQueueById(id: string, schoolId?: string) {
    return this.queue.find((q) => q.id === id && (!schoolId || q.schoolId === schoolId)) ?? null;
  }
  async updateQueue(id: string, patch: Partial<QueueRow>, schoolId?: string) {
    const row = this.queue.find((q) => q.id === id && (!schoolId || q.schoolId === schoolId));
    if (!row) throw Object.assign(new Error('Message not found'), { code: 'NOT_FOUND' });
    Object.assign(row, patch);
    return row;
  }
  async createDelivery(input: { queueId: string; provider: 'sim' | 'gateway'; deviceId?: string | null; status: string; error?: string | null }) {
    void input;
  }
  async createAuditLog(log: AuditLogInput) {
    this.audits.push(log);
  }
  async getDeviceByDeviceId(deviceId: string) {
    return this.devices.get(deviceId) ?? null;
  }
  async upsertDevice(input: { schoolId: string; deviceId: string; name: string }) {
    const existing = this.devices.get(input.deviceId);
    if (existing && existing.schoolId !== input.schoolId) {
      throw Object.assign(new Error('device_id is already registered to another school'), { code: 'CONFLICT' });
    }
    const row: DeviceRow = { id: `dev-${input.deviceId}`, schoolId: input.schoolId, deviceId: input.deviceId, name: input.name, lastSeenAt: null, status: 'offline' };
    this.devices.set(input.deviceId, row);
    return row;
  }
  async touchDevice(deviceId: string) {
    const d = this.devices.get(deviceId);
    if (d) {
      d.lastSeenAt = new Date();
      d.status = 'online';
    }
  }
  async getDevicesStatus(schoolId: string) {
    const mine = [...this.devices.values()].filter((d) => d.schoolId === schoolId);
    return { lastSeenAt: null, onlineCount: mine.filter((d) => d.status === 'online').length };
  }
  async countQueued(schoolId: string) {
    return {
      queued: this.queue.filter((q) => q.schoolId === schoolId && q.status === 'queued').length,
      pendingApproval: this.queue.filter((q) => q.schoolId === schoolId && q.status === 'queued' && q.approvedAt === null).length,
    };
  }
}

function msgDeps(store: TwoSchoolStore): ServiceDeps {
  return { store, crypto: testCrypto, now: () => new Date(`${DAY}T09:00:00Z`) };
}

describe('messaging cross-tenant (service layer)', () => {
  let store: TwoSchoolStore;
  beforeEach(async () => {
    store = new TwoSchoolStore();
    store.seedQueue({ id: 'q-a1', schoolId: A, studentId: 'stu-a1', classId: 'class-a-5a', dedupeKey: `absent:stu-a1:${DAY}`, body: 'Ahmed Raza absent' });
    store.seedQueue({ id: 'q-b1', schoolId: B, studentId: 'stu-b1', classId: 'class-b-5a', dedupeKey: `absent:stu-b1:${DAY}`, body: 'Bilal Ahmed absent' });
    await store.upsertDevice({ schoolId: A, deviceId: 'dev-a1', name: 'Alpha phone' });
    await store.upsertDevice({ schoolId: B, deviceId: 'dev-b1', name: 'Beta phone' });
  });

  it("B approving A's draft approves nothing (dedupe key + group)", async () => {
    const deps = msgDeps(store);
    const byKey = await approveMessages(deps, { schoolId: B, approvedBy: ADMIN_B, dedupeKeys: [`absent:stu-a1:${DAY}`] });
    expect(byKey.approved).toBe(0);
    const byGroup = await approveMessages(deps, { schoolId: B, approvedBy: ADMIN_B, groupId: `class-a-5a:${DAY}:absent` });
    expect(byGroup.approved).toBe(0);
    expect(store.queue.find((q) => q.id === 'q-a1')?.approvedAt).toBeNull();
    // B approving its own draft still works.
    const own = await approveMessages(deps, { schoolId: B, approvedBy: ADMIN_B, dedupeKeys: [`absent:stu-b1:${DAY}`] });
    expect(own.approved).toBe(1);
  });

  it("B cannot edit / retry / report-delivery on A's queue row", async () => {
    const deps = msgDeps(store);
    await expect(editQueueBody(deps, { schoolId: B, queueId: 'q-a1', body: 'Hijacked', editedBy: ADMIN_B })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(retryFailed(deps, { schoolId: B, queueId: 'q-a1', retriedBy: ADMIN_B })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      reportDelivery(deps, { schoolId: B, deviceId: 'dev-b1', queueId: 'q-a1', status: 'sent' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(store.queue.find((q) => q.id === 'q-a1')?.body).toBe('Ahmed Raza absent');
  });

  it("B polling with A's device id gets nothing (device is school-bound)", async () => {
    const deps = msgDeps(store);
    await expect(getDeviceQueue(deps, { schoolId: B, deviceId: 'dev-a1' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // B's own device only ever receives B's approved rows.
    await approveMessages(deps, { schoolId: B, approvedBy: ADMIN_B, dedupeKeys: [`absent:stu-b1:${DAY}`] });
    for (const row of store.queue) row.scheduledFor = new Date('2026-11-06T08:00:00Z');
    const items = await getDeviceQueue(deps, { schoolId: B, deviceId: 'dev-b1' });
    expect(items).toHaveLength(1);
    expect(items[0].queueId).toBe('q-b1');
  });

  it("B cannot steal A's device_id (registering it under B conflicts)", async () => {
    await expect(store.upsertDevice({ schoolId: B, deviceId: 'dev-a1', name: 'Stolen' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(store.devices.get('dev-a1')?.schoolId).toBe(A);
    // Re-registering under the SAME school is fine.
    const same = await store.upsertDevice({ schoolId: A, deviceId: 'dev-a1', name: 'Alpha phone 2' });
    expect(same.schoolId).toBe(A);
    expect(same.name).toBe('Alpha phone 2');
  });

  it("B's pending-approval / log / templates never include A's rows", async () => {
    const pendingB = await store.listPendingApproval(B);
    expect(pendingB.every((q) => q.schoolId === B)).toBe(true);
    expect(pendingB.map((q) => q.id)).not.toContain('q-a1');
    const logB = await store.listQueue(B, { page: 1, limit: 20 });
    expect(logB.items.every((q) => q.schoolId === B)).toBe(true);
    const tplB = await store.listTemplates(B);
    expect(tplB).toHaveLength(6);
    expect(tplB.every((t) => t.schoolId === B)).toBe(true);
    // Student-name lookup is scoped: A's student id resolves to nothing for B.
    expect(await store.getStudentsByIds(['stu-a1'], B)).toHaveLength(0);
    expect(await store.getStudentsByIds(['stu-a1'], A)).toHaveLength(1);
  });

  it("B drafting absent messages cannot pick up A's dedupe key", async () => {
    const deps = msgDeps(store);
    // A draft already exists for stu-a1; B building drafts for ITS OWN
    // student with a forged dedupe collision must not see/ reuse A's row.
    const foundForB = await store.findQueueByDedupeKey(`absent:stu-a1:${DAY}`, B);
    expect(foundForB).toBeNull();
    const foundForA = await store.findQueueByDedupeKey(`absent:stu-a1:${DAY}`, A);
    expect(foundForA?.id).toBe('q-a1');
    void deps;
  });
});

describe('messaging store (Prisma adapter on the fake DB)', () => {
  let db: FakeDb;
  let store: MessagingStore;
  beforeEach(() => {
    db = seedTwoSchools().db;
    store = createPrismaMessagingStore(db as any);
  });

  it('getStudentsByIds returns only the requesting school students', async () => {
    expect(await store.getStudentsByIds(['stu-a1', 'stu-b1'], B)).toEqual([{ id: 'stu-b1', name: 'Bilal Ahmed' }]);
    expect(await store.getStudentsByIds(['stu-a1', 'stu-b1'], A)).toEqual([{ id: 'stu-a1', name: 'Ahmed Raza' }]);
  });

  it('template lookups/updates are school-scoped', async () => {
    expect(await store.getTemplateById('tpl-school-a-absent-en', B)).toBeNull();
    expect((await store.getTemplateById('tpl-school-a-absent-en', A))?.schoolId).toBe(A);
    await expect(store.updateTemplate('tpl-school-a-absent-en', { body: 'Hijacked' }, B)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const updated = await store.updateTemplate('tpl-school-b-absent-en', { body: 'Beta body v2' }, B);
    expect(updated.body).toBe('Beta body v2');
    expect(db.messageTemplate.findUnique({ where: { id: 'tpl-school-a-absent-en' } })?.body).not.toBe('Beta body v2');
  });

  it('queue lookups/updates are school-scoped', async () => {
    expect(await store.findQueueByDedupeKey(`absent:stu-a1:${DAY}`, B)).toBeNull();
    expect((await store.findQueueByDedupeKey(`absent:stu-a1:${DAY}`, A))?.id).toBe('q-a1');
    expect(await store.getQueueById('q-a1', B)).toBeNull();
    await expect(store.updateQueue('q-a1', { body: 'Hijacked' }, B)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const updated = await store.updateQueue('q-b1', { body: 'Beta edited' }, B);
    expect(updated.body).toBe('Beta edited');
  });

  it('upsertDevice refuses a cross-school device_id takeover', async () => {
    await expect(store.upsertDevice({ schoolId: B, deviceId: 'dev-a1', name: 'Stolen' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.smsDevice.findUnique({ where: { deviceId: 'dev-a1' } })?.schoolId).toBe(A);
    const ok = await store.upsertDevice({ schoolId: A, deviceId: 'dev-a1', name: 'Alpha phone 2' });
    expect(ok.schoolId).toBe(A);
  });

  it('buildAbsentDrafts via the real adapter never reuses another school dedupe key', async () => {
    const deps: ServiceDeps = { store, crypto: testCrypto, now: () => new Date(`${DAY}T09:00:00Z`) };
    // B drafts for its own absent student: creates exactly one B row.
    const res = await buildAbsentDrafts(deps, {
      school: SCHOOL_B,
      classId: 'class-b-5a',
      className: '5-A',
      date: DAY,
      records: [{ studentId: 'stu-b1', status: 'absent' }],
      students: [{ id: 'stu-b1', name: 'Bilal Ahmed', classId: 'class-b-5a', parentName: 'Parent', parentPhoneEnc: testCrypto.encrypt('+923002222222'), parentOptOut: false }],
    });
    expect(res.created).toBe(0); // q-b1 already exists for this dedupe key
    expect(res.skipped[0].reason).toBe('already_queued');
    expect(db.messageQueue.findMany({ where: { schoolId: B } })).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* OCR uploads                                                         */
/* ------------------------------------------------------------------ */

function makeOcrDb(): { db: OcrDb; uploads: Map<string, UploadRecord> } {
  const uploads = new Map<string, UploadRecord>();
  uploads.set('up-a1', { id: 'up-a1', school_id: A, class_id: 'class-a-5a', file_path: '/tmp/a.png', status: 'review', raw_text: '1. Ahmed Raza 0301-1111111\n2. Sara Ahmed' });
  uploads.set('up-b1', { id: 'up-b1', school_id: B, class_id: 'class-b-5a', file_path: '/tmp/b.png', status: 'review', raw_text: '1. Bilal Ahmed 0300-2222222' });
  const db: OcrDb = {
    async getClass(schoolId, classId) {
      const known: Record<string, string> = { 'class-a-5a': A, 'class-b-5a': B };
      return known[classId] === schoolId ? { id: classId } : null;
    },
    async listStudents() {
      return [];
    },
    async createUpload(data) {
      const id = `up-${uploads.size + 1}`;
      uploads.set(id, { id, school_id: data.school_id, class_id: data.class_id, file_path: data.file_path, status: 'processing', raw_text: null });
      return { id };
    },
    async getUpload(schoolId, uploadId) {
      const u = uploads.get(uploadId) ?? null;
      return u && u.school_id === schoolId ? u : null;
    },
    async updateUpload(schoolId, uploadId, data) {
      const u = uploads.get(uploadId);
      if (!u || u.school_id !== schoolId) {
        const err = new Error('OCR upload not found') as Error & { status?: number; code?: string };
        err.status = 404;
        err.code = 'NOT_FOUND';
        throw err;
      }
      uploads.set(uploadId, { ...u, ...data });
    },
    async createStudents() {
      return { created: 0 };
    },
    async getUploadFile(schoolId, uploadId) {
      const u = uploads.get(uploadId) ?? null;
      return u && u.school_id === schoolId ? { file_path: u.file_path } : null;
    },
    async createAuditLog() {},
  };
  return { db, uploads };
}

describe('OCR cross-tenant', () => {
  it("B cannot review or confirm A's upload", async () => {
    const { db, uploads } = makeOcrDb();
    const svc = new OcrService(db, {});
    await expect(svc.getUploadForReview(B, 'up-a1')).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.confirmRows(B, 'class-b-5a', 'up-a1', ADMIN_B, [{ name: 'Intruder' }]),
    ).rejects.toMatchObject({ status: 404 });
    expect(uploads.get('up-a1')?.status).toBe('review'); // untouched
    const own = await svc.getUploadForReview(A, 'up-a1');
    expect(own.upload_id).toBe('up-a1');
    expect(own.rows.length).toBeGreaterThan(0);
  });

  it('prisma adapter updateUpload refuses a cross-school update', async () => {
    const rows: any[] = [
      { id: 'up-a1', schoolId: A, classId: 'class-a-5a', filePath: '/tmp/a.png', status: 'review', rawText: 'raw' },
    ];
    const stubPrisma: any = {
      class: { findFirst: async () => null },
      student: { findMany: async () => [] },
      ocrUpload: {
        create: async () => ({ id: 'x' }),
        findFirst: async ({ where }: any) => rows.find((r) => r.id === where.id && r.schoolId === where.schoolId) ?? null,
        update: async ({ where, data }: any) => {
          const r = rows.find((x) => x.id === where.id);
          Object.assign(r, data);
          return r;
        },
      },
      auditLog: { create: async () => {} },
    };
    const adapter = prismaOcrDb(stubPrisma);
    await expect(adapter.updateUpload(B, 'up-a1', { status: 'saved' })).rejects.toMatchObject({ status: 404 });
    expect(rows[0].status).toBe('review');
    await adapter.updateUpload(A, 'up-a1', { status: 'saved' });
    expect(rows[0].status).toBe('saved');
    expect(await adapter.getUpload(B, 'up-a1')).toBeNull();
    expect((await adapter.getUpload(A, 'up-a1'))?.id).toBe('up-a1');
  });
});
