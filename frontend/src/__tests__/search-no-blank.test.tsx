// Search-reload regression tests (user-reported: the Fees search blanked
// the whole list with "Loading fees…" on every letter typed — the search
// box itself unmounted mid-typing).
//
// These tests hold the refetch pending and assert the old rows stay
// rendered, the full-page spinner never appears, and the new rows swap in
// when the request resolves. A second test asserts the superseded request
// is aborted. The same no-blank behaviour is covered for the Students
// panel and the Results table, which had the same flaw.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn() }));

vi.mock('../lib/api', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/api')>();
  return {
    ...orig,
    api: apiMock,
    apiPrint: vi.fn(),
    apiDownload: vi.fn(),
    getAccessToken: () => null,
  };
});

import FeesPage from '../pages/Fees';
import ResultsPage from '../pages/Results';
import StudentsPage from '../pages/Students';

const CLASS_5A = { id: 'c1', name: '5', section: 'A', teacher_name: 'Ms Shazia' };
const EXAM_1 = { id: 'e1', name: 'Midterm Test', type: 'midterm', class_id: 'c1' };

const FEE_ROWS = [
  { student_id: 's1', student_name: 'Ahmed Test', class_name: '5-A', month: '2026-11', amount_due: 1000, amount_paid: 0, discount: 0, status: 'unpaid', receipt_no: null, record_id: 'r1', record_exists: true, no_structure: false },
  { student_id: 's2', student_name: 'Bilal Test', class_name: '5-A', month: '2026-11', amount_due: 1000, amount_paid: 0, discount: 0, status: 'unpaid', receipt_no: null, record_id: 'r2', record_exists: true, no_structure: false },
];
const FEE_PAGE = { items: FEE_ROWS, total: 2, pages: 1, totals: { collected: 0, pending: 2000, paid_count: 0, unpaid_count: 2 } };
const FEE_PAGE_FILTERED = { items: [FEE_ROWS[0]], total: 1, pages: 1, totals: { collected: 0, pending: 1000, paid_count: 0, unpaid_count: 1 } };

const STUDENTS = [
  { id: 's1', name: 'Ahmed Test', father_name: 'Imran Test', roll_no: 1, admission_no: 'A-001', parent_name: 'Imran Test', parent_phone: '+92 3XX XXXX437', parent_has_phone: true, class_name: '5-A', status: 'active' },
  { id: 's2', name: 'Bilal Test', father_name: 'Khalid Test', roll_no: 2, admission_no: 'A-002', parent_name: 'Khalid Test', parent_phone: '+92 3XX XXXX678', parent_has_phone: true, class_name: '5-A', status: 'active' },
];

const RESULT_ROWS = [
  { id: 'r1', student_id: 's1', student_name: 'Ahmed Test', father_name: 'Imran Test', roll_no: 1, exam_id: 'e1', obtained_marks: 85, total_marks: 100, percentage: 85, grade: 'A', remarks: '', linked: true },
  { id: 'r2', student_id: 's2', student_name: 'Bilal Test', father_name: 'Khalid Test', roll_no: 2, exam_id: 'e1', obtained_marks: 70, total_marks: 100, percentage: 70, grade: 'B', remarks: '', linked: true },
];

interface PendingCall {
  path: string;
  signal: AbortSignal | undefined;
  resolve: (v: unknown) => void;
}

const pending: PendingCall[] = [];

function track(path: string, opts?: { signal?: AbortSignal }): Promise<unknown> {
  return new Promise((resolve, reject) => {
    pending.push({ path, signal: opts?.signal, resolve });
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (opts?.signal?.aborted) onAbort();
    else opts?.signal?.addEventListener('abort', onAbort);
  });
}

function route(path: string, opts?: { signal?: AbortSignal }): Promise<unknown> {
  if (path.startsWith('/fees?')) return track(path, opts);
  if (path === '/fees/structures') return Promise.resolve([]);
  if (path.startsWith('/fees/vouchers?')) return Promise.resolve({ items: [], total: 0, pages: 1 });
  if (path === '/classes') return Promise.resolve({ items: [CLASS_5A], total: 1, pages: 1 });
  if (path.startsWith('/classes/c1/students')) return track(path, opts);
  if (path.startsWith('/exams?')) return Promise.resolve({ items: [EXAM_1], total: 1, pages: 1 });
  if (path.startsWith('/results?')) return track(path, opts);
  return Promise.resolve({ items: [], total: 0, pages: 1 });
}

function callsFor(prefix: string): PendingCall[] {
  return pending.filter((c) => c.path.startsWith(prefix));
}

// Names render through HighlightedText, which splits matched text into
// <mark>/<span> pieces, and the Students name cell also carries the
// admission number in the same <td> — so no single cell reliably equals
// the name. Match the <tr> instead: exactly one data row per student,
// and its textContent always contains the full name, highlighted or not.
function rowEl(t: string) {
  return screen.getByText((_content, el) => el?.tagName === 'TR' && (el.textContent ?? '').includes(t), { selector: 'tr' });
}
function queryRowEl(t: string) {
  return screen.queryByText((_content, el) => el?.tagName === 'TR' && (el.textContent ?? '').includes(t), { selector: 'tr' });
}

async function flush(fn: () => void) {
  await act(async () => {
    fn();
  });
}

beforeEach(() => {
  apiMock.mockImplementation((path: string, opts?: { signal?: AbortSignal }) => route(path, opts));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  pending.length = 0;
});

describe('search never blanks the list', () => {
  it('fees search keeps the rows rendered while the new results load', async () => {
    render(
      <MemoryRouter>
        <FeesPage />
      </MemoryRouter>,
    );
    expect(screen.getByText('Loading fees…')).toBeTruthy();
    expect(callsFor('/fees?').length).toBe(1);
    await flush(() => callsFor('/fees?')[0].resolve(FEE_PAGE));
    await waitFor(() => expect(rowEl('Ahmed Test')).toBeTruthy());
    expect(rowEl('Bilal Test')).toBeTruthy();
    expect(screen.queryByText('Loading fees…')).toBeNull();

    const input = screen.getByRole('searchbox', { name: 'Search students' });
    fireEvent.change(input, { target: { value: 'Ah' } });
    await waitFor(() => expect(callsFor('/fees?').length).toBe(2));

    // While the search is in flight: old rows still rendered, the search
    // box still holds the typed text, no full-page spinner — only the
    // small spinner inside the search field.
    expect(rowEl('Ahmed Test')).toBeTruthy();
    expect(rowEl('Bilal Test')).toBeTruthy();
    expect(screen.queryByText('Loading fees…')).toBeNull();
    expect((input as HTMLInputElement).value).toBe('Ah');
    expect(screen.getByLabelText('Searching…')).toBeTruthy();

    await flush(() => callsFor('/fees?')[1].resolve(FEE_PAGE_FILTERED));
    await waitFor(() => expect(queryRowEl('Bilal Test')).toBeNull());
    expect(rowEl('Ahmed Test')).toBeTruthy();
  });

  it('fees search aborts the superseded request', async () => {
    render(
      <MemoryRouter>
        <FeesPage />
      </MemoryRouter>,
    );
    await flush(() => callsFor('/fees?')[0].resolve(FEE_PAGE));
    await waitFor(() => expect(rowEl('Ahmed Test')).toBeTruthy());

    const input = screen.getByRole('searchbox', { name: 'Search students' });
    fireEvent.change(input, { target: { value: 'Ah' } });
    await waitFor(() => expect(callsFor('/fees?').length).toBe(2));
    const superseded = callsFor('/fees?')[1];
    fireEvent.change(input, { target: { value: 'Ahm' } });
    await waitFor(() => expect(callsFor('/fees?').length).toBe(3));
    expect(superseded.signal?.aborted).toBe(true);

    await flush(() => callsFor('/fees?')[2].resolve(FEE_PAGE_FILTERED));
    await waitFor(() => expect(queryRowEl('Bilal Test')).toBeNull());
    expect(rowEl('Ahmed Test')).toBeTruthy();
  });

  it('students search keeps the panel (and its search box) rendered', async () => {
    render(
      <MemoryRouter>
        <StudentsPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(callsFor('/classes/c1/students').length).toBe(1));
    await flush(() => callsFor('/classes/c1/students')[0].resolve({ items: STUDENTS, total: 2, pages: 1 }));
    await waitFor(() => expect(rowEl('Ahmed Test')).toBeTruthy());

    const input = screen.getByRole('searchbox', { name: 'Search students' });
    fireEvent.change(input, { target: { value: 'Ah' } });
    await waitFor(() => expect(callsFor('/classes/c1/students').length).toBe(2));

    expect(rowEl('Ahmed Test')).toBeTruthy();
    expect(rowEl('Bilal Test')).toBeTruthy();
    expect(screen.queryByText('Loading students…')).toBeNull();
    expect(screen.getByLabelText('Searching…')).toBeTruthy();

    await flush(() => callsFor('/classes/c1/students')[1].resolve({ items: [STUDENTS[0]], total: 1, pages: 1 }));
    await waitFor(() => expect(queryRowEl('Bilal Test')).toBeNull());
    expect(rowEl('Ahmed Test')).toBeTruthy();
  });

  it('results search keeps the table rendered while the new results load', async () => {
    render(
      <MemoryRouter>
        <ResultsPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(callsFor('/results?').length).toBe(1));
    await flush(() => callsFor('/results?')[0].resolve({ items: RESULT_ROWS, total: 2, pages: 1 }));
    await waitFor(() => expect(rowEl('Ahmed Test')).toBeTruthy());

    const input = screen.getByRole('searchbox', { name: 'Search results' });
    fireEvent.change(input, { target: { value: 'Ah' } });
    await waitFor(() => expect(callsFor('/results?').length).toBe(2));

    expect(rowEl('Ahmed Test')).toBeTruthy();
    expect(rowEl('Bilal Test')).toBeTruthy();
    expect(screen.queryByText('Loading results…')).toBeNull();
    expect(screen.getByLabelText('Searching…')).toBeTruthy();

    await flush(() => callsFor('/results?')[1].resolve({ items: [RESULT_ROWS[0]], total: 1, pages: 1 }));
    await waitFor(() => expect(queryRowEl('Bilal Test')).toBeNull());
    expect(rowEl('Ahmed Test')).toBeTruthy();
  });
});
