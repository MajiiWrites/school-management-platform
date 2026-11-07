// Signup regression tests: the signup form collects the full
// registration profile (school + admin details) and sends it in ONE
// signup() call.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { signupMock } = vi.hoisted(() => ({
  signupMock: vi.fn(() => Promise.resolve()),
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

function renderSignup() {
  return render(
    <MemoryRouter initialEntries={['/signup']}>
      <Routes>
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/dashboard" element={<div>Dashboard stub</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  signupMock.mockClear();
  signupMock.mockImplementation(() => Promise.resolve());
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

  it('submits all fields in one signup() call and navigates to /dashboard', async () => {
    renderSignup();

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
    fireEvent.change(screen.getByLabelText('Password', { exact: false }), { target: { value: 'secret123' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(signupMock).toHaveBeenCalledTimes(1));
    expect(signupMock).toHaveBeenCalledWith({
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
    });
    await waitFor(() => expect(screen.getByText('Dashboard stub')).toBeTruthy());
  });

  it('shows an error and does not call signup when the password is too short', async () => {
    renderSignup();

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
    fireEvent.change(screen.getByLabelText('Password', { exact: false }), { target: { value: 'short' } });

    fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    await waitFor(() => expect(screen.getByText('Password must be at least 8 characters.')).toBeTruthy());
    expect(signupMock).not.toHaveBeenCalled();
  });
});
