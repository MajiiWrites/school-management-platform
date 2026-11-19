// Phase 1 email-verification tests: LoginPage EMAIL_NOT_VERIFIED +
// resend, VerifyEmailPage sent-interstitial + no-token resend, and the
// Dashboard verification banner copy per email_verification_status.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClientError } from '../lib/api';
import type { DashboardData, SmsStatus, User } from '../lib/types';

const { loginMock, apiMock, authState } = vi.hoisted(() => ({
  loginMock: vi.fn(),
  apiMock: vi.fn(),
  authState: { user: null as User | null },
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: authState.user,
    loading: false,
    login: loginMock,
    signup: vi.fn(),
    logout: vi.fn(),
    sessionExpired: false,
    clearSessionExpired: vi.fn(),
  }),
}));

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: apiMock };
});

import { LoginPage, VerifyEmailPage } from '../pages/Auth';
import DashboardPage from '../pages/Dashboard';

const DASHBOARD_DATA: DashboardData = {
  classes_submitted: 2,
  classes_pending: 1,
  present: 9,
  absent: 2,
  teachers_present: 2,
  teachers_absent: 1,
  fee_collected_this_month: 17500,
  fee_pending_this_month: 20000,
  recent_notifications: [],
};

const SMS_STATUS: SmsStatus = { provider: 'sim', sim_connected: false, queued_count: 0 };

function unverifiedUser(status?: User['email_verification_status']): User {
  return {
    id: 'u-1',
    email: 'admin@school.pk',
    role: 'admin',
    school_id: 'sch-1',
    email_verified: false,
    email_verification_status: status,
  };
}

beforeEach(() => {
  loginMock.mockReset();
  apiMock.mockReset();
  authState.user = null;
  sessionStorage.clear();
  apiMock.mockImplementation((path: string) => {
    if (path === '/auth/resend-verification') {
      return Promise.resolve({ sent: true, message: 'Verification link sent.' });
    }
    if (path === '/dashboard') return Promise.resolve(DASHBOARD_DATA);
    if (path === '/sms/status') return Promise.resolve(SMS_STATUS);
    return Promise.reject(new Error(`Unexpected api call: ${path}`));
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LoginPage EMAIL_NOT_VERIFIED', () => {
  it('shows the server message and offers a resend that posts the entered email', async () => {
    loginMock.mockRejectedValueOnce(
      new ApiClientError(
        403,
        'EMAIL_NOT_VERIFIED',
        'Please verify your email before logging in. Check your inbox for the verification link, or resend it below.',
      ),
    );
    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/dashboard" element={<div>Dashboard stub</div>} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@school.pk' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() =>
      expect(screen.getByText(/Please verify your email before logging in/)).toBeTruthy(),
    );
    expect(screen.queryByText('Dashboard stub')).toBeNull();

    const resend = screen.getByRole('button', { name: 'Resend verification email' });
    expect(resend).toBeTruthy();
    fireEvent.click(resend);

    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/auth/resend-verification', {
        method: 'POST',
        body: { email: 'admin@school.pk' },
      }),
    );
    await waitFor(() => expect(screen.getByText('Verification link sent.')).toBeTruthy());
  });

  it('does not offer a resend for a plain invalid-login error', async () => {
    loginMock.mockRejectedValueOnce(new ApiClientError(401, 'UNAUTHORIZED', 'Invalid email or password'));
    render(
      <MemoryRouter initialEntries={['/login']}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@school.pk' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrongpass' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));

    await waitFor(() => expect(screen.getByText('Invalid email or password')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Resend verification email' })).toBeNull();
  });
});

describe('VerifyEmailPage', () => {
  it('shows the sent interstitial with the email and a resend button', async () => {
    render(
      <MemoryRouter initialEntries={['/verify-email?sent=1&email=admin%40school.pk']}>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText(/We're sending a verification link to admin@school\.pk/)).toBeTruthy();
    expect(screen.getByText(/it usually arrives within a minute/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Resend verification email' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/auth/resend-verification', {
        method: 'POST',
        body: { email: 'admin@school.pk' },
      }),
    );
    await waitFor(() => expect(screen.getByText('Verification link sent.')).toBeTruthy());
  });

  it('shows the honest failed-send result instead of claiming a send', async () => {
    apiMock.mockImplementationOnce(() =>
      Promise.resolve({ sent: false, message: 'We could not send the verification email. Please try again later.' }),
    );
    render(
      <MemoryRouter initialEntries={['/verify-email?sent=1&email=admin%40school.pk']}>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Resend verification email' }));
    await waitFor(() =>
      expect(screen.getByText('We could not send the verification email. Please try again later.')).toBeTruthy(),
    );
  });

  it('with no token and no sent flag shows the no-token text plus a resend form', async () => {
    render(
      <MemoryRouter initialEntries={['/verify-email']}>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('No verification token in this link.')).toBeTruthy();
    expect(screen.getByText("Didn't receive the email?")).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'admin@school.pk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Resend verification email' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/auth/resend-verification', {
        method: 'POST',
        body: { email: 'admin@school.pk' },
      }),
    );
    await waitFor(() => expect(screen.getByText('Verification link sent.')).toBeTruthy());
  });
});

describe('Dashboard verification banner', () => {
  function renderDashboard() {
    return render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/dashboard" element={<DashboardPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("status 'sent' says the link was sent", async () => {
    authState.user = unverifiedUser('sent');
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/We sent a verification link to admin@school\.pk/)).toBeTruthy(),
    );
    expect(screen.getByText(/please check your inbox \(and spam folder\)/)).toBeTruthy();
  });

  it("status 'failed' says the send failed and offers a resend", async () => {
    authState.user = unverifiedUser('failed');
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/We could not send the verification email to admin@school\.pk/)).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Resend verification email' }));
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith('/auth/resend-verification', {
        method: 'POST',
        body: { email: 'admin@school.pk' },
      }),
    );
    await waitFor(() => expect(screen.getByText('Verification link sent.')).toBeTruthy());
  });

  it("status 'pending' says the link is being sent", async () => {
    authState.user = unverifiedUser('pending');
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/We're sending a verification link to admin@school\.pk/)).toBeTruthy(),
    );
    expect(screen.getByText(/If it doesn't arrive in a few minutes, resend it/)).toBeTruthy();
  });

  it('undefined status falls back to the pending copy', async () => {
    authState.user = unverifiedUser(undefined);
    renderDashboard();
    await waitFor(() =>
      expect(screen.getByText(/We're sending a verification link to admin@school\.pk/)).toBeTruthy(),
    );
  });

  it('is hidden once the email is verified', async () => {
    authState.user = { ...unverifiedUser('sent'), email_verified: true };
    renderDashboard();
    await waitFor(() => expect(screen.getByText("Today's overview")).toBeTruthy());
    expect(screen.queryByText(/Verify your email/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resend verification email' })).toBeNull();
  });
});
