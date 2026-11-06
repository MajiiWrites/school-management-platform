import crypto from 'node:crypto';

/**
 * Phone helpers for the Messaging module.
 *
 * Contract (SCHEMA.md): PK numbers are normalized to E.164 (`+92` + 10 digits),
 * stored encrypted with AES-256-GCM (key from PHONE_ENC_KEY, 32 bytes base64),
 * `parent_phone_hash` = SHA-256 of the E.164 number (duplicate detection only),
 * and full numbers are NEVER logged or returned to humans — use maskPhone().
 *
 * INTEGRATION (Phase 3): the normalize/encrypt/decrypt/mask/hash helpers are
 * re-exports of the canonical src/lib/crypto.ts — same behaviour, same wire
 * format (base64 of iv||tag||ciphertext). Only deriveDeviceKey stays local:
 * it is messaging-specific (HMAC over SMS_DEVICE_SECRET).
 */
export {
  normalizePhone as normalizePK,
  isValidPhone as isValidPK,
  maskPhone,
  sha256Hex as hashPhone,
  encryptPhone,
  decryptPhone,
} from '../../lib/crypto';

/** Device API key derivation (school-scoped). See routes.ts deviceAuth. */
export function deriveDeviceKey(schoolId: string): string {
  const secret = process.env.SMS_DEVICE_SECRET;
  if (!secret) throw new Error('SMS_DEVICE_SECRET is not set');
  return crypto.createHmac('sha256', secret).update(`device:${schoolId}`).digest('hex');
}
