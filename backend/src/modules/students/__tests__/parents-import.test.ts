/**
 * Parents bulk import (Phase 9 fix) — preview validation + import.
 * No DB, no network: a minimal fake Db (student.findMany/update +
 * auditLog.create) driving the real service functions.
 */
import { describe, it, expect } from 'vitest';
import {
  parentRowsFromGrid,
  previewParentsImport,
  importParents,
} from '../service';
import { sha256Hex } from '../../../lib/crypto';

const SCHOOL = 'school-1';

function fakeDb(students: any[]) {
  const updated: Array<{ id: string; data: any }> = [];
  const audits: any[] = [];
  const db: any = {
    student: {
      findMany: async () => students,
      update: async ({ where, data }: any) => {
        updated.push({ id: where.id, data });
        const s = students.find((x) => x.id === where.id);
        if (s) Object.assign(s, {
          parentName: data.parentName ?? s.parentName,
          parentPhoneEnc: data.parentPhoneEnc ?? s.parentPhoneEnc,
          parentPhoneHash: data.parentPhoneHash ?? s.parentPhoneHash,
        });
        return s;
      },
    },
    auditLog: { create: async ({ data }: any) => { audits.push(data); } },
  };
  return { db, updated, audits };
}

const AHMED = {
  id: 'stu-ahmed', schoolId: SCHOOL, name: 'Ahmed Raza', admissionNo: 'ADM-001',
  parentName: null, parentPhoneEnc: null, parentPhoneHash: null, deletedAt: null,
};
const BILAL = {
  id: 'stu-bilal', schoolId: SCHOOL, name: 'Bilal Khan', admissionNo: 'ADM-002',
  parentName: 'Khan Sr', parentPhoneEnc: 'enc', parentPhoneHash: sha256Hex('+923001234567'), deletedAt: null,
};

describe('parentRowsFromGrid', () => {
  it('maps admission_no / student / parent columns', () => {
    const rows = parentRowsFromGrid([
      ['admission_no', 'student', 'parent_name', 'parent_phone'],
      ['ADM-001', 'Ahmed Raza', 'Raza Sr', '03001234567'],
      ['', 'Bilal Khan', '', '+923001234567'],
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ admission_no: 'ADM-001', student_name: 'Ahmed Raza', parent_name: 'Raza Sr', parent_phone: '03001234567' });
    expect(rows[1].student_name).toBe('Bilal Khan');
  });
});

describe('previewParentsImport', () => {
  it('oks a valid row, flags invalid phone, unknown student and duplicates', async () => {
    const { db } = fakeDb([{ ...AHMED }, { ...BILAL }]);
    const preview = await previewParentsImport(db, SCHOOL, [
      { admission_no: 'ADM-001', student_name: '', parent_name: 'Raza Sr', parent_phone: '03007654321' },
      { admission_no: null, student_name: 'Bilal Khan', parent_name: null, parent_phone: 'not-a-number' },
      { admission_no: 'ADM-999', student_name: '', parent_name: null, parent_phone: '03001111111' },
      { admission_no: null, student_name: 'Bilal Khan', parent_name: null, parent_phone: '03001234567' },
    ]);
    expect(preview.total).toBe(4);
    expect(preview.valid).toBe(1);
    expect(preview.preview[0].status).toBe('ok');
    expect(preview.preview[0].student_id).toBe('stu-ahmed');
    expect(preview.preview[1].status).toBe('invalid');
    expect(preview.preview[2].status).toBe('invalid');
    // Bilal already has +923001234567 on file.
    expect(preview.preview[3].status).toBe('duplicate');
    expect(preview.duplicates_flagged).toBe(1);
    expect(preview.invalid_rows).toHaveLength(2);
  });

  it('rejects an ambiguous name and accepts the same name via admission_no', async () => {
    const twins = [
      { ...AHMED, id: 'stu-a1', admissionNo: 'ADM-001' },
      { ...AHMED, id: 'stu-a2', name: 'Ahmed Raza', admissionNo: 'ADM-003' },
    ];
    const { db } = fakeDb(twins);
    const preview = await previewParentsImport(db, SCHOOL, [
      { admission_no: null, student_name: 'Ahmed Raza', parent_name: null, parent_phone: '03007654321' },
      { admission_no: 'ADM-003', student_name: '', parent_name: null, parent_phone: '03007654321' },
    ]);
    expect(preview.preview[0].status).toBe('invalid');
    expect(preview.preview[0].reason).toMatch(/admission number/);
    expect(preview.preview[1].status).toBe('ok');
    expect(preview.preview[1].student_id).toBe('stu-a2');
  });
});

describe('importParents', () => {
  it('updates only ok rows and encrypts the number', async () => {
    const { db, updated } = fakeDb([{ ...AHMED }, { ...BILAL }]);
    const result = await importParents(db, SCHOOL, [
      { admission_no: 'ADM-001', student_name: '', parent_name: 'Raza Sr', parent_phone: '03007654321' },
      { admission_no: null, student_name: 'Nobody Here', parent_name: null, parent_phone: '03001111111' },
    ], 'admin-1');
    expect(result.imported).toBe(1);
    expect(result.saved_ids).toEqual(['stu-ahmed']);
    expect(updated).toHaveLength(1);
    expect(updated[0].data.parentPhoneHash).toBe(sha256Hex('+923007654321'));
    expect(updated[0].data.parentName).toBe('Raza Sr');
  });
});
