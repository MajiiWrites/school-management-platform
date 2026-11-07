/**
 * Round 5 (F1 + F10) — server-side student pagination/search/flag filter
 * and CSV import rows with an empty name.
 * No DB, no network: a minimal fake Db driving the real service functions.
 */
import { describe, it, expect } from 'vitest';
import {
  listStudents,
  rowsToImportRows,
  previewImport,
} from '../service';
import { encryptPhone, sha256Hex } from '../../../lib/crypto';

const SCHOOL = 'school-1';
const CLASS = 'class-1';

const PHONE_A = '+923001111111';
const PHONE_Z = '+923002222222';

function studentRow(id: string, rollNo: number, name: string, phone: string | null, hash: string | null) {
  return {
    id,
    schoolId: SCHOOL,
    classId: CLASS,
    rollNo,
    name,
    nameUr: null,
    parentName: `Parent of ${name}`,
    parentPhoneEnc: phone ? encryptPhone(phone) : null,
    parentPhoneHash: hash,
    parent2PhoneEnc: null,
    parent2PhoneHash: null,
    parentOptOut: false,
    status: 'active',
    fatherName: null,
    admissionNo: null,
    dateOfBirth: null,
    gender: null,
    address: null,
    admissionDate: null,
    parent2Name: null,
    parent2OptOut: false,
    idCardIssuedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    deletedAt: null,
  };
}

const STUDENTS = [
  // Duplicate pair: same name + same parent phone, split across pages.
  studentRow('stu-1', 1, 'Ahmed Raza', PHONE_A, sha256Hex(PHONE_A)),
  studentRow('stu-2', 2, 'Ahmed Raza', PHONE_A, sha256Hex(PHONE_A)),
  studentRow('stu-3', 3, 'Bilal Khan', null, null),
  // 'invalid': a phone is stored but the hash is missing (decrypt also
  // fails on the garbage ciphertext, so the public flag is 'invalid').
  { ...studentRow('stu-4', 4, 'Sara Khan', null, null), parentPhoneEnc: 'garbage-not-ciphertext', parentPhoneHash: null },
  studentRow('stu-5', 5, 'Zara Malik', PHONE_Z, sha256Hex(PHONE_Z)),
];

function matches(row: Record<string, any>, where: any): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === 'OR' && Array.isArray(cond)) {
      if (!cond.some((c) => matches(row, c))) return false;
      continue;
    }
    const val = row[key];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      const c = cond as Record<string, any>;
      if ('not' in c) {
        if (c.not === null && (val === null || val === undefined)) return false;
        continue;
      }
      if ('in' in c) {
        if (!c.in.includes(val)) return false;
        continue;
      }
      if ('contains' in c) {
        const hay = String(val ?? '');
        const ok = c.mode === 'insensitive'
          ? hay.toLowerCase().includes(String(c.contains).toLowerCase())
          : hay.includes(String(c.contains));
        if (!ok) return false;
        continue;
      }
    }
    if (cond === null) {
      if (val !== null && val !== undefined) return false;
    } else if (val !== cond) {
      return false;
    }
  }
  return true;
}

function fakeDb(students: any[]) {
  const db: any = {
    class: {
      findFirst: async ({ where }: any) =>
        where.id === CLASS && where.schoolId === SCHOOL ? { id: CLASS, schoolId: SCHOOL, deletedAt: null } : null,
    },
    student: {
      findMany: async ({ where, orderBy, skip, take, select }: any) => {
        let list = students.filter((s) => matches(s, where));
        if (orderBy) {
          const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
          list = [...list].sort((a, b) => {
            for (const spec of specs) {
              for (const [field, dir] of Object.entries(spec)) {
                const av = a[field];
                const bv = b[field];
                if (av === bv) continue;
                if (av === null || av === undefined) return 1;
                if (bv === null || bv === undefined) return -1;
                return (dir === 'desc' ? -1 : 1) * (av < bv ? -1 : 1);
              }
            }
            return 0;
          });
        }
        if (skip) list = list.slice(skip);
        if (take !== undefined) list = list.slice(0, take);
        if (select) {
          list = list.map((r) => {
            const out: Record<string, any> = {};
            for (const k of Object.keys(select)) if (select[k]) out[k] = r[k];
            return out;
          });
        }
        return list;
      },
      count: async ({ where }: any) => students.filter((s) => matches(s, where)).length,
    },
  };
  return db;
}

describe('listStudents (Round 5 server pagination)', () => {
  it('pages by roll order and reports the server total', async () => {
    const db = fakeDb(STUDENTS);
    const p1 = await listStudents(db, SCHOOL, CLASS, { page: 1, limit: 2 });
    expect(p1.total).toBe(5);
    expect(p1.pages).toBe(3);
    expect(p1.items.map((i: any) => i.roll_no)).toEqual([1, 2]);
    const p2 = await listStudents(db, SCHOOL, CLASS, { page: 2, limit: 2 });
    expect(p2.items.map((i: any) => i.roll_no)).toEqual([3, 4]);
    const p3 = await listStudents(db, SCHOOL, CLASS, { page: 3, limit: 2 });
    expect(p3.items.map((i: any) => i.roll_no)).toEqual([5]);
  });

  it('searches server-side by name and by roll number', async () => {
    const db = fakeDb(STUDENTS);
    const byName = await listStudents(db, SCHOOL, CLASS, { search: 'ahmed' });
    expect(byName.total).toBe(2);
    expect(byName.items.map((i: any) => i.name)).toEqual(['Ahmed Raza', 'Ahmed Raza']);
    const byRoll = await listStudents(db, SCHOOL, CLASS, { search: '3' });
    expect(byRoll.total).toBe(1);
    expect(byRoll.items[0].name).toBe('Bilal Khan');
  });

  it('flags a duplicate pair even when the pair is split across pages', async () => {
    const db = fakeDb(STUDENTS);
    // Page 1 (limit 1) holds only stu-1; page 2 only stu-2. The old
    // page-local flagging saw neither as a duplicate.
    const p1 = await listStudents(db, SCHOOL, CLASS, { flag: 'duplicate', page: 1, limit: 1 });
    expect(p1.total).toBe(2);
    expect(p1.items[0].id).toBe('stu-1');
    expect(p1.items[0].phone_flag).toBe('duplicate');
    const p2 = await listStudents(db, SCHOOL, CLASS, { flag: 'duplicate', page: 2, limit: 1 });
    expect(p2.items[0].id).toBe('stu-2');
    expect(p2.items[0].phone_flag).toBe('duplicate');
  });

  it('filters missing / invalid phones server-side', async () => {
    const db = fakeDb(STUDENTS);
    const missing = await listStudents(db, SCHOOL, CLASS, { flag: 'missing' });
    expect(missing.total).toBe(1);
    expect(missing.items[0].id).toBe('stu-3');
    const invalid = await listStudents(db, SCHOOL, CLASS, { flag: 'invalid' });
    expect(invalid.total).toBe(1);
    expect(invalid.items[0].id).toBe('stu-4');
    expect(invalid.items[0].phone_flag).toBe('invalid');
  });
});

describe('rowsToImportRows + previewImport (Round 5 F10)', () => {
  it('skips genuinely blank lines but keeps empty-name rows for validation', () => {
    const rows = rowsToImportRows([
      ['name', 'roll_no', 'parent_phone'],
      ['', '', ''],
      ['', '7', '03001234567'],
      ['New Kid', '9', ''],
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('');
    expect(rows[0].roll_no).toBe(7);
    expect(rows[1].name).toBe('New Kid');
  });

  it('reports the empty-name row as invalid ("Missing student name")', async () => {
    const db = fakeDb(STUDENTS);
    const rows = rowsToImportRows([
      ['name', 'roll_no', 'parent_phone'],
      ['', '', ''],
      ['', '7', '03001234567'],
      ['New Kid', '9', ''],
    ]);
    const preview = await previewImport(db, SCHOOL, CLASS, rows);
    expect(preview.total).toBe(2);
    expect(preview.valid).toBe(1);
    expect(preview.invalid_rows).toEqual([{ row: 2, reason: 'Missing student name' }]);
    expect(preview.preview[0].status).toBe('invalid');
    expect(preview.preview[1].status).toBe('ok');
  });
});
