// School-timezone date helpers (fees + jobs).
// All business dates are school-local; the server may run in any timezone.
// Implemented with Intl so no extra dependency is needed.
//
// NOTE: lib/dates.ts (Backend Agent) has the same isValidDateString/addDays
// helpers — they are re-exported here instead of duplicated. The helpers in
// THIS file are the `now`-parameterised variants (needed by jobs + tests,
// which run for arbitrary instants, not just "now"); lib/dates.ts only
// exposes "today" variants.

export { addDays, isValidDateString } from '../lib/dates';

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  weekday: string; // 'Sunday' | 'Monday' | ...
  date: string; // YYYY-MM-DD (school-local)
  monthKey: string; // YYYY-MM (school-local)
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(timeZone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = timeZone + JSON.stringify(opts);
  let f = dtfCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, ...opts });
    dtfCache.set(key, f);
  }
  return f;
}

/** School-local date/time parts for an instant (default: now). */
export function localParts(now: Date, timeZone: string): LocalParts {
  const parts = dtf(timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'long',
  }).formatToParts(now);
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const hour = Number(get('hour'));
  const minute = Number(get('minute'));
  const weekday = get('weekday');
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { year, month, day, hour, minute, weekday, date, monthKey: date.slice(0, 7) };
}

/** School-local date (YYYY-MM-DD) for an instant. */
export function localDateString(now: Date, timeZone: string): string {
  return localParts(now, timeZone).date;
}

/** School-local month key (YYYY-MM) for an instant. */
export function localMonthKey(now: Date, timeZone: string): string {
  return localParts(now, timeZone).monthKey;
}

/** True when the school-local weekday is Sunday (always a non-school day). */
export function isSunday(now: Date, timeZone: string): boolean {
  return localParts(now, timeZone).weekday === 'Sunday';
}

/** "HH:MM" for a school-local instant. */
export function localHHMM(now: Date, timeZone: string): string {
  const p = localParts(now, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** Minutes since local midnight. */
export function localMinutes(now: Date, timeZone: string): number {
  const p = localParts(now, timeZone);
  return p.hour * 60 + p.minute;
}

export function parseHHMM(hhmm: string): { hour: number; minute: number } | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!m) return null;
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

export function hhmmToMinutes(hhmm: string): number | null {
  const p = parseHHMM(hhmm);
  return p ? p.hour * 60 + p.minute : null;
}

/** Validate a YYYY-MM month key. */
export function isValidMonthKey(s: string): boolean {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(s);
  if (!m) return false;
  return true;
}

/** First day of a month key, as YYYY-MM-DD. */
export function monthStartDate(monthKey: string): string {
  return `${monthKey}-01`;
}

/** Month key n months after the given one (n may be negative). */
export function addMonths(monthKey: string, n: number): string {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Weekday name ('Sunday'..'Saturday') for a YYYY-MM-DD date, in a timezone. */
export function weekdayOf(dateStr: string, timeZone: string): string {
  // Noon UTC avoids any tz-boundary issues for the date itself.
  return dtf(timeZone, { weekday: 'long' }).format(new Date(`${dateStr}T12:00:00Z`));
}
