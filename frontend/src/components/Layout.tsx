import { Suspense, useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { api } from '../lib/api';
import type { NotificationItem, Role } from '../lib/types';
import { cx } from '../lib/utils';
import { Spinner } from './ui';
import { useLanguage } from '../lib/i18n';
import DeveloperFooter from './DeveloperFooter';
import IdleTimeout from './IdleTimeout'; // 6D component (added by its agent; import was missing)
// P8-TOUR: guided tour (Phase 10 criterion E) — modal-based, no library.
import GuidedTour, { startGuidedTour } from './GuidedTour';

const NAV: { to: string; labelKey: string; icon: string; roles: Role[] }[] = [
  { to: '/', labelKey: 'dashboard', icon: '▦', roles: ['admin', 'clerk', 'principal'] },
  { to: '/classes', labelKey: 'classes', icon: '▤', roles: ['admin', 'clerk', 'principal'] },
  { to: '/students', labelKey: 'students', icon: '👥', roles: ['admin', 'clerk', 'principal'] },
  { to: '/parents', labelKey: 'parents', icon: '☎', roles: ['admin', 'clerk', 'principal'] },
  { to: '/fees', labelKey: 'fees', icon: '₨', roles: ['admin', 'clerk', 'principal'] },
  { to: '/messages', labelKey: 'messages', icon: '✉', roles: ['admin', 'clerk', 'principal'] },
  { to: '/reports', labelKey: 'reports', icon: '▧', roles: ['admin', 'clerk', 'principal'] },
  // 6B: results (OCR sheets, toppers, report cards)
  { to: '/results', labelKey: 'results', icon: '🏆', roles: ['admin', 'clerk', 'principal'] },
  // 6C-1: sessions / exams / timetable / staff & payroll.
  { to: '/sessions', labelKey: 'sessions', icon: '🗓', roles: ['admin', 'clerk', 'principal'] },
  { to: '/exams', labelKey: 'exams', icon: '📝', roles: ['admin', 'clerk', 'principal'] },
  { to: '/timetable', labelKey: 'timetable', icon: '🕘', roles: ['admin', 'clerk', 'principal'] },
  { to: '/staff', labelKey: 'staff-payroll', icon: '👩‍🏫', roles: ['admin', 'clerk', 'principal'] },
  // 6C-2: expenses, announcements, events, certificates, leave/late, notifications.
  { to: '/expenses', labelKey: 'expenses', icon: '🧾', roles: ['admin', 'clerk', 'principal'] },
  { to: '/announcements', labelKey: 'announcements', icon: '📢', roles: ['admin', 'clerk', 'principal'] },
  { to: '/events', labelKey: 'events', icon: '📅', roles: ['admin', 'clerk', 'principal'] },
  { to: '/certificates', labelKey: 'certificates', icon: '🎓', roles: ['admin', 'clerk', 'principal'] },
  { to: '/leaves', labelKey: 'leaves', icon: '🗓', roles: ['admin', 'clerk', 'principal'] },
  { to: '/notifications', labelKey: 'notifications', icon: '🔔', roles: ['admin', 'clerk', 'principal'] },
  // P8-TOUR: Help page (guided tour + how-tos + glossary).
  { to: '/help', labelKey: 'help', icon: '?', roles: ['admin', 'clerk', 'principal'] },
  // D2: approval queue — clerk creates/updates/deletes land here for admin decision.
  { to: '/approvals', labelKey: 'approvals', icon: '☑', roles: ['admin'] },
  // D1: Recycle Bin (30-day restore) + Change History (old → new audit).
  { to: '/recycle-bin', labelKey: 'recycle-bin', icon: '♻', roles: ['admin'] },
  { to: '/change-history', labelKey: 'change-history', icon: '↺', roles: ['admin'] },
  { to: '/settings', labelKey: 'settings', icon: '⚙', roles: ['admin'] },
  // 6D: 2FA, roles & permissions, data export, deletion requests, login alerts, backups.
  { to: '/security', labelKey: 'security', icon: '🔒', roles: ['admin'] },
];

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { nav } = useLanguage();

  // R2-E (round 2) empty-sidebar fix: the nav must never render empty
  // inside the portal. While the session re-verifies the role can be
  // transiently unknown (or a stale cache holds an unexpected shape),
  // so fall back to the common nav shared by admin/clerk/principal;
  // admin-only items stay gated on role === 'admin'. If the role filter
  // ever yields nothing, the common nav is the last resort — an empty
  // sidebar is never a valid state.
  const commonNav = NAV.filter(
    (n) => n.roles.includes('admin') && n.roles.includes('clerk') && n.roles.includes('principal'),
  );
  const roleFiltered = user ? NAV.filter((n) => n.roles.includes(user.role)) : commonNav;
  const visibleNav = roleFiltered.length > 0 ? roleFiltered : commonNav;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 px-4 py-4">
        <p className="text-lg font-bold text-brand-900">🏫 School Manager</p>
        <p className="truncate text-xs text-slate-500">{user?.school_name ?? 'Your school'}</p>
      </div>
      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-3">
        {visibleNav.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.to === '/'}
            onClick={onNavigate}
            className={({ isActive }) =>
              cx(
                'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium',
                isActive ? 'bg-brand-100 text-brand-700' : 'text-slate-600 hover:bg-slate-100',
              )
            }
          >
            <span className="w-5 text-center">{n.icon}</span>
            {nav(n.labelKey)}
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-slate-200 px-4 py-3 text-xs text-slate-500">
        <p className="truncate font-medium text-slate-700">{user?.email}</p>
        <p className="capitalize">{user?.role}</p>
        <button
          onClick={() => {
            logout();
            navigate('/login');
          }}
          className="mt-2 font-medium text-red-600 hover:underline"
        >
          Log out
        </button>
      </div>
    </div>
  );
}

export default function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const location = useLocation();

  // Phase 9 fix (stale badge): the bell used to fetch once on mount and
  // never again, so after viewing the notification center (which marks
  // items read) the header badge still showed the old unread count until
  // a full reload. Re-fetch on every navigation and whenever the bell
  // is opened, so header and notification center always agree.
  const loadNotifications = useCallback(() => {
    api<{ items: NotificationItem[] }>('/notifications?limit=10')
      .then((d) => setNotifications(d.items))
      .catch(() => undefined);
  }, []);

  useEffect(loadNotifications, [loadNotifications, location.pathname]);

  // D5: close the bell dropdown on navigation — it used to stay open
  // across page changes until clicked again. (Separate from the refetch
  // above; closing here must not touch the notification list.)
  useEffect(() => {
    setBellOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (bellOpen) loadNotifications();
  }, [bellOpen, loadNotifications]);

  // R2-D (i): the Notification Center marks items read on view, but the
  // header only re-fetched on navigation — and that refetch raced the
  // center's fire-and-forget mark-read calls, so the badge kept the old
  // count until the NEXT navigation/reload. The center now dispatches
  // 'notifications-read' once its mark-read calls land; clear the badge
  // immediately here (optimistic + server refetch to confirm).
  useEffect(() => {
    const onRead = () => {
      setNotifications((ns) => ns.map((n) => ({ ...n, is_read: true })));
      loadNotifications();
    };
    window.addEventListener('notifications-read', onRead);
    return () => window.removeEventListener('notifications-read', onRead);
  }, [loadNotifications]);

  const unread = notifications.filter((n) => !n.is_read).length;

  const markRead = (id: string) => {
    api(`/notifications/${id}/read`, { method: 'POST' }).catch(() => undefined);
    setNotifications((ns) => ns.map((n) => (n.id === id ? { ...n, is_read: true } : n)));
  };

  return (
    <div className="min-h-screen lg:flex">
      {/* 6D: idle/session-timeout warning + auto sign-out (authed area only). */}
      <IdleTimeout />
      {/* P8-TOUR: guided tour modal — auto-opens once on first login; the
          header "?" button relaunches it anytime. */}
      <GuidedTour />
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white lg:block">
        <div className="sticky top-0 h-screen">
          <SidebarContent />
        </div>
      </aside>

      {/* Mobile sidebar */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 bg-white shadow-xl">
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}

      <div className="min-w-0 flex-1">
        {/* Top bar */}
        <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
          <button
            className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            ☰
          </button>
          <p className="flex-1 text-sm font-semibold text-slate-800 lg:hidden">School Manager</p>
          {/* P8-TOUR: relaunch the guided tour anytime. */}
          <button
            onClick={startGuidedTour}
            className="ml-auto rounded-lg p-2 text-slate-600 hover:bg-slate-100"
            title="Take the guided tour"
            aria-label="Take the guided tour"
          >
            ?
          </button>
          <div className="relative">
            <button
              onClick={() => setBellOpen((v) => !v)}
              className="relative rounded-lg p-2 text-slate-600 hover:bg-slate-100"
              aria-label="Notifications"
            >
              🔔
              {unread > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white">
                  {unread}
                </span>
              )}
            </button>
            {bellOpen && (
              <div className="absolute right-0 mt-2 w-80 max-w-[90vw] rounded-xl border border-slate-200 bg-white shadow-xl">
                <p className="border-b border-slate-200 px-4 py-2 text-sm font-semibold">Notifications</p>
                <div className="max-h-96 overflow-y-auto">
                  {notifications.length === 0 && (
                    <p className="px-4 py-6 text-center text-sm text-slate-500">No notifications.</p>
                  )}
                  {notifications.map((n) => (
                    <button
                      key={n.id}
                      onClick={() => markRead(n.id)}
                      className={cx('block w-full px-4 py-3 text-left hover:bg-slate-50', !n.is_read && 'bg-brand-50')}
                    >
                      <p className="text-sm font-medium text-slate-800">{n.title}</p>
                      <p className="text-xs text-slate-500">{n.body}</p>
                    </button>
                  ))}
                </div>
                {/* 6C-2: the bell is a preview; the full center lives on its own page. */}
                <NavLink
                  to="/notifications"
                  onClick={() => setBellOpen(false)}
                  className="block border-t border-slate-200 px-4 py-2 text-center text-sm font-medium text-brand-700 hover:bg-slate-50"
                >
                  View all in the notification center →
                </NavLink>
              </div>
            )}
          </div>
        </header>

        <main className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
          {/* R2-E: pages are lazy chunks — the sidebar + header stay
              visible while a page chunk loads, never a bare white page. */}
          <Suspense fallback={<Spinner label="Loading page…" />}>
            <Outlet />
          </Suspense>
        </main>
        <DeveloperFooter variant="compact" />
      </div>
    </div>
  );
}
