// Unit tests for phone crypto (crypto.ts): AES-256-GCM round-trip + format.
//
// INTEGRATION (Phase 3): ../crypto.ts now re-exports the canonical
// src/lib/crypto.ts. The wire format is base64(iv[12] || authTag[16] ||
// ciphertext) — a single base64 blob, NOT the old OCR-module colon format
// (base64(iv):base64(ct):base64(tag)). The key is loaded once at startup by
// src/config.ts (PHONE_ENC_KEY; ephemeral dev fallback outside production),
// so there is no call-time "key not set" error to test here anymore.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encryptPhone, decryptPhone } from '../crypto.js';

test('encrypt/decrypt round-trips a phone number', () => {
  const enc = encryptPhone('+923012345678');
  assert.notEqual(enc, '+923012345678');
  assert.equal(decryptPhone(enc), '+923012345678');
});

test('format is the canonical single base64 blob: base64(iv||tag||ciphertext)', () => {
  const enc = encryptPhone('+923012345678');
  assert.equal(enc.includes(':'), false, 'must not be the old iv:ct:tag format');
  const buf = Buffer.from(enc, 'base64');
  // 12-byte IV + 16-byte GCM tag + >= 1 byte of ciphertext
  assert.ok(buf.length >= 29, `decoded length ${buf.length} is too short for iv||tag||ct`);
  assert.equal(decryptPhone(enc), '+923012345678');
});

test('encryption is non-deterministic (fresh IV per call)', () => {
  assert.notEqual(encryptPhone('+923012345678'), encryptPhone('+923012345678'));
});

test('tampered ciphertext fails authentication', () => {
  const enc = encryptPhone('+923012345678');
  const buf = Buffer.from(enc, 'base64');
  buf[buf.length - 1] ^= 0xff; // flip a ciphertext byte
  const tampered = buf.toString('base64');
  assert.throws(() => decryptPhone(tampered));
});
