import jwt from 'jsonwebtoken';
import { config } from '../config';
import { randomToken, hashToken } from './crypto';

export interface AccessPayload {
  sub: string; // user id
  school_id: string;
  role: 'admin' | 'clerk' | 'principal' | 'platform_admin';
  email: string;
  type: 'access';
}

export interface RefreshPayload {
  sub: string;
  school_id: string;
  role: 'admin' | 'clerk' | 'principal' | 'platform_admin';
  type: 'refresh';
  jti: string;
  /** Platform Admin Panel (2026-11-20): the user's token_version at issue
   * time. Missing on pre-change tokens = 0. refreshTokens() rejects when
   * it differs from the user's current token_version ("revoke all
   * sessions" = bump token_version). Access tokens live 15 min, so
   * revocation takes effect at the next refresh. There is NO server-side
   * session store — this version check is the whole mechanism. */
  token_version?: number;
  /** Issued-at (seconds since epoch) — set automatically by jsonwebtoken.
   * 6D: the session-timeout check measures idle time from this value. */
  iat?: number;
}

/** Short-lived token issued after the password step when 2FA is enabled (5 min). */
export interface Temp2faPayload {
  sub: string;
  school_id: string;
  role: 'admin' | 'clerk' | 'principal' | 'platform_admin';
  email: string;
  type: '2fa-temp';
}

export function signAccessToken(user: { id: string; schoolId: string; role: string; email: string }): string {
  return jwt.sign(
    { sub: user.id, school_id: user.schoolId, role: user.role, email: user.email, type: 'access' },
    config.jwtSecret,
    { expiresIn: config.accessTokenTtlSeconds },
  );
}

export function signRefreshToken(
  user: { id: string; schoolId: string; role: string; tokenVersion?: number },
): string {
  return jwt.sign(
    {
      sub: user.id,
      school_id: user.schoolId,
      role: user.role,
      type: 'refresh',
      jti: randomToken(16),
      token_version: user.tokenVersion ?? 0,
    },
    config.jwtRefreshSecret,
    { expiresIn: config.refreshTokenTtlSeconds },
  );
}

export function verifyAccessToken(token: string): AccessPayload {
  const payload = jwt.verify(token, config.jwtSecret) as AccessPayload;
  if (payload.type !== 'access') throw new Error('Not an access token');
  return payload;
}

export function verifyRefreshToken(token: string): RefreshPayload {
  const payload = jwt.verify(token, config.jwtRefreshSecret) as RefreshPayload;
  if (payload.type !== 'refresh') throw new Error('Not a refresh token');
  return payload;
}

/** Issue a 5-minute 2FA temp token (password step passed, TOTP still pending). */
export function signTemp2faToken(user: { id: string; schoolId: string; role: string; email: string }): string {
  return jwt.sign(
    { sub: user.id, school_id: user.schoolId, role: user.role, email: user.email, type: '2fa-temp' },
    config.jwtSecret,
    { expiresIn: 5 * 60 },
  );
}

export function verifyTemp2faToken(token: string): Temp2faPayload {
  const payload = jwt.verify(token, config.jwtSecret) as Temp2faPayload;
  if (payload.type !== '2fa-temp') throw new Error('Not a 2FA temp token');
  return payload;
}

/** Email verification / password-reset token: random value + SHA-256 hash for storage. */
export function makeEmailToken(): { token: string; hash: string } {
  const token = randomToken(32);
  return { token, hash: hashToken(token) };
}
