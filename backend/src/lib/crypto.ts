import crypto from 'crypto';
import { config } from '../config';

/**
 * Phone + crypto helpers (contracts/SCHEMA.md).
 * - PK numbers normalize to E.164: +92 + 10 digits (mobile, starts with 3).
 * - *_phone_enc is AES-256-GCM, key from PHONE_ENC_KEY (32 bytes base64).
 * - parent_phone_hash = SHA-256 of the normalized number (duplicate detection only).
 * - Full numbers are NEVER logged or returned; use maskPhone().
 */

const E164_PK = /^\+92(3\d{9})$/;

/** Normalize a Pakistani mobile number to E.164, or null if it is not a valid PK mobile. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.trim().replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) {
    if (!digits.startsWith('+92')) return null;
    digits = digits.slice(3);
  } else if (digits.startsWith('0092')) {
    digits = digits.slice(4);
  } else if (digits.startsWith('92') && digits.length === 12) {
    digits = digits.slice(2);
  } else if (digits.startsWith('0') && digits.length === 11) {
    digits = digits.slice(1);
  }
  // digits is now the 10-digit national number (3XXXXXXXXX)
  if (!/^3\d{9}$/.test(digits)) return null;
  return `+92${digits}`;
}

export function isValidPhone(raw: string | null | undefined): boolean {
  return normalizePhone(raw) !== null;
}

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/** AES-256-GCM encrypt. Stored format: base64(iv[12] || authTag[16] || ciphertext). */
export function encryptPhone(e164: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.phoneEncKey, iv);
  const ciphertext = Buffer.concat([cipher.update(e164, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

export function decryptPhone(enc: string): string {
  const buf = Buffer.from(enc, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.phoneEncKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Mask for display/logs: +92 3XX XXXX123 (keeps country + last 3 digits only). */
export function maskPhone(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const m = E164_PK.exec(e164);
  if (!m) return '+92 *** *******';
  return `+92 3XX XXXX${e164.slice(-3)}`;
}

/** Normalize a student name for duplicate detection: lowercase, trim, collapse spaces, strip diacritics. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Crypto-random token (hex) for attendance links / email tokens. */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

export function hashToken(token: string): string {
  return sha256Hex(token);
}
