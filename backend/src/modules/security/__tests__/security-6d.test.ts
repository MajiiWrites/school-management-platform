/**
 * Phase 6D tests — backup job, session timeout, 2FA over HTTP, manual
 * backup endpoint, backups log scoping.
 *
 * Backup + session-timeout tests run the real service/job functions against
 * the in-memory fake DB (./fake-db-6d.ts); the 2FA and POST /backups/run
 * tests go over real HTTP (real routers) with lib/db mocked to the fake.
 * No live DB is touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import express from 'express';
import type { Server } from 'node:http';
import { FakeDb6D, seedTwoSchools, schoolRowOf } from './fake-db-6d';
import { runSchoolBackup, runNightlyBackups } from '../../../jobs/backup';
import { runJobForSchool } from '../../../jobs/registry';
import { refreshTokens, resolveSessionTimeoutMinutes } from '../../auth/service';
import { signAccessToken } from '../../../lib/tokens';
import { config } from '../../../config';
import { errorHandler } from '../../../middleware/errors';
import { generateTotpCodeForTest } from '../../hardening/twofa';
import * as hardeningSvc from '../../hardening/service';

const holder = vi.hoisted(() => ({ db: null as any }));
vi.mock('../../../lib/db', () => ({ getDb: () => holder.db }));

const PASSWORD = 'correct-password';

async function seed(): Promise<{ db: FakeDb6D; seed: Awaited<ReturnType<typeof seedTwoSchools>> }> {
  const db = new FakeDb6D();
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const s = await seedTwoSchools(db, passwordHash);
  holder.db = db as any;
  return { db, seed: s };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'smp-backup-6d-'));
}

async function startApp(mount: (app: express.Express) => void): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  mount(app);
  app.use(errorHandler);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as any).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

/** Mint a refresh token whose iat is `ageSeconds` in the past (jsonwebtoken
 * preserves a payload-supplied iat). */
function refreshTokenWithAge(userId: string, schoolId: string, ageSeconds: number): string {
  return jwt.sign(
    { sub: userId, school_id: schoolId, role: 'admin', type: 'refresh', jti: 'test-jti', iat: Math.floor(Date.now() / 1000) - ageSeconds },
    config.jwtRefreshSecret,
    { expiresIn: '7d' },
  );
}

describe('backup job (6D)', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('backs up one school to backend/backups/<slug>/<date>.json with decrypted phones and no other-school data', async () => {
    const { db, seed: s } = await seed();
    const now = new Date('2026-11-06T03:00:00Z'); // 08:00 PKT, 6 Nov
    const result = await runSchoolBackup(db as any, schoolRowOf(s.schoolA), { baseDir: dir, now });
    expect(result.ran).toBe(true);
    expect(result.file).toBe('backups/alpha-school/2026-11-06.json');
    expect(result.sizeBytes).toBeGreaterThan(0);

    const filePath = path.join(dir, 'alpha-school', '2026-11-06.json');
    expect(fs.existsSync(filePath)).toBe(true);
    const backup = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    expect(backup.school_id).toBe('school-a');
    const names = (backup.tables.students as any[]).map((st) => st.name);
    expect(names).toEqual(expect.arrayContaining(['Ahmed Raza Alpha', 'Sara Khan Alpha']));
    expect(names.join(' ')).not.toContain('Beta');
    expect(JSON.stringify(backup)).not.toContain('stu-b1');
    expect(JSON.stringify(backup)).not.toContain('Zainab Noor Beta');
    // Phones are decrypted in the school's own backup (same shape as /export/all).
    const a1 = (backup.tables.students as any[]).find((st) => st.id === 'stu-a1');
    expect(a1.parent_phone).toBe('+923001234567');
    const classA = (backup.tables.classes as any[]).find((c: any) => c.id === 'class-a1');
    expect(classA.teacher_phone).toBe('+923001111111');
    // Users are scrubbed of credential material.
    const userA = (backup.tables.users as any[]).find((u: any) => u.id === 'admin-a');
    expect(userA.passwordHash).toBeUndefined();
    expect(userA.totpSecretEnc).toBeUndefined();

    // school_backups row written for A only.
    const rows = db.schoolBackup.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0].schoolId).toBe('school-a');
    expect(rows[0].fileRef).toBe('backups/alpha-school/2026-11-06.json');
    expect(rows[0].sizeBytes).toBe(result.sizeBytes);
    expect(fs.existsSync(path.join(dir, 'beta-school', '2026-11-06.json'))).toBe(false);
  });

  it('runNightlyBackups backs up every school, one file + one row each', async () => {
    const { db, seed: s } = await seed();
    const out = await runNightlyBackups(db as any, { baseDir: dir, now: new Date('2026-11-06T03:00:00Z') });
    expect(out.ran).toBe(true);
    expect(out.results).toHaveLength(2);
    expect(fs.existsSync(path.join(dir, 'alpha-school', '2026-11-06.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'beta-school', '2026-11-06.json'))).toBe(true);
    const rows = db.schoolBackup.findMany({});
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.schoolId).sort()).toEqual(['school-a', 'school-b']);
    const beta = JSON.parse(fs.readFileSync(path.join(dir, 'beta-school', '2026-11-06.json'), 'utf8'));
    expect(JSON.stringify(beta)).not.toContain('Ahmed Raza Alpha');
    expect((beta.tables.students as any[]).map((st: any) => st.name)).toEqual(['Zainab Noor Beta']);
  });

  it('runs through the jobs registry as school_backup (the nightly cron wiring)', async () => {
    const { db, seed: s } = await seed();
    // runJobForSchool has no baseDir option — point the job at the tmp dir via BACKUP_DIR.
    const prev = process.env.BACKUP_DIR;
    process.env.BACKUP_DIR = dir;
    try {
      const result: any = await runJobForSchool(db as any, 'school_backup', schoolRowOf(s.schoolB), new Date('2026-11-06T03:00:00Z'));
      expect(result.ran).toBe(true);
      expect(result.school).toBe('beta-school');
      expect(fs.existsSync(path.join(dir, 'beta-school', '2026-11-06.json'))).toBe(true);
      expect(db.schoolBackup.findMany({})).toHaveLength(1);
    } finally {
      if (prev === undefined) delete process.env.BACKUP_DIR;
      else process.env.BACKUP_DIR = prev;
    }
  });
});

describe('session timeout (6D)', () => {
  it('resolveSessionTimeoutMinutes defaults to 120 and clamps to 15–1440', () => {
    expect(resolveSessionTimeoutMinutes(undefined)).toBe(120);
    expect(resolveSessionTimeoutMinutes(null)).toBe(120);
    expect(resolveSessionTimeoutMinutes({})).toBe(120);
    expect(resolveSessionTimeoutMinutes({ session_timeout_minutes: 30 })).toBe(30);
    expect(resolveSessionTimeoutMinutes({ session_timeout_minutes: 5 })).toBe(15);
    expect(resolveSessionTimeoutMinutes({ session_timeout_minutes: 2000 })).toBe(1440);
    expect(resolveSessionTimeoutMinutes({ session_timeout_minutes: 'x' })).toBe(120);
  });

  it('refresh succeeds while the token is fresh', async () => {
    const { db, seed: s } = await seed();
    const { signRefreshToken } = await import('../../../lib/tokens');
    const token = signRefreshToken({ id: s.adminA.id, schoolId: s.schoolA.id, role: 'admin' });
    const out = await refreshTokens(db as any, token);
    expect(out.access).toBeTruthy();
    expect(out.refresh).toBeTruthy();
    expect(out.user.id).toBe('admin-a');
  });

  it('refresh is rejected with SESSION_EXPIRED when idle past the default 120 min', async () => {
    const { db, seed: s } = await seed();
    const old = refreshTokenWithAge(s.adminA.id, s.schoolA.id, 3 * 60 * 60); // 3 h idle
    let caught: any = null;
    try {
      await refreshTokens(db as any, old);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe('SESSION_EXPIRED');
    expect(caught.status).toBe(401);
  });

  it('refresh is rejected when idle past the school setting (15 min), but ok inside it', async () => {
    const { db, seed: s } = await seed();
    await db.school.update({ where: { id: s.schoolA.id }, data: { settings: { session_timeout_minutes: 15 } } });
    const tooOld = refreshTokenWithAge(s.adminA.id, s.schoolA.id, 30 * 60);
    await expect(refreshTokens(db as any, tooOld)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    const freshEnough = refreshTokenWithAge(s.adminA.id, s.schoolA.id, 10 * 60);
    const out = await refreshTokens(db as any, freshEnough);
    expect(out.access).toBeTruthy();
  });
});

describe('2FA endpoints over HTTP (the calls the Security page makes)', () => {
  it('setup -> verify -> disable round-trips', async () => {
    const { seed: s } = await seed();
    const { authRouter } = await import('../../auth/routes');
    const { base, close } = await startApp((app) => app.use('/api/v1/auth', authRouter));
    try {
      const access = signAccessToken({ id: s.adminA.id, schoolId: s.schoolA.id, role: 'admin', email: s.adminA.email });
      const headers = { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' };

      const setupRes = await fetch(`${base}/api/v1/auth/2fa/setup`, { method: 'POST', headers });
      expect(setupRes.status).toBe(200);
      const setup = (await setupRes.json()) as any;
      expect(setup.data.otpauth_url).toContain('otpauth://totp/');
      expect(typeof setup.data.secret).toBe('string');

      const code = generateTotpCodeForTest(setup.data.secret);
      const verifyRes = await fetch(`${base}/api/v1/auth/2fa/verify`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ code, secret: setup.data.secret }),
      });
      expect(verifyRes.status).toBe(200);
      expect(((await verifyRes.json()) as any).data.enabled).toBe(true);

      const disableRes = await fetch(`${base}/api/v1/auth/2fa/disable`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ password: PASSWORD }),
      });
      expect(disableRes.status).toBe(200);
      expect(((await disableRes.json()) as any).data.enabled).toBe(false);
    } finally {
      await close();
    }
  }, 60_000);
});

describe('POST /backups/run + GET /backups log (6D)', () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
    process.env.BACKUP_DIR = dir;
  });
  afterEach(() => {
    delete process.env.BACKUP_DIR;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('admin triggers a backup now; the log lists only their own school', async () => {
    const { db, seed: s } = await seed();
    const { securityRouter } = await import('../routes');
    const { base, close } = await startApp((app) => app.use('/api/v1', securityRouter));
    try {
      const access = signAccessToken({ id: s.adminA.id, schoolId: s.schoolA.id, role: 'admin', email: s.adminA.email });
      const res = await fetch(`${base}/api/v1/backups/run`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.data.ran).toBe(true);
      expect(body.data.school).toBe('alpha-school');
      // File is named by the SCHOOL-local date (Asia/Karachi) — list the dir instead of assuming UTC.
      const files = fs.readdirSync(path.join(dir, 'alpha-school'));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}\.json$/);

      // The existing GET /backups log (hardening) lists this row, scoped to A.
      db.schoolBackup.create({ data: { schoolId: 'school-b', fileRef: 'backups/beta-school/2026-11-06.json', sizeBytes: 123 } });
      const items = await hardeningSvc.listBackups(db as any, 'school-a');
      expect(items).toHaveLength(1);
      expect(items[0].schoolId).toBe('school-a');
      const itemsB = await hardeningSvc.listBackups(db as any, 'school-b');
      expect(itemsB).toHaveLength(1);
      expect(itemsB[0].schoolId).toBe('school-b');
    } finally {
      await close();
    }
  }, 60_000);
});
