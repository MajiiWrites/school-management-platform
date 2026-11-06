import { describe, it, expect } from 'vitest';
import { createClass, listClasses, regenerateLink, revokeLink, updateClass, toPublicClass } from './service';
import { getLinkPage, submitAttendance, unlockAttendance } from '../attendance/service';
import { hashToken, encryptPhone, sha256Hex } from '../../lib/crypto';
import { todayInTz } from '../../lib/dates';

/**
 * Fix C (Phase 9) — Classes page forgot attendance links + today's status
 * on reload, and the teacher page showed "Class -" / "undefined-undefined".
 *
 * In-memory fake of the Db surface the classes + attendance services use.
 * Mirrors backend/src/modules/attendance/attendance.test.ts conventions
 * (null where-values match unset fields; @db.Date compares by date value).
 * Today is computed live (Asia/Karachi) so the "submitted today" leg works
 * whenever the suite runs on a school day; it is skipped on Sundays, when
 * no submission is possible at all.
 */
function fakeDb() {
  const classes: any[] = [
    {
      id: 'class-1',
      schoolId: 'school-1',
      name: '5',
      section: 'A',
      teacherName: 'Sir Ahmed',
      teacherPhoneEnc: encryptPhone('+923001111111'),
      teacherPhoneHash: sha256Hex('+923001111111'),
      // Legacy row: link generated BEFORE the attendance_token_enc column
      // existed — hash present, encrypted token absent.
      attendanceTokenHash: hashToken('legacy-token'),
      attendanceTokenEnc: undefined,
      tokenExpiresAt: null,
      tokenRevoked: false,
      deletedAt: null,
    },
  ];
  const schools: any[] = [{ id: 'school-1', name: 'Test School', timezone: 'Asia/Karachi', settings: {} }];
  const students: any[] = [
    { id: 'stu-1', schoolId: 'school-1', classId: 'class-1', rollNo: 1, name: 'Ahmed Ali', parentPhoneEnc: encryptPhone('+923001111111'), parentPhoneHash: sha256Hex('+923001111111'), parentOptOut: false, status: 'active', deletedAt: null },
    { id: 'stu-2', schoolId: 'school-1', classId: 'class-1', rollNo: 2, name: 'Bilal Khan', parentPhoneEnc: encryptPhone('+923002222222'), parentPhoneHash: sha256Hex('+923002222222'), parentOptOut: false, status: 'active', deletedAt: null },
  ];
  const days: any[] = [];
  const records: any[] = [];
  const queue: any[] = [];
  const notifications: any[] = [];
  const holidays: any[] = [];
  const changeLogs: any[] = [];
  let seq = 1;
  const id = () => `id-${seq++}`;

  const same = (a: any, b: any): boolean => {
    const norm = (v: any) => (v instanceof Date ? v.toISOString().slice(0, 10) : v);
    return norm(a) === norm(b);
  };
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]) => {
      if (v !== null && typeof v === 'object' && 'in' in (v as any)) return (v as any).in.includes(row[k]);
      if (v === null) return row[k] == null;
      return same(row[k], v);
    });

  const db: any = {
    class: {
      findFirst: async ({ where }: any) => classes.find((c) => matches(c, where)) ?? null,
      findMany: async ({ where }: any) => classes.filter((c) => matches(c, where)),
      create: async ({ data }: any) => {
        const c = { id: id(), tokenRevoked: false, tokenExpiresAt: null, attendanceTokenHash: null, attendanceTokenEnc: null, deletedAt: null, createdAt: new Date(), updatedAt: new Date(), ...data };
        classes.push(c);
        return c;
      },
      update: async ({ where, data }: any) => {
        const c = classes.find((x) => x.id === where.id);
        Object.assign(c, data);
        return c;
      },
    },
    school: {
      findUnique: async ({ where }: any) => schools.find((s) => s.id === where.id) ?? null,
    },
    student: {
      findMany: async ({ where }: any) => students.filter((s) => matches(s, where)),
      groupBy: async ({ by, where }: any) => {
        const groups = new Map<string, number>();
        for (const s of students.filter((x) => matches(x, where))) {
          const key = s[by[0]];
          groups.set(key, (groups.get(key) ?? 0) + 1);
        }
        return [...groups.entries()].map(([k, n]) => ({ [by[0]]: k, _count: { _all: n } }));
      },
      count: async ({ where }: any) => students.filter((s) => matches(s, where)).length,
    },
    holiday: {
      findFirst: async ({ where }: any) => holidays.find((h) => h.schoolId === where.schoolId && same(h.date, where.date)) ?? null,
    },
    attendanceDay: {
      findFirst: async ({ where }: any) => days.find((d) => matches(d, where)) ?? null,
      findMany: async ({ where }: any) => days.filter((d) => matches(d, where)),
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
      findMany: async ({ where }: any) => records.filter((r) => matches(r, where)),
      createMany: async ({ data }: any) => {
        for (const row of data) records.push({ id: id(), ...row });
        return { count: data.length };
      },
      deleteMany: async ({ where }: any) => {
        const before = records.length;
        for (let i = records.length - 1; i >= 0; i--) {
          if (matches(records[i], where)) records.splice(i, 1);
        }
        return { count: before - records.length };
      },
      count: async ({ where }: any) => records.filter((r) => matches(r, where)).length,
      groupBy: async ({ by, where }: any) => {
        const groups = new Map<string, number>();
        for (const r of records.filter((x) => matches(x, where))) {
          const key = by.map((b: string) => r[b]).join('|');
          groups.set(key, (groups.get(key) ?? 0) + 1);
        }
        return [...groups.entries()].map(([key, n]) => {
          const parts = key.split('|');
          const out: any = { _count: { _all: n } };
          by.forEach((b: string, i: number) => { out[b] = parts[i]; });
          return out;
        });
      },
    },
    messageTemplate: {
      findFirst: async () => null, // forces the built-in default template
    },
    messageQueue: {
      findUnique: async ({ where }: any) => queue.find((q) => q.dedupeKey === where.dedupeKey) ?? null,
      findMany: async ({ where }: any) => queue.filter((q) => matches(q, where)),
      create: async ({ data }: any) => {
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
    changeLog: {
      create: async ({ data }: any) => {
        const row = { id: id(), ...data };
        changeLogs.push(row);
        return row;
      },
    },
    $transaction: async (fn: (tx: any) => Promise<any>) => fn(db),
    __classes: classes,
    __days: days,
    __records: records,
    __queue: queue,
  };
  return db;
}

const today = todayInTz('Asia/Karachi');
const isSunday = new Date(`${today}T00:00:00Z`).getUTCDay() === 0;

describe('Fix C — Classes page remembers links + today status', () => {
  it('regenerate stores the encrypted token; a reloaded list shows the same link', async () => {
    const db = fakeDb();
    const created = await createClass(db as any, 'school-1', { name: '6', section: 'B', teacher_name: 'Ms. Rabia', teacher_phone: '03001234567' }, 'admin-1');
    const gen = await regenerateLink(db as any, 'school-1', created.id, 'admin-1');
    expect(gen.link).toMatch(/^https?:\/\/.+\/t\/[0-9a-f]+$/);

    // Simulate "navigate away and back": a fresh listClasses call.
    const items = await listClasses(db as any, 'school-1');
    const row = items.find((c: any) => c.id === created.id) as any;
    expect(row.attendance_link).toBe(gen.link);
    expect(row.attendance_link_active).toBe(true);
    expect(row.submitted_today).toBe(false);
    expect(row.attendance_date).toBe(today);
    // Teacher phone is masked in the list (edit form pre-fills from this).
    expect(row.teacher_phone_masked).toBe('+92 3XX XXXX567');
  });

  it('legacy links (hash only, no encrypted token) report active but no URL', async () => {
    const db = fakeDb();
    const items = await listClasses(db as any, 'school-1');
    const row = items.find((c: any) => c.id === 'class-1') as any;
    expect(row.attendance_link).toBeNull();
    expect(row.attendance_link_active).toBe(true);
  });

  it('a corrupt encrypted token never breaks the list', async () => {
    const db = fakeDb();
    db.__classes[0].attendanceTokenEnc = 'aGVsbG8='; // 5 bytes — not a valid ciphertext
    const items = await listClasses(db as any, 'school-1');
    expect((items[0] as any).attendance_link).toBeNull();
  });

  it('revoke clears the link from the list; regenerate issues a new one', async () => {
    const db = fakeDb();
    const gen1 = await regenerateLink(db as any, 'school-1', 'class-1', 'admin-1');
    expect((await listClasses(db as any, 'school-1')).find((c: any) => c.id === 'class-1')!.attendance_link).toBe(gen1.link);
    await revokeLink(db as any, 'school-1', 'class-1', 'admin-1');
    const afterRevoke = (await listClasses(db as any, 'school-1')).find((c: any) => c.id === 'class-1') as any;
    expect(afterRevoke.attendance_link).toBeNull();
    expect(afterRevoke.attendance_link_active).toBe(false);
    const gen2 = await regenerateLink(db as any, 'school-1', 'class-1', 'admin-1');
    expect(gen2.link).not.toBe(gen1.link);
    expect(((await listClasses(db as any, 'school-1')).find((c: any) => c.id === 'class-1') as any).attendance_link).toBe(gen2.link);
  });

  it('updating a class changes the masked teacher phone the edit form reads', async () => {
    const db = fakeDb();
    await updateClass(db as any, 'school-1', 'class-1', { teacher_phone: '03009998888' }, 'admin-1');
    const row = (await listClasses(db as any, 'school-1')).find((c: any) => c.id === 'class-1') as any;
    expect(row.teacher_phone_masked).toBe('+92 3XX XXXX888');
  });

  it('toPublicClass never leaks the raw teacher phone', async () => {
    const db = fakeDb();
    const row = toPublicClass(db.__classes[0], 2) as any;
    expect(JSON.stringify(row)).not.toContain('03001111111');
    expect(JSON.stringify(row)).not.toContain('+923001111111');
  });

  it.skipIf(isSunday)('full flow: link → public page shows class name → submit → list shows submitted/locked → unlock → resubmit', async () => {
    const db = fakeDb();
    const gen = await regenerateLink(db as any, 'school-1', 'class-1', 'admin-1');

    // Public teacher page: the class name must render (was "Class -").
    const page = await getLinkPage(db as any, gen.token);
    expect((page.class as any).name).toBe('5');
    expect((page.class as any).section).toBe('A');
    expect((page.class as any).display_name).toBe('5-A');
    expect(page.already_submitted).toBe(false);

    // Teacher submits (stu-2 absent, stu-1 defaults to present).
    const result = await submitAttendance(db as any, {
      token: gen.token,
      dateOverride: today,
      records: [{ student_id: 'stu-2', status: 'absent' }],
    });
    expect(result.present).toBe(1);
    expect(result.absent).toBe(1);

    // Reload the Classes page: the card must now show Submitted + absent count.
    const row = (await listClasses(db as any, 'school-1')).find((c: any) => c.id === 'class-1') as any;
    expect(row.submitted_today).toBe(true);
    expect(row.absent_today).toBe(1);
    expect(row.present_today).toBe(1);
    expect(row.attendance_unlocked).toBe(false);
    // The link itself is still shown after submission.
    expect(row.attendance_link).toBe(gen.link);

    // Second submission is locked (409) until the admin unlocks it.
    await expect(
      submitAttendance(db as any, { token: gen.token, dateOverride: today, records: [] }),
    ).rejects.toMatchObject({ code: 'CONFLICT' } as any);

    await unlockAttendance(db as any, 'school-1', 'class-1', today, 'admin-1');
    const unlocked = (await listClasses(db as any, 'school-1')).find((c: any) => c.id === 'class-1') as any;
    expect(unlocked.attendance_unlocked).toBe(true);
    const resubmitted = await submitAttendance(db as any, { token: gen.token, dateOverride: today, records: [] });
    expect(resubmitted.present).toBe(2);
  });
});
