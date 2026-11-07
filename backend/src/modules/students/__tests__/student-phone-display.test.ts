/**
 * D2 — Students list PHONE column showed "—" for every student.
 *
 * Investigation verdict: STORED, not lost — a DISPLAY bug.
 * - Manual add (createStudent), CSV import (importStudents) and OCR
 *   (ocr/service encrypts, prisma-adapter passes enc/hash through) all
 *   store parentPhoneEnc (AES-256-GCM) + parentPhoneHash.
 * - The list serializer (toPublicStudent) returned only
 *   `parent_phone_masked` / `parent_has_phone` — never the `parent_phone`
 *   or `phone_flag` the Students table and badge read — so the column
 *   was always "—" and the badge always fell through to green "OK".
 *
 * No DB, no network: mocked DB rows + a real encrypt/decrypt round-trip
 * through lib/crypto (dev key fallback in config.ts).
 */
import { describe, it, expect } from 'vitest';
import { toPublicStudent, createStudent, listStudents } from '../service';
import { encryptPhone, decryptPhone, normalizePhone, sha256Hex } from '../../../lib/crypto';

const SCHOOL = 'school-1';
const CLASS = 'class-5a';
// The re-test manual-add number: 03242699437 -> +923242699437 -> masked +92 3XX XXXX437
const MANUAL_PHONE = '03242699437';
const MANUAL_E164 = '+923242699437';

function row(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'stu-1',
    schoolId: SCHOOL,
    classId: CLASS,
    rollNo: 1,
    name: 'Ahmed Raza',
    nameUr: null,
    parentName: 'Muhammad Raza',
    parentPhoneEnc: null,
    parentPhoneHash: null,
    parentOptOut: false,
    status: 'active',
    fatherName: null,
    admissionNo: null,
    dateOfBirth: null,
    gender: null,
    address: null,
    admissionDate: null,
    parent2Name: null,
    parent2PhoneEnc: null,
    parent2PhoneHash: null,
    parent2OptOut: false,
    idCardIssuedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('D2: toPublicStudent — the phone the list actually displays', () => {
  it('round-trips the re-test number through real AES-256-GCM and returns it MASKED', () => {
    const enc = encryptPhone(normalizePhone(MANUAL_PHONE)!);
    expect(enc).not.toContain(MANUAL_E164); // ciphertext never leaks the number
    expect(decryptPhone(enc)).toBe(MANUAL_E164);
    const pub = toPublicStudent(row({ parentPhoneEnc: enc, parentPhoneHash: sha256Hex(MANUAL_E164) }));
    expect(pub.parent_phone_masked).toBe('+92 3XX XXXX437');
    expect(pub.parent_phone).toBe('+92 3XX XXXX437'); // masked alias the table reads
    expect(pub.parent_phone).not.toContain('2426994');
    expect(pub.parent_has_phone).toBe(true);
    expect(pub.phone_flag).toBeNull();
  });

  it('reports missing when no phone is stored', () => {
    const pub = toPublicStudent(row());
    expect(pub.parent_phone).toBeNull();
    expect(pub.parent_phone_masked).toBeNull();
    expect(pub.parent_has_phone).toBe(false);
    expect(pub.phone_flag).toBe('missing');
  });

  it('reports invalid when a ciphertext is stored without its hash', () => {
    const enc = encryptPhone(MANUAL_E164);
    const pub = toPublicStudent(row({ parentPhoneEnc: enc, parentPhoneHash: null }));
    expect(pub.phone_flag).toBe('invalid');
  });

  it('reports invalid (never throws / 500s the list) when decryption fails', () => {
    const pub = toPublicStudent(row({ parentPhoneEnc: 'not-valid-base64!!!', parentPhoneHash: sha256Hex(MANUAL_E164) }));
    expect(pub.parent_phone).toBeNull();
    expect(pub.phone_flag).toBe('invalid');
  });
});

describe('D2: phones are STORED by the write paths', () => {
  it('createStudent (manual add) stores an encrypted phone that decrypts back', async () => {
    const created: any[] = [];
    const db: any = {
      class: { findFirst: async () => ({ id: CLASS }) },
      student: {
        findMany: async () => [],
        findFirst: async () => null,
        create: async ({ data }: any) => {
          const rec = { id: 'stu-new', ...data, createdAt: new Date(), updatedAt: new Date() };
          created.push(rec);
          return rec;
        },
      },
      changeLog: { create: async () => ({}) },
      auditLog: { create: async () => ({}) },
    };
    const saved = await createStudent(db, SCHOOL, CLASS, { name: 'Test Kid', roll_no: 1, parent_phone: MANUAL_PHONE });
    expect(saved.parentPhoneEnc).toBeTruthy();
    expect(decryptPhone(saved.parentPhoneEnc)).toBe(MANUAL_E164);
    expect(saved.parentPhoneHash).toBe(sha256Hex(MANUAL_E164));
    // ...and the same row now displays masked in the list serializer.
    expect(toPublicStudent({ ...row(), parentPhoneEnc: saved.parentPhoneEnc, parentPhoneHash: saved.parentPhoneHash }).parent_phone).toBe('+92 3XX XXXX437');
    expect(created).toHaveLength(1);
  });
});

describe('D2: listStudents — duplicate flag from the returned set', () => {
  it('flags same phone + same name as duplicate, but not a sibling sharing the number', async () => {
    const hash = sha256Hex(MANUAL_E164);
    const enc = encryptPhone(MANUAL_E164);
    const students = [
      row({ id: 's1', name: 'Ahmed Raza', parentPhoneEnc: enc, parentPhoneHash: hash }),
      row({ id: 's2', name: 'Ahmed Raza', rollNo: 2, parentPhoneEnc: encryptPhone(MANUAL_E164), parentPhoneHash: hash }),
      row({ id: 's3', name: 'Sara Raza', rollNo: 3, parentPhoneEnc: encryptPhone(MANUAL_E164), parentPhoneHash: hash }),
      row({ id: 's4', name: 'No Phone', rollNo: 4 }),
    ];
    const db: any = {
      class: { findFirst: async () => ({ id: CLASS }) },
      student: {
        findMany: async () => students,
        count: async () => students.length,
      },
    };
    const res = await listStudents(db, SCHOOL, CLASS, {});
    expect(res.items).toHaveLength(4);
    const byId = new Map(res.items.map((s: any) => [s.id, s]));
    expect(byId.get('s1').phone_flag).toBe('duplicate');
    expect(byId.get('s2').phone_flag).toBe('duplicate');
    expect(byId.get('s3').phone_flag).toBeNull(); // sibling, same number, different name
    expect(byId.get('s3').parent_phone).toBe('+92 3XX XXXX437');
    expect(byId.get('s4').phone_flag).toBe('missing');
    expect(byId.get('s4').parent_phone).toBeNull();
  });
});
