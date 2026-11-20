// Maintenance gate (Platform Admin, 2026-11-20).
//
// Fetches the public GET /platform/status once per mount. When
// maintenance_mode is true and the signed-in user is NOT a platform
// admin, the maintenance screen replaces the app shell. Platform
// admins are never gated. Public pages (/, /login, /signup, /p/:token,
// /admissions/:slug, /t/:token) are outside Layout, so they are never
// gated either. While the status is still loading — or the fetch fails
// — the normal shell renders (fail-open: a status outage must not lock
// schools out of the portal).
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';
import { platformApi } from '../lib/platform';

export function usePlatformMaintenance(): { maintenance: boolean; loading: boolean } {
  const [maintenance, setMaintenance] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    platformApi
      .getStatus()
      .then((s) => {
        if (alive) setMaintenance(s.maintenance_mode === true);
      })
      .catch(() => {
        if (alive) setMaintenance(false);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  return { maintenance, loading };
}

export function MaintenanceScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <p className="text-4xl">🛠️</p>
        <h1 className="mt-3 text-xl font-bold text-slate-900">Student Manager is under maintenance</h1>
        <p className="mt-2 text-sm text-slate-600">
          The platform is temporarily unavailable while we work on it. Please try again in a little while —
          your school&apos;s data is safe.
        </p>
        <p className="mt-3 text-xs text-slate-400">
          If you are a platform admin, sign in to switch maintenance mode off.
        </p>
        <a
          href="/login"
          className="mt-5 inline-block rounded-lg bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-900"
        >
          Go to sign-in
        </a>
      </div>
    </div>
  );
}

export default function MaintenanceGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const { maintenance } = usePlatformMaintenance();
  if (maintenance && user?.role !== 'platform_admin') return <MaintenanceScreen />;
  return <>{children}</>;
}
