// Admissions tests (Gap #2, 2026-11-20): public form + honeypot,
// validation, pipeline statuses (admitted is admit-only + terminal),
// Admit atomicity (student + fee record + voucher, one transaction),
// voucher numbering, no-structure admit. In-memory fake Db, same
// conventions as modules/college/college.test.ts.
import { describe, it, expect } from 'vitest';
import * as svc from './service';
import { encryptPhone, sha256Hex } from '../../lib/crypto';

function fakeDb() {
  const schools: any[] = [
    { id: 'school-1', name: 'Test School', slug: 'test-school', timezone: 'Asia/Karachi', settings: {} },
    { id: 'school-2', name: 'Other School', slug: 'other-school', timezone: 'Asia/Karachi', settings: {} },
  ];
  const classes: any[] = [
    { id: 'class-1', schoolId: 'school-1', name: '5', section: 'A', teacherName: 'Miss Sana', deletedAt: null },
    { id: 'class-2', schoolId: 'school-1', name: '6', section: 'B', teacherName: 'Sir Ali', deletedAt: null },
    { id: 'class-nofee', schoolId: 'school-1', name: '7', section: 'C', teacherName: 'Miss Hina', deletedAt: null },
    { id: 'class-other', schoolId: 'school-2', name: '5', section: 'A', teacherName: 'Other', deletedAt: null },
  ];
  const students: any[] = [];
  const inquiries: any[] = [];
  const feeStructures: any[] = [
    { id: 'fs-1', schoolId: 'school-1', classId: 'class-1', monthlyAmount: 2000, admissionFee: 500, siblingDiscountPct: 0, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
  ];
  const feeRecords: any[] = [];
  const feeVouchers: any[] = [];
  const auditLogs: any[] = [];
  const changeLogs: any[] = [];
  let seq = 1;
  const id = () => `id-${seq++}`;

  const norm = (v: any) => (v instanceof Date ? v.getTime() : v);
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]) => {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        if ('in' in (v as any)) return (v as any).in.map(norm).includes(norm(row[k]));
        if ('not' in (v as any)) return (v as any).not === null ? row[k] != null : norm(row[k]) !== norm((v as any).not);
        if ('lt' in (v as any)) return norm(row[k]) < norm((v as any).lt);
        if ('startsWith' in (v as any)) return String(row[k] ?? '').startsWith((v as any).startsWith);
      }
      if (v === null) return row[k] == null;
      return norm(row[k]) === norm(v);
    });
  const sortBy = (rows: any[], orderBy: any): any[] => {
    let out = [...rows];
    for (const o of (Array.isArray(orderBy) ? orderBy : [orderBy])) {
      const [k, dir] = Object.entries(o)[0] as [string, string];
      out = out.sort((a, b) => (norm(a[k]) < norm(b[k]) ? -1 : norm(a[k]) > norm(b[k]) ? 1 : 0) * (dir === 'desc' ? -1 : 1));
    }
    return out;
  };
  const collection = (rows: any[]) => ({
    findFirst: async ({ where, orderBy }: any) => {
      const found = rows.filter((r) => matches(r, where));
      return (orderBy ? sortBy(found, orderBy) : found)[0] ?? null;
    },
    findUnique: async ({ where }: any) => rows.find((r) => matches(r, where)) ?? null,
    findMany: async ({ where, orderBy }: any) => {
      const out = rows.filter((r) => matches(r, where));
      return orderBy ? sortBy(out, orderBy) : out;
    },
    create: async ({ data }: any) => {
      const row = { id: id(), deletedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
      rows.push(row);
      return row;
    },
    update: async ({ where, data }: any) => {
      const r = rows.find((x) => x.id === where.id);
      Object.assign(r, data, { updatedAt: new Date() });
      return r;
    },
    updateMany: async ({ where, data }: any) => {
      let count = 0;
      for (const r of rows) if (matches(r, where)) { Object.assign(r, data, { updatedAt: new Date() }); count += 1; }
      return { count };
    },
    count: async ({ where }: any) => rows.filter((r) => matches(r, where)).length,
  });

  const db: any = {
    school: collection(schools),
    class: collection(classes),
    student: collection(students),
    admissionInquiry: collection(inquiries),
    feeStructure: collection(feeStructures),
    feeRecord: collection(feeRecords),
    feeVoucher: collection(feeVouchers),
    auditLog: { create: async ({ data }: any) => { const r = { id: id(), ...data }; auditLogs.push(r); return r; } },
    changeLog: { create: async ({ data }: any) => { const r = { id: id(), ...data }; changeLogs.push(r); return r; } },
    $transaction: async (fn: (tx: any) => Promise<any>) => fn(db),
    __inquiries: inquiries,
    __students: students,
    __feeRecords: feeRecords,
    __feeVouchers: feeVouchers,
    __auditLogs: auditLogs,
  };
  return db;
}

const VALID = {
  student_name: 'New Applicant',
  class_id: 'class-1',
  parent_name: 'Father Applicant',
  parent_phone: '03001234567',
  parent_email: 'father@example.com',
  notes: 'Wants morning shift',
};

async function seedInquiry(db: any, overrides: Record<string, unknown> = {}) {
  return svc.submitInquiry(db as any, 'test-school', { ...VALID, ...overrides });
}

describe('public admissions form', () => {
  it('returns the school + its classes; unknown slug is a 404', async () => {
    const db = fakeDb();
    const form = await svc.getPublicAdmissionsForm(db as any, 'test-school');
    expect(form.school_name).toBe('Test School');
    expect((form.classes as any[]).map((c: any) => c.display_name)).toEqual(['5-A', '6-B', '7-C']);
    await expect(svc.getPublicAdmissionsForm(db as any, 'no-such-school')).rejects.toMatchObject({ status: 404 });
  });

  it('accepts a valid inquiry, encrypts the phone, starts at new', async () => {
    const db = fakeDb();
    const res = await seedInquiry(db);
    expect(res.received).toBe(true);
    const row = db.__inquiries[0];
    expect(row.status).toBe('new');
    expect(row.className).toBe('5-A');
    expect(row.parentPhoneEnc).not.toContain('03001234567');
    expect(row.parentPhoneHash).toBe(sha256Hex('+923001234567'));
    expect(row.parentPhoneEnc).toBeTruthy();
  });

  it('silently drops honeypot submissions without storing anything', async () => {
    const db = fakeDb();
    const res = await seedInquiry(db, { website: 'http://spam.example' });
    expect(res.received).toBe(true);
    expect(db.__inquiries.length).toBe(0);
  });

  it('rejects a bad phone, an unknown class, and a class from another school', async () => {
    const db = fakeDb();
    await expect(seedInquiry(db, { parent_phone: '12345' })).rejects.toMatchObject({ status: 400 });
    await expect(seedInquiry(db, { class_id: '00000000-0000-0000-0000-000000000000' })).rejects.toMatchObject({ status: 400 });
    await expect(seedInquiry(db, { class_id: 'class-other' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('pipeline statuses', () => {
  it('moves new → contacted → test → interview → rejected; admitted cannot be set by hand', async () => {
    const db = fakeDb();
    await seedInquiry(db);
    const id = db.__inquiries[0].id;
    for (const status of ['contacted', 'test', 'interview', 'rejected']) {
      const updated = await svc.updateInquiryStatus(db as any, 'school-1', id, status, 'admin-1');
      expect(updated.status).toBe(status);
    }
    await expect(svc.updateInquiryStatus(db as any, 'school-1', id, 'admitted', 'admin-1')).rejects.toMatchObject({ status: 400 });
    await expect(svc.updateInquiryStatus(db as any, 'school-1', id, 'bogus', 'admin-1')).rejects.toMatchObject({ status: 400 });
  });

  it('list filters by status and masks the parent phone', async () => {
    const db = fakeDb();
    await seedInquiry(db);
    await seedInquiry(db, { student_name: 'Second Applicant', parent_phone: '03007654321' });
    await svc.updateInquiryStatus(db as any, 'school-1', db.__inquiries[1].id, 'contacted', 'admin-1');
    const all = await svc.listInquiries(db as any, 'school-1', {});
    expect(all.total).toBe(2);
    expect((all.items as any[])[0].parent_phone_masked).toMatch(/^\+92 3XX XXXX\d{3}$/);
    const contacted = await svc.listInquiries(db as any, 'school-1', { status: 'contacted' });
    expect(contacted.total).toBe(1);
    expect((contacted.items as any[])[0].student_name).toBe('Second Applicant');
  });
});

describe('admit (one transaction: student + fee record + voucher)', () => {
  it('creates the student, first fee record (monthly + admission fee) and voucher V001', async () => {
    const db = fakeDb();
    await seedInquiry(db);
    const id = db.__inquiries[0].id;
    const result = await svc.admitInquiry(db as any, 'school-1', id, { class_id: 'class-1', roll_no: 5, admission_no: 'A-101' }, 'admin-1');
    expect(result.student_name).toBe('New Applicant');
    expect(db.__students.length).toBe(1);
    expect(db.__students[0].rollNo).toBe(5);
    expect(db.__students[0].admissionNo).toBe('A-101');
    expect(db.__students[0].parentPhoneEnc).toBeTruthy();
    // Monthly 2000 + admission fee 500 (first record) = 2500 due.
    expect(db.__feeRecords.length).toBe(1);
    expect(db.__feeRecords[0].amountDue).toBe(2500);
    expect(db.__feeRecords[0].month).toMatch(/^\d{4}-\d{2}$/);
    expect(db.__feeVouchers.length).toBe(1);
    expect(result.voucher_no).toMatch(/^test-school-\d{6}-V001$/);
    expect(db.__inquiries[0].status).toBe('admitted');
    expect(db.__inquiries[0].admittedStudentId).toBe(db.__students[0].id);
  });

  it('a second admit is a conflict and creates nothing more', async () => {
    const db = fakeDb();
    await seedInquiry(db);
    const id = db.__inquiries[0].id;
    await svc.admitInquiry(db as any, 'school-1', id, { class_id: 'class-1' }, 'admin-1');
    await expect(svc.admitInquiry(db as any, 'school-1', id, { class_id: 'class-1' }, 'admin-1')).rejects.toMatchObject({ status: 409 });
    expect(db.__students.length).toBe(1);
    expect(db.__feeVouchers.length).toBe(1);
  });

  it('a rejected inquiry cannot be admitted', async () => {
    const db = fakeDb();
    await seedInquiry(db);
    const id = db.__inquiries[0].id;
    await svc.updateInquiryStatus(db as any, 'school-1', id, 'rejected', 'admin-1');
    await expect(svc.admitInquiry(db as any, 'school-1', id, { class_id: 'class-1' }, 'admin-1')).rejects.toMatchObject({ status: 409 });
  });

  it('admits without a voucher when the class has no fee structure', async () => {
    const db = fakeDb();
    await seedInquiry(db, { class_id: 'class-nofee' });
    const id = db.__inquiries[0].id;
    const result = await svc.admitInquiry(db as any, 'school-1', id, { class_id: 'class-nofee' }, 'admin-1');
    expect(result.student_id).toBeTruthy();
    expect(result.voucher_no).toBeNull();
    expect(db.__feeRecords.length).toBe(0);
    expect(db.__inquiries[0].status).toBe('admitted');
  });

  it('admit is isolated: another school cannot admit this inquiry', async () => {
    const db = fakeDb();
    await seedInquiry(db);
    const id = db.__inquiries[0].id;
    await expect(svc.admitInquiry(db as any, 'school-2', id, { class_id: 'class-other' }, 'admin-1')).rejects.toMatchObject({ status: 404 });
  });
});
