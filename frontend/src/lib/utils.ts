// Small helpers: dates (school-local), money, phone masking, class names.
//
// DATE RULE (Phase 9 fix): every displayed date and every "today"
// computation uses the SCHOOL timezone (Asia/Karachi by default), never
// the server/browser UTC date. A notice posted at 00:30 PKT is 19:30 UTC
// the previous day — slicing a UTC ISO timestamp (`slice(0, 10)`) showed
// it a day behind. All helpers below format in the school timezone.

/** Default school timezone. The school row can override it (Settings);
 * pages that load settings should pass that value instead. */
export const SCHOOL_TZ = 'Asia/Karachi';

/** "Today" in the given IANA timezone, as YYYY-MM-DD. */
export function todayISOInTz(timeZone: string = SCHOOL_TZ, date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function todayISO(date = new Date()): string {
  return todayISOInTz(SCHOOL_TZ, date);
}

export function currentMonth(): string {
  return todayISO().slice(0, 7);
}

/** YYYY-MM-DD calendar date of an ISO timestamp, in the school timezone. */
export function dateInTz(iso: string, timeZone: string = SCHOOL_TZ): string {
  if (!iso) return '';
  return todayISOInTz(timeZone, new Date(iso));
}

export function monthName(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

export function fmtDate(iso: string, timeZone: string = SCHOOL_TZ): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone });
}

/** Display date for an ISO timestamp, in the school timezone (PKT) —
 * use this instead of `iso.slice(0, 10)`, which is the UTC date. */
export function fmtDateTz(iso: string, timeZone: string = SCHOOL_TZ): string {
  return fmtDate(iso, timeZone);
}

export function fmtDateTime(iso: string | null | undefined, timeZone: string = SCHOOL_TZ): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
}

export function fmtPKR(n: number): string {
  return `Rs ${n.toLocaleString('en-PK')}`;
}

export function displayClass(c: { name: string; section: string }): string {
  return `${c.name}-${c.section}`;
}

/** Pakistan mobile: normalize to E.164 (+92 + 10 digits) or return null. */
export function normalizePkPhone(input: string): string | null {
  const digits = input.replace(/\D/g, '');
  let rest = digits;
  if (rest.startsWith('92')) rest = rest.slice(2);
  else if (rest.startsWith('0')) rest = rest.slice(1);
  if (rest.length !== 10 || !rest.startsWith('3')) return null;
  return `+92${rest}`;
}

export function maskPhone(masked: string | null | undefined): string {
  return masked ?? '—';
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
