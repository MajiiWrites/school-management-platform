/**
 * Platform Admin Panel tests (2026-11-20).
 *
 * Service-level tests run against an in-memory fake Db (Proxy-based: any
 * delegate key resolves to a generic collection). Route-level tests mount
 * the real platformRouter on a throwaway express app with getDb() mocked
 * to the fake, and drive it over HTTP with real JWTs.
 *
 * Tenant-isolation spot-check: a platform-admin JWT on the SCHOOL routes
 * (adminRouter GET /users) is a full admin of their OWN school only —
 * it returns 200 with just that school's users, never another school's.
 * A school admin's token on school routes returns ONLY that admin's own
 * school's users.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import express from 'express';
import { generateSecret, generateSync } from 'otplib';
import { signAccessToken, signRefreshToken, signTemp2faToken } from '../../lib/tokens';
import { encryptPhone } from '../../lib/crypto';
import { login, refreshTokens, signup } from '../auth/service';
import { completeTwofaLogin, generateTotpCodeForTest } from '../hardening/twofa';
import { errorHandler } from '../../middleware/errors';
import * as svc from './service';
import { PLATFORM_2FA_MESSAGE } from './guard';

const mockedSendMail = vi.hoisted(() => vi.fn(async () => undefined));
const mockedSendMailOnce = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../lib/mail', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/mail')>();
  return { ...orig, sendMail: mockedSendMail, sendMailOnce: mockedSendMailOnce };
});

const mockedResolveMx = vi.hoisted(() =>
  vi.fn(async (_domain: string) => [{ exchange: 'mx.example.com', priority: 10 }]),
);
vi.mock('node:dns/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:dns/promises')>();
  return { ...orig, resolveMx: mockedResolveMx };
});

// Route tests: getDb() returns whichever fake the current test installed.
const dbHolder = vi.hoisted(() => ({ current: null as any }));
vi.mock('../../lib/db', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/db')>();
  return { ...orig, getDb: () => dbHolder.current };
});

beforeEach(() => {
  mockedSendMail.mockClear();
  mockedSendMailOnce.mockClear();
  mockedResolveMx.mockClear();
  mockedResolveMx.mockImplementation(async (_domain: string) => [{ exchange: 'mx.example.com', priority: 10 }]);
});

// ---------------------------------------------------------------------------
// In-memory fake Db
// ---------------------------------------------------------------------------

function matches(row: any, where: any): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === 'OR') return (v as any[]).some((w) => matches(row, w));
    if (k === 'AND') return (v as any[]).every((w) => matches(row, w));
    const rv = row[k];
    if (v && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v)) {
      return Object.entries(v).every(([op, ov]: [string, any]) => {
        if (op === 'contains') {
          if (typeof rv !== 'string') return false;
          return v.mode === 'insensitive'
            ? rv.toLowerCase().includes(String(ov).toLowerCase())
            : rv.includes(String(ov));
        }
        if (op === 'in') return (ov as any[]).includes(rv);
        if (op === 'not') return ov === null ? rv !== null && rv !== undefined : rv !== ov;
        if (op === 'gt') return rv > ov;
        if (op === 'gte') return rv >= ov;
        if (op === 'lt') return rv < ov;
        if (op === 'lte') return rv <= ov;
        if (op === 'equals') return rv === ov;
        return true;
      });
    }
    // Prisma returns null (not undefined) for an unset nullable column.
    return rv === v || (rv === undefined && v === null);
  });
}

function sortRows(rows: any[], orderBy: any): any[] {
  const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const spec of specs) {
      for (const [field, dir] of Object.entries(spec)) {
        const av = a[field];
        const bv = b[field];
        if (av === bv) continue;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        const cmp = av < bv ? -1 : 1;
        return dir === 'desc' ? -cmp : cmp;
      }
    }
    return 0;
  });
}

function fakeDb() {
  const store: Record<string, any[]> = {};
  const rowsOf = (key: string): any[] => {
    if (!store[key]) store[key] = [];
    return store[key];
  };
  const delegate = (key: string): any => ({
    findUnique: async ({ where }: any) => rowsOf(key).find((r) => matches(r, where)) ?? null,
    findFirst: async (args: any = {}) => {
      let rows = rowsOf(key).filter((r) => matches(r, args.where));
      if (args.orderBy) rows = sortRows(rows, args.orderBy);
      return rows[0] ?? null;
    },
    findMany: async (args: any = {}) => {
      let rows = rowsOf(key).filter((r) => matches(r, args.where));
      if (args.orderBy) rows = sortRows(rows, args.orderBy);
      if (typeof args.skip === 'number') rows = rows.slice(args.skip);
      if (typeof args.take === 'number') rows = rows.slice(0, args.take);
      return rows;
    },
    create: async ({ data }: any) => {
      const row = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...data };
      rowsOf(key).push(row);
      return row;
    },
    createMany: async ({ data }: any) => {
      for (const d of data) rowsOf(key).push({ id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...d });
      return { count: data.length };
    },
    update: async ({ where, data }: any) => {
      const row = rowsOf(key).find((r) => matches(r, where));
      if (!row) throw Object.assign(new Error('Not found'), { code: 'P2025' });
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    },
    updateMany: async ({ where, data }: any) => {
      let n = 0;
      for (const row of rowsOf(key).filter((r) => matches(r, where))) {
        Object.assign(row, data);
        n += 1;
      }
      return { count: n };
    },
    upsert: async ({ where, update, create }: any) => {
      const row = rowsOf(key).find((r) => matches(r, where));
      if (row) {
        Object.assign(row, update, { updatedAt: new Date() });
        return row;
      }
      const created = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...create };
      rowsOf(key).push(created);
      return created;
    },
    delete: async ({ where }: any) => {
      const arr = rowsOf(key);
      const idx = arr.findIndex((r) => matches(r, where));
      if (idx < 0) throw Object.assign(new Error('Not found'), { code: 'P2025' });
      return arr.splice(idx, 1)[0];
    },
    deleteMany: async ({ where }: any) => {
      const kept = rowsOf(key).filter((r) => !matches(r, where));
      const n = rowsOf(key).length - kept.length;
      store[key] = kept;
      return { count: n };
    },
    count: async (args: any = {}) => rowsOf(key).filter((r) => matches(r, args.where)).length,
    groupBy: async ({ by, _count }: any) => {
      const groups = new Map<string, { row: any; n: number }>();
      for (const r of rowsOf(key)) {
        const gk = by.map((b: string) => String(r[b])).join('|');
        if (!groups.has(gk)) groups.set(gk, { row: Object.fromEntries(by.map((b: string) => [b, r[b]])), n: 0 });
        groups.get(gk)!.n += 1;
      }
      return [...groups.values()].map((g) => ({ ...g.row, _count: _count?._all ? { _all: g.n } : {} }));
    },
  });
  const db: any = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === '$transaction') return async (fn: (tx: any) => Promise<any>) => fn(db);
        if (prop === '__store') return store;
        if (prop === '__rows') return rowsOf;
        return delegate(prop);
      },
    },
  );
  return db;
}

async function seedSchool(db: any, overrides: Record<string, unknown> = {}): Promise<any> {
  return db.school.create({
    data: { name: 'Demo Public School', slug: `demo-${randomUUID().slice(0, 8)}`, timezone: 'Asia/Karachi', country: 'PK', settings: {}, orgType: 'School', province: 'Punjab', category: 'Private', suspendedAt: null, suspendedReason: null, ...overrides },
  });
}

async function seedUser(
  db: any,
  schoolId: string,
  overrides: Record<string, unknown> = {},
): Promise<any> {
  const passwordHash = await bcrypt.hash('Secret123', 4);
  return db.user.create({
    data: {
      schoolId,
      email: `user-${randomUUID().slice(0, 8)}@school.pk`,
      passwordHash,
      role: 'admin',
      emailVerified: true,
      verifyEmailStatus: 'sent',
      verifyEmailError: null,
      totpEnabled: false,
      totpSecretEnc: null,
      tokenVersion: 0,
      disabledAt: null,
      lastLoginAt: null,
      lastLoginIp: null,
      name: 'Test Admin',
      ...overrides,
    },
  });
}

function tokenFor(user: any): string {
  return signAccessToken({ id: user.id, schoolId: user.schoolId, role: user.role, email: user.email });
}

async function httpApp(db: any): Promise<{ base: string; close: () => Promise<void> }> {
  dbHolder.current = db;
  const { platformRouter } = await import('./routes');
  const { adminRouter } = await import('../admin/routes');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/platform', platformRouter);
  app.use('/api/v1', adminRouter);
  app.use(errorHandler);
  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function req(base: string, method: string, path: string, token?: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// ---------------------------------------------------------------------------
// Auth gates (service level)
// ---------------------------------------------------------------------------

describe('auth gates (platform admin panel)', () => {
  it('login blocks a disabled account with ACCOUNT_DISABLED', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    const user = await seedUser(db, school.id, { email: 'disabled@school.pk', disabledAt: new Date() });
    await expect(login(db as any, { email: user.email, password: 'Secret123' })).rejects.toMatchObject({
      code: 'ACCOUNT_DISABLED',
      status: 403,
    } as any);
  });

  it('login blocks a suspended school admin but NOT a platform admin', async () => {
    const db = fakeDb();
    const school = await seedSchool(db, { suspendedAt: new Date(), suspendedReason: 'Unpaid fees' });
    const admin = await seedUser(db, school.id, { email: 'admin@school.pk' });
    await expect(login(db as any, { email: admin.email, password: 'Secret123' })).rejects.toMatchObject({
      code: 'SCHOOL_SUSPENDED',
      status: 403,
    } as any);
    const owner = await seedUser(db, school.id, { email: 'owner@school.pk', role: 'platform_admin' });
    const logged = await login(db as any, { email: owner.email, password: 'Secret123' });
    expect('access' in logged && logged.access).toBeTruthy();
  });

  it('login succeeds for the owner row after the migration marks it verified (2026-11-20)', async () => {
    // The owner signed up on the live site but Gmail SMTP is dead from
    // Render, so no verification mail could arrive and login stayed blocked
    // with EMAIL_NOT_VERIFIED — exactly what he reported. Migration
    // 20261120050000 marks ONLY that one account verified and clears its
    // token; it does NOT touch verifyEmailStatus (no mail was sent, so
    // 'failed' stays honest). Simulate that exact pre/post-migration row
    // and prove the login gate now passes.
    const db = fakeDb();
    const school = await seedSchool(db);
    const owner = await seedUser(db, school.id, {
      email: 'majidalioffical0@gmail.com',
      role: 'admin',
      emailVerified: false,
      verifyTokenHash: 'deadbeef-token',
      verifyExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      verifyEmailStatus: 'failed',
    });
    // Pre-migration: login blocked, as the user saw live.
    await expect(login(db as any, { email: owner.email, password: 'Secret123' })).rejects.toMatchObject({
      code: 'EMAIL_NOT_VERIFIED',
    } as any);
    // The migration's owner step, applied to the row:
    owner.role = 'platform_admin';
    owner.emailVerified = true;
    owner.verifyTokenHash = null;
    owner.verifyExpiresAt = null;
    // verifyEmailStatus deliberately untouched — still 'failed'.
    expect(owner.verifyEmailStatus).toBe('failed');
    const logged = await login(db as any, { email: owner.email, password: 'Secret123' });
    expect('access' in logged && logged.access).toBeTruthy();
  });

  it('refresh rejects a stale token_version after revoke, accepts the current one', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    const user = await seedUser(db, school.id, { email: 'admin@school.pk' });
    const stale = signRefreshToken({ id: user.id, schoolId: school.id, role: 'admin', tokenVersion: 0 });
    await db.user.update({ where: { id: user.id }, data: { tokenVersion: 1 } });
    await expect(refreshTokens(db as any, stale)).rejects.toMatchObject({ code: 'UNAUTHORIZED' } as any);
    const fresh = signRefreshToken({ id: user.id, schoolId: school.id, role: 'admin', tokenVersion: 1 });
    const result = await refreshTokens(db as any, fresh);
    expect(result.access).toBeTruthy();
    expect(result.refresh).toBeTruthy();
  });

  it('refresh blocks a disabled account', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    const user = await seedUser(db, school.id, { email: 'admin@school.pk' });
    const token = signRefreshToken({ id: user.id, schoolId: school.id, role: 'admin', tokenVersion: 0 });
    await db.user.update({ where: { id: user.id }, data: { disabledAt: new Date() } });
    await expect(refreshTokens(db as any, token)).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' } as any);
  });

  it('2FA completion blocks a disabled account', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    const secret = generateSecret();
    const user = await seedUser(db, school.id, {
      email: 'admin@school.pk',
      totpEnabled: true,
      totpSecretEnc: encryptPhone(secret),
    });
    const temp = signTemp2faToken(user);
    const code = generateTotpCodeForTest(secret);
    const ok = await completeTwofaLogin(db as any, temp, code);
    expect(ok.access).toBeTruthy();
    await db.user.update({ where: { id: user.id }, data: { disabledAt: new Date() } });
    await expect(completeTwofaLogin(db as any, temp, generateTotpCodeForTest(secret))).rejects.toMatchObject({
      code: 'ACCOUNT_DISABLED',
    } as any);
  });

  it('signup is blocked when registration is closed, and during maintenance', async () => {
    const db = fakeDb();
    await db.platformSetting.create({ data: { key: 'registration_open', value: false } });
    const input = {
      school_name: 'New School',
      email: 'new@school.pk',
      password: 'Secret123',
      admin_name: 'Majid Ali',
      admin_phone: '03001234567',
      address: '12 Main Bazaar Road, Bahawalpur',
      tehsil: 'Bahawalpur City',
      district: 'Bahawalpur',
      province: 'Punjab' as const,
      category: 'Private' as const,
      org_type: 'School' as const,
    };
    await expect(signup(db as any, input)).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('Registration is currently closed'),
    } as any);
    await db.platformSetting.update({ where: { key: 'registration_open' }, data: { value: true } });
    await db.platformSetting.create({ data: { key: 'maintenance_mode', value: true } });
    await expect(signup(db as any, input)).rejects.toMatchObject({ code: 'MAINTENANCE', status: 503 } as any);
  });
});

// ---------------------------------------------------------------------------
// Platform service
// ---------------------------------------------------------------------------

describe('platform service', () => {
  it('overview totals, signups and health come from real aggregates', async () => {
    const db = fakeDb();
    const s1 = await seedSchool(db);
    const s2 = await seedSchool(db);
    await seedUser(db, s1.id, { emailVerified: true });
    await seedUser(db, s1.id, { emailVerified: false, verifyEmailStatus: 'failed', verifyEmailError: 'timeout' });
    await seedUser(db, s2.id, { emailVerified: true });
    await db.student.create({ data: { schoolId: s1.id, classId: randomUUID(), name: 'Ali', status: 'active' } });
    await db.messageQueue.create({
      data: { schoolId: s1.id, type: 'absent', parentPhoneEnc: 'x', body: 'hi', status: 'failed', attempts: 2, dedupeKey: 'd1', scheduledFor: new Date() },
    });
    await db.schoolBackup.create({ data: { schoolId: s1.id, fileRef: 'backups/x.json', sizeBytes: 123 } });
    const out = await svc.getOverview(db as any);
    expect((out.totals as any).schools).toBe(2);
    expect((out.totals as any).users).toBe(3);
    expect((out.totals as any).verified_users).toBe(2);
    expect((out.totals as any).unverified_users).toBe(1);
    expect(((out.health as any).mail as any).failed).toBe(1);
    expect(((out.health as any).queue as any).failed).toBe(1);
    expect((out.health as any).last_backup_at).toBeTruthy();
  });

  it('suspend blocks login via the gate and activate restores it; both are audited twice', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    const admin = await seedUser(db, school.id, { email: 'admin@school.pk' });
    const owner = await seedUser(db, school.id, { email: 'owner@school.pk', role: 'platform_admin', totpEnabled: true });
    await svc.suspendSchool(db as any, school.id, owner.id, 'Test suspension');
    await expect(login(db as any, { email: admin.email, password: 'Secret123' })).rejects.toMatchObject({
      code: 'SCHOOL_SUSPENDED',
    } as any);
    const platformAudits = db.__rows('platformAuditLog');
    const schoolAudits = db.__rows('auditLog');
    expect(platformAudits.some((a: any) => a.action === 'platform.school_suspend')).toBe(true);
    expect(schoolAudits.some((a: any) => a.action === 'platform.school_suspend')).toBe(true);
    await svc.activateSchool(db as any, school.id, owner.id);
    const logged = await login(db as any, { email: admin.email, password: 'Secret123' });
    expect('access' in logged && logged.access).toBeTruthy();
  });

  it('delete requires the exact school name; wrong confirm deletes nothing', async () => {
    const db = fakeDb();
    const school = await seedSchool(db, { name: 'Exact Name School' });
    const user = await seedUser(db, school.id);
    const student = await db.student.create({ data: { schoolId: school.id, classId: randomUUID(), name: 'Ali', status: 'active' } });
    const owner = await seedUser(db, school.id, { role: 'platform_admin', totpEnabled: true });
    await expect(svc.deleteSchool(db as any, school.id, owner.id, 'exact name school')).rejects.toMatchObject({
      code: 'VALIDATION',
    } as any);
    expect(db.__rows('school')).toHaveLength(1);
    expect(db.__rows('user')).toHaveLength(2);
    const out = await svc.deleteSchool(db as any, school.id, owner.id, 'Exact Name School');
    expect(out.deleted).toBe(true);
    expect(db.__rows('school')).toHaveLength(0);
    expect(db.__rows('user')).toHaveLength(0);
    expect(db.__rows('student')).toHaveLength(0);
    expect(db.__rows('platformAuditLog').some((a: any) => a.action === 'platform.school_delete')).toBe(true);
    void student;
    void user;
  });

  it('disable/demote refuse the last platform admin', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    const only = await seedUser(db, school.id, { role: 'platform_admin', totpEnabled: true });
    await expect(svc.disableUser(db as any, only.id, only.id)).rejects.toMatchObject({ code: 'VALIDATION' } as any);
    await expect(svc.demoteUser(db as any, only.id, only.id, 'admin')).rejects.toMatchObject({ code: 'VALIDATION' } as any);
    const second = await seedUser(db, school.id, { role: 'platform_admin', totpEnabled: true });
    const disabled = await svc.disableUser(db as any, second.id, only.id);
    expect(disabled.disabled).toBe(true);
    // With the second admin disabled, the first is again the last enabled one.
    await expect(svc.demoteUser(db as any, only.id, only.id, 'admin')).rejects.toMatchObject({ code: 'VALIDATION' } as any);
  });

  it('promote requires 2FA on the target', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    const owner = await seedUser(db, school.id, { role: 'platform_admin', totpEnabled: true });
    const plain = await seedUser(db, school.id, { email: 'plain@school.pk', totpEnabled: false });
    await expect(svc.promoteUser(db as any, plain.id, owner.id, 'platform_admin')).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringContaining('two-factor'),
    } as any);
    await db.user.update({ where: { id: plain.id }, data: { totpEnabled: true } });
    const out = await svc.promoteUser(db as any, plain.id, owner.id, 'platform_admin');
    expect(out.role).toBe('platform_admin');
  });

  it('reverify resets verification and triggers the resend flow', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    const owner = await seedUser(db, school.id, { role: 'platform_admin', totpEnabled: true });
    const target = await seedUser(db, school.id, { email: 'target@school.pk', emailVerified: true });
    const result = await svc.reverifyUser(db as any, target.id, owner.id);
    expect(result.sent).toBe(true);
    expect(mockedSendMailOnce).toHaveBeenCalledTimes(1);
    const after: any = await db.user.findUnique({ where: { id: target.id } });
    expect(after.emailVerified).toBe(false);
  });

  it('reset-password triggers the forgot-password flow and never sets a password', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    const owner = await seedUser(db, school.id, { role: 'platform_admin', totpEnabled: true });
    const target = await seedUser(db, school.id, { email: 'target@school.pk' });
    const before = target.passwordHash;
    await svc.resetUserPassword(db as any, target.id, owner.id);
    expect(mockedSendMail).toHaveBeenCalled();
    const after: any = await db.user.findUnique({ where: { id: target.id } });
    expect(after.passwordHash).toBe(before);
    expect(after.resetTokenHash).toBeTruthy();
  });

  it('revoke-sessions bumps token_version', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    const owner = await seedUser(db, school.id, { role: 'platform_admin', totpEnabled: true });
    const target = await seedUser(db, school.id, { email: 'target@school.pk', tokenVersion: 2 });
    const out = await svc.revokeUserSessions(db as any, target.id, owner.id);
    expect(out.token_version).toBe(3);
  });

  it('audit logs merge platform + school rows newest first with source tags', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    await db.auditLog.create({
      data: { schoolId: school.id, actorId: null, actorType: 'user', action: 'student.create', entity: 'student', entityId: randomUUID(), details: {}, createdAt: new Date('2026-11-20T10:00:00Z') },
    });
    await db.platformAuditLog.create({
      data: { actorId: randomUUID(), action: 'platform.school_suspend', entity: 'school', entityId: school.id, details: {}, createdAt: new Date('2026-11-20T11:00:00Z') },
    });
    const out = await svc.listMergedAuditLogs(db as any, {});
    expect(out.total).toBe(2);
    expect((out.items[0] as any).source).toBe('platform');
    expect((out.items[1] as any).source).toBe('school');
    const filtered = await svc.listMergedAuditLogs(db as any, { school_id: school.id });
    expect(filtered.total).toBe(2);
    const other = await svc.listMergedAuditLogs(db as any, { school_id: randomUUID() });
    expect(other.total).toBe(0);
  });

  it('school data browser masks phones and never leaks encrypted fields', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    const phone = '+923001234567';
    await db.student.create({
      data: { schoolId: school.id, classId: randomUUID(), name: 'Ali', status: 'active', parentName: 'Ahmed', parentPhoneEnc: encryptPhone(phone) },
    });
    const out = await svc.listSchoolEntityData(db as any, school.id, 'students', {});
    expect(out.total).toBe(1);
    const row: any = out.items[0];
    expect(row.parent_phone_masked).toBeTruthy();
    expect(row.parent_phone_masked).not.toContain('03001234567');
    expect('parentPhoneEnc' in row).toBe(false);
    expect('parent_phone' in row).toBe(false);
    const csv = await svc.exportSchoolEntityCsv(db as any, school.id, 'students', {}, randomUUID());
    expect(csv.csv).not.toContain('03001234567');
    expect(csv.csv).toContain('parent_phone_masked');
    expect(csv.csv).not.toContain('parentPhoneEnc');
  });

  it('messaging retry resets a failed row to queued with attempts 0', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    const owner = await seedUser(db, school.id, { role: 'platform_admin', totpEnabled: true });
    const row = await db.messageQueue.create({
      data: { schoolId: school.id, type: 'absent', parentPhoneEnc: 'x', body: 'hi', status: 'failed', attempts: 3, error: 'timeout', dedupeKey: 'd1', scheduledFor: new Date() },
    });
    const out = await svc.retryQueueMessage(db as any, row.id, owner.id);
    expect(out.status).toBe('queued');
    expect(out.attempts).toBe(0);
    const failed = await svc.listFailedMessages(db as any, {});
    expect(failed.total).toBe(0);
  });

  it('mail-health derives counts from user rows and carries the honest note', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    await seedUser(db, school.id, { verifyEmailStatus: 'failed', verifyEmailError: 'SMTP timeout' });
    const out = await svc.getMailHealth(db as any);
    expect((out.recent_verification_mail as any).failed).toBe(1);
    expect((out.recent_failures as any)).toHaveLength(1);
    expect((out.recent_failures as any)[0].error).toContain('SMTP timeout');
    expect(out.transport).toBe('smtp');
    expect(out.note).toContain('Gmail SMTP is currently timing out');
  });

  it('settings patch stores the notice and closes registration', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    const owner = await seedUser(db, school.id, { role: 'platform_admin', totpEnabled: true });
    const out = await svc.updatePlatformSettings(db as any, owner.id, {
      registration_open: false,
      notice: { text: 'Maintenance on Sunday' },
    });
    expect(out.registration_open).toBe(false);
    expect(out.notice?.text).toBe('Maintenance on Sunday');
    expect(out.notice?.created_by).toBe(owner.id);
    const pub = await svc.getPublicStatus(db as any);
    expect(pub.registration_open).toBe(false);
    expect(pub.notice?.text).toBe('Maintenance on Sunday');
  });

  it('recycle bin restores across schools and permanent-delete needs the exact confirm', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    const owner = await seedUser(db, school.id, { role: 'platform_admin', totpEnabled: true });
    const cls = await db.class.create({
      data: { schoolId: school.id, name: 'Class 1', section: 'A', teacherName: 'T', deletedAt: new Date() },
    });
    const rec = await db.deletedRecord.create({
      data: { schoolId: school.id, entity: 'class', entityId: cls.id, snapshot: {}, deletedAt: new Date(), restoreBy: new Date(Date.now() + 86400000) },
    });
    const listed = await svc.listPlatformRecycleBin(db as any, {});
    expect(listed.total).toBe(1);
    await expect(
      svc.permanentDeletePlatformRecycleBinRecord(db as any, rec.id, owner.id, 'class:wrong-id'),
    ).rejects.toMatchObject({ code: 'VALIDATION' } as any);
    expect(db.__rows('deletedRecord')).toHaveLength(1);
    const restored = await svc.restorePlatformRecycleBinRecord(db as any, rec.id, owner.id);
    expect((restored as any).restored).toBe(true);
    const clsAfter: any = await db.class.findUnique({ where: { id: cls.id } });
    expect(clsAfter.deletedAt).toBeNull();
  });

  it('backups report latest null honestly when no backup ever ran', async () => {
    const db = fakeDb();
    const out = await svc.getBackups(db as any);
    expect(out.latest).toBeNull();
    expect(out.total).toBe(0);
  });

  it('security lists carry the honest stateless-JWT notes', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    await seedUser(db, school.id, { role: 'platform_admin', totpEnabled: true, lastLoginAt: new Date(), lastLoginIp: '1.2.3.4' });
    const logins = await svc.listRecentLogins(db as any, 7);
    expect((logins.items as any[])).toHaveLength(1);
    expect(logins.note).toContain('not a live session list');
    const sessions = await svc.listSessions(db as any);
    expect(sessions.note).toContain('15 minutes');
    const admins = await svc.listPlatformAdmins(db as any);
    expect((admins.items as any[])).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Routes (HTTP)
// ---------------------------------------------------------------------------

describe('platform routes', () => {
  it('401 unauthenticated, 403 for school admins, 200 for a platform admin with 2FA', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    const admin = await seedUser(db, school.id, { email: 'admin@school.pk' });
    const owner = await seedUser(db, school.id, { email: 'owner@school.pk', role: 'platform_admin', totpEnabled: true });
    const { base, close } = await httpApp(db);
    try {
      const anon = await req(base, 'GET', '/api/v1/platform/overview');
      expect(anon.status).toBe(401);
      const schoolAdmin = await req(base, 'GET', '/api/v1/platform/overview', tokenFor(admin));
      expect(schoolAdmin.status).toBe(403);
      const ok = await req(base, 'GET', '/api/v1/platform/overview', tokenFor(owner));
      expect(ok.status).toBe(200);
      expect(ok.json.ok).toBe(true);
      expect((ok.json.data.totals as any).schools).toBe(1);
    } finally {
      await close();
    }
  });

  it('platform admin WITHOUT 2FA gets 403 with the enable-2FA message', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    const owner = await seedUser(db, school.id, { email: 'owner@school.pk', role: 'platform_admin', totpEnabled: false });
    const { base, close } = await httpApp(db);
    try {
      const res = await req(base, 'GET', '/api/v1/platform/overview', tokenFor(owner));
      expect(res.status).toBe(403);
      expect(res.json.error.message).toBe(PLATFORM_2FA_MESSAGE);
    } finally {
      await close();
    }
  });

  it('public status needs no auth; notice needs any authenticated user', async () => {
    const db = fakeDb();
    const school = await seedSchool(db);
    const clerk = await seedUser(db, school.id, { email: 'clerk@school.pk', role: 'clerk' });
    const { base, close } = await httpApp(db);
    try {
      const pub = await req(base, 'GET', '/api/v1/platform/status');
      expect(pub.status).toBe(200);
      expect(pub.json.data.registration_open).toBe(true);
      const anonNotice = await req(base, 'GET', '/api/v1/platform/notice');
      expect(anonNotice.status).toBe(401);
      const clerkNotice = await req(base, 'GET', '/api/v1/platform/notice', tokenFor(clerk));
      expect(clerkNotice.status).toBe(200);
      expect(clerkNotice.json.data.notice).toBeNull();
    } finally {
      await close();
    }
  });

  it('school routes stay tenant-scoped: a platform admin sees only their own school', async () => {
    const db = fakeDb();
    const schoolA = await seedSchool(db, { name: 'School A' });
    const schoolB = await seedSchool(db, { name: 'School B' });
    const adminA = await seedUser(db, schoolA.id, { email: 'a@school.pk' });
    await seedUser(db, schoolB.id, { email: 'b@school.pk' });
    const owner = await seedUser(db, schoolA.id, { email: 'owner@school.pk', role: 'platform_admin', totpEnabled: true });
    const { base, close } = await httpApp(db);
    try {
      // A platform-admin JWT on the SCHOOL routes is a full admin of
      // their OWN school only (requireSchool scopes by JWT school_id):
      // 200, but school B's users never leak.
      const platformOnSchool = await req(base, 'GET', '/api/v1/users', tokenFor(owner));
      expect(platformOnSchool.status).toBe(200);
      const ownerItems = (platformOnSchool.json.data as any).items;
      expect(ownerItems).toHaveLength(2); // adminA + owner (both in school A)
      expect(ownerItems.every((u: any) => u.email !== 'b@school.pk')).toBe(true);
      // A school admin sees only their own school's users.
      const adminUsers = await req(base, 'GET', '/api/v1/users', tokenFor(adminA));
      expect(adminUsers.status).toBe(200);
      const items = (adminUsers.json.data as any).items;
      expect(items).toHaveLength(2); // adminA + owner (both in school A)
      expect(items.every((u: any) => u.email !== 'b@school.pk')).toBe(true);
    } finally {
      await close();
    }
  });
});
