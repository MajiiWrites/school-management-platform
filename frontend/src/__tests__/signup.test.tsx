// Signup regression tests: the signup form collects the full
// registration profile (school + admin details) and sends it in ONE
// signup() call. Phase 1: signup issues NO tokens and does NOT log
// the user in — on success the page routes to /verify-email, and
// signup() is called with a 30s timeout.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../lib/api';

const { signupMock } = vi.hoisted(() => ({
  signupMock: vi.fn(() =>
    Promise.resolve({
      user: { id: 'u-1', email: 'admin@school.pk', role: 'admin', school_id: 'sch-1', email_verified: false },
      school: { id: 'sch-1', name: 'Al-Noor Public School' },
      email_verification: { status: 'sent' },
    }),
  ),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    loading: false,
    login: vi.fn(),
    signup: signupMock,
    logout: vi.fn(),
    sessionExpired: false,
    clearSessionExpired: vi.fn(),
  }),
}));

import { SignupPage } from '../pages/Auth';

function VerifyStub() {
  const loc = useLocation();
  return (
    <div>
      Verify stub {loc.pathname}
      {loc.search}
    </div>
  );
}

function renderSignup() {
  return render(
    <MemoryRouter initialEntries={['/signup']}>
      <Routes>
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/verify-email" element={<VerifyStub />} />
      </Routes>
    </MemoryRouter>,
  );
}

function fillSignupForm(password = 'secret123') {
  fireEvent.change(screen.getByLabelText('School name'), { target: { value: 'Al-Noor Public School' } });
  fireEvent.change(screen.getByLabelText('Organization type'), { target: { value: 'School' } });
  fireEvent.change(screen.getByLabelText('School category'), { target: { value: 'Private' } });
  fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'Main Bazaar Road' } });
  fireEvent.change(screen.getByLabelText('Tehsil'), { target: { value: 'Bahawalpur Saddar' } });
  fireEvent.change(screen.getByLabelText('District'), { target: { value: 'Bahawalpur' } });
  fireEvent.change(screen.getByLabelText('Province'), { target: { value: 'Punjab' } });
  fireEvent.change(screen.getByLabelText('Admin name'), { target: { value: 'Majid Ali' } });
  fireEvent.change(screen.getByLabelText('Admin number', { exact: false }), { target: { value: '03001234567' } });
  fireEvent.change(screen.getByLabelText('Admin email'), { target: { value: 'admin@school.pk' } });
  fireEvent.change(screen.getByLabelText('Password', { exact: false }), { target: { value: password } });
}

beforeEach(() => {
  signupMock.mockClear();
  signupMock.mockImplementation(() =>
    Promise.resolve({
      user: { id: 'u-1', email: 'admin@school.pk', role: 'admin', school_id: 'sch-1', email_verified: false },
      school: { id: 'sch-1', name: 'Al-Noor Public School' },
      email_verification: { status: 'sent' },
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('signup form', () => {
  it('renders every registration field, grouped under section headings', () => {
    renderSignup();

    expect(screen.getByRole('heading', { name: 'School details' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Admin details' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Account' })).toBeTruthy();

    expect(screen.getByLabelText('School name')).toBeTruthy();
    expect(screen.getByLabelText('Organization type')).toBeTruthy();
    expect(screen.getByLabelText('School category')).toBeTruthy();
    expect(screen.getByLabelText('Address')).toBeTruthy();
    expect(screen.getByLabelText('Tehsil')).toBeTruthy();
    expect(screen.getByLabelText('District')).toBeTruthy();
    expect(screen.getByLabelText('Province')).toBeTruthy();
    expect(screen.getByLabelText('Admin name')).toBeTruthy();
    expect(screen.getByLabelText('Admin number', { exact: false })).toBeTruthy();
    expect(screen.getByLabelText('Admin email')).toBeTruthy();
    expect(screen.getByLabelText('Password', { exact: false })).toBeTruthy();

    // Dropdown options.
    const orgType = screen.getByLabelText('Organization type') as HTMLSelectElement;
    expect(Array.from(orgType.options).map((o) => o.value)).toContain('School');
    expect(Array.from(orgType.options).map((o) => o.value)).toContain('College');
    const category = screen.getByLabelText('School category') as HTMLSelectElement;
    expect(Array.from(category.options).map((o) => o.value)).toEqual(
      expect.arrayContaining(['Private', 'Public', 'Semi-Government']),
    );
    const province = screen.getByLabelText('Province') as HTMLSelectElement;
    expect(Array.from(province.options).map((o) => o.value)).toEqual(
      expect.arrayContaining([
        'Punjab',
        'Sindh',
        'Khyber Pakhtunkhwa',
        'Balochistan',
        'Gilgit-Baltistan',
        'Azad Jammu & Kashmir',
        'Islamabad Capital Territory',
      ]),
    );

    // Admin number hint + login link.
    expect(screen.getByText('Pakistani mobile number')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Log in' }).getAttribute('href')).toBe('/login');
  });

  it('submits all fields in one signup() call with a 30s timeout and navigates to /verify-email', async () => {
    renderSignup();
    fillSignupForm();

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(signupMock).toHaveBeenCalledTimes(1));
    expect(signupMock).toHaveBeenCalledWith(
      {
        school_name: 'Al-Noor Public School',
        admin_name: 'Majid Ali',
        admin_phone: '03001234567',
        address: 'Main Bazaar Road',
        tehsil: 'Bahawalpur Saddar',
        district: 'Bahawalpur',
        province: 'Punjab',
        category: 'Private',
        org_type: 'School',
        email: 'admin@school.pk',
        password: 'secret123',
      },
      { timeoutMs: 30000 },
    );
    await waitFor(() =>
      expect(screen.getByText('Verify stub /verify-email?sent=1&email=admin%40school.pk')).toBeTruthy(),
    );
  });

  it('shows an error and does not call signup when the password is too short', async () => {
    renderSignup();
    fillSignupForm('short');

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(screen.getByText('Password must be at least 8 characters.')).toBeTruthy());
    expect(signupMock).not.toHaveBeenCalled();
  });

  it('shows the already-exists message on a 409 CONFLICT', async () => {
    signupMock.mockRejectedValueOnce(new ApiClientError(409, 'CONFLICT', 'Email already registered'));
    renderSignup();
    fillSignupForm();

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() =>
      expect(screen.getByText('An account with this email already exists — log in instead.')).toBeTruthy(),
    );
  });

  it('shows the timeout message when signup times out', async () => {
    signupMock.mockRejectedValueOnce(new ApiClientError(0, 'TIMEOUT', 'Request timed out'));
    renderSignup();
    fillSignupForm();

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() =>
      expect(
        screen.getByText('This is taking too long — your account may already exist, try logging in.'),
      ).toBeTruthy(),
    );
  });
});
