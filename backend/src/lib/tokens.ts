import jwt from 'jsonwebtoken';
import { config } from '../config';
import { randomToken, hashToken } from './crypto';

export interface AccessPayload {
  sub: string; // user id
  school_id: string;
  role: 'admin' | 'clerk';
  email: string;
  type: 'access';
}

export interface RefreshPayload {
  sub: string;
  school_id: string;
  role: 'admin' | 'clerk';
  type: 'refresh';
  jti: string;
}

export function signAccessToken(user: { id: string; schoolId: string; role: string; email: string }): string {
  return jwt.sign(
    { sub: user.id, school_id: user.schoolId, role: user.role, email: user.email, type: 'access' },
    config.jwtSecret,
    { expiresIn: config.accessTokenTtlSeconds },
  );
}

export function signRefreshToken(user: { id: string; schoolId: string; role: string }): string {
  return jwt.sign(
    { sub: user.id, school_id: user.schoolId, role: user.role, type: 'refresh', jti: randomToken(16) },
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

/** Email verification / password-reset token: random value + SHA-256 hash for storage. */
export function makeEmailToken(): { token: string; hash: string } {
  const token = randomToken(32);
  return { token, hash: hashToken(token) };
}
