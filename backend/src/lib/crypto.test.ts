import { describe, it, expect } from 'vitest';
import { normalizePhone, encryptPhone, decryptPhone, maskPhone, normalizeName, sha256Hex } from './crypto';

describe('normalizePhone (PK → E.164)', () => {
  it('accepts 03XX local format', () => {
    expect(normalizePhone('03001234567')).toBe('+923001234567');
  });
  it('accepts +92, 92 and 0092 prefixes', () => {
    expect(normalizePhone('+92 300 1234567')).toBe('+923001234567');
    expect(normalizePhone('923001234567')).toBe('+923001234567');
    expect(normalizePhone('00923001234567')).toBe('+923001234567');
  });
  it('strips dashes and spaces', () => {
    expect(normalizePhone('0300-123-4567')).toBe('+923001234567');
  });
  it('rejects non-PK and malformed numbers', () => {
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('+1 555 123 4567')).toBeNull();
    expect(normalizePhone('02001234567')).toBeNull(); // landline prefix
    expect(normalizePhone('0300123456')).toBeNull(); // too short
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe('phone encryption', () => {
  it('round-trips through AES-256-GCM', () => {
    const enc = encryptPhone('+923001234567');
    expect(enc).not.toContain('+923001234567');
    expect(decryptPhone(enc)).toBe('+923001234567');
  });
  it('encrypts the same number to different ciphertexts (random IV)', () => {
    expect(encryptPhone('+923001234567')).not.toBe(encryptPhone('+923001234567'));
  });
  it('hash is stable and hex', () => {
    expect(sha256Hex('+923001234567')).toBe(sha256Hex('+923001234567'));
    expect(sha256Hex('+923001234567')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('maskPhone', () => {
  it('masks the middle digits', () => {
    expect(maskPhone('+923001234567')).toBe('+92 3XX XXXX567');
    expect(maskPhone(null)).toBeNull();
  });
});

describe('normalizeName', () => {
  it('lowercases, trims and collapses spaces', () => {
    expect(normalizeName('  Ahmed   Ali ')).toBe('ahmed ali');
  });
});
