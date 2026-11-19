// College Mode tests: nav gating, GPA/CGPA display (incl. null GPA),
// report-card college block, and the Programs list rendering.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatGpa, formatPct, isCollegeOrg, showCollegeNav } from '../lib/college';
import { CollegeNotAvailable, CollegeReportCardBlock } from '../components/CollegeReportCard';
import { GpaCourseTable, GpaSummary } from '../pages/CollegeStudentGpa';
import type { CollegeGpa, ReportCardCollege } from '../lib/types';

const { listProgramsMock, deleteProgramMock, MockApiError } = vi.hoisted(() => {
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
    listProgramsMock: vi.fn(() =>
      Promise.resolve({
        programs: [
          { id: 'prog-1', name: 'BS Computer Science', code: 'BSCS', department: 'Computer Science', duration_years: 4, semester_count: 2, student_count: 2 },
          { id: 'prog-2', name: 'BBA', code: 'BBA', department: 'Business', duration_years: 4, semester_count: 0, student_count: 0 },
        ],
      }),
    ),
    deleteProgramMock: vi.fn(() => Promise.resolve({ ok: true })),
    MockApiError,
  };
});

vi.mock('../lib/api', () => ({
  ApiClientError: MockApiError,
  collegeApi: {
    listPrograms: listProgramsMock,
    deleteProgram: deleteProgramMock,
    createProgram: vi.fn(),
    updateProgram: vi.fn(),
  },
  api: vi.fn(),
  cachedApiGet: vi.fn(),
}));

import CollegeProgramsPage from '../pages/CollegePrograms';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  listProgramsMock.mockClear();
  listProgramsMock.mockImplementation(() =>
    Promise.resolve({
      programs: [
        { id: 'prog-1', name: 'BS Computer Science', code: 'BSCS', department: 'Computer Science', duration_years: 4, semester_count: 2, student_count: 2 },
        { id: 'prog-2', name: 'BBA', code: 'BBA', department: 'Business', duration_years: 4, semester_count: 0, student_count: 0 },
      ],
    }),
  );
});

describe('college nav gating', () => {
  it('shows College items only for College orgs', () => {
    expect(showCollegeNav('College')).toBe(true);
    expect(isCollegeOrg('College')).toBe(true);
    expect(showCollegeNav('School')).toBe(false);
    expect(showCollegeNav(undefined)).toBe(false);
    expect(showCollegeNav(null)).toBe(false);
    expect(showCollegeNav('')).toBe(false);
  });

  it('renders the not-available state for School orgs', () => {
    render(
      <MemoryRouter>
        <CollegeNotAvailable />
      </MemoryRouter>,
    );
    expect(screen.getByText('Not available for your organization type')).toBeTruthy();
    expect(screen.getByText(/only for colleges/i)).toBeTruthy();
  });
});

describe('GPA formatting', () => {
  it('formats GPA to 2 decimals and shows — for null/undefined', () => {
    expect(formatGpa(3.5)).toBe('3.50');
    expect(formatGpa(4)).toBe('4.00');
    expect(formatGpa(null)).toBe('—');
    expect(formatGpa(undefined)).toBe('—');
    expect(formatPct(85)).toBe('85%');
    expect(formatPct(null)).toBe('—');
  });
});

const COLLEGE_BLOCK: ReportCardCollege = {
  program: 'BS Computer Science',
  semester: 'Semester 1',
  semester_gpa: 3.5,
  cgpa: 3.62,
  courses: [
    { course_id: 'crs-1', course_code: 'CS101', course_title: 'Intro to Computing', credit_hours: 3, obtained_marks: 85, total_marks: 100, percentage: 85, grade: 'A', grade_points: 4.0 },
    { course_id: 'crs-2', course_code: 'MTH101', course_title: 'Calculus I', credit_hours: 3, obtained_marks: 72, total_marks: 100, percentage: 72, grade: 'B', grade_points: 3.0 },
  ],
};

describe('report-card college block', () => {
  it('renders program, semester, GPA, CGPA and course rows with grade/points', () => {
    render(<CollegeReportCardBlock college={COLLEGE_BLOCK} />);
    expect(screen.getByText('BS Computer Science')).toBeTruthy();
    expect(screen.getByText('Semester 1')).toBeTruthy();
    expect(screen.getByTestId('college-semester-gpa').textContent).toBe('3.50');
    expect(screen.getByTestId('college-cgpa').textContent).toBe('3.62');
    expect(screen.getByText('CS101')).toBeTruthy();
    expect(screen.getByText('Intro to Computing')).toBeTruthy();
    expect(screen.getByText('A')).toBeTruthy();
    expect(screen.getByText('4.00')).toBeTruthy();
    expect(screen.getByText('B')).toBeTruthy();
    expect(screen.getByText('3.00')).toBeTruthy();
  });

  it('shows — for null semester GPA / CGPA and null grade/points', () => {
    render(
      <CollegeReportCardBlock
        college={{ program: null, semester: null, semester_gpa: null, cgpa: null, courses: [{ course_id: 'c1', course_code: 'CS101', course_title: 'Intro', credit_hours: 3, obtained_marks: null, total_marks: null, percentage: null, grade: null, grade_points: null }] }}
      />,
    );
    expect(screen.getByTestId('college-semester-gpa').textContent).toBe('—');
    expect(screen.getByTestId('college-cgpa').textContent).toBe('—');
    expect(screen.queryByText('Program')).toBeNull();
  });
});

describe('student GPA view', () => {
  const GPA: CollegeGpa = {
    student_id: 'st-1',
    semester: { id: 'sem-1', number: 1, name: 'Semester 1', gpa: 3.5, total_credit_hours: 6 },
    cgpa: 3.5,
    total_credit_hours_all: 6,
    courses: COLLEGE_BLOCK.courses,
  };

  it('renders semester GPA, CGPA and the course table', () => {
    render(
      <>
        <GpaSummary gpa={GPA} />
        <GpaCourseTable gpa={GPA} />
      </>,
    );
    expect(screen.getByTestId('gpa-semester-gpa').textContent).toBe('3.50');
    expect(screen.getByTestId('gpa-cgpa').textContent).toBe('3.50');
    expect(screen.getByText('CS101')).toBeTruthy();
    expect(screen.getByText('A')).toBeTruthy();
  });

  it('shows — when GPA and CGPA are null (no marks yet)', () => {
    render(<GpaSummary gpa={{ ...GPA, semester: { id: 'sem-1', number: 1, name: 'Semester 1', gpa: null, total_credit_hours: 0 }, cgpa: null, total_credit_hours_all: 0, courses: [] }} />);
    expect(screen.getByTestId('gpa-semester-gpa').textContent).toBe('—');
    expect(screen.getByTestId('gpa-cgpa').textContent).toBe('—');
    render(<GpaCourseTable gpa={{ ...GPA, courses: [] }} />);
    expect(screen.getByText('No courses with marks yet for this selection.')).toBeTruthy();
  });
});

describe('programs list', () => {
  it('renders programs from the API and filters by search', async () => {
    render(
      <MemoryRouter>
        <CollegeProgramsPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('BS Computer Science')).toBeTruthy());
    expect(screen.getByText('BBA')).toBeTruthy();
    expect(listProgramsMock).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('Search programs'), { target: { value: 'BBA' } });
    await waitFor(() => expect(screen.queryByText('BS Computer Science')).toBeNull());
    expect(screen.getByText('BBA')).toBeTruthy();
  });
});
