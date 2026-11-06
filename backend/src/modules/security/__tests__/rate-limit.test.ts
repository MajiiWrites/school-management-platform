/**
 * Rate-limit verification tests (6D).
 *
 * The limiters live in src/middleware/rateLimit.ts and are wired in
 * app.ts + auth/routes.ts + attendance/routes.ts. These tests hammer the
 * REAL routes (real authRouter, real limiters) over HTTP with a fake DB, so
 * they prove the limits as wired — not just the middleware in isolation.
 *
 * Each test re-imports the router after vi.resetModules() so it gets a
 * FRESH limiter instance (the in-memory store is per-middleware-instance;
 * without this, one test's 20 requests would exhaust the next test's quota
 * — the same instance is shared across all auth routes in production, by
 * design: 20 attempts / 15 min / IP across signup+login+refresh+reset).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import bcrypt from 'bcrypt';
import express from 'express';
import type { Server } from 'node:http';
import { FakeDb6D } from './fake-db-6d';
import { signRefreshToken } from '../../../lib/tokens';
import { errorHandler } from '../../../middleware/errors';

const holder = vi.hoisted(() => ({ db: null as any }));
vi.mock('../../../lib/db', () => ({ getDb: () => holder.db }));

async function startApp(router: any): Promise<{ base: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', router);
  app.use(errorHandler);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as any).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function freshAuthRouter(): Promise<any> {
  vi.resetModules();
  const mod = await import('../../auth/routes');
  return mod.authRouter;
}

async function seedUser(): Promise<{ db: FakeDb6D; email: string }> {
  const db = new FakeDb6D();
  const passwordHash = await bcrypt.hash('correct-password', 4);
  db.school.create({ data: { id: 'school-a', name: 'Alpha School', slug: 'alpha-school', timezone: 'Asia/Karachi', country: 'PK', settings: {} } });
  db.user.create({
    data: { id: 'admin-a', schoolId: 'school-a', email: 'admin@alpha.test', passwordHash, role: 'admin', emailVerified: true, totpEnabled: false, loginAlerts: true, lastLoginIp: null },
  });
  holder.db = db as any;
  return { db, email: 'admin@alpha.test' };
}

describe('rate limiting (6D verification)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('POST /auth/login with wrong passwords returns 429 after 20 attempts', async () => {
    const { email } = await seedUser();
    const router = await freshAuthRouter();
    const { base, close } = await startApp(router);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 25; i++) {
        const res = await fetch(`${base}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: 'wrong-password' }),
        });
        statuses.push(res.status);
        await res.text(); // drain body
      }
      expect(statuses.slice(0, 20)).toEqual(Array(20).fill(401));
      expect(statuses.slice(20)).toEqual(Array(5).fill(429));
      // The 429 carries the envelope error code the frontend recognises.
      const res = await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'wrong-password' }),
      });
      const body = (await res.json()) as any;
      expect(res.status).toBe(429);
      expect(body.error.code).toBe('RATE_LIMITED');
    } finally {
      await close();
    }
  }, 60_000);

  it('POST /auth/refresh is rate-limited too (the one auth route that had no authLimiter)', async () => {
    await seedUser();
    const router = await freshAuthRouter();
    const { base, close } = await startApp(router);
    try {
      const refresh = signRefreshToken({ id: 'admin-a', schoolId: 'school-a', role: 'admin' });
      const statuses: number[] = [];
      for (let i = 0; i < 25; i++) {
        const res = await fetch(`${base}/api/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh }),
        });
        statuses.push(res.status);
        await res.text();
      }
      // Same 20/15min/IP auth limiter: first 20 refreshes succeed, then 429.
      expect(statuses.slice(0, 20)).toEqual(Array(20).fill(200));
      expect(statuses.slice(20)).toEqual(Array(5).fill(429));
    } finally {
      await close();
    }
  }, 60_000);

  it('apiLimiter allows 300 requests / 15 min per IP, then 429', async () => {
    vi.resetModules();
    const { apiLimiter } = await import('../../../middleware/rateLimit');
    const app = express();
    app.use('/api', apiLimiter);
    app.get('/api/ping', (_req, res) => res.json({ ok: true }));
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    const port = (server.address() as any).port;
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 302; i++) {
        const res = await fetch(`http://127.0.0.1:${port}/api/ping`);
        statuses.push(res.status);
        await res.text();
      }
      expect(statuses.slice(0, 300).every((s) => s === 200)).toBe(true);
      expect(statuses[300]).toBe(429);
      expect(statuses[301]).toBe(429);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 120_000);
});
