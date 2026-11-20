// Platform Admin panel tests (2026-11-20):
// - nav: 'Platform Admin' hidden for school roles, shown for platform_admin.
// - RequirePlatformAdmin: fails closed while role unknown/loading, redirects
//   non-platform-admins, renders for platform_admin.
// - Schools tab typed-confirm delete sends the exact school name as `confirm`.
// - MaintenanceGate: maintenance screen for non-platform-admins when
//   maintenance is on, never for platform_admin, never when it is off.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
  user: null as { id: string; email: string; role: string; school_id: string } | null,
  loading: false,
  maintenance: false,
}));

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

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    user: testState.user,
    loading: testState.loading,
    login: vi.fn(),
    signup: vi.fn(),
    logout: vi.fn(),
    sessionExpired: false,
    clearSessionExpired: vi.fn(),
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { RequirePlatformAdmin } from '../App';
import { navForRole } from '../components/Layout';
import MaintenanceGate from '../components/MaintenanceGate';
import SchoolsTab from '../pages/Platform/SchoolsTab';

const SCHOOL = {
  id: 'sch-1',
  name: 'Demo Public School',
  org_type: 'School',
  province: 'Punjab',
  category: 'Private',
  verified: true,
  suspended: false,
  student_count: 15,
  user_count: 2,
  admin_name: 'Demo Admin',
  admin_email: 'admin@mock.local',
  created_at: '2026-11-01T00:00:00Z',
};

const platformAdmin = { id: 'u-pa', email: 'owner@example.com', role: 'platform_admin', school_id: 'sch-1' };
const schoolAdmin = { id: 'u-1', email: 'admin@school.pk', role: 'admin', school_id: 'sch-1' };

beforeEach(() => {
  testState.user = null;
  testState.loading = false;
  testState.maintenance = false;
  apiMock.mockImplementation((path: string) => {
    if (path === '/platform/status') {
      return Promise.resolve({ registration_open: true, maintenance_mode: testState.maintenance, notice: null });
    }
    if (path.startsWith('/platform/schools?')) {
      return Promise.resolve({ items: [SCHOOL], total: 1, page: 1, pages: 1 });
    }
    if (path === '/platform/schools/sch-1') {
      return Promise.resolve(SCHOOL);
    }
    return Promise.resolve({ items: [], total: 0, page: 1, pages: 1 });
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('platform nav visibility', () => {
  it('hides Platform Admin for school roles and unknown roles', () => {
    expect(navForRole('admin').some((n) => n.to === '/platform')).toBe(false);
    expect(navForRole('clerk').some((n) => n.to === '/platform')).toBe(false);
    expect(navForRole(null).some((n) => n.to === '/platform')).toBe(false);
  });

  it('shows Platform Admin (and keeps the school dashboard) for platform_admin', () => {
    const nav = navForRole('platform_admin');
    expect(nav.some((n) => n.to === '/platform')).toBe(true);
    expect(nav.some((n) => n.to === '/dashboard')).toBe(true);
  });
});

describe('RequirePlatformAdmin', () => {
  function renderGuard() {
    render(
      <MemoryRouter initialEntries={['/platform']}>
        <Routes>
          <Route
            path="/platform"
            element={
              <RequirePlatformAdmin>
                <p>Panel content</p>
              </RequirePlatformAdmin>
            }
          />
          <Route path="/dashboard" element={<p>Dashboard page</p>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('fails closed while the role is unknown (loading, no user)', () => {
    testState.user = null;
    testState.loading = true;
    renderGuard();
    expect(screen.queryByText('Panel content')).toBeNull();
  });

  it('redirects a school admin to /dashboard', async () => {
    testState.user = schoolAdmin;
    renderGuard();
    await waitFor(() => expect(screen.getByText('Dashboard page')).toBeTruthy());
    expect(screen.queryByText('Panel content')).toBeNull();
  });

  it('renders the panel for platform_admin', () => {
    testState.user = platformAdmin;
    renderGuard();
    expect(screen.getByText('Panel content')).toBeTruthy();
  });
});

describe('schools typed-confirm delete', () => {
  it('sends the exact school name as confirm, and only when it matches', async () => {
    testState.user = platformAdmin;
    const deleteCalls: { path: string; opts?: unknown }[] = [];
    apiMock.mockImplementation((path: string, opts?: { method?: string; body?: unknown }) => {
      if (path.startsWith('/platform/schools?')) {
        return Promise.resolve({ items: [SCHOOL], total: 1, page: 1, pages: 1 });
      }
      if (path === '/platform/schools/sch-1' && opts?.method === 'DELETE') {
        deleteCalls.push({ path, opts });
        return Promise.resolve({ deleted: true, message: 'Deleted.' });
      }
      if (path === '/platform/schools/sch-1') return Promise.resolve(SCHOOL);
      return Promise.resolve({ items: [], total: 0, page: 1, pages: 1 });
    });

    render(
      <MemoryRouter>
        <SchoolsTab />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByText('Demo Public School')).toBeTruthy());
    fireEvent.click(screen.getByText('Demo Public School'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete school…' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delete school…' }));

    const input = screen.getByLabelText('Type the exact school name to confirm');
    const confirmBtn = screen.getByRole('button', { name: 'Delete school permanently' });
    expect(confirmBtn.hasAttribute('disabled')).toBe(true);

    fireEvent.change(input, { target: { value: 'Demo Public Schoo' } });
    expect(confirmBtn.hasAttribute('disabled')).toBe(true);

    fireEvent.change(input, { target: { value: 'Demo Public School' } });
    expect(confirmBtn.hasAttribute('disabled')).toBe(false);
    fireEvent.click(confirmBtn);

    await waitFor(() => expect(deleteCalls.length).toBe(1));
    expect(deleteCalls[0].opts).toMatchObject({ method: 'DELETE', body: { confirm: 'Demo Public School' } });
  });
});

describe('MaintenanceGate', () => {
  function renderGate() {
    render(
      <MemoryRouter>
        <MaintenanceGate>
          <p>Portal content</p>
        </MaintenanceGate>
      </MemoryRouter>,
    );
  }

  it('shows the maintenance screen when maintenance is on and the user is not a platform admin', async () => {
    testState.user = schoolAdmin;
    testState.maintenance = true;
    renderGate();
    await waitFor(() => expect(screen.getByText(/under maintenance/i)).toBeTruthy());
    expect(screen.queryByText('Portal content')).toBeNull();
  });

  it('does not gate a platform admin when maintenance is on', async () => {
    testState.user = platformAdmin;
    testState.maintenance = true;
    renderGate();
    await waitFor(() => expect(screen.getByText('Portal content')).toBeTruthy());
    expect(screen.queryByText(/under maintenance/i)).toBeNull();
  });

  it('does not gate anyone when maintenance is off', async () => {
    testState.user = schoolAdmin;
    testState.maintenance = false;
    renderGate();
    await waitFor(() => expect(screen.getByText('Portal content')).toBeTruthy());
    expect(screen.queryByText(/under maintenance/i)).toBeNull();
  });
});
