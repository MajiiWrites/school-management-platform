/**
 * Round 5 (F4) — restoreDeletedRecord for message templates.
 * Templates have no deleted_at column: delete is a hard delete + a
 * deleted_records snapshot, so restore re-creates the template from its
 * snapshot. No DB, no network: a minimal fake Db.
 */
import { describe, it, expect } from 'vitest';
import { restoreDeletedRecord } from '../recycleBin';

const SCHOOL = 'school-1';

function fakeDb(opts: { createThrows?: { code: string } | null } = {}) {
  const created: any[] = [];
  const deleted: string[] = [];
  const changeLogs: any[] = [];
  const audits: any[] = [];
  const record = {
    id: 'bin-1',
    schoolId: SCHOOL,
    entity: 'message_template',
    entityId: 'tpl-1',
    snapshot: {
      name: 'Welcome',
      type: 'custom',
      language: 'en',
      body: 'Hello {student_name}',
      isCustom: true,
      isActive: true,
    },
    deletedAt: new Date('2026-11-06T00:00:00Z'),
    restoreBy: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    permanentlyDeletedAt: null,
  };
  const db: any = {
    deletedRecord: {
      findFirst: async () => record,
      delete: async ({ where }: any) => {
        deleted.push(where.id);
        return record;
      },
    },
    messageTemplate: {
      create: async ({ data }: any) => {
        if (opts.createThrows) throw opts.createThrows;
        created.push(data);
        return data;
      },
    },
    changeLog: { create: async ({ data }: any) => { changeLogs.push(data); return data; } },
    auditLog: { create: async ({ data }: any) => { audits.push(data); return data; } },
  };
  return { db, created, deleted, changeLogs, audits, record };
}

describe('restoreDeletedRecord — message_template', () => {
  it('re-creates the template from its snapshot and clears the bin row', async () => {
    const { db, created, deleted, audits } = fakeDb();
    const out = await restoreDeletedRecord(db, SCHOOL, 'bin-1', 'admin-1');
    expect(out).toEqual({ entity: 'message_template', entity_id: 'tpl-1', restored: true });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      id: 'tpl-1',
      schoolId: SCHOOL,
      name: 'Welcome',
      type: 'custom',
      language: 'en',
      body: 'Hello {student_name}',
      isCustom: true,
      isActive: true,
    });
    expect(deleted).toEqual(['bin-1']);
    expect(audits.some((a: any) => a.action === 'recycle_bin.restore')).toBe(true);
  });

  it('says plainly when the (type, language, name) slot is taken now', async () => {
    const { db } = fakeDb({ createThrows: { code: 'P2002' } });
    await expect(restoreDeletedRecord(db, SCHOOL, 'bin-1', 'admin-1')).rejects.toThrow(
      /same name already exists for this message type and language/,
    );
  });
});
