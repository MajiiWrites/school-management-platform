// Small helpers: dates (school-local), money, phone masking, class names.

export function todayISO(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthName(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

export function fmtDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
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
