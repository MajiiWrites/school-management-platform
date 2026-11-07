/**
 * Round 5 (F11) — nextCopyName: first free name for a duplicated template.
 * Pure helper (store.ts); the template unique key is now
 * (school, type, language, name), so a duplicate needs a name no other
 * template of the same type/language holds.
 */
import { describe, it, expect } from 'vitest';
import { nextCopyName } from '../store';

describe('nextCopyName', () => {
  it('returns the base name when it is free', () => {
    expect(nextCopyName(new Set(), 'Copy of Absent alert')).toBe('Copy of Absent alert');
    expect(nextCopyName([], 'Copy of Absent alert')).toBe('Copy of Absent alert');
  });

  it('numbers the copy when the base name is taken', () => {
    expect(nextCopyName(new Set(['Copy of Absent alert']), 'Copy of Absent alert')).toBe(
      'Copy of Absent alert (2)',
    );
  });

  it('skips taken numbers in order', () => {
    const taken = new Set(['Copy of Fee reminder', 'Copy of Fee reminder (2)', 'Copy of Fee reminder (3)']);
    expect(nextCopyName(taken, 'Copy of Fee reminder')).toBe('Copy of Fee reminder (4)');
  });

  it('does not collide with a different template name', () => {
    const taken = new Set(['Copy of Absent alert']);
    expect(nextCopyName(taken, 'Copy of Fee reminder')).toBe('Copy of Fee reminder');
  });
});
