import { describe, it, expect } from 'vitest';
import { todayInTz, isSunday, weekdayOf, weekStartOf, monthRange, addDays, isValidDateString, monthOf } from './dates';

describe('dates', () => {
  it('todayInTz returns YYYY-MM-DD', () => {
    expect(todayInTz('Asia/Karachi')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('isSunday detects Sundays', () => {
    expect(isSunday('2026-11-08')).toBe(true); // verified Sunday
    expect(isSunday('2026-11-09')).toBe(false); // Monday
  });
  it('weekdayOf matches known days', () => {
    expect(weekdayOf('2026-11-09')).toBe(1); // Monday
    expect(weekdayOf('2026-11-15')).toBe(0); // Sunday
  });
  it('weekStartOf returns the Monday of the week', () => {
    expect(weekStartOf('2026-11-11')).toBe('2026-11-09'); // Wed -> Mon
    expect(weekStartOf('2026-11-08')).toBe('2026-11-02'); // Sun -> previous Mon
    expect(weekStartOf('2026-11-09')).toBe('2026-11-09'); // Mon -> itself
  });
  it('monthRange covers the full month', () => {
    expect(monthRange('2026-11')).toEqual({ start: '2026-11-01', end: '2026-11-30' });
    expect(monthRange('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
  });
  it('addDays crosses month boundaries', () => {
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-11-09', -1)).toBe('2026-11-08');
  });
  it('isValidDateString rejects impossible dates', () => {
    expect(isValidDateString('2026-11-09')).toBe(true);
    expect(isValidDateString('2026-02-30')).toBe(false);
    expect(isValidDateString('09-11-2026')).toBe(false);
  });
  it('monthOf extracts YYYY-MM', () => {
    expect(monthOf('2026-11-09')).toBe('2026-11');
  });
});
