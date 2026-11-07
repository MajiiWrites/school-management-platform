/**
 * FINAL REBUILD (Module C) — per-school SMS sender number.
 *
 * Run: cd backend && npx vitest run src/modules/messaging/__tests__/sender-number.test.ts
 * Uses the in-memory FakeStore from service.test.ts — no DB, no network.
 *
 * Covers:
 *  - save normalizes to E.164 (0300… -> +92…), rejects invalid numbers
 *    (including "—", which is NOT a phone), and clears on null/''.
 *  - getSenderSettings / getSmsStatus expose the number MASKED, plus the
 *    linked device (name + online) so the UI can tie the display to the
 *    connected SIM; with no device the saved number itself is the sender.
 *  - the save writes an audit log entry with the masked number only.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSenderSettings,
  getSmsStatus,
  normalizeSenderNumber,
  updateSenderNumber,
  type ServiceDeps,
} from '../service';
import { FakeStore, testCrypto } from './service.test';

const SCHOOL_ID = 'school-1';

function depsFor(store: FakeStore): ServiceDeps {
  return { store, crypto: testCrypto, now: () => new Date('2026-11-07T10:00:00Z') };
}

function validationError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as unknown as { code?: string }).code === 'VALIDATION'
  );
}

describe('normalizeSenderNumber', () => {
  it('normalizes local, +92 and 92 forms to E.164', () => {
    expect(normalizeSenderNumber('03001234567')).toBe('+923001234567');
    expect(normalizeSenderNumber('+92 300 1234567')).toBe('+923001234567');
    expect(normalizeSenderNumber('923001234567')).toBe('+923001234567');
  });

  it('clears on null / empty string', () => {
    expect(normalizeSenderNumber(null)).toBeNull();
    expect(normalizeSenderNumber('')).toBeNull();
    expect(normalizeSenderNumber('   ')).toBeNull();
  });

  it('rejects anything that is not a valid PK mobile — including "—"', () => {
    for (const bad of ['12345', '+1 555 1234567', '—', '0300123456', 'abc']) {
      expect(() => normalizeSenderNumber(bad)).toThrow();
      try {
        normalizeSenderNumber(bad);
        expect.unreachable();
      } catch (err) {
        expect(validationError(err)).toBe(true);
      }
    }
  });
});

describe('sender number save + display', () => {
  let store: FakeStore;
  let deps: ServiceDeps;
  beforeEach(() => {
    store = new FakeStore();
    deps = depsFor(store);
  });

  it('saves per school, normalized; settings return full + masked', async () => {
    const saved = await updateSenderNumber(deps, {
      schoolId: SCHOOL_ID,
      senderNumber: '03001234567',
      actorId: 'admin-1',
    });
    expect(saved.senderNumber).toBe('+923001234567');
    expect(saved.senderNumberMasked).toBe('+92 3XX XXXX567');
    expect(store.senderNumber).toBe('+923001234567');

    const again = await getSenderSettings(deps, { schoolId: SCHOOL_ID });
    expect(again.senderNumber).toBe('+923001234567');
    expect(again.senderNumberMasked).toBe('+92 3XX XXXX567');
    expect(again.deviceName).toBeNull();
  });

  it('rejects an invalid number and keeps the old one', async () => {
    await updateSenderNumber(deps, { schoolId: SCHOOL_ID, senderNumber: '03001234567', actorId: 'admin-1' });
    await expect(
      updateSenderNumber(deps, { schoolId: SCHOOL_ID, senderNumber: 'not-a-number', actorId: 'admin-1' }),
    ).rejects.toThrow(/valid Pakistani mobile/);
    expect(store.senderNumber).toBe('+923001234567');
  });

  it('clears the number on null', async () => {
    await updateSenderNumber(deps, { schoolId: SCHOOL_ID, senderNumber: '03001234567', actorId: 'admin-1' });
    const cleared = await updateSenderNumber(deps, { schoolId: SCHOOL_ID, senderNumber: null, actorId: 'admin-1' });
    expect(cleared.senderNumber).toBeNull();
    expect(cleared.senderNumberMasked).toBeNull();
    expect(store.senderNumber).toBeNull();
  });

  it('audit log records the change with the masked number only', async () => {
    await updateSenderNumber(deps, { schoolId: SCHOOL_ID, senderNumber: '03001234567', actorId: 'admin-1' });
    expect(store.audits).toHaveLength(1);
    expect(store.audits[0].action).toBe('sender_number.update');
    expect(JSON.stringify(store.audits[0].details)).not.toContain('+923001234567');
    expect(JSON.stringify(store.audits[0].details)).toContain('+92 3XX XXXX567');
  });

  it('sms status ties the display to the linked device when one exists', async () => {
    await updateSenderNumber(deps, { schoolId: SCHOOL_ID, senderNumber: '03001234567', actorId: 'admin-1' });
    await store.upsertDevice({ schoolId: SCHOOL_ID, deviceId: 'phone-1', name: 'Admin phone' });
    await store.touchDevice('phone-1'); // seen just now -> online

    const status = await getSmsStatus(deps, { schoolId: SCHOOL_ID });
    expect(status.senderNumberMasked).toBe('+92 3XX XXXX567');
    expect(status.deviceName).toBe('Admin phone');
    expect(status.deviceOnline).toBe(true);
    expect(status.simConnected).toBe(true);
  });

  it('sms status shows the saved number as the sender when no device is linked', async () => {
    await updateSenderNumber(deps, { schoolId: SCHOOL_ID, senderNumber: '03001234567', actorId: 'admin-1' });
    const status = await getSmsStatus(deps, { schoolId: SCHOOL_ID });
    expect(status.senderNumberMasked).toBe('+92 3XX XXXX567');
    expect(status.deviceName).toBeNull();
    expect(status.deviceOnline).toBe(false);
    expect(status.simConnected).toBe(false);
  });

  it('sms status shows no sender when nothing is set', async () => {
    const status = await getSmsStatus(deps, { schoolId: SCHOOL_ID });
    expect(status.senderNumberMasked).toBeNull();
    expect(status.deviceName).toBeNull();
  });
});
