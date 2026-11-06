/**
 * TOTP 2FA (6A, contracts/SCHEMA.md §9) — optional, admin only.
 *
 * - POST /auth/2fa/setup: generates a secret, returns the otpauth URL +
 *   secret ONCE. The secret is held in a process-local pending map (10 min)
 *   and is stored encrypted (AES-256-GCM, same pattern as phones via
 *   lib/crypto.ts) ONLY after a successful verify — never before.
 * - POST /auth/2fa/verify {code}: enables totp_enabled.
 * - POST /auth/2fa/disable {password}: clears secret + flag.
 * - Login: if totp_enabled and no valid totp_code was supplied, the password
 *   step returns {needs_2fa: true, temp_token} (5-min JWT); POST
 *   /auth/2fa/login {temp_token, code} issues the access/refresh JWTs.
 *
 * TOTP via otplib v13 (sync API, ±1 step tolerance = epochTolerance 30s).
 */
import bcrypt from 'bcrypt';
import { generateSecret, generateSync, generateURI, verifySync } from 'otplib';
import { ApiError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { encryptPhone, decryptPhone } from '../../lib/crypto';
import { signAccessToken, signRefreshToken, signTemp2faToken, verifyTemp2faToken } from '../../lib/tokens';
import type { Db } from '../../lib/db';

const ISSUER = 'School Management';
const PENDING_TTL_MS = 10 * 60 * 1000;

/** userId -> { secret, expiresAt }. Process-local; single-instance only. */
const pendingSecrets = new Map<string, { secret: string; expiresAt: number }>();

function prunePending(): void {
  const now = Date.now();
  for (const [userId, entry] of pendingSecrets) {
    if (entry.expiresAt < now) pendingSecrets.delete(userId);
  }
}

export function generateTotpCodeForTest(secret: string): string {
  return generateSync({ secret });
}

export function verifyTotpCode(secret: string, code: string): boolean {
  if (!/^\d{6}$/.test(code.trim())) return false;
  try {
    const result = verifySync({ secret, token: code.trim(), epochTolerance: 30 });
    return result.valid === true;
  } catch {
    return false;
  }
}

export function decryptTotpSecret(enc: string): string {
  return decryptPhone(enc);
}

/** Setup step: generate + hold the secret (NOT stored yet), return otpauth URL + secret once. */
export async function setupTwofa(
  db: Db,
  user: any,
): Promise<{ otpauth_url: string; secret: string }> {
  const secret = generateSecret();
  prunePending();
  pendingSecrets.set(user.id, { secret, expiresAt: Date.now() + PENDING_TTL_MS });
  const otpauthUrl = generateURI({ issuer: ISSUER, label: user.email, secret });
  await writeAudit(db, {
    schoolId: user.schoolId,
    actorId: user.id,
    actorType: 'user',
    action: 'auth.2fa_setup_started',
    entity: 'user',
    entityId: user.id,
  });
  return { otpauth_url: otpauthUrl, secret };
}

/** Verify step: checks the code against the pending (or re-supplied) secret, then stores it encrypted. */
export async function verifyTwofaSetup(
  db: Db,
  user: any,
  code: string,
  secretOverride?: string,
): Promise<{ enabled: boolean }> {
  prunePending();
  const secret = secretOverride?.trim() || pendingSecrets.get(user.id)?.secret;
  if (!secret) {
    throw ApiError.validation('No 2FA setup in progress — call POST /auth/2fa/setup first');
  }
  if (!verifyTotpCode(secret, code)) {
    throw ApiError.validation('Invalid verification code');
  }
  await db.user.update({
    where: { id: user.id },
    data: { totpSecretEnc: encryptPhone(secret), totpEnabled: true },
  });
  pendingSecrets.delete(user.id);
  await writeAudit(db, {
    schoolId: user.schoolId,
    actorId: user.id,
    actorType: 'user',
    action: 'auth.2fa_enabled',
    entity: 'user',
    entityId: user.id,
  });
  return { enabled: true };
}

/** Disable step: requires the account password; clears secret + flag. */
export async function disableTwofa(db: Db, user: any, password: string): Promise<{ enabled: boolean }> {
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) throw ApiError.unauthorized('Invalid password');
  await db.user.update({ where: { id: user.id }, data: { totpSecretEnc: null, totpEnabled: false } });
  pendingSecrets.delete(user.id);
  await writeAudit(db, {
    schoolId: user.schoolId,
    actorId: user.id,
    actorType: 'user',
    action: 'auth.2fa_disabled',
    entity: 'user',
    entityId: user.id,
  });
  return { enabled: false };
}

/** Check a TOTP code against the user's stored (encrypted) secret. */
export function userTotpValid(user: any, code: string): boolean {
  if (!user.totpSecretEnc) return false;
  try {
    return verifyTotpCode(decryptTotpSecret(user.totpSecretEnc), code);
  } catch {
    return false;
  }
}

/**
 * Second login step: exchange a 5-min temp token + TOTP code for full JWTs.
 * Also performs the login-alert + last_login_ip update (same as login()).
 */
export async function completeTwofaLogin(
  db: Db,
  tempToken: string,
  code: string,
  ip?: string,
): Promise<{ access: string; refresh: string; user: any }> {
  let payload;
  try {
    payload = verifyTemp2faToken(tempToken);
  } catch {
    throw ApiError.unauthorized('Invalid or expired 2FA session — log in again');
  }
  const user = await db.user.findUnique({ where: { id: payload.sub } });
  if (!user || user.schoolId !== payload.school_id) {
    throw ApiError.unauthorized('Invalid or expired 2FA session — log in again');
  }
  if (!user.totpEnabled || !userTotpValid(user, code)) {
    throw ApiError.unauthorized('Invalid verification code');
  }
  await finishLoginBookkeeping(db, user, ip);
  return { access: signAccessToken(user), refresh: signRefreshToken(user), user };
}

/**
 * Shared post-login bookkeeping: login alert when the IP changed + update
 * last_login_ip / last_login_at. Alert failures never break the login.
 */
export async function finishLoginBookkeeping(db: Db, user: any, ip?: string): Promise<void> {
  const now = new Date();
  const data: Record<string, unknown> = { lastLoginAt: now };
  if (ip) data.lastLoginIp = ip;
  try {
    if (ip && user.loginAlerts !== false && user.lastLoginIp && user.lastLoginIp !== ip) {
      await db.notification.create({
        data: {
          schoolId: user.schoolId,
          type: 'login_alert',
          title: `New login from ${ip}`,
          body: `Your account (${user.email}) was used to log in from ${ip}. If this was not you, change your password.`,
          relatedType: 'user',
          relatedId: user.id,
          isRead: false,
        },
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[login-alert] failed to write login alert:', (err as Error).message);
  }
  await db.user.update({ where: { id: user.id }, data });
}
