// R2-D (b): the OCR adapter's listStudents must exclude soft-deleted
// students (deletedAt IS NULL) — otherwise a student in the Recycle Bin
// still flags re-uploaded rows as "Duplicate?". Run:
//   npx tsx --test tests/prisma-adapter.test.ts  (from the tests/ harness dir)
import test from 'node:test';
import assert from 'node:assert/strict';
import { prismaOcrDb, type PrismaLike } from '../prisma-adapter.js';

test('listStudents excludes soft-deleted students (deletedAt: null)', async () => {
  let capturedWhere: unknown = null;
  const fake = {
    class: { findFirst: async () => null },
    student: {
      findMany: async (args: { where: unknown }) => {
        capturedWhere = args.where;
        return [];
      },
      createMany: async () => ({ count: 0 }),
    },
    ocrUpload: {
      create: async () => ({ id: 'u1' }),
      findFirst: async () => null,
      update: async () => undefined,
    },
    auditLog: { create: async () => undefined },
  } as unknown as PrismaLike;

  const db = prismaOcrDb(fake);
  const rows = await db.listStudents('school-1', 'class-1');
  assert.deepEqual(capturedWhere, { schoolId: 'school-1', classId: 'class-1', deletedAt: null });
  assert.deepEqual(rows, []);
});
