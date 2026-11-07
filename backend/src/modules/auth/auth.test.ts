import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signup, verifyEmail, login, forgotPassword, resetPassword } from './service';
import { ApiError } from '../../lib/errors';
import { decryptPhone, sha256Hex } from '../../lib/crypto';

/** Round-3: the auth tests control mail delivery instead of hitting the
 * dev-mode console logger — a failing send must not fail forgot-password. */
const mockedSendMail = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../lib/mail', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/mail')>();
  return { ...orig, sendMail: mockedSendMail };
});

beforeEach(() => {
  mockedSendMail.mockClear();
});

/** Minimal in-memory fake of the Db surface the auth service uses. */
function fakeDb() {
  const users: any[] = [];
  const schools: any[] = [];
  const audits: any[] = [];
  const templates: any[] = [];
  let seq = 1;
  const id = () => `id-${seq++}`;
  const matches = (row: any, where: any): boolean => {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => {
      if (v && typeof v === 'object' && 'gt' in (v as any)) return row[k] > (v as any).gt;
      return row[k] === v;
    });
  };
  const db: any = {
    user: {
      findFirst: async ({ where }: any) => users.find((u) => matches(u, where)) ?? null,
      findUnique: async ({ where }: any) => users.find((u) => matches(u, where)) ?? null,
      create: async ({ data }: any) => {
        const u = { id: id(), created_at: new Date(), updated_at: new Date(), last_login_at: null, ...data };
        users.push(u);
        return u;
      },
      update: async ({ where, data }: any) => {
        const u = users.find((x) => matches(x, where));
        Object.assign(u, data);
        return u;
      },
    },
    school: {
      findUnique: async ({ where }: any) => schools.find((s) => matches(s, where)) ?? null,
      create: async ({ data }: any) => {
        const s = { id: id(), created_at: new Date(), updated_at: new Date(), ...data };
        schools.push(s);
        return s;
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        audits.push(data);
        return data;
      },
    },
    messageTemplate: {
      createMany: async ({ data }: any) => {
        for (const row of data) templates.push({ id: id(), created_at: new Date(), ...row });
        return { count: data.length };
      },
    },
    // Registration round: the service wraps school+user creation in a
    // transaction — the fake runs the callback against itself.
    $transaction: async (fn: (tx: any) => Promise<any>) => fn(db),
    __users: users,
    __schools: schools,
    __audits: audits,
    __templates: templates,
  };
  return db;
}

describe('auth service', () => {
  /** Full registration-profile signup input; overrides replace fields. */
  const PROFILE = {
    admin_name: 'Majid Ali',
    admin_phone: '03001234567',
    address: '12 Main Bazaar Road, Bahawalpur',
    tehsil: 'Bahawalpur City',
    district: 'Bahawalpur',
    province: 'Punjab' as const,
    category: 'Private' as const,
    org_type: 'School' as const,
  };
  const sign = (db: any, overrides: Record<string, unknown> = {}) =>
    signup(db as any, { school_name: 'Demo Public School', email: 'admin@school.pk', password: 'Secret123', ...PROFILE, ...overrides });

  it('signup creates a school + admin and returns a dev token', async () => {
    const db = fakeDb();
    const result = await sign(db);
    expect(result.user.email).toBe('admin@school.pk');
    expect(result.user.role).toBe('admin');
    // Signup seeds the 6 default message templates (3 types x en + ur).
    expect(db.__templates).toHaveLength(6);
    expect(new Set(db.__templates.map((t: any) => t.type))).toEqual(new Set(['absent', 'fee_reminder', 'teacher_reminder']));
    expect(result.user.email_verified).toBe(false);
    expect(result.school.slug).toBe('demo-public-school');
    expect(result.dev_token).toBeTruthy();
    // Phase 9 fix: signup must issue a session like login does — the
    // frontend stores data.access/data.refresh; without them the new
    // admin's post-signup calls all 401 with a literal "undefined" token.
    expect(result.access).toBeTruthy();
    expect(result.refresh).toBeTruthy();
    expect(db.__users).toHaveLength(1);
    expect(db.__schools).toHaveLength(1);
  });

  it('signup rejects a duplicate email', async () => {
    const db = fakeDb();
    await sign(db, { school_name: 'School A' });
    await expect(sign(db, { school_name: 'School B', email: 'ADMIN@school.pk' })).rejects.toMatchObject({
      code: 'CONFLICT',
    } as any);
  });

  it('verify-email + login work end to end', async () => {
    const db = fakeDb();
    const signed = await sign(db, { school_name: 'School', email: 'a@b.pk' });
    const verified = await verifyEmail(db as any, signed.dev_token!);
    expect(verified.user.email_verified).toBe(true);
    const logged = await login(db as any, { email: 'a@b.pk', password: 'Secret123' });
    // No 2FA on this account, so login completes with JWTs (union narrows here).
    expect('access' in logged && logged.access).toBeTruthy();
    expect('refresh' in logged && logged.refresh).toBeTruthy();
    expect('user' in logged && logged.user.email).toBe('a@b.pk');
  });

  it('login rejects a wrong password', async () => {
    const db = fakeDb();
    await sign(db, { school_name: 'School', email: 'a@b.pk' });
    await expect(login(db as any, { email: 'a@b.pk', password: 'WrongPass1' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' } as any);
  });

  it('forgot + reset password flow works, and unknown emails do not leak', async () => {
    const db = fakeDb();
    await sign(db, { school_name: 'School', email: 'a@b.pk' });
    const unknown = await forgotPassword(db as any, 'nobody@nowhere.pk');
    expect(unknown.dev_token).toBeUndefined();
    const known = await forgotPassword(db as any, 'a@b.pk');
    expect(known.dev_token).toBeTruthy();
    const reset = await resetPassword(db as any, known.dev_token!, 'NewSecret1');
    expect(reset.user.email).toBe('a@b.pk');
    const logged = await login(db as any, { email: 'a@b.pk', password: 'NewSecret1' });
    expect('access' in logged && logged.access).toBeTruthy();
  });

  it('forgot-password still succeeds when the mail send fails (round 3)', async () => {
    // Live re-test: a stalled SMTP send 500'd the request after ~2 min.
    // The endpoint must never reveal account existence OR mail state — the
    // failure is logged server-side and the caller gets success; the token
    // was already stored, so the reset still works once mail is back.
    const db = fakeDb();
    await sign(db, { school_name: 'School', email: 'a@b.pk' });
    mockedSendMail.mockRejectedValueOnce(new Error('SMTP connection timed out'));
    const result = await forgotPassword(db as any, 'a@b.pk');
    expect(result.dev_token).toBeTruthy();
    const reset = await resetPassword(db as any, result.dev_token!, 'NewSecret1');
    expect(reset.user.email).toBe('a@b.pk');
  });

  it('signup still succeeds when the verification mail send fails (round 4, D1)', async () => {
    // Live re-test: signup showed "Internal server error" after ~40 s on
    // "Creating…" yet the account had been created and login worked right
    // after. A stalled/failed SMTP send must never 500 a committed signup
    // — the mail is best-effort, the failure is logged server-side, and
    // the stored verification token stays valid so resend still works.
    const db = fakeDb();
    mockedSendMail.mockRejectedValueOnce(new Error('SMTP connection timed out'));
    const result = await sign(db, { school_name: 'School', email: 'a@b.pk' });
    expect(result.user.email).toBe('a@b.pk');
    expect(result.access).toBeTruthy();
    expect(result.refresh).toBeTruthy();
    expect(result.dev_token).toBeTruthy();
    expect(db.__users).toHaveLength(1);
    expect(db.__schools).toHaveLength(1);
    // The stored verification token still works (resend path), and login
    // works immediately — exactly what the live re-test observed post-500.
    const verified = await verifyEmail(db as any, result.dev_token!);
    expect(verified.user.email_verified).toBe(true);
    const logged = await login(db as any, { email: 'a@b.pk', password: 'Secret123' });
    expect('access' in logged && logged.access).toBeTruthy();
  });

  it('signup stores the full registration profile (school + admin phone)', async () => {
    const db = fakeDb();
    const result = await sign(db);
    // Response carries the profile (additive — existing keys unchanged).
    expect(result.school.address).toBe('12 Main Bazaar Road, Bahawalpur');
    expect(result.school.tehsil).toBe('Bahawalpur City');
    expect(result.school.district).toBe('Bahawalpur');
    expect(result.school.province).toBe('Punjab');
    expect(result.school.category).toBe('Private');
    expect(result.school.org_type).toBe('School');
    // Stored school row carries every profile column.
    const school = db.__schools[0];
    expect(school.address).toBe('12 Main Bazaar Road, Bahawalpur');
    expect(school.tehsil).toBe('Bahawalpur City');
    expect(school.district).toBe('Bahawalpur');
    expect(school.province).toBe('Punjab');
    expect(school.category).toBe('Private');
    expect(school.orgType).toBe('School');
    // Stored admin row: name in clear, phone encrypted + hashed.
    const user = db.__users[0];
    expect(user.name).toBe('Majid Ali');
    expect(user.phoneEnc).toBeTruthy();
    expect(decryptPhone(user.phoneEnc)).toBe('+923001234567');
    expect(user.phoneHash).toBe(sha256Hex('+923001234567'));
  });

  it('signup rejects a missing required profile field', async () => {
    const db = fakeDb();
    await expect(sign(db, { address: '' })).rejects.toMatchObject({ code: 'VALIDATION' } as any);
    await expect(sign(db, { admin_name: ' ' })).rejects.toMatchObject({ code: 'VALIDATION' } as any);
    await expect(sign(db, { tehsil: 'X' })).rejects.toMatchObject({ code: 'VALIDATION' } as any);
    expect(db.__schools).toHaveLength(0);
    expect(db.__users).toHaveLength(0);
  });

  it('signup rejects an invalid category / province / org_type', async () => {
    const db = fakeDb();
    await expect(sign(db, { category: 'Charter' as any })).rejects.toMatchObject({ code: 'VALIDATION' } as any);
    await expect(sign(db, { province: 'Atlantis' as any })).rejects.toMatchObject({ code: 'VALIDATION' } as any);
    await expect(sign(db, { org_type: 'University' as any })).rejects.toMatchObject({ code: 'VALIDATION' } as any);
    expect(db.__schools).toHaveLength(0);
  });

  it('signup rejects an invalid admin phone', async () => {
    const db = fakeDb();
    await expect(sign(db, { admin_phone: '12345' })).rejects.toMatchObject({ code: 'VALIDATION' } as any);
    await expect(sign(db, { admin_phone: '+442071234567' })).rejects.toMatchObject({ code: 'VALIDATION' } as any);
    expect(db.__schools).toHaveLength(0);
    // A +92-format number normalizes and succeeds.
    const ok = await sign(db, { admin_phone: '+92 300 1234567' });
    expect(decryptPhone(db.__users[0].phoneEnc)).toBe('+923001234567');
    expect(ok.user.email).toBe('admin@school.pk');
  });

  it('verify-email rejects a bad token', async () => {
    const db = fakeDb();
    await expect(verifyEmail(db as any, 'not-a-real-token')).rejects.toBeInstanceOf(ApiError);
  });
});
