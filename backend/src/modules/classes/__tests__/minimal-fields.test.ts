/**
 * FINAL REBUILD Point 1 — a class needs ONLY Class Name + Class Teacher
 * Name. Section, teacher phone and every other detail are optional:
 * saving with just the two fields must work, with no validation error
 * for any empty optional field (zod schema + service), and optional
 * details can be added/edited later. No DB schema change: section is
 * stored as "" and the @@unique([schoolId, name, section]) keeps working.
 * No DB, no network: minimal fake Db driving the real service + schema.
 */
import { describe, it, expect } from 'vitest';
import { createClass, updateClass, listClasses, toPublicClass } from '../service';
import { classSchema } from '../routes';

const SCHOOL = 'school-1';

function fakeDb() {
  const classes: any[] = [];
  const changeLogs: any[] = [];
  let seq = 1;
  const id = () => `id-${seq++}`;
  const matches = (row: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]) => {
      if (v !== null && typeof v === 'object' && 'in' in (v as any)) return (v as any).in.includes(row[k]);
      if (v === null) return row[k] == null;
      return row[k] === v;
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
    school: { findUnique: async () => ({ id: SCHOOL, timezone: 'Asia/Karachi' }) },
    student: {
      groupBy: async () => [],
      count: async () => 0,
    },
    attendanceDay: { findMany: async () => [] },
    attendanceRecord: { groupBy: async () => [] },
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
    __changeLogs: changeLogs,
  };
  return db;
}

describe('Point 1 — zod schema: only name + teacher name required', () => {
  it('parses with just name + teacher_name (no section, no phone)', () => {
    const parsed = classSchema.parse({ name: '5', teacher_name: 'Ms Shazia' });
    expect(parsed.name).toBe('5');
    expect(parsed.section).toBeUndefined();
    expect(parsed.teacher_phone).toBeUndefined();
  });

  it('parses with empty-string section and empty phone without error', () => {
    const parsed = classSchema.parse({ name: '5', section: '', teacher_name: 'Ms Shazia', teacher_phone: '' });
    expect(parsed.section).toBe('');
  });

  it('still rejects a missing class name and a missing teacher name', () => {
    expect(() => classSchema.parse({ teacher_name: 'Ms Shazia' })).toThrow();
    expect(() => classSchema.parse({ name: '5' })).toThrow();
    expect(() => classSchema.parse({ name: '5', teacher_name: 'X' })).toThrow(); // too short
  });
});

describe('Point 1 — createClass with minimal fields', () => {
  it('saves with only name + teacher name; section stored as ""', async () => {
    const db = fakeDb();
    const created = await createClass(db as any, SCHOOL, { name: '5', teacher_name: 'Ms Shazia' }, 'admin-1');
    expect(created.section).toBe('');
    expect(created.teacherPhoneEnc).toBeNull();
    const row = toPublicClass(created, 0) as any;
    expect(row.display_name).toBe('5'); // never "5-"
    expect(row.teacher_phone_masked).toBeNull();
  });

  it('saves with empty-string section and empty phone (no validation error)', async () => {
    const db = fakeDb();
    const created = await createClass(db as any, SCHOOL, { name: '6', section: '', teacher_name: 'Sir Ahmed', teacher_phone: '' }, 'admin-1');
    expect(created.section).toBe('');
    expect(created.teacherPhoneEnc).toBeNull();
  });

  it('a class with a section still works, and the unique key still applies', async () => {
    const db = fakeDb();
    await createClass(db as any, SCHOOL, { name: '5', teacher_name: 'Ms Shazia' }, 'admin-1');
    // Same name, no section again → conflict (same ("5", "") key).
    await expect(createClass(db as any, SCHOOL, { name: '5', teacher_name: 'Someone Else' }, 'admin-1')).rejects.toMatchObject({ code: 'CONFLICT' });
    // Same name, a real section → a different class, allowed.
    const other = await createClass(db as any, SCHOOL, { name: '5', section: 'B', teacher_name: 'Sir Ahmed' }, 'admin-1');
    expect((toPublicClass(other, 0) as any).display_name).toBe('5-B');
  });

  it('existing classes are unaffected — a stored section round-trips', async () => {
    const db = fakeDb();
    const created = await createClass(db as any, SCHOOL, { name: '7', section: 'A', teacher_name: 'Ms Rabia', teacher_phone: '03001234567' }, 'admin-1');
    const row = (await listClasses(db as any, SCHOOL)).find((c: any) => c.id === created.id) as any;
    expect(row.display_name).toBe('7-A');
    expect(row.teacher_phone_masked).toBe('+92 3XX XXXX567');
  });
});

describe('Point 1 — optional details addable / editable later', () => {
  it('update without section keeps the existing section', async () => {
    const db = fakeDb();
    const created = await createClass(db as any, SCHOOL, { name: '5', section: 'A', teacher_name: 'Ms Shazia' }, 'admin-1');
    const updated = await updateClass(db as any, SCHOOL, created.id, { teacher_name: 'Ms Shazia Parveen' }, 'admin-1');
    expect(updated.section).toBe('A');
    expect(updated.teacherName).toBe('Ms Shazia Parveen');
  });

  it('section can be added later to a section-less class', async () => {
    const db = fakeDb();
    const created = await createClass(db as any, SCHOOL, { name: '5', teacher_name: 'Ms Shazia' }, 'admin-1');
    const updated = await updateClass(db as any, SCHOOL, created.id, { section: 'C' }, 'admin-1');
    expect(updated.section).toBe('C');
    expect((toPublicClass(updated, 0) as any).display_name).toBe('5-C');
  });

  it('section can be cleared back to blank later', async () => {
    const db = fakeDb();
    const created = await createClass(db as any, SCHOOL, { name: '5', section: 'A', teacher_name: 'Ms Shazia' }, 'admin-1');
    const updated = await updateClass(db as any, SCHOOL, created.id, { section: '' }, 'admin-1');
    expect(updated.section).toBe('');
    expect((toPublicClass(updated, 0) as any).display_name).toBe('5');
  });

  it('teacher phone can be added later', async () => {
    const db = fakeDb();
    const created = await createClass(db as any, SCHOOL, { name: '5', teacher_name: 'Ms Shazia' }, 'admin-1');
    await updateClass(db as any, SCHOOL, created.id, { teacher_phone: '03009998888' }, 'admin-1');
    const row = (await listClasses(db as any, SCHOOL)).find((c: any) => c.id === created.id) as any;
    expect(row.teacher_phone_masked).toBe('+92 3XX XXXX888');
  });

  it('create + update are logged to change history', async () => {
    const db = fakeDb();
    const created = await createClass(db as any, SCHOOL, { name: '5', teacher_name: 'Ms Shazia' }, 'admin-1');
    await updateClass(db as any, SCHOOL, created.id, { section: 'A' }, 'admin-1');
    expect(db.__changeLogs.length).toBeGreaterThanOrEqual(2); // create + update (one row per changed field)
    expect(db.__changeLogs.every((l: any) => l.entity === 'class')).toBe(true);
    expect(db.__changeLogs.every((l: any) => l.entityId === created.id)).toBe(true);
  });
});
