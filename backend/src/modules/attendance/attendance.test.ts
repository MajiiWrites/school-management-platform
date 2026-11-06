import { describe, it, expect } from 'vitest';
import { submitAttendance, getLinkPage } from './service';
import { hashToken, encryptPhone, sha256Hex } from '../../lib/crypto';

/**
 * In-memory fake of the Db surface the attendance service uses.
 * Dates used: 2026-11-09 (Monday), 2026-11-08 (Sunday), 2026-11-10 (Tuesday, holiday in one test).
 */
function fakeDb(opts: { revoked?: boolean; expired?: boolean; optOut?: boolean } = {}) {
  const classes: any[] = [
    {
      id: 'class-1',
      schoolId: 'school-1',
      name: '5',
      section: 'A',
      teacherName: 'Sir Ahmed',
      attendanceTokenHash: hashToken('valid-token'),
      tokenExpiresAt: opts.expired ? new Date('2020-01-01') : null,
      tokenRevoked: opts.revoked ?? false,
    },
  ];
  const schools: any[] = [{ id: 'school-1', name: 'Demo Public School', timezone: 'Asia/Karachi', settings: {} }];
  const students: any[] = [
    {
      id: 'stu-1',
      schoolId: 'school-1',
      classId: 'class-1',
      rollNo: 1,
      name: 'Ahmed Ali',
      parentPhoneEnc: encryptPhone('+923001111111'),
      parentPhoneHash: sha256Hex('+923001111111'),
      parentOptOut: false,
      status: 'active',
    },
    {
      id: 'stu-2',
      schoolId: 'school-1',
      classId: 'class-1',
      rollNo: 2,
      name: 'Bilal Khan',
      parentPhoneEnc: encryptPhone('+923002222222'),
      parentPhoneHash: sha256Hex('+923002222222'),
      parentOptOut: opts.optOut ?? false,
      status: 'active',
    },
  ];
  const days: any[] = [];
  const records: any[] = [];
  const queue: any[] = [];
  const notifications: any[] = [];
  const holidays: any[] = [];
  let seq = 1;
  const id = () => `id-${seq++}`;

  // Prisma @db.Date columns compare by DATE VALUE; the service now passes
  // Date objects (see lib/dates dateOnly). The fake must do the same —
  // strict === between a Date and a stored string (or two Date instances)
  // would never match, hiding double-submit / holiday regressions.
  const same = (a: any, b: any): boolean => {
    const norm = (v: any) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);
    return norm(a) === norm(b);
  };

  const db: any = {
    class: {
      // Strict === matching, except Prisma `field: null` (IS NULL) also
      // matches rows where the field is unset (6A: deletedAt filters).
      findFirst: async ({ where }: any) =>
        classes.find((c) => Object.entries(where ?? {}).every(([k, v]) => (v === null ? c[k] == null : c[k] === v))) ?? null,
    },
    school: {
      findUnique: async ({ where }: any) => schools.find((s) => s.id === where.id) ?? null,
    },
    student: {
      findMany: async ({ where }: any) =>
        students.filter((s) => Object.entries(where ?? {}).every(([k, v]) => (v === null ? s[k] == null : s[k] === v))),
    },
    holiday: {
      findFirst: async ({ where }: any) => holidays.find((h) => h.schoolId === where.schoolId && same(h.date, where.date)) ?? null,
    },
    attendanceDay: {
      findFirst: async ({ where }: any) =>
        days.find((d) => Object.entries(where ?? {}).every(([k, v]) => same(d[k], v))) ?? null,
      create: async ({ data }: any) => {
        const d = { id: id(), created_at: new Date(), ...data };
        days.push(d);
        return d;
      },
      update: async ({ where, data }: any) => {
        const d = days.find((x) => x.id === where.id);
        Object.assign(d, data);
        return d;
      },
    },
    attendanceRecord: {
      findMany: async ({ where }: any) =>
        records.filter((r) => Object.entries(where ?? {}).every(([k, v]) => r[k] === v)),
      createMany: async ({ data }: any) => {
        for (const row of data) records.push({ id: id(), ...row });
        return { count: data.length };
      },
      deleteMany: async ({ where }: any) => {
        const before = records.length;
        for (let i = records.length - 1; i >= 0; i--) {
          if (Object.entries(where ?? {}).every(([k, v]) => (records[i] as any)[k] === v)) records.splice(i, 1);
        }
        return { count: before - records.length };
      },
      count: async ({ where }: any) =>
        records.filter((r) => Object.entries(where ?? {}).every(([k, v]) => (r as any)[k] === v)).length,
    },
    messageTemplate: {
      findFirst: async () => null, // forces the built-in default template
    },
    messageQueue: {
      findUnique: async ({ where }: any) => queue.find((q) => q.dedupeKey === where.dedupeKey) ?? null,
      findMany: async ({ where }: any) =>
        queue.filter((q) => Object.entries(where ?? {}).every(([k, v]) => (q as any)[k] === v)),
      create: async ({ data }: any) => {
        // Mirror the DB defaults Prisma applies on a real insert (nullable
        // columns default to null; status/attempts have DB defaults) so the
        // fake row reads exactly like a row the real client returns.
        const q = { id: id(), createdAt: new Date(), status: 'queued', attempts: 0, sentAt: null, error: null, approvedBy: null, approvedAt: null, ...data };
        queue.push(q);
        return q;
      },
      update: async ({ where, data }: any) => {
        const q = queue.find((x) => x.id === where.id);
        Object.assign(q, data);
        return q;
      },
    },
    notification: {
      create: async ({ data }: any) => {
        const n = { id: id(), created_at: new Date(), is_read: false, ...data };
        notifications.push(n);
        return n;
      },
    },
    auditLog: { create: async ({ data }: any) => data },
    $transaction: async (fn: (tx: any) => Promise<any>) => fn(db),
    __days: days,
    __records: records,
    __queue: queue,
    __notifications: notifications,
    __holidays: holidays,
  };
  return db;
}

describe('submitAttendance rules', () => {
  it('submits a Monday: defaults missing students to present, drafts one absent message', async () => {
    const db = fakeDb();
    const result = await submitAttendance(db as any, {
      token: 'valid-token',
      dateOverride: '2026-11-09',
      records: [{ student_id: 'stu-2', status: 'absent' }], // stu-1 omitted -> present
    });
    expect(result.present).toBe(1);
    expect(result.absent).toBe(1);
    expect(result.messages_drafted).toBe(1);
    expect(db.__queue).toHaveLength(1);
    expect(db.__queue[0].dedupeKey).toBe('absent:stu-2:2026-11-09');
    expect(db.__queue[0].approvedBy).toBeNull(); // held for admin approval
    expect(db.__queue[0].body).toContain('Bilal Khan');
    expect(db.__queue[0].body).toContain('Class 5-A');
    expect(db.__notifications).toHaveLength(1);
    expect(db.__notifications[0].type).toBe('absent_approval');
  });

  it('rejects a second submission on the same day (409)', async () => {
    const db = fakeDb();
    await submitAttendance(db as any, { token: 'valid-token', dateOverride: '2026-11-09', records: [] });
    await expect(
      submitAttendance(db as any, { token: 'valid-token', dateOverride: '2026-11-09', records: [] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' } as any);
  });

  it('blocks submission on a Sunday', async () => {
    const db = fakeDb();
    await expect(
      submitAttendance(db as any, { token: 'valid-token', dateOverride: '2026-11-08', records: [] }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('Sundays') } as any);
  });

  it('blocks submission on a holiday', async () => {
    const db = fakeDb();
    db.__holidays.push({ schoolId: 'school-1', date: '2026-11-10', name: 'Iqbal Day' });
    await expect(
      submitAttendance(db as any, { token: 'valid-token', dateOverride: '2026-11-10', records: [] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' } as any);
  });

  it('rejects a revoked token and an unknown token', async () => {
    const revoked = fakeDb({ revoked: true });
    await expect(
      submitAttendance(revoked as any, { token: 'valid-token', dateOverride: '2026-11-09', records: [] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' } as any);
    const db = fakeDb();
    await expect(
      submitAttendance(db as any, { token: 'wrong-token', dateOverride: '2026-11-09', records: [] }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' } as any);
  });

  it('does not draft a message for an opted-out parent', async () => {
    const db = fakeDb({ optOut: true });
    const result = await submitAttendance(db as any, {
      token: 'valid-token',
      dateOverride: '2026-11-09',
      records: [{ student_id: 'stu-2', status: 'absent' }],
    });
    expect(result.messages_drafted).toBe(0);
    expect(result.students_without_valid_number).toHaveLength(1);
    expect(db.__queue).toHaveLength(0);
  });

  it('does not draft when nobody is absent', async () => {
    const db = fakeDb();
    const result = await submitAttendance(db as any, { token: 'valid-token', dateOverride: '2026-11-09', records: [] });
    expect(result.absent).toBe(0);
    expect(result.messages_drafted).toBe(0);
    expect(db.__queue).toHaveLength(0);
    expect(db.__notifications).toHaveLength(0);
  });
});

describe('getLinkPage (Fix C — teacher page class name)', () => {
  it('returns the class name and section the teacher page renders', async () => {
    const db = fakeDb();
    const page = await getLinkPage(db as any, 'valid-token');
    // Was: only display_name — the page rendered "Class -" and
    // "Class undefined-undefined" in the submit dialog.
    expect((page.class as any).name).toBe('5');
    expect((page.class as any).section).toBe('A');
    expect((page.class as any).display_name).toBe('5-A');
    expect(page.already_submitted).toBe(false);
    expect((page.students as any[])).toHaveLength(2);
  });
});
