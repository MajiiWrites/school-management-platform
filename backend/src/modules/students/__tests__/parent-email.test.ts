// Student.parentEmail (Messaging Center wiring, 2026-11-20): stored
// normalized + lowercased on create/update, shown by the serializer,
// rejected when malformed. No DB, no network: minimal fake Db.
import { describe, it, expect } from 'vitest';
import { toPublicStudent, createStudent, updateStudent, updateParent } from '../service';

const SCHOOL = 'school-1';
const CLASS = 'class-5a';

function row(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'stu-1',
    schoolId: SCHOOL,
    classId: CLASS,
    rollNo: 1,
    name: 'Ahmed Raza',
    parentName: 'Muhammad Raza',
    parentPhoneEnc: null,
    parentPhoneHash: null,
    parentOptOut: false,
    parentEmail: null,
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

describe('Student.parentEmail', () => {
  it('toPublicStudent surfaces the saved parent email', () => {
    expect(toPublicStudent(row({ parentEmail: 'father@example.com' })).parent_email).toBe('father@example.com');
    expect(toPublicStudent(row()).parent_email).toBeNull();
  });

  it('createStudent stores a normalized (trimmed, lowercased) email; blank stays null', async () => {
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
    const saved = await createStudent(db, SCHOOL, CLASS, {
      name: 'Test Kid',
      parent_email: '  Father@Example.COM ',
    });
    expect(saved.parentEmail).toBe('father@example.com');
    const blank = await createStudent(db, SCHOOL, CLASS, { name: 'Test Kid 2', parent_email: '   ' });
    expect(blank.parentEmail).toBeNull();
    expect(created).toHaveLength(2);
  });

  it('createStudent rejects a malformed parent email', async () => {
    const db: any = {
      class: { findFirst: async () => ({ id: CLASS }) },
      student: { findMany: async () => [], findFirst: async () => null },
      changeLog: { create: async () => ({}) },
      auditLog: { create: async () => ({}) },
    };
    await expect(
      createStudent(db, SCHOOL, CLASS, { name: 'Test Kid', parent_email: 'not-an-email' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('updateStudent + updateParent change the saved email; malformed is rejected', async () => {
    let current = row({ parentEmail: 'old@example.com' });
    const db: any = {
      class: { findFirst: async () => ({ id: CLASS }) },
      student: {
        findMany: async () => [],
        findFirst: async () => current,
        update: async ({ data }: any) => {
          current = { ...current, ...data };
          return current;
        },
      },
      changeLog: { create: async () => ({}) },
      auditLog: { create: async () => ({}) },
    };
    const updated = await updateStudent(db, SCHOOL, 'stu-1', { parent_email: 'New@Example.com' });
    expect(updated.parentEmail).toBe('new@example.com');
    await expect(updateStudent(db, SCHOOL, 'stu-1', { parent_email: 'bad' })).rejects.toMatchObject({
      status: 400,
    });
    const viaParent = await updateParent(db, SCHOOL, 'stu-1', { parent_email: 'parent@example.com' });
    expect(viaParent.parentEmail).toBe('parent@example.com');
  });
});
