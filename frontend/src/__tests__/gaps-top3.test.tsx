// Gaps Top 3 frontend tests (2026-11-20): parent portal tabs render
// (attendance / homework), admissions pipeline list + status badges,
// homework diary list. API is mocked; routing via MemoryRouter.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getPortalMock, admissionsListMock, homeworkListMock, MockApiError } = vi.hoisted(() => {
  class MockApiError extends Error {
    code: string;
    status: number;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    getPortalMock: vi.fn(() =>
      Promise.resolve({
        school: { name: 'Test School' },
        student: { id: 'stu-1', name: 'Ayesha Khan', class_name: '5-A', roll_no: 1, admission_no: 'A-101' },
        attendance: [
          { date: '2026-11-19', status: 'present' },
          { date: '2026-11-18', status: 'absent' },
        ],
        results: [
          { id: 'res-1', exam_name: 'Midterm', obtained_marks: 80, total_marks: 100, percentage: 80, grade: 'A', position: 1, created_at: '2026-11-15' },
        ],
        fees: [
          { month: '2026-11', amount_due: 2000, amount_paid: 0, discount: 0, status: 'unpaid', paid_at: null, receipt_no: null },
        ],
        timetable: [
          { day_of_week: 1, periods: [{ period_no: 1, subject: 'Math', start_time: '08:00', end_time: '08:45', room: 'R1', teacher_name: null }] },
        ],
        announcements: [{ id: 'ann-1', title: 'PTM on Friday', body: 'Meeting at 10am', created_at: '2026-11-18' }],
        homework: [{ id: 'hw-1', subject: 'Math', title: 'Exercise 5.2', description: 'Q1-10', due_date: '2026-11-21', teacher: 'Miss Sana' }],
      }),
    ),
    admissionsListMock: vi.fn(() =>
      Promise.resolve({
        items: [
          { id: 'inq-1', student_name: 'New Applicant', class_id: 'class-1', class_name: '5-A', parent_name: 'Father Applicant', parent_phone_masked: '+92 3XX XXXX567', parent_email: null, notes: null, status: 'new', admitted_student_id: null, created_at: '2026-11-19', updated_at: '2026-11-19' },
          { id: 'inq-2', student_name: 'Second Applicant', class_id: 'class-1', class_name: '5-A', parent_name: 'Mother Second', parent_phone_masked: '+92 3XX XXXX321', parent_email: null, notes: null, status: 'contacted', admitted_student_id: null, created_at: '2026-11-19', updated_at: '2026-11-19' },
        ],
        total: 2,
        page: 1,
        pages: 1,
        public_form_url: 'http://localhost:5173/admissions/test-school',
      }),
    ),
    homeworkListMock: vi.fn(() =>
      Promise.resolve({
        items: [
          { id: 'hw-1', class_id: 'class-1', class_name: '5-A', subject: 'Math', title: 'Exercise 5.2', description: 'Q1-10', due_date: '2026-11-21', teacher: 'Miss Sana', created_at: '2026-11-19' },
          { id: 'hw-2', class_id: 'class-1', class_name: '5-A', subject: 'English', title: 'Read chapter 3', description: null, due_date: '2026-11-22', teacher: 'Sir Ali', created_at: '2026-11-19' },
        ],
        total: 2,
      }),
    ),
    MockApiError,
  };
});

vi.mock('../lib/api', () => ({
  ApiClientError: MockApiError,
  portalApi: { getPortal: getPortalMock },
  admissionsApi: { list: admissionsListMock, setStatus: vi.fn(), admit: vi.fn() },
  homeworkApi: { list: homeworkListMock, create: vi.fn(), update: vi.fn(), remove: vi.fn(), notify: vi.fn() },
  api: vi.fn(() => Promise.resolve({ items: [], total: 0, page: 1, pages: 1 })),
  cachedApiGet: vi.fn(),
}));

import ParentPortalPage from '../pages/ParentPortal';
import AdmissionsPage from '../pages/Admissions';
import HomeworkPage from '../pages/Homework';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('parent portal page', () => {
  it('shows the student + attendance first, and the homework tab shows the diary', async () => {
    render(
      <MemoryRouter initialEntries={['/p/abc123token']}>
        <Routes>
          <Route path="/p/:token" element={<ParentPortalPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Ayesha Khan')).toBeTruthy());
    expect(screen.getByText(/Class 5-A/)).toBeTruthy();
    expect(screen.getByText('2026-11-19')).toBeTruthy();
    expect(screen.getByText('Absent')).toBeTruthy();
    fireEvent.click(screen.getByText('Homework'));
    expect(screen.getByText('Exercise 5.2')).toBeTruthy();
    expect(screen.getByText('Due 2026-11-21 · Miss Sana')).toBeTruthy();
    fireEvent.click(screen.getByText('Fees'));
    expect(screen.getByText('2026-11')).toBeTruthy();
    expect(screen.getByText(/Balance Rs 2,000/)).toBeTruthy();
  });

  it('shows the invalid-link state when the token is rejected', async () => {
    getPortalMock.mockRejectedValueOnce(new MockApiError(404, 'NOT_FOUND', 'not found'));
    render(
      <MemoryRouter initialEntries={['/p/badtoken']}>
        <Routes>
          <Route path="/p/:token" element={<ParentPortalPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Link could not be opened')).toBeTruthy());
  });
});

describe('admissions pipeline page', () => {
  it('lists inquiries with status badges and the public link', async () => {
    render(
      <MemoryRouter initialEntries={['/admissions']}>
        <AdmissionsPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('New Applicant')).toBeTruthy());
    expect(screen.getByText('Second Applicant')).toBeTruthy();
    // 'New' / 'Contacted' appear both as filter tabs and as row badges.
    expect(screen.getAllByText('New').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Contacted').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('http://localhost:5173/admissions/test-school')).toBeTruthy();
    expect(screen.getAllByText('Admit').length).toBe(2);
  });
});

describe('homework diary page', () => {
  it('lists homework with due dates and notify buttons', async () => {
    render(
      <MemoryRouter initialEntries={['/homework']}>
        <HomeworkPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Exercise 5.2')).toBeTruthy());
    expect(screen.getByText('Read chapter 3')).toBeTruthy();
    expect(screen.getByText('2026-11-21')).toBeTruthy();
    expect(screen.getAllByText('Notify parents').length).toBe(2);
  });
});
