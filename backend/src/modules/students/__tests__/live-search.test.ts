/**
 * FINAL REBUILD Point 3 — server-side live search (`q` param, alias
 * `search`) in listStudents + listStudentsSchoolWide.
 * Partial match anywhere, case-insensitive, Urdu + English, across:
 * student name (EN + Urdu), father's name, roll number, admission
 * number (parent/guardian name kept as an extra field). Empty q = plain
 * list; a q matching nothing → total 0 ("No student found" in the UI).
 * Scoped by schoolId; paginated server-side (never fetch-all).
 * No DB, no network: minimal fake Db driving the real service functions.
 */
import { describe, it, expect } from 'vitest';
import { listStudents, listStudentsSchoolWide } from '../service';
import { encryptPhone, sha256Hex } from '../../../lib/crypto';

const SCHOOL = 'school-1';
const OTHER_SCHOOL = 'school-2';
const CLASS = 'class-1';

const PHONE_A = '+923001111111';

function studentRow(over: Record<string, any>) {
  return {
    id: 'stu-x',
    schoolId: SCHOOL,
    classId: CLASS,
    rollNo: null,
    name: 'Unnamed',
    nameUr: null,
    parentName: null,
    parentPhoneEnc: null,
    parentPhoneHash: null,
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
    ...over,
  };
}

const STUDENTS = [
  studentRow({ id: 'stu-1', rollNo: 1, name: 'Ahmed Raza', nameUr: 'احمد رضا', fatherName: 'Muhammad Raza', admissionNo: 'ADM-101', parentName: 'Muhammad Raza', parentPhoneEnc: encryptPhone(PHONE_A), parentPhoneHash: sha256Hex(PHONE_A) }),
  studentRow({ id: 'stu-2', rollNo: 12, name: 'Bilal Khan', fatherName: 'Imran Khan', admissionNo: 'ADM-102', parentName: 'Imran Khan' }),
  studentRow({ id: 'stu-3', rollNo: 3, name: 'Sara Khan', fatherName: 'Ahmed Khan', admissionNo: 'ADM-103', parentName: 'Ahmed Khan' }),
  // Same name, different school — must never leak across tenants.
  studentRow({ id: 'stu-4', schoolId: OTHER_SCHOOL, rollNo: 1, name: 'Ahmed Raza', fatherName: 'Other Father', admissionNo: 'ADM-999' }),
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

describe('listStudents live search (q)', () => {
  it('partial name match, case-insensitive ("ahm" and "AHMED")', async () => {
    const db = fakeDb(STUDENTS);
    const lower = await listStudents(db, SCHOOL, CLASS, { q: 'ahm' });
    expect(lower.total).toBe(2); // Ahmed Raza (name) + Sara Khan (father Ahmed Khan)
    expect(lower.items.map((i: any) => i.id).sort()).toEqual(['stu-1', 'stu-3']);
    const upper = await listStudents(db, SCHOOL, CLASS, { q: 'AHMED' });
    expect(upper.total).toBe(2);
  });

  it('matches the Urdu name', async () => {
    const db = fakeDb(STUDENTS);
    const res = await listStudents(db, SCHOOL, CLASS, { q: 'احمد' });
    expect(res.total).toBe(1);
    expect(res.items[0].id).toBe('stu-1');
  });

  it("matches by father's name", async () => {
    const db = fakeDb(STUDENTS);
    const res = await listStudents(db, SCHOOL, CLASS, { q: 'imran' });
    expect(res.total).toBe(1);
    expect(res.items[0].id).toBe('stu-2');
  });

  it('matches by admission number, partial ("adm-10" finds all three)', async () => {
    const db = fakeDb(STUDENTS);
    const all = await listStudents(db, SCHOOL, CLASS, { q: 'adm-10' });
    expect(all.total).toBe(3);
    const one = await listStudents(db, SCHOOL, CLASS, { q: 'ADM-102' });
    expect(one.total).toBe(1);
    expect(one.items[0].id).toBe('stu-2');
  });

  it('matches by roll number (exact int for the Int column)', async () => {
    const db = fakeDb(STUDENTS);
    const res = await listStudents(db, SCHOOL, CLASS, { q: '12' });
    expect(res.total).toBe(1);
    expect(res.items[0].id).toBe('stu-2');
  });

  it('`search` still works as an alias for `q`', async () => {
    const db = fakeDb(STUDENTS);
    const res = await listStudents(db, SCHOOL, CLASS, { search: 'bilal' });
    expect(res.total).toBe(1);
    expect(res.items[0].id).toBe('stu-2');
  });

  it('a query matching nothing returns no results (total 0)', async () => {
    const db = fakeDb(STUDENTS);
    const res = await listStudents(db, SCHOOL, CLASS, { q: 'zzz-no-such-student' });
    expect(res.total).toBe(0);
    expect(res.items).toEqual([]);
    expect(res.pages).toBe(1);
  });

  it('empty q returns the full list (list mode, not a search)', async () => {
    const db = fakeDb(STUDENTS);
    expect((await listStudents(db, SCHOOL, CLASS, { q: '' })).total).toBe(3);
    expect((await listStudents(db, SCHOOL, CLASS, {})).total).toBe(3);
  });

  it('never leaks students from another school', async () => {
    const db = fakeDb(STUDENTS);
    const res = await listStudents(db, SCHOOL, CLASS, { q: 'ADM-999' });
    expect(res.total).toBe(0);
    const all = await listStudents(db, SCHOOL, CLASS, {});
    expect(all.items.map((i: any) => i.id).sort()).toEqual(['stu-1', 'stu-2', 'stu-3']);
  });

  it('search stays server-paginated (page 2 of a search)', async () => {
    const db = fakeDb(STUDENTS);
    const p1 = await listStudents(db, SCHOOL, CLASS, { q: 'adm-10', page: 1, limit: 2 });
    expect(p1.total).toBe(3);
    expect(p1.pages).toBe(2);
    expect(p1.items).toHaveLength(2);
    const p2 = await listStudents(db, SCHOOL, CLASS, { q: 'adm-10', page: 2, limit: 2 });
    expect(p2.items).toHaveLength(1);
  });
});

describe('listStudentsSchoolWide live search (q)', () => {
  it("searches father's name and admission number school-wide", async () => {
    const db = fakeDb(STUDENTS);
    const byFather = await listStudentsSchoolWide(db, SCHOOL, { q: 'imran' });
    expect(byFather.total).toBe(1);
    expect(byFather.items[0].id).toBe('stu-2');
    const byAdm = await listStudentsSchoolWide(db, SCHOOL, { q: 'adm-103' });
    expect(byAdm.total).toBe(1);
    expect(byAdm.items[0].id).toBe('stu-3');
  });

  it('no-match → total 0; empty q → all students in the school', async () => {
    const db = fakeDb(STUDENTS);
    expect((await listStudentsSchoolWide(db, SCHOOL, { q: 'zzz' })).total).toBe(0);
    expect((await listStudentsSchoolWide(db, SCHOOL, { q: '' })).total).toBe(3);
  });
});
