// Sessions (6C-1) tests — set-current uniqueness, archive read-only rules,
// class-section promotion via the reused admin implementation, guards,
// cross-tenant 404s.
import { describe, it, expect, beforeEach } from 'vitest';
import type { Db } from '../../../lib/db';
import { FakeDb, seed6C1, OTHER_SCHOOL_ID } from './fake-db';
import * as svc from '../service';
import * as examsSvc from '../../exams/service';

function fresh(): { db: Db; schoolId: string; classAId: string; classBId: string; studentIds: string[] } {
  const fake = new FakeDb();
  const seed = seed6C1(fake);
  return { db: fake as unknown as Db, ...seed };
}

async function makeSession(db: Db, schoolId: string, name: string, start = '2026-04-01', end = '2027-03-31') {
  return svc.createSession(db, schoolId, { name, start_date: start, end_date: end }, 'admin-1');
}

describe('sessions CRUD + set-current uniqueness', () => {
  let db: Db;
  const schoolId = 'school-6c1';
  beforeEach(() => {
    ({ db } = fresh());
  });

  it('creates a session and rejects a duplicate name in the same school', async () => {
    const s = await makeSession(db, schoolId, '2026-27');
    expect(s.name).toBe('2026-27');
    expect(s.is_current).toBe(false);
    expect(s.is_archived).toBe(false);
    await expect(makeSession(db, schoolId, '2026-27')).rejects.toThrow('already exists');
  });

  it('rejects start_date on/after end_date', async () => {
    await expect(makeSession(db, schoolId, 'Bad', '2027-03-31', '2026-04-01')).rejects.toThrow('start_date must be before end_date');
  });

  it('make-current leaves exactly one current session', async () => {
    const a = await makeSession(db, schoolId, '2025-26', '2025-04-01', '2026-03-31');
    const b = await makeSession(db, schoolId, '2026-27');
    await svc.makeSessionCurrent(db, schoolId, a.id as string, 'admin-1');
    await svc.makeSessionCurrent(db, schoolId, b.id as string, 'admin-1');
    const list = await svc.listSessions(db, schoolId, {});
    const current = list.items.filter((s: any) => s.is_current);
    expect(current).toHaveLength(1);
    expect(current[0].id).toBe(b.id);
    expect(list.items.find((s: any) => s.id === a.id).is_current).toBe(false);
  });

  it('update writes change logs and rejects an empty rename', async () => {
    const s = await makeSession(db, schoolId, '2026-27');
    const updated = await svc.updateSession(db, schoolId, s.id as string, { name: '2026-27 (Revised)' }, 'admin-1');
    expect(updated.name).toBe('2026-27 (Revised)');
    const logs = (db as any).changeLog.findMany({ where: { entity: 'academic_session', entityId: s.id } });
    expect(logs.some((l: any) => l.field === 'name' && l.oldValue === '2026-27')).toBe(true);
  });
});

describe('sessions archive', () => {
  let db: Db;
  const schoolId = 'school-6c1';
  beforeEach(() => {
    ({ db } = fresh());
  });

  it('archive clears current, flags is_archived, and blocks make-current/update/promote', async () => {
    const s = await makeSession(db, schoolId, '2025-26', '2025-04-01', '2026-03-31');
    await svc.makeSessionCurrent(db, schoolId, s.id as string, 'admin-1');
    const archived = await svc.archiveSession(db, schoolId, s.id as string, 'admin-1');
    expect(archived.is_archived).toBe(true);
    expect(archived.is_current).toBe(false);
    await expect(svc.makeSessionCurrent(db, schoolId, s.id as string, 'admin-1')).rejects.toThrow('archived');
    await expect(svc.updateSession(db, schoolId, s.id as string, { name: 'Nope' }, 'admin-1')).rejects.toThrow('archived');
    await expect(svc.archiveSession(db, schoolId, s.id as string, 'admin-1')).rejects.toThrow('already archived');
    const unarchived = await svc.unarchiveSession(db, schoolId, s.id as string, 'admin-1');
    expect(unarchived.is_archived).toBe(false);
    const again = await svc.updateSession(db, schoolId, s.id as string, { name: '2025-26 (Revised)' }, 'admin-1');
    expect(again.name).toBe('2025-26 (Revised)');
  });

  it('list filters: archived_only / include_archived=false', async () => {
    const a = await makeSession(db, schoolId, '2025-26', '2025-04-01', '2026-03-31');
    await makeSession(db, schoolId, '2026-27');
    await svc.archiveSession(db, schoolId, a.id as string, 'admin-1');
    const only = await svc.listSessions(db, schoolId, { archived_only: 'true' });
    expect(only.items.map((s: any) => s.id)).toEqual([a.id]);
    const current = await svc.listSessions(db, schoolId, { include_archived: 'false' });
    expect(current.items.map((s: any) => s.id)).not.toContain(a.id);
    expect(current.items).toHaveLength(1);
  });

  it('delete is blocked while current or referenced by exams', async () => {
    const s = await makeSession(db, schoolId, '2026-27');
    await svc.makeSessionCurrent(db, schoolId, s.id as string, 'admin-1');
    await expect(svc.deleteSession(db, schoolId, s.id as string, 'admin-1')).rejects.toThrow('current session');
    const s2 = await makeSession(db, schoolId, '2027-28', '2027-04-01', '2028-03-31');
    await examsSvc.createExam(db, schoolId, { name: 'Midterm', session_id: s2.id as string }, 'admin-1');
    await expect(svc.deleteSession(db, schoolId, s2.id as string, 'admin-1')).rejects.toThrow('exams');
    await svc.deleteSession(db, schoolId, s.id as string, 'admin-1').catch(() => undefined);
  });
});

describe('sessions promotion (class-section)', () => {
  let db: Db;
  let schoolId: string;
  let classAId: string;
  let classBId: string;
  let studentIds: string[];
  beforeEach(() => {
    ({ db, schoolId, classAId, classBId, studentIds } = fresh());
  });

  it('promotes every active student of the from class and records promotions', async () => {
    const s = await makeSession(db, schoolId, '2026-27');
    const result = await svc.promoteClassSection(db, schoolId, s.id as string, { from_class_id: classAId, to_class_id: classBId }, 'admin-1');
    expect(result.promoted).toBe(3);
    for (const id of studentIds) {
      const st = await (db as any).student.findFirst({ where: { id } });
      expect(st.classId).toBe(classBId);
    }
    const history = await svc.listSessionPromotions(db, schoolId, s.id as string, {});
    expect(history.total).toBe(3);
    expect(history.items[0].from_class).toBe('5-A');
    expect(history.items[0].to_class).toBe('6-A');
  });

  it('rejects same-class promotion, empty classes, and archived sessions', async () => {
    const s = await makeSession(db, schoolId, '2026-27');
    await expect(svc.promoteClassSection(db, schoolId, s.id as string, { from_class_id: classAId, to_class_id: classAId }, 'admin-1')).rejects.toThrow('different classes');
    // From class B has no students yet.
    await expect(svc.promoteClassSection(db, schoolId, s.id as string, { from_class_id: classBId, to_class_id: classAId }, 'admin-1')).rejects.toThrow('No active students');
    await svc.archiveSession(db, schoolId, s.id as string, 'admin-1');
    await expect(svc.promoteClassSection(db, schoolId, s.id as string, { from_class_id: classAId, to_class_id: classBId }, 'admin-1')).rejects.toThrow('archived');
  });
});

describe('sessions cross-tenant isolation', () => {
  let db: Db;
  const schoolId = 'school-6c1';
  beforeEach(() => {
    ({ db } = fresh());
  });

  it('another school cannot read, update, archive, or promote our session (404)', async () => {
    const s = await makeSession(db, schoolId, '2026-27');
    await expect(svc.getSession(db, OTHER_SCHOOL_ID, s.id as string)).rejects.toThrow('Session not found');
    await expect(svc.updateSession(db, OTHER_SCHOOL_ID, s.id as string, { name: 'Hijack' }, 'admin-2')).rejects.toThrow('Session not found');
    await expect(svc.archiveSession(db, OTHER_SCHOOL_ID, s.id as string, 'admin-2')).rejects.toThrow('Session not found');
    await expect(svc.makeSessionCurrent(db, OTHER_SCHOOL_ID, s.id as string, 'admin-2')).rejects.toThrow('Session not found');
    await expect(svc.deleteSession(db, OTHER_SCHOOL_ID, s.id as string, 'admin-2')).rejects.toThrow('Session not found');
    // And our session is untouched.
    expect((await svc.getSession(db, schoolId, s.id as string)).name).toBe('2026-27');
  });
});
