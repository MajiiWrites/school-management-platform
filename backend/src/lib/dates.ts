/**
 * Date helpers. Business dates are ALWAYS school-local `date` strings
 * (YYYY-MM-DD) computed in the school's timezone — never the server's local
 * date (contracts/STRUCTURE.md).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateString(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** "Today" in the given IANA timezone, as YYYY-MM-DD. */
export function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Current month in the given timezone, as YYYY-MM. */
export function currentMonthInTz(tz: string): string {
  return todayInTz(tz).slice(0, 7);
}

/** Weekday of a YYYY-MM-DD date (UTC arithmetic — the date is already school-local). 0 = Sunday. */
export function weekdayOf(dateStr: string): number {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

export function isSunday(dateStr: string): boolean {
  return weekdayOf(dateStr) === 0;
}

/**
 * Convert a YYYY-MM-DD string to a Date for Prisma `@db.Date` columns.
 * Prisma Client REJECTS plain date strings for @db.Date fields
 * ("Invalid value for argument `date`: premature end of input. Expected
 * ISO-8601 DateTime") — every read/write of a @db.Date column MUST go
 * through this helper (QA 2026-11-06: the string form 500'd every
 * attendance, holiday and session endpoints live).
 */
export function dateOnly(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

export function monthOf(dateStr: string): string {
  return dateStr.slice(0, 7);
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** First/last date of a YYYY-MM month. */
export function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start, end: `${month}-${String(lastDay).padStart(2, '0')}` };
}

/** Monday of the week containing dateStr (weeks start Monday). */
export function weekStartOf(dateStr: string): string {
  const wd = weekdayOf(dateStr); // 0 Sun .. 6 Sat
  const offset = wd === 0 ? -6 : 1 - wd;
  return addDays(dateStr, offset);
}

export interface DbLike {
  holiday: { findFirst: (args: any) => Promise<any> };
}

/** A date is a non-school day if it is a Sunday or a row in holidays. */
export async function isNonSchoolDay(db: DbLike, schoolId: string, dateStr: string): Promise<boolean> {
  if (isSunday(dateStr)) return true;
  const row = await db.holiday.findFirst({ where: { schoolId: schoolId, date: dateOnly(dateStr) } });
  return row !== null && row !== undefined;
}
