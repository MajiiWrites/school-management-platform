import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signup, verifyEmail, login, forgotPassword, resetPassword } from './service';
import { ApiError } from '../../lib/errors';

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
    __users: users,
    __schools: schools,
    __audits: audits,
    __templates: templates,
  };
  return db;
}

describe('auth service', () => {
  it('signup creates a school + admin and returns a dev token', async () => {
    const db = fakeDb();
    const result = await signup(db as any, { school_name: 'Demo Public School', email: 'admin@school.pk', password: 'Secret123' });
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
    await signup(db as any, { school_name: 'School A', email: 'admin@school.pk', password: 'Secret123' });
    await expect(signup(db as any, { school_name: 'School B', email: 'ADMIN@school.pk', password: 'Secret123' })).rejects.toMatchObject({
      code: 'CONFLICT',
    } as any);
  });

  it('verify-email + login work end to end', async () => {
    const db = fakeDb();
    const signed = await signup(db as any, { school_name: 'School', email: 'a@b.pk', password: 'Secret123' });
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
    await signup(db as any, { school_name: 'School', email: 'a@b.pk', password: 'Secret123' });
    await expect(login(db as any, { email: 'a@b.pk', password: 'WrongPass1' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' } as any);
  });

  it('forgot + reset password flow works, and unknown emails do not leak', async () => {
    const db = fakeDb();
    await signup(db as any, { school_name: 'School', email: 'a@b.pk', password: 'Secret123' });
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
    await signup(db as any, { school_name: 'School', email: 'a@b.pk', password: 'Secret123' });
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
    const result = await signup(db as any, { school_name: 'School', email: 'a@b.pk', password: 'Secret123' });
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

  it('verify-email rejects a bad token', async () => {
    const db = fakeDb();
    await expect(verifyEmail(db as any, 'not-a-real-token')).rejects.toBeInstanceOf(ApiError);
  });
});
