// Login 2FA regression tests (2026-11-23 owner lockout): when TOTP is
// enabled the password step answers needs_2fa + temp_token (HTTP 200)
// instead of JWTs. The page must show a 6-digit code step — the old page
// had none, stored undefined tokens, navigated to /dashboard, and got
// bounced back to a cleared login form.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../lib/api';

const { loginMock, completeTwofaMock } = vi.hoisted(() => ({
  loginMock: vi.fn(() => Promise.resolve({ needs2fa: false })),
  completeTwofaMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: null,
    loading: false,
    login: loginMock,
    signup: vi.fn(),
    completeTwofaLogin: completeTwofaMock,
    logout: vi.fn(),
    sessionExpired: false,
    clearSessionExpired: vi.fn(),
  }),
}));

import { LoginPage } from '../pages/Auth';

function DashboardStub() {
  const loc = useLocation();
  return <div>Dashboard stub {loc.pathname}</div>;
}

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/dashboard" element={<DashboardStub />} />
      </Routes>
    </MemoryRouter>,
  );
}

function fillPasswordForm() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@school.pk' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret123' } });
}

beforeEach(() => {
  loginMock.mockClear();
  completeTwofaMock.mockClear();
  loginMock.mockImplementation(() => Promise.resolve({ needs2fa: false }));
  completeTwofaMock.mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  cleanup();
});

describe('login form', () => {
  it('logs in directly and navigates to /dashboard when 2FA is not enabled', async () => {
    renderLogin();
    fillPasswordForm();

    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(loginMock).toHaveBeenCalledTimes(1));
    expect(loginMock).toHaveBeenCalledWith('admin@school.pk', 'secret123');
    await waitFor(() => expect(screen.getByText('Dashboard stub /dashboard')).toBeTruthy());
    expect(completeTwofaMock).not.toHaveBeenCalled();
  });

  it('shows the code step instead of navigating when the password step answers needs_2fa', async () => {
    loginMock.mockImplementation(() => Promise.resolve({ needs2fa: true }));
    renderLogin();
    fillPasswordForm();

    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(screen.getByLabelText('Verification code')).toBeTruthy());
    expect(screen.queryByText('Dashboard stub /dashboard')).toBeNull();
  });

  it('completes login from the code step and navigates to /dashboard', async () => {
    loginMock.mockImplementation(() => Promise.resolve({ needs2fa: true }));
    renderLogin();
    fillPasswordForm();
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(screen.getByLabelText('Verification code')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & log in' }));

    await waitFor(() => expect(completeTwofaMock).toHaveBeenCalledTimes(1));
    expect(completeTwofaMock).toHaveBeenCalledWith('123456');
    await waitFor(() => expect(screen.getByText('Dashboard stub /dashboard')).toBeTruthy());
  });

  it('shows the error and stays on the code step when the code is wrong', async () => {
    loginMock.mockImplementation(() => Promise.resolve({ needs2fa: true }));
    completeTwofaMock.mockRejectedValueOnce(new ApiClientError(401, 'UNAUTHORIZED', 'Invalid verification code'));
    renderLogin();
    fillPasswordForm();
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(screen.getByLabelText('Verification code')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Verification code'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify & log in' }));

    await waitFor(() => expect(screen.getByText('Invalid verification code')).toBeTruthy());
    expect(screen.getByLabelText('Verification code')).toBeTruthy();
    expect(screen.queryByText('Dashboard stub /dashboard')).toBeNull();
  });

  it('shows the timeout message when login times out', async () => {
    loginMock.mockRejectedValueOnce(new ApiClientError(0, 'TIMEOUT', 'Request timed out'));
    renderLogin();
    fillPasswordForm();

    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() =>
      expect(
        screen.getByText('The server took too long to respond — it may have been waking up. Please try again.'),
      ).toBeTruthy(),
    );
  });
});
