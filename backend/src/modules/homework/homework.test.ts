// Homework tests (Gap #3, 2026-11-20): CRUD scoping + soft delete to
// the recycle bin, notify drafts (eligible parents only, deduped,
// held for approval — never auto-sent). In-memory fake Db, same
// conventions as modules/college/college.test.ts.
import { describe, it, expect } from 'vitest';
import * as svc from './service';
import { encryptPhone } from '../../lib/crypto';

function fakeDb() {
  const schools: any[] = [
    { id: 'school-1', name: 'Test School', slug: 'test-school', timezone: 'Asia/Karachi', settings: {} },
    { id: 'school-2', name: 'Other School', slug: 'other-school', timezone: 'Asia/Karachi', settings: {} },
  ];
  const classes: any[] = [
    { id: 'class-1', schoolId: 'school-1', name: '5', section: 'A', teacherName: 'Miss Sana', deletedAt: null },
    { id: 'class-2', schoolId: 'school-1', name: '6', section: 'B', teacherName: 'Sir Ali', deletedAt: null },
    { id: 'class-other', schoolId: 'school-2', name: '5', section: 'A', teacherName: 'Other', deletedAt: null },
  ];
  const students: any[] = [
    { id: 'stu-1', schoolId: 'school-1', classId: 'class-1', status: 'active', deletedAt: null, name: 'Ayesha Khan', parentPhoneEnc: encryptPhone('+923001234567'), parentOptOut: false },
    { id: 'stu-2', schoolId: 'school-1', classId: 'class-1', status: 'active', deletedAt: null, name: 'Bilal Ahmed', parentPhoneEnc: encryptPhone('+923001234568'), parentOptOut: false },
    { id: 'stu-nophone', schoolId: 'school-1', classId: 'class-1', status: 'active', deletedAt: null, name: 'No Phone', parentPhoneEnc: null, parentOptOut: false },
    { id: 'stu-optout', schoolId: 'school-1', classId: 'class-1', status: 'active', deletedAt: null, name: 'Opted Out', parentPhoneEnc: encryptPhone('+923001234569'), parentOptOut: true },
    { id: 'stu-left', schoolId: 'school-1', classId: 'class-1', status: 'left', deletedAt: null, name: 'Left School', parentPhoneEnc: encryptPhone('+923001234570'), parentOptOut: false },
    { id: 'stu-other-class', schoolId: 'school-1', classId: 'class-2', status: 'active', deletedAt: null, name: 'Other Class', parentPhoneEnc: encryptPhone('+923001234571'), parentOptOut: false },
  ];
  const homework: any[] = [];
  const messageQueue: any[] = [];
  const auditLogs: any[] = [];
  const changeLogs: any[] = [];
  const deletedRecords: any[] = [];
  let seq = 1;
  const id = () => `id-${seq++}`;

  const norm = (v: any) => (v instanceof Date ? v.getTime() : v);
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]) => {
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        if ('in' in (v as any)) return (v as any).in.map(norm).includes(norm(row[k]));
        if ('not' in (v as any)) return (v as any).not === null ? row[k] != null : norm(row[k]) !== norm((v as any).not);
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
    homework: collection(homework),
    messageQueue: collection(messageQueue),
    auditLog: { create: async ({ data }: any) => { const r = { id: id(), ...data }; auditLogs.push(r); return r; } },
    changeLog: { create: async ({ data }: any) => { const r = { id: id(), ...data }; changeLogs.push(r); return r; } },
    deletedRecord: { create: async ({ data }: any) => { const r = { id: id(), ...data }; deletedRecords.push(r); return r; } },
    $transaction: async (fn: (tx: any) => Promise<any>) => fn(db),
    __homework: homework,
    __messageQueue: messageQueue,
    __deletedRecords: deletedRecords,
    __auditLogs: auditLogs,
  };
  return db;
}

const VALID = {
  class_id: 'class-1',
  subject: 'Math',
  title: 'Exercise 5.2',
  description: 'Questions 1–10',
  due_date: '2026-11-21',
  teacher: 'Miss Sana',
};

describe('homework CRUD', () => {
  it('creates homework for a class in its own school', async () => {
    const db = fakeDb();
    const created = await svc.createHomework(db as any, 'school-1', VALID, 'admin-1');
    expect(created.title).toBe('Exercise 5.2');
    expect(created.due_date).toBe('2026-11-21');
    expect(created.class_name).toBe('5-A');
    expect(db.__homework.length).toBe(1);
  });

  it('rejects a class from another school and a bad due date', async () => {
    const db = fakeDb();
    await expect(svc.createHomework(db as any, 'school-1', { ...VALID, class_id: 'class-other' }, 'admin-1')).rejects.toMatchObject({ status: 404 });
    await expect(svc.createHomework(db as any, 'school-1', { ...VALID, due_date: '21-11-2026' }, 'admin-1')).rejects.toMatchObject({ status: 400 });
  });

  it('lists per class, soonest due first, and hides soft-deleted rows', async () => {
    const db = fakeDb();
    const hw1 = await svc.createHomework(db as any, 'school-1', VALID, 'admin-1');
    await svc.createHomework(db as any, 'school-1', { ...VALID, class_id: 'class-2', title: 'Later work', due_date: '2026-11-25' }, 'admin-1');
    await svc.createHomework(db as any, 'school-1', { ...VALID, title: 'Earlier work', due_date: '2026-11-20' }, 'admin-1');
    const all = await svc.listHomework(db as any, 'school-1', {});
    expect((all.items as any[]).map((h: any) => h.title)).toEqual(['Earlier work', 'Exercise 5.2', 'Later work']);
    const onlyClass2 = await svc.listHomework(db as any, 'school-1', { class_id: 'class-2' });
    expect((onlyClass2.items as any[]).map((h: any) => h.title)).toEqual(['Later work']);
    await svc.deleteHomework(db as any, 'school-1', hw1.id as string, 'admin-1');
    const after = await svc.listHomework(db as any, 'school-1', {});
    expect((after.items as any[]).map((h: any) => h.title)).toEqual(['Earlier work', 'Later work']);
  });

  it('updates title and due date; a second delete is a conflict', async () => {
    const db = fakeDb();
    const created = await svc.createHomework(db as any, 'school-1', VALID, 'admin-1');
    const updated = await svc.updateHomework(db as any, 'school-1', created.id as string, { title: 'Exercise 5.3', due_date: '2026-11-22' }, 'admin-1');
    expect(updated.title).toBe('Exercise 5.3');
    expect(updated.due_date).toBe('2026-11-22');
    await svc.deleteHomework(db as any, 'school-1', created.id as string, 'admin-1');
    expect(db.__deletedRecords.length).toBe(1);
    expect(db.__deletedRecords[0].entity).toBe('homework');
    await expect(svc.deleteHomework(db as any, 'school-1', created.id as string, 'admin-1')).rejects.toMatchObject({ status: 404 });
  });

  it('update/delete of another school homework is a 404', async () => {
    const db = fakeDb();
    const created = await svc.createHomework(db as any, 'school-1', VALID, 'admin-1');
    await expect(svc.updateHomework(db as any, 'school-2', created.id as string, { title: 'Hijack' }, 'admin-1')).rejects.toMatchObject({ status: 404 });
    await expect(svc.deleteHomework(db as any, 'school-2', created.id as string, 'admin-1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('homework notify (held drafts, never auto-sent)', () => {
  it('drafts only for eligible parents of that class; skips opted-out, missing number, left students, other classes', async () => {
    const db = fakeDb();
    const created = await svc.createHomework(db as any, 'school-1', VALID, 'admin-1');
    const result = await svc.notifyHomework(db as any, 'school-1', created.id as string, 'admin-1');
    // Eligible: stu-1 + stu-2. Skipped: no-phone + opted-out (2). Left + other-class never counted.
    expect(result).toEqual({ drafted: 2, skipped: 2, total_students: 4 });
    expect(db.__messageQueue.length).toBe(2);
    for (const q of db.__messageQueue) {
      expect(q.type).toBe('custom');
      expect(q.status).toBe('queued');
      expect(q.approvedBy).toBeNull();
      expect(q.body).toContain('Exercise 5.2');
      expect(q.body).toContain('due 2026-11-21');
    }
  });

  it('notifying twice does not duplicate drafts (dedupe key)', async () => {
    const db = fakeDb();
    const created = await svc.createHomework(db as any, 'school-1', VALID, 'admin-1');
    await svc.notifyHomework(db as any, 'school-1', created.id as string, 'admin-1');
    const second = await svc.notifyHomework(db as any, 'school-1', created.id as string, 'admin-1');
    expect(second.drafted).toBe(0);
    expect(db.__messageQueue.length).toBe(2);
  });
});
