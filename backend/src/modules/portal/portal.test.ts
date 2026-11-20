// Parent portal tests (Gap #1, 2026-11-20): token resolve (valid /
// revoked / expired), one-student isolation, token rotate/revoke,
// held SMS draft (never auto-sent) + dedupe. In-memory fake Db, same
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
  ];
  const students: any[] = [
    { id: 'stu-1', schoolId: 'school-1', classId: 'class-1', rollNo: 1, name: 'Ayesha Khan', fatherName: 'Ahmed Khan', status: 'active', deletedAt: null, parentName: 'Ahmed Khan', parentPhoneEnc: encryptPhone('+923001234567'), parentPhoneHash: sha256Hex('+923001234567'), parentOptOut: false },
    { id: 'stu-2', schoolId: 'school-1', classId: 'class-1', rollNo: 2, name: 'Bilal Ahmed', fatherName: 'Raza Ahmed', status: 'active', deletedAt: null, parentName: 'Raza Ahmed', parentPhoneEnc: encryptPhone('+923001234568'), parentPhoneHash: sha256Hex('+923001234568'), parentOptOut: false },
    { id: 'stu-nophone', schoolId: 'school-1', classId: 'class-1', rollNo: 3, name: 'No Phone', fatherName: null, status: 'active', deletedAt: null, parentName: null, parentPhoneEnc: null, parentPhoneHash: null, parentOptOut: false },
    { id: 'stu-optout', schoolId: 'school-1', classId: 'class-1', rollNo: 4, name: 'Opted Out', fatherName: null, status: 'active', deletedAt: null, parentName: 'Opt Out', parentPhoneEnc: encryptPhone('+923001234569'), parentPhoneHash: sha256Hex('+923001234569'), parentOptOut: true },
    { id: 'stu-other', schoolId: 'school-2', classId: 'class-1', rollNo: 1, name: 'Other School Kid', fatherName: null, status: 'active', deletedAt: null, parentName: null, parentPhoneEnc: null, parentPhoneHash: null, parentOptOut: false },
  ];
  const parentTokens: any[] = [];
  const messageQueue: any[] = [];
  const attendanceDays: any[] = [
    { id: 'day-1', schoolId: 'school-1', classId: 'class-1', date: new Date('2026-11-19T00:00:00Z') },
    { id: 'day-2', schoolId: 'school-1', classId: 'class-1', date: new Date('2026-11-18T00:00:00Z') },
  ];
  const attendanceRecords: any[] = [
    { id: 'rec-1', attendanceDayId: 'day-1', studentId: 'stu-1', status: 'present' },
    { id: 'rec-2', attendanceDayId: 'day-1', studentId: 'stu-2', status: 'absent' },
    { id: 'rec-3', attendanceDayId: 'day-2', studentId: 'stu-1', status: 'absent' },
    { id: 'rec-4', attendanceDayId: 'day-2', studentId: 'stu-2', status: 'present' },
  ];
  const exams: any[] = [{ id: 'exam-1', schoolId: 'school-1', name: 'Midterm', type: 'midterm', deletedAt: null }];
  const results: any[] = [
    { id: 'res-1', schoolId: 'school-1', examId: 'exam-1', classId: 'class-1', studentId: 'stu-1', rollNo: 1, studentName: 'Ayesha Khan', obtainedMarks: 80, totalMarks: 100, percentage: 80, grade: 'A', position: 1, deletedAt: null, createdAt: new Date('2026-11-15T00:00:00Z') },
    { id: 'res-2', schoolId: 'school-1', examId: 'exam-1', classId: 'class-1', studentId: 'stu-2', rollNo: 2, studentName: 'Bilal Ahmed', obtainedMarks: 60, totalMarks: 100, percentage: 60, grade: 'C', position: 2, deletedAt: null, createdAt: new Date('2026-11-15T00:00:00Z') },
  ];
  const feeRecords: any[] = [
    { id: 'fee-1', schoolId: 'school-1', studentId: 'stu-1', month: '2026-11', amountDue: 2000, amountPaid: 2000, discount: 0, status: 'paid', paidAt: new Date(), receiptNo: 'R-1', deletedAt: null },
    { id: 'fee-2', schoolId: 'school-1', studentId: 'stu-2', month: '2026-11', amountDue: 2000, amountPaid: 0, discount: 0, status: 'unpaid', paidAt: null, receiptNo: null, deletedAt: null },
  ];
  const timetableEntries: any[] = [
    { id: 'tt-1', schoolId: 'school-1', classId: 'class-1', teacherId: null, dayOfWeek: 1, periodNo: 1, subject: 'Math', startTime: '08:00', endTime: '08:45', room: 'R1' },
    { id: 'tt-2', schoolId: 'school-1', classId: 'class-1', teacherId: null, dayOfWeek: 1, periodNo: 2, subject: 'English', startTime: '08:45', endTime: '09:30', room: 'R1' },
  ];
  const staff: any[] = [];
  const announcements: any[] = [
    { id: 'ann-1', schoolId: 'school-1', title: 'PTM on Friday', body: 'Parent-teacher meeting', targetType: 'all', targetClassId: null, status: 'approved', createdAt: new Date('2026-11-18T00:00:00Z') },
    { id: 'ann-2', schoolId: 'school-1', title: 'Draft — not for parents', body: 'secret', targetType: 'all', targetClassId: null, status: 'draft', createdAt: new Date('2026-11-18T00:00:00Z') },
  ];
  const homework: any[] = [
    { id: 'hw-1', schoolId: 'school-1', classId: 'class-1', subject: 'Math', title: 'Exercise 5.2', description: 'Q1-10', dueDate: new Date('2026-11-21T00:00:00Z'), teacher: 'Miss Sana', deletedAt: null, createdAt: new Date() },
  ];
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
        if ('lte' in (v as any)) return norm(row[k]) <= norm((v as any).lte);
        if ('gt' in (v as any)) return norm(row[k]) > norm((v as any).gt);
        if ('gte' in (v as any)) return norm(row[k]) >= norm((v as any).gte);
        if ('startsWith' in (v as any)) return String(row[k] ?? '').startsWith((v as any).startsWith);
        if ('contains' in (v as any)) return String(row[k] ?? '').includes((v as any).contains);
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
    delete: async ({ where }: any) => {
      const i = rows.findIndex((x) => x.id === where.id);
      const [r] = rows.splice(i, 1);
      return r;
    },
    count: async ({ where }: any) => rows.filter((r) => matches(r, where)).length,
  });

  const db: any = {
    school: collection(schools),
    student: collection(students),
    class: collection(classes),
    parentToken: collection(parentTokens),
    messageQueue: collection(messageQueue),
    attendanceDay: collection(attendanceDays),
    attendanceRecord: collection(attendanceRecords),
    exam: collection(exams),
    result: collection(results),
    feeRecord: collection(feeRecords),
    timetableEntry: collection(timetableEntries),
    staff: collection(staff),
    announcement: collection(announcements),
    homework: collection(homework),
    auditLog: { create: async ({ data }: any) => { const r = { id: id(), ...data }; auditLogs.push(r); return r; } },
    changeLog: { create: async ({ data }: any) => { const r = { id: id(), ...data }; changeLogs.push(r); return r; } },
    $transaction: async (fn: (tx: any) => Promise<any>) => fn(db),
    __parentTokens: parentTokens,
    __messageQueue: messageQueue,
    __auditLogs: auditLogs,
  };
  return db;
}

function tokenFromUrl(url: string): string {
  return url.split('/p/')[1];
}

describe('parent tokens', () => {
  it('creates a link whose raw token is never stored in plaintext', async () => {
    const db = fakeDb();
    const info = await svc.createParentToken(db as any, 'school-1', 'stu-1', 'admin-1');
    expect(info.url).toMatch(/^http:\/\/localhost:5173\/p\/[0-9a-f]{64}$/);
    const row = db.__parentTokens[0];
    expect(row.tokenHash).not.toContain(tokenFromUrl(info.url as string));
    expect(row.tokenEnc).not.toContain(tokenFromUrl(info.url as string));
    expect(new Date(row.expiresAt as string).getTime()).toBeGreaterThan(Date.now());
  });

  it('rotating a token revokes the old one', async () => {
    const db = fakeDb();
    const first = await svc.createParentToken(db as any, 'school-1', 'stu-1', 'admin-1');
    const second = await svc.createParentToken(db as any, 'school-1', 'stu-1', 'admin-1');
    expect(tokenFromUrl(second.url as string)).not.toBe(tokenFromUrl(first.url as string));
    expect(await svc.resolveParentToken(db as any, tokenFromUrl(first.url as string))).toBeNull();
    expect(await svc.resolveParentToken(db as any, tokenFromUrl(second.url as string))).not.toBeNull();
  });

  it('revoked and expired tokens resolve to null', async () => {
    const db = fakeDb();
    const info = await svc.createParentToken(db as any, 'school-1', 'stu-1', 'admin-1');
    const raw = tokenFromUrl(info.url as string);
    await svc.revokeParentToken(db as any, 'school-1', 'stu-1', 'admin-1');
    expect(await svc.resolveParentToken(db as any, raw)).toBeNull();
    const info2 = await svc.createParentToken(db as any, 'school-1', 'stu-1', 'admin-1');
    db.__parentTokens[db.__parentTokens.length - 1].expiresAt = new Date(Date.now() - 1000);
    expect(await svc.resolveParentToken(db as any, tokenFromUrl(info2.url as string))).toBeNull();
  });

  it('token info reports the live link, then nothing after revoke', async () => {
    const db = fakeDb();
    expect(await svc.getParentTokenInfo(db as any, 'school-1', 'stu-1')).toEqual({ exists: false, url: null, expires_at: null });
    const info = await svc.createParentToken(db as any, 'school-1', 'stu-1', 'admin-1');
    const got = await svc.getParentTokenInfo(db as any, 'school-1', 'stu-1');
    expect(got.exists).toBe(true);
    expect(got.url).toBe(info.url);
    await svc.revokeParentToken(db as any, 'school-1', 'stu-1', 'admin-1');
    expect((await svc.getParentTokenInfo(db as any, 'school-1', 'stu-1')).exists).toBe(false);
  });

  it('creating a token for another school student is a 404, never a leak', async () => {
    const db = fakeDb();
    await expect(svc.createParentToken(db as any, 'school-1', 'stu-other', 'admin-1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('parent portal data — one student only', () => {
  it('shows exactly its own student: attendance, results, fees, homework; drafts hidden', async () => {
    const db = fakeDb();
    const info = await svc.createParentToken(db as any, 'school-1', 'stu-1', 'admin-1');
    const data = await svc.getParentPortal(db as any, tokenFromUrl(info.url as string));
    const student = data.student as any;
    expect(student.name).toBe('Ayesha Khan');
    expect(student.class_name).toBe('5-A');
    // Attendance: only stu-1's own statuses (present 19th, absent 18th).
    expect(data.attendance).toEqual([
      { date: '2026-11-19', status: 'present' },
      { date: '2026-11-18', status: 'absent' },
    ]);
    // Results/fees: stu-1 only — Bilal's 60 marks / unpaid fee never appear.
    expect((data.results as any[]).map((r: any) => r.obtained_marks)).toEqual([80]);
    expect((data.fees as any[]).map((f: any) => f.status)).toEqual(['paid']);
    // Timetable grouped by day; homework for the class; only approved announcements.
    expect((data.timetable as any[]).map((d: any) => d.day_of_week)).toEqual([1]);
    expect((data.homework as any[]).map((h: any) => h.title)).toEqual(['Exercise 5.2']);
    expect((data.announcements as any[]).map((a: any) => a.title)).toEqual(['PTM on Friday']);
  });

  it('a bogus token is a 404', async () => {
    const db = fakeDb();
    await expect(svc.getParentPortal(db as any, 'deadbeef'.repeat(8))).rejects.toMatchObject({ status: 404 });
  });
});

describe('send parent link via SMS (held draft, never auto-sent)', () => {
  it('queues one custom draft, unapproved; a second send the same day dedupes', async () => {
    const db = fakeDb();
    const first = await svc.sendParentLinkSms(db as any, 'school-1', 'stu-1', 'admin-1');
    expect(first.queued).toBe(true);
    expect(first.already_queued).toBe(false);
    const row = db.__messageQueue[0];
    expect(row.type).toBe('custom');
    expect(row.status).toBe('queued');
    expect(row.approvedBy).toBeNull();
    expect(row.body).toContain('/p/');
    expect(row.body).toContain('Ayesha Khan');
    const second = await svc.sendParentLinkSms(db as any, 'school-1', 'stu-1', 'admin-1');
    expect(second.already_queued).toBe(true);
    expect(db.__messageQueue.length).toBe(1);
  });

  it('refuses students with no number or an opted-out parent', async () => {
    const db = fakeDb();
    await expect(svc.sendParentLinkSms(db as any, 'school-1', 'stu-nophone', 'admin-1')).rejects.toMatchObject({ status: 400 });
    await expect(svc.sendParentLinkSms(db as any, 'school-1', 'stu-optout', 'admin-1')).rejects.toMatchObject({ status: 400 });
  });
});

describe('parent link via WhatsApp (Messaging Center wiring — click-to-send, queues nothing)', () => {
  it('returns a wa.me link with the portal URL pre-filled, and creates the token when none exists', async () => {
    const db = fakeDb();
    const res = await svc.getParentLinkWhatsApp(db as any, 'school-1', 'stu-1', 'admin-1');
    expect(typeof res.wa_url).toBe('string');
    expect(res.wa_url as string).toMatch(/^https:\/\/wa\.me\/923001234567\?text=/);
    const text = decodeURIComponent((res.wa_url as string).split('text=')[1]);
    expect(text).toContain('/p/');
    expect(text).toContain('Ayesha Khan');
    expect(res.phone_masked).toBeTruthy();
    // A token was created (none existed) — and NO queue row was made.
    expect(db.__parentTokens.length).toBe(1);
    expect(db.__messageQueue.length).toBe(0);
    expect(db.__auditLogs.some((a: any) => a.action === 'parent_token.whatsapp_link')).toBe(true);
  });

  it('refuses students with no number or an opted-out parent — same rules as SMS', async () => {
    const db = fakeDb();
    await expect(svc.getParentLinkWhatsApp(db as any, 'school-1', 'stu-nophone', 'admin-1')).rejects.toMatchObject({ status: 400 });
    await expect(svc.getParentLinkWhatsApp(db as any, 'school-1', 'stu-optout', 'admin-1')).rejects.toMatchObject({ status: 400 });
  });
});
